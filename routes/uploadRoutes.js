/**
 * Authenticated image uploads.
 * ImgBB is the primary host; Cloudinary's unsigned upload is a fallback so a
 * blocked ImgBB host does not break the feature. File contents are checked by
 * magic bytes, never by the client-supplied mimetype alone.
 */
import express from 'express';
import multer from 'multer';
import { createHash } from 'crypto';
import { verifyToken } from '../middleware/authMiddleware.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, callback) => {
    if (!file.mimetype?.startsWith('image/')) {
      return callback(new Error('Only image files are allowed'));
    }
    return callback(null, true);
  },
});

/** Detect real JPEG / PNG / GIF / WebP file signatures. */
function hasImageSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return true;

  // GIF87a / GIF89a
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return true;

  // WebP: RIFF....WEBPVP8 / VP8L / VP8X
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'RIFF') return false;
  return (
    buffer.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16))
  );
}

/** Strip path components and unsafe characters from a client file name. */
function sanitizeUploadName(originalName) {
  const base = String(originalName ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'image';
  const maxLength = 80;
  if (cleaned.length <= maxLength) return cleaned;

  const extension = /\.[A-Za-z0-9_-]{1,10}$/.exec(cleaned)?.[0] ?? '';
  const stem = extension ? cleaned.slice(0, -extension.length) : cleaned;
  return `${stem.slice(0, maxLength - extension.length)}${extension}`;
}

const cloudinaryConfigured = () =>
  Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_UPLOAD_PRESET);

const requireUploadProvider = (req, res, next) => {
  if (!process.env.IMGBB_API_KEY && !cloudinaryConfigured()) {
    return res.status(503).json({
      success: false,
      message:
        'Image upload is not configured. Set IMGBB_API_KEY or CLOUDINARY_CLOUD_NAME + CLOUDINARY_UPLOAD_PRESET.',
    });
  }
  return next();
};

// Vercel Hobby functions have a ~10s limit; keep uploads under it there.
const timeoutSignal = () =>
  AbortSignal.timeout(process.env.VERCEL ? 8_000 : 45_000);

/** Primary provider: ImgBB (base64 form upload). */
async function uploadToImgBB(file) {
  const form = new FormData();
  form.append('key', process.env.IMGBB_API_KEY);
  form.append('image', file.buffer.toString('base64'));
  form.append('name', `${Date.now()}-${sanitizeUploadName(file.originalname)}`);

  const response = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: form,
    signal: timeoutSignal(),
  });

  if (!response.ok) {
    const upstreamText = await response.text().catch(() => '');
    // A non-secret fingerprint makes key-related failures debuggable without
    // ever printing the API key itself.
    const fingerprint = createHash('sha256')
      .update(process.env.IMGBB_API_KEY || '')
      .digest('hex')
      .slice(0, 8);
    const detail = upstreamText.trim().slice(0, 160);
    const error = new Error(
      detail
        ? `Image host returned ${response.status} (key=${fingerprint}): ${detail}`
        : `Image host returned ${response.status} (key=${fingerprint})`,
    );
    error.status = response.status;
    throw error;
  }

  const result = await response.json().catch(() => ({}));
  if (!result.success || !result.data?.url) {
    const detail = typeof result.error?.message === 'string' ? result.error.message : '';
    const error = new Error(detail ? `Image host rejected the upload: ${detail}` : 'Image upload failed');
    error.status = 502;
    throw error;
  }

  return { url: result.data.url, deleteUrl: result.data.delete_url || '' };
}

/** Fallback provider: Cloudinary unsigned upload (no API secret required). */
async function uploadToCloudinary(file) {
  if (!cloudinaryConfigured()) return null;

  const form = new FormData();
  form.append(
    'file',
    new Blob([file.buffer], { type: file.mimetype || 'image/jpeg' }),
    sanitizeUploadName(file.originalname),
  );
  form.append('upload_preset', process.env.CLOUDINARY_UPLOAD_PRESET);
  // Each website uses its own folder; Cloudinary creates it automatically.
  form.append('folder', process.env.CLOUDINARY_FOLDER || 'learnnest');

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(process.env.CLOUDINARY_CLOUD_NAME)}/image/upload`,
    { method: 'POST', body: form, signal: timeoutSignal() },
  );

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.secure_url) {
    const error = new Error(result.error?.message || `Cloudinary returned ${response.status}`);
    error.status = response.status || 502;
    throw error;
  }

  return { url: result.secure_url, deleteUrl: '' };
}

router.post(
  '/image',
  verifyToken,
  requireUploadProvider,
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Please provide an image file in the 'image' field",
        });
      }

      if (!hasImageSignature(req.file.buffer)) {
        return res.status(400).json({
          success: false,
          message: 'Only JPG, PNG, GIF or WEBP images are allowed',
        });
      }

      let hosted = null;
      let providerErrors = '';

      if (process.env.IMGBB_API_KEY) {
        try {
          hosted = await uploadToImgBB(req.file);
        } catch (error) {
          providerErrors = error.message;
          console.error('[upload] ImgBB failed:', error.message);
        }
      }

      if (!hosted && cloudinaryConfigured()) {
        try {
          hosted = await uploadToCloudinary(req.file);
        } catch (error) {
          console.error('[upload] Cloudinary fallback failed:', error.message);
          providerErrors = `${providerErrors ? `${providerErrors} ` : ''}Cloudinary fallback: ${error.message}`;
        }
      }

      if (!hosted) {
        return res.status(502).json({
          success: false,
          message:
            providerErrors ||
            'Image upload failed. Configure IMGBB_API_KEY or Cloudinary upload settings.',
        });
      }

      return res.status(200).json({
        success: true,
        imageUrl: hosted.url,
        deleteUrl: hosted.deleteUrl,
      });
    } catch (error) {
      console.error('[upload] unexpected error:', error?.message || error);

      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return res.status(504).json({
          success: false,
          message: 'Image host did not respond in time. Please try again.',
        });
      }

      return res.status(500).json({ success: false, message: 'Failed to upload image' });
    }
  },
);

// Surface multer errors as JSON instead of Express' default HTML error page.
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Image must be smaller than 5MB'
          : error.message,
    });
  }

  if (error?.message === 'Only image files are allowed') {
    return res.status(400).json({ success: false, message: error.message });
  }

  return next(error);
});

export default router;
