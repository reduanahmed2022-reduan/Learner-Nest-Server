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

/**
 * Normalize a configured origin so small dashboard mistakes do not break CORS:
 * surrounding quotes, a trailing slash, a missing scheme, or a whole pasted
 * dotenv line such as `NEXT_PUBLIC_API_URL = https://example.com`.
 * Returns "" when nothing usable is left.
 */
export function normalizeOrigin(value) {
  let origin = String(value ?? "").trim();
  if (!origin) return "";

  const equals = origin.lastIndexOf("=");
  if (equals !== -1) origin = origin.slice(equals + 1).trim();

  origin = origin.replace(/^['"`]+|['"`]+$/g, "").trim();
  if (!origin) return "";

  if (!/^https?:\/\//i.test(origin) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(origin)) {
    origin = `https://${origin}`;
  }

  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

const isProduction = process.env.NODE_ENV === "production";

/**
 * Production browser origins that must keep working even if CLIENT_URL is
 * misconfigured in the hosting dashboard. Extra origins can be added through
 * the optional comma-separated CLIENT_ORIGINS variable.
 */
const DEFAULT_PRODUCTION_ORIGINS = ["https://learner-nest.vercel.app"];

/** Deduplicated, normalized allowlist used by CORS and BetterAuth. */
export const CLIENT_ORIGINS = [
  ...new Set(
    [
      ...rawClientUrls.split(","),
      ...(process.env.CLIENT_ORIGINS || "").split(","),
      ...(isProduction ? DEFAULT_PRODUCTION_ORIGINS : []),
    ]
      .map(normalizeOrigin)
      .filter(Boolean),
  ),
];
const isLocalOrigin = (origin) =>
  /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(origin) ||
  /local\.|\.local\b/i.test(origin);

/**
 * The canonical browser redirect URL. In production prefer a real deployed
 * origin over localhost entries; fall back to the first configured origin.
 */
export const CLIENT_URL = (() => {
  if (!isProduction) return CLIENT_ORIGINS[0] || "http://localhost:3000";

  // Never use the API's own origin as the browser redirect target.
  const apiOrigins = new Set(
    [
      process.env.BETTER_AUTH_URL,
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
      process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "",
    ]
      .map(normalizeOrigin)
      .filter(Boolean),
  );

  const deployed = CLIENT_ORIGINS.find(
    (origin) => !isLocalOrigin(origin) && !apiOrigins.has(origin),
  );
  return deployed || CLIENT_ORIGINS.find((origin) => !isLocalOrigin(origin)) || "http://localhost:3000";
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
