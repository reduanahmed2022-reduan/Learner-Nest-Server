/**
 * MongoDB connection lifecycle for LearnNest.
 *
 * The connection is lazy (created on the first connectDB call) so that
 * `dotenv.config()` in index.js has already populated process.env, and it is
 * idempotent so multiple callers (server startup, seed script, tests, Vercel
 * warm starts) share a single MongoClient.
 */
import { MongoClient } from "mongodb";

export const DB_NAME = "LearnNest";

/** Live bindings: importers always see the current client/database. */
export let client = null;
export let db = null;

let connecting = null;

export function getClient() {
  return client;
}

export function getDB() {
  return db;
}

/**
 * Indexes are safe to create repeatedly: MongoDB treats an identical
 * createIndex call as a no-op.
 */
async function ensureIndexes(database) {
  // BetterAuth maps its models onto this collection (see config/betterAuth.js),
  // so the unique e-mail index is sparse: non-user documents (account /
  // verification records) simply do not carry an e-mail field.
  await database.collection("users").createIndex(
    { email: 1 },
    { name: "uniq_users_email", unique: true, sparse: true },
  );

  // One enrollment per course per student.
  await database.collection("enrollments").createIndex(
    { courseId: 1, studentEmail: 1 },
    { name: "uniq_enrollments_course_student", unique: true },
  );

  // A Stripe Checkout Session may only be used once.
  await database.collection("payments").createIndex(
    { stripeSessionId: 1 },
    { name: "uniq_payments_stripeSessionId", unique: true, sparse: true },
  );

  // Courses are deliberately NOT unique on any user-facing field: multiple
  // instructors may publish courses with the same title/category.
  await Promise.all([
    database.collection("courses").createIndex(
      { category: 1 },
      { name: "idx_courses_category" },
    ),
    database.collection("courses").createIndex(
      { createdAt: -1 },
      { name: "idx_courses_createdAt" },
    ),
  ]);
}

/**
 * Connect (once) and return the LearnNest database.
 * @returns {Promise<import("mongodb").Db>}
 */
export async function connectDB() {
  if (client && db) return db;
  if (connecting) return connecting;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not configured. Copy .env.example to .env and set it before starting the server.",
    );
  }

  connecting = (async () => {
    const mongoClient = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10_000,
    });

    try {
      await mongoClient.connect();
      const database = mongoClient.db(DB_NAME);

      // Fail fast if the database is unreachable or credentials are wrong.
      await database.command({ ping: 1 });
      await ensureIndexes(database);

      client = mongoClient;
      db = database;
      return database;
    } catch (error) {
      await mongoClient.close().catch(() => {});
      throw error;
    }
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Close the shared connection. Safe to call more than once. */
export async function closeDB() {
  try {
    if (client) await client.close();
  } finally {
    client = null;
    db = null;
    connecting = null;
  }
}
