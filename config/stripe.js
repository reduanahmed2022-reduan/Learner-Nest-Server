/**
 * Stripe client and client-origin configuration.
 * Everything is read from process.env at import time (index.js loads dotenv
 * first via `import "dotenv/config"`).
 */
import Stripe from "stripe";

const rawSecretKey = process.env.STRIPE_SECRET_KEY || "";

/** Null when Stripe is not configured, so the API can still boot locally. */
export const stripe = rawSecretKey ? new Stripe(rawSecretKey) : null;

export const isStripeConfigured = Boolean(stripe);
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;

const rawClientUrls = process.env.CLIENT_URL || "http://localhost:3000";

/** Deduplicated, trimmed allowlist used by CORS and BetterAuth. */
export const CLIENT_ORIGINS = [
  ...new Set(
    rawClientUrls
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
];

const isProduction = process.env.NODE_ENV === "production";
const isLocalOrigin = (origin) =>
  /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(origin) ||
  /local\.|\.local\b/i.test(origin);

/**
 * The canonical browser redirect URL. In production prefer a real deployed
 * origin over localhost entries; fall back to the first configured origin.
 */
export const CLIENT_URL = (() => {
  if (!isProduction) return CLIENT_ORIGINS[0] || "http://localhost:3000";
  const deployed = CLIENT_ORIGINS.find((origin) => !isLocalOrigin(origin));
  return deployed || CLIENT_ORIGINS[0] || "http://localhost:3000";
})();

/** Subscription plans used by the payment routes. Amounts are in cents. */
export const PRO_PLANS = {
  instructor: {
    name: "Pro Instructor Plan",
    amount: 1500,
    currency: "usd",
    interval: "month",
  },
  student: {
    name: "Pro Student Plan",
    amount: 1000,
    currency: "usd",
    interval: "month",
  },
};
