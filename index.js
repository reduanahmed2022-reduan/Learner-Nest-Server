/**
 * LearnNest REST API entry point.
 * Import order matters: dotenv/config must run before the config modules read
 * process.env, and the Stripe webhook + BetterAuth handlers must be mounted
 * before express.json() so they can see the raw request body / full URL.
 */
import "dotenv/config";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";

import { connectDB, getDB } from "./config/db.js";
import {
  BETTER_AUTH_BASE_PATH,
  getAuth,
  isBetterAuthConfigured,
} from "./config/betterAuth.js";
import { CLIENT_ORIGINS, CLIENT_URL, normalizeOrigin } from "./config/stripe.js";

import authRoutes from "./routes/authRoutes.js";
import courseRoutes from "./routes/courseRoutes.js";
import enrollmentRoutes from "./routes/enrollmentRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import uploadRoutes from "./routes/uploadRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

dotenv.config();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

/* -------------------------------------------------------------------------- */
/* CORS                                                                       */
/* -------------------------------------------------------------------------- */
const allowedOrigins = new Set(
  CLIENT_ORIGINS.map((origin) => normalizeOrigin(origin)).filter(Boolean),
);
const corsOptions = {
  origin(origin, callback) {
    // Requests without an Origin header (curl, server-to-server, health
    // probes) are not subject to browser CORS rules.
    const requested = normalizeOrigin(origin);
    if (!origin || allowedOrigins.has(requested)) return callback(null, true);
    const error = new Error(`Origin ${origin} is not allowed by CORS`);
    error.code = "CORS_NOT_ALLOWED";
    error.statusCode = 403;
    return callback(error);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "stripe-signature",
  ],
  exposedHeaders: ["Content-Disposition"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Translate CORS rejection into a JSON response instead of Express' HTML page.
app.use((err, req, res, next) => {
  if (err && (err.code === "CORS_NOT_ALLOWED" || /CORS/i.test(err.message || ""))) {
    return res.status(403).json({
      success: false,
      message: err.message || "Origin not allowed by CORS",
      error: "CORS_NOT_ALLOWED",
    });
  }
  return next(err);
});

/* -------------------------------------------------------------------------- */
/* Raw-body routes (must precede express.json)                               */
/* -------------------------------------------------------------------------- */
const rawJson = express.raw({ type: ["application/json", "application/*+json"], limit: "2mb" });

// Support webhook routers that declare either `post("/webhook")` or `post("/")`.
app.use(
  "/api/payments",
  (req, res, next) => {
    if (req.method === "POST" && /^\/webhook\/?$/.test(req.path)) {
      return rawJson(req, res, next);
    }
    return next();
  },
  webhookRoutes,
);
app.use("/api/payments/webhook", rawJson, webhookRoutes);

/* -------------------------------------------------------------------------- */
/* BetterAuth handler (also before express.json)                             */
/* -------------------------------------------------------------------------- */
const betterAuth = getAuth();
if (betterAuth) {
  const betterAuthHandler = toNodeHandler(betterAuth);
  app.use(BETTER_AUTH_BASE_PATH, (req, res, next) => {
    // Express strips the mount path; BetterAuth needs the full URL to resolve
    // its configured basePath.
    req.url = req.originalUrl || req.url;
    return betterAuthHandler(req, res, next);
  });
} else {
  app.use(BETTER_AUTH_BASE_PATH, (req, res) =>
    res.status(503).json({
      success: false,
      message:
        "BetterAuth is not configured. Set BETTER_AUTH_SECRET and MONGODB_URI.",
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Body parsers + API routers                                                 */
/* -------------------------------------------------------------------------- */
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api/auth", authRoutes);
app.use("/api/courses", courseRoutes);
app.use("/api/enrollments", enrollmentRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/admin", adminRoutes);

/* -------------------------------------------------------------------------- */
/* Root / health                                                              */
/* -------------------------------------------------------------------------- */
app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "LearnNest API",
    version: "1.0.0",
    clientUrl: CLIENT_URL,
    endpoints: [
      "/api/auth",
      "/api/courses",
      "/api/enrollments",
      "/api/payments",
      "/api/upload",
      "/api/admin",
      "/api/better-auth",
    ],
    health: "/health",
  });
});

app.get("/health", async (req, res) => {
  let database = "disconnected";
  try {
    if (getDB()) {
      await getDB().command({ ping: 1 });
      database = "connected";
    }
  } catch (error) {
    database = "unreachable";
  }

  res.status(database === "unreachable" ? 503 : 200).json({
    success: database !== "unreachable",
    status: database === "unreachable" ? "degraded" : "ok",
    uptime: process.uptime(),
    database,
    timestamp: new Date().toISOString(),
  });
});

/* -------------------------------------------------------------------------- */
/* JSON 404 fallbacks                                                         */
/* -------------------------------------------------------------------------- */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

/* -------------------------------------------------------------------------- */
/* Centralized error handler                                                  */
/* -------------------------------------------------------------------------- */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  let status = err.statusCode || err.status;
  if (!status || status < 400 || status > 599) {
    if (err.code === "CORS_NOT_ALLOWED") status = 403;
    else if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") status = 401;
    else if (err.type === "entity.parse.failed" || err instanceof SyntaxError && "body" in err) status = 400;
    else if (err.code === "LIMIT_FILE_SIZE") status = 413;
    else status = 500;
  }

  const message =
    status === 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Unexpected error";

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  }

  const body = { success: false, message };
  if (err.code) body.code = err.code;
  if (process.env.NODE_ENV !== "production" && err.stack) body.stack = err.stack;

  return res.status(status).json(body);
});

/* -------------------------------------------------------------------------- */
/* Startup                                                                    */
/* -------------------------------------------------------------------------- */
let readyPromise = null;

/** Idempotent readiness check used by serverless handlers and startup. */
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = connectDB()
      .then((database) => {
        if (isBetterAuthConfigured()) getAuth();
        return database;
      })
      .catch((error) => {
        readyPromise = null;
        throw error;
      });
  }
  return readyPromise;
}

export function startServer() {
  if (process.env.VERCEL) return Promise.resolve(null);

  const port = Number(process.env.PORT) || 5000;
  return ensureReady()
    .then(() => {
      const server = app.listen(port, () => {
        console.log(`LearnNest API listening on port ${port} (${process.env.NODE_ENV || "development"})`);
      });
      return server;
    })
    .catch((error) => {
      console.error("[startup] failed to connect to MongoDB:", error?.message || error);
      process.exitCode = 1;
      return null;
    });
}

if (!process.env.VERCEL) {
  startServer();
}

export { app };
export default app;
