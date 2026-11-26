/**
 * Stripe subscription Checkout, verification and webhook handlers.
 * Plans and prices live in config/stripe.js; all database writes are delegated
 * to services/subscriptionService.js so the browser and webhook share the
 * same idempotent activation logic.
 */
import { ObjectId } from 'mongodb';
import {
  CLIENT_URL,
  PRO_PLANS,
  STRIPE_WEBHOOK_SECRET,
  stripe,
} from '../config/stripe.js';
import { getDB } from '../config/db.js';
import {
  activateSubscription,
  deactivateSubscription,
  recordRenewalPayment,
} from '../services/subscriptionService.js';

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

/** verifyToken exposes `id`; tolerate other middleware shapes as well. */
function authUserId(req) {
  const source = req.user || req.auth || {};
  if (typeof source === 'string') return source;
  return source.userId || source.id || source._id || req.userId || null;
}

const stripeUnavailable = (res) =>
  fail(res, 503, 'Stripe is not configured. Please set STRIPE_SECRET_KEY.');

/** POST /api/payments/checkout — start a monthly Pro subscription. */
export const createCheckoutSession = async (req, res) => {
  try {
    if (!stripe) return stripeUnavailable(res);

    const userId = authUserId(req);
    if (!userId || !ObjectId.isValid(String(userId))) {
      return fail(res, 401, 'Invalid user information');
    }

    const database = getDB();
    if (!database) return fail(res, 503, 'Database is not connected');

    const user = await database
      .collection('users')
      .findOne(
        { _id: new ObjectId(String(userId)) },
        { projection: { password: 0 } },
      );

    if (!user) return fail(res, 404, 'User not found');

    const role = String(user.role || '').toLowerCase();
    if (role === 'admin') {
      return fail(res, 403, 'Administrator accounts do not need a Pro subscription');
    }

    const plan = PRO_PLANS[role];
    if (!plan) {
      return fail(res, 403, 'Only instructors and students can purchase the Pro plan');
    }

    if (user.plan === 'pro') {
      return fail(res, 400, 'Your Pro plan is already active');
    }

    const metadata = {
      userId: String(user._id),
      userEmail: user.email,
      userName: user.name || '',
      userRole: role,
      planName: plan.name,
    };

    const session = await stripe.checkout.sessions.create({
      // A recurring subscription, never a one-time charge.
      mode: 'subscription',
      customer_email: user.email,
      client_reference_id: String(user._id),
      line_items: [
        {
          price_data: {
            currency: plan.currency,
            unit_amount: plan.amount,
            recurring: { interval: plan.interval || 'month' },
            product_data: {
              name: plan.name,
              description: 'LearnNest Pro Plan — monthly subscription',
            },
          },
          quantity: 1,
        },
      ],
      metadata,
      subscription_data: { metadata },
      success_url: `${CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/payment/cancel`,
    });

    return res.status(200).json({
      success: true,
      url: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error('[payments] create checkout error:', error?.message || error);
    return fail(res, 500, 'Failed to create Stripe checkout session');
  }
};

/** POST /api/payments/verify — activate after the browser returns from Stripe. */
export const verifyCheckoutSession = async (req, res) => {
  try {
    if (!stripe) return stripeUnavailable(res);

    const { sessionId } = req.body || {};
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      return fail(res, 400, 'sessionId is required');
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId.trim());
    const userId = authUserId(req);

    if (!session.metadata?.userId || String(session.metadata.userId) !== String(userId)) {
      return fail(res, 403, 'This payment does not belong to you');
    }

    const result = await activateSubscription(session);

    if (result.reason === 'user_not_found') {
      return fail(res, 404, 'User not found');
    }

    const activated = Boolean(result.activated || result.reason === 'already_recorded');
    const messages = {
      payment_not_paid: 'Payment is not completed yet',
      invalid_amount: 'Payment amount did not match the selected plan',
      invalid_plan: 'Plan could not be verified',
      user_not_found: 'User not found',
    };

    return res.status(200).json({
      success: activated,
      plan: result.plan || 'free',
      message: messages[result.reason] || (activated ? 'Your Pro plan is active' : 'We could not activate your Pro plan'),
    });
  } catch (error) {
    console.error('[payments] verify checkout error:', error?.message || error);
    return fail(res, 500, 'Failed to verify payment');
  }
};

/**
 * POST /api/payments/webhook — signature-verified Stripe events.
 * The raw request body is supplied by routes/webhookRoutes.js (mounted before
 * express.json in index.js).
 */
export const handleStripeWebhook = async (req, res) => {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    return fail(res, 503, 'Stripe webhook is not configured');
  }

  if (!signature) {
    return fail(res, 400, 'Missing Stripe signature');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    console.error('[payments] invalid webhook signature:', error?.message || error);
    return fail(res, 400, 'Invalid webhook signature');
  }

  try {
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      console.log('[payments] subscription sync:', await activateSubscription(event.data.object));
    } else if (event.type === 'invoice.paid') {
      console.log('[payments] renewal sync:', await recordRenewalPayment(event.data.object));
    } else if (event.type === 'customer.subscription.deleted') {
      console.log('[payments] cancellation sync:', await deactivateSubscription(event.data.object));
    }
  } catch (error) {
    console.error(`[payments] webhook handler failed for ${event.type}:`, error?.message || error);
    return fail(res, 500, 'Failed to process webhook event');
  }

  return res.status(200).json({ received: true });
};

export default {
  createCheckoutSession,
  verifyCheckoutSession,
  handleStripeWebhook,
};
