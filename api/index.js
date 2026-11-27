/**
 * Vercel serverless entry point.
 *
 * - Express needs the raw request stream for the Stripe webhook and BetterAuth.
 * - `ensureReady()` makes sure MongoDB (and BetterAuth) are ready on cold starts.
 */
import { app, ensureReady } from "../index.js";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  try {
    await ensureReady();
  } catch (error) {
    const detail = String(error?.message || error);
    console.error("[vercel] initialization failed:", detail);

    const message = /MONGODB_URI|not configured/i.test(detail)
      ? "Server configuration is incomplete: MONGODB_URI is missing."
      : "Server initialization failed. Check the deployment environment variables.";

    return res.status(503).json({ success: false, message });
  }

  return app(req, res);
}
