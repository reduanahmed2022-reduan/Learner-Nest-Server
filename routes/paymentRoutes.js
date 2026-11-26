import express from 'express';
import {
  createCheckoutSession,
  verifyCheckoutSession,
} from '../controllers/paymentController.js';
import { verifyToken } from '../middleware/authMiddleware.js';

const router = express.Router();

// Both routes require a valid JWT. The webhook is mounted separately because
// Stripe signs the raw body and cannot send an Authorization header.
router.post('/checkout', verifyToken, createCheckoutSession);
router.post('/verify', verifyToken, verifyCheckoutSession);

export default router;
