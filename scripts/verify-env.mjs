/**
 * Pre-deploy environment verification for the LearnNest server.
 *
 * Usage (from the server directory):
 *   node scripts/verify-env.mjs
 *
 * Prints key names and PRESENT / MISSING status only - never values.
 * Exits with code 1 only when a REQUIRED variable is missing.
 */
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const REQUIRED = ['MONGODB_URI', 'JWT_SECRET', 'BETTER_AUTH_SECRET'];

const RECOMMENDED = [
  'BETTER_AUTH_URL',
  'CLIENT_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'IMGBB_API_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_UPLOAD_PRESET',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
];

const OPTIONAL = ['PORT', 'JWT_EXPIRES_IN', 'ADMIN_NAME', 'NODE_ENV'];

const STRIPE_KEYS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
const CLOUDINARY_PAIR = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_UPLOAD_PRESET'];

function isPresent(key) {
  return (
    Object.prototype.hasOwnProperty.call(process.env, key) &&
    String(process.env[key]).trim().length > 0
  );
}

function report(title, keys) {
  console.log(`${title}:`);
  for (const key of keys) {
    console.log(`  ${key}: ${isPresent(key) ? 'PRESENT' : 'MISSING'}`);
  }
  console.log('');
}

report('REQUIRED', REQUIRED);
report('RECOMMENDED', RECOMMENDED);
report('OPTIONAL', OPTIONAL);

const isProduction = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const clientUrl = String(process.env.CLIENT_URL || '').trim();

if (
  isProduction &&
  /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(clientUrl)
) {
  console.warn(
    'WARNING: CLIENT_URL points to localhost while NODE_ENV=production. ' +
      'Set CLIENT_URL to the deployed client origin.',
  );
}

if (STRIPE_KEYS.some((key) => !isPresent(key))) {
  console.warn('WARNING: Stripe configuration is incomplete; payment endpoints will return 503.');
}

if (!isPresent('IMGBB_API_KEY') && CLOUDINARY_PAIR.some((key) => !isPresent(key))) {
  console.warn(
    'WARNING: No complete image host configuration; /api/upload/image will return 503.',
  );
} else if (CLOUDINARY_PAIR.some((key) => !isPresent(key))) {
  console.warn('WARNING: Cloudinary fallback is incomplete (both cloud name and upload preset are needed).');
}

const missingRequired = REQUIRED.filter((key) => !isPresent(key));
if (missingRequired.length > 0) {
  console.error(
    `FAIL: ${missingRequired.length} required environment variable(s) missing: ` +
      missingRequired.join(', '),
  );
  process.exit(1);
}

console.log('OK: all required environment variables are present.');
