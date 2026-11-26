/**
 * JWT authentication and role authorization middleware.
 * Roles are always re-read from MongoDB so a demotion/promotion takes effect
 * immediately, even if an old JWT is still valid.
 */
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

function sendError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

/**
 * Strict `Authorization: Bearer <token>` verification with HS256 only.
 */
export function verifyToken(req, res, next) {
  const header = req.headers.authorization || req.headers.Authorization;

  if (typeof header !== "string" || !header.trim()) {
    return sendError(res, 401, "Authorization header is required");
  }

  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return sendError(res, 401, "Authorization header must be 'Bearer <token>'");
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return sendError(res, 500, "JWT_SECRET is not configured");
  }

  try {
    const payload = jwt.verify(parts[1], secret, { algorithms: ["HS256"] });
    const rawId = payload?.id || payload?.userId || payload?._id;

    if (!rawId || !ObjectId.isValid(String(rawId))) {
      return sendError(res, 401, "Token payload contains an invalid user id");
    }

    req.user = {
      id: String(rawId),
      email: payload.email || null,
      role: payload.role || null,
      token: parts[1],
    };
    return next();
  } catch (error) {
    const message =
      error?.name === "TokenExpiredError"
        ? "Token has expired"
        : error?.name === "NotBeforeError"
          ? "Token is not active yet"
          : "Invalid or malformed token";
    return sendError(res, 401, message);
  }
}

/**
 * Factory: builds middleware that allows only the given live DB roles.
 */
export function authorizeRole(...allowedRoles) {
  const allowed = new Set(
    (Array.isArray(allowedRoles[0]) ? allowedRoles[0] : allowedRoles).map((r) =>
      String(r).toLowerCase(),
    ),
  );

  return async (req, res, next) => {
    if (!req.user?.id) {
      return sendError(res, 401, "Authentication required");
    }

    const database = getDB();
    if (!database) {
      return sendError(res, 503, "Database is not connected");
    }

    try {
      const user = await database.collection("users").findOne(
        { _id: new ObjectId(req.user.id) },
        {
          projection: {
            email: 1,
            name: 1,
            role: 1,
            isPro: 1,
            proPlan: 1,
            proStatus: 1,
          },
        },
      );

      if (!user) {
        return sendError(res, 401, "User no longer exists");
      }

      const role = String(user.role || "").toLowerCase();
      if (!allowed.has(role)) {
        return sendError(
          res,
          403,
          `Access denied. Required role: ${[...allowed].join(" or ")}`,
        );
      }

      // Refresh the request identity from the database, not from the token.
      req.user.role = role;
      req.user.email = user.email || req.user.email;
      req.dbUser = user;
      return next();
    } catch (error) {
      console.error("[authMiddleware] role lookup failed:", error?.message || error);
      return sendError(res, 500, "Failed to verify user role");
    }
  };
}

export const verifyStudent = authorizeRole("student");
export const verifyInstructor = authorizeRole("instructor");
export const verifyAdmin = authorizeRole("admin");
