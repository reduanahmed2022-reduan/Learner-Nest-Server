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
  await ensureReady();
  return app(req, res);
}
