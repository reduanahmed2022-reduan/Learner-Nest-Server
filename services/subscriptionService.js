/**
 * Subscription bookkeeping shared by the Checkout verification endpoint and
 * the Stripe webhook. Every operation is idempotent: Stripe may deliver the
 * same event more than once, and the browser and webhook can both activate a
 * session, but a payment must only be recorded once.
 */
import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';
import { PRO_PLANS } from '../config/stripe.js';

const PAID_STATUSES = new Set(['paid', 'no_payment_required']);

function firstId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.id || '';
}

function userFilterFromSession(session, metadata) {
  if (metadata.userId && ObjectId.isValid(String(metadata.userId))) {
    return { _id: new ObjectId(String(metadata.userId)) };
  }

  const email = metadata.userEmail || session.customer_details?.email || session.customer_email;
  return email ? { email: String(email).toLowerCase() } : null;
}

/**
 * Record a paid Checkout Session in `payments` and upgrade the user to Pro.
 * Safe to call more than once for the same session.
 *
 * @param {object} session Stripe Checkout Session (retrieved or from webhook)
 */
export async function activateSubscription(session) {
  if (!PAID_STATUSES.has(session?.payment_status)) {
    return { activated: false, reason: 'payment_not_paid' };
  }

  const database = getDB();
  if (!database) {
    return { activated: false, reason: 'database_not_connected' };
  }

  const users = database.collection('users');
  const payments = database.collection('payments');
  const metadata = session.metadata || {};

  const filter = userFilterFromSession(session, metadata);
  if (!filter) {
    return { activated: false, reason: 'user_not_found' };
  }

  const user = await users.findOne(filter, { projection: { password: 0 } });
  if (!user) {
    return { activated: false, reason: 'user_not_found' };
  }

  // Validate against the role signed into Stripe metadata at Checkout time.
  // The live role may have changed while the payment was in flight, and a
  // missing signed plan must never silently skip the amount validation.
  const signedRole = String(metadata.userRole || user.role || '').toLowerCase();
  const plan = PRO_PLANS[signedRole];

  if (!plan || (metadata.planName && metadata.planName !== plan.name)) {
    return { activated: false, reason: 'invalid_plan' };
  }

  const paidAmount = session.amount_total ?? plan.amount;
  const currency = String(session.currency || plan.currency).toLowerCase();
  if (paidAmount !== plan.amount || currency !== plan.currency) {
    return { activated: false, reason: 'invalid_amount' };
  }

  const subscriptionId = firstId(session.subscription);

  const payment = {
    userEmail: user.email,
    userName: user.name || '',
    userRole: signedRole,
    planName: metadata.planName || plan.name,
    amount: paidAmount / 100,
    currency: currency.toUpperCase(),
    transactionId:
      subscriptionId ||
      firstId(session.payment_intent) ||
      session.id,
    stripeSessionId: session.id,
    stripeSubscriptionId: subscriptionId,
    paymentStatus: 'paid',
    paidAt: new Date(),
    createdAt: new Date(),
  };

  const markPro = () =>
    users.updateOne(
      { _id: user._id },
      {
        $set: {
          plan: 'pro',
          ...(subscriptionId && { stripeSubscriptionId: subscriptionId }),
          updatedAt: new Date(),
        },
      },
    );

  try {
    // The unique index on stripeSessionId makes the claim atomic: a duplicate
    // delivery simply matches the existing row instead of inserting again.
    const claim = await payments.updateOne(
      { stripeSessionId: session.id },
      { $setOnInsert: payment },
      { upsert: true },
    );

    // Heal the user record even when the payment was already recorded (e.g. a
    // previous webhook inserted the row but failed before upgrading the user).
    await markPro();

    if (claim.upsertedCount === 0) {
      return { activated: false, reason: 'already_recorded', plan: 'pro' };
    }

    return { activated: true, plan: 'pro', payment };
  } catch (error) {
    if (error?.code === 11000) {
      await markPro();
      return { activated: false, reason: 'already_recorded', plan: 'pro' };
    }
    throw error;
  }
}

/**
 * Record a monthly renewal from `invoice.paid`. Invoice ids are unique, so
 * re-delivered events cannot create duplicate revenue entries.
 */
export async function recordRenewalPayment(invoice) {
  if (!invoice || invoice.paid !== true) {
    return { recorded: false, reason: 'invoice_not_paid' };
  }

  const subscriptionId = firstId(invoice.subscription);
  if (!subscriptionId || !invoice.id) {
    return { recorded: false, reason: 'subscription_not_found' };
  }

  const database = getDB();
  if (!database) {
    return { recorded: false, reason: 'database_not_connected' };
  }

  const users = database.collection('users');
  const payments = database.collection('payments');

  const user = await users.findOne(
    { stripeSubscriptionId: subscriptionId },
    { projection: { password: 0 } },
  );
  if (!user) {
    return { recorded: false, reason: 'user_not_found' };
  }

  const role = String(user.role || '').toLowerCase();
  const plan = PRO_PLANS[role];
  if (!plan) {
    return { recorded: false, reason: 'invalid_plan' };
  }

  const payment = {
    userEmail: user.email,
    userName: user.name || '',
    userRole: role,
    planName: user.proPlan || plan.name,
    amount: (invoice.amount_paid ?? 0) / 100,
    currency: String(invoice.currency || plan.currency).toUpperCase(),
    transactionId: firstId(invoice.payment_intent) || invoice.id,
    // Reuse the unique stripeSessionId field for invoice ids: it is the
    // natural idempotency key and keeps all transactions in one collection.
    stripeSessionId: invoice.id,
    stripeInvoiceId: invoice.id,
    stripeSubscriptionId: subscriptionId,
    paymentStatus: 'paid',
    paidAt: new Date((invoice.created || Date.now() / 1000) * 1000),
    createdAt: new Date(),
  };

  try {
    const claim = await payments.updateOne(
      { stripeSessionId: invoice.id },
      { $setOnInsert: payment },
      { upsert: true },
    );

    if (claim.upsertedCount === 0) {
      return { recorded: false, reason: 'already_recorded' };
    }

    return { recorded: true, payment };
  } catch (error) {
    if (error?.code === 11000) {
      return { recorded: false, reason: 'already_recorded' };
    }
    throw error;
  }
}

/**
 * Return the account to the Free plan when `customer.subscription.deleted`
 * arrives (user-initiated cancellation).
 */
export async function deactivateSubscription(subscription) {
  const subscriptionId = firstId(subscription?.id || subscription);
  if (!subscriptionId) {
    return { deactivated: false, reason: 'subscription_not_found' };
  }

  const database = getDB();
  if (!database) {
    return { deactivated: false, reason: 'database_not_connected' };
  }

  const users = database.collection('users');
  const user = await users.findOne({ stripeSubscriptionId: subscriptionId });
  if (!user) {
    return { deactivated: false, reason: 'user_not_found' };
  }

  await users.updateOne(
    { _id: user._id },
    {
      $set: { plan: 'free', updatedAt: new Date() },
      $unset: { stripeSubscriptionId: '' },
    },
  );

  return { deactivated: true };
}
