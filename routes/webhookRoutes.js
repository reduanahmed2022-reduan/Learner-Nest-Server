import express from 'express';
import { handleStripeWebhook } from '../controllers/paymentController.js';

const router = express.Router();

// Stripe verifies a signature over the exact bytes it sent, so this route
// needs express.raw() and must be mounted before express.json() in index.js.
router.post(
  '/webhook',
  express.raw({ type: 'application/json', limit: '2mb' }),
  handleStripeWebhook,
);

export default router;
