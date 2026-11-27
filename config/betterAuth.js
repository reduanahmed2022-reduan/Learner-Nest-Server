/**
 * BetterAuth configuration.
 *
 * BetterAuth's models are mapped onto the existing `users` collection so the
 * REST API and BetterAuth share one user store. Sessions and verification
 * values are kept in an in-memory secondary storage instead of dedicated
 * `session` / `verification` collections.
 */
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { MongoClient } from "mongodb";

import { DB_NAME, getClient } from "./db.js";
import { CLIENT_ORIGINS } from "./stripe.js";

export const BETTER_AUTH_BASE_PATH = "/api/better-auth";

let authInstance = null;
let ownedClient = null;

export function isBetterAuthConfigured() {
  return Boolean(process.env.BETTER_AUTH_SECRET && process.env.MONGODB_URI);
}

/**
 * Minimal TTL-aware store implementing BetterAuth's secondaryStorage contract.
 * Values are strings; ttl is supplied in seconds.
 */
function createSecondaryStorage() {
  const entries = new Map();

  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttl) {
      const expiresAt =
        Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null;
      entries.set(String(key), { value: String(value), expiresAt });
    },
    async delete(key) {
      entries.delete(String(key));
    },
  };
}

/**
 * Lazily build (and memoize) the BetterAuth instance.
 * Returns null when required env vars are missing so the server can still run
 * with only the JWT-based /api/auth routes.
 */
export function getAuth() {
  if (authInstance) return authInstance;
  if (!isBetterAuthConfigured()) return null;

  try {
    // Reuse the app connection when it is already open; otherwise create one.
    const mongoClient = getClient() || new MongoClient(process.env.MONGODB_URI);
    if (!getClient()) ownedClient = mongoClient;
    const database = mongoClient.db(DB_NAME);

    authInstance = betterAuth({
      secret: process.env.BETTER_AUTH_SECRET,
      baseURL: process.env.BETTER_AUTH_URL || undefined,
      basePath: BETTER_AUTH_BASE_PATH,
      trustedOrigins: CLIENT_ORIGINS,

      database: mongodbAdapter(database, { client: mongoClient }),
      secondaryStorage: createSecondaryStorage(),

      // Keep session/verification data out of MongoDB collections.
      session: {
        storeSessionInDatabase: false,
        expiresIn: 60 * 60 * 24 * 7,
        updateAge: 60 * 60 * 24,
      },

      // All BetterAuth models live in the pre-existing `users` collection.
      // config/db.js already creates the unique `email_1` index, so disable
      // BetterAuth's own email index to avoid an IndexOptionsConflict at boot.
      schema: {
        user: {
          tableName: "users",
          fields: { email: { type: "string", index: false } },
        },
        // All models share one collection; disable BetterAuth's automatic
        // indexes here because our own indexes already cover these lookups.
        account: {
          tableName: "users",
          fields: { userId: { type: "string", index: false } },
        },
        session: { tableName: "users" },
        verification: { tableName: "users" },
      },

      emailAndPassword: {
        enabled: true,
        autoSignIn: true,
      },
    });

    return authInstance;
  } catch (error) {
    console.error(
      "[better-auth] initialization failed:",
      error?.message || error,
    );
    if (ownedClient && !getClient()) {
      ownedClient.close().catch(() => {});
      ownedClient = null;
    }
    return null;
  }
}
