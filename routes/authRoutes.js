import express from 'express';
import {
  register,
  login,
  getMe,
  updateMe,
  googleStatus,
  googleStart,
} from '../controllers/authController.js';
import { verifyToken } from '../middleware/authMiddleware.js';

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', verifyToken, getMe);
router.put('/me', verifyToken, updateMe);
router.get('/google/status', googleStatus);
router.get('/google/start', googleStart);

export default router;
