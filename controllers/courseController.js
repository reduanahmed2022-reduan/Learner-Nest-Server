import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 50;

// Guard before trimming: a non-string must never reach .trim().
const isText = (value) => typeof value === "string" && value.trim().length > 0;

// Escape regex metacharacters so user input cannot inject a pattern.
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeLimit = (value, fallback = DEFAULT_LIMIT) => {
  if (Array.isArray(value) || value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "string" && value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
};

const normalizePage = (value) => {
  if (Array.isArray(value) || value === undefined || value === null) {
    return 1;
  }

  if (typeof value === "string" && value.trim() === "") {
    return 1;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 1;
};

// Canonicalize the two supported modes while accepting mixed-case input.
const normalizeMode = (value) => {
  if (!isText(value)) return null;

  const normalized = value.trim().toLowerCase();

  if (normalized === "online") return "Online";
  if (normalized === "offline") return "Offline";

  return null;
};

const isPro = (user) =>
  user?.plan === "pro" ||
  user?.plan === "premium" ||
  user?.isPro === true;

/**
 * Resolve the authenticated account. Tokens normally carry `userId`; BetterAuth
 * sessions may instead expose `id` or just an email, so support all three.
 */
async function getRequestUser(db, req) {
  const rawId = req.user?.userId || req.user?.id || req.user?._id;

  if (ObjectId.isValid(rawId)) {
    const user = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(rawId) },
        { projection: { password: 0 } }
      );

    if (user) return user;
  }

  const email = req.user?.email;

  if (typeof email === "string" && email.trim()) {
    return db.collection("users").findOne(
      { email: { $regex: `^${escapeRegex(email.trim())}$`, $options: "i" } },
      { projection: { password: 0 } }
    );
  }

  return null;
}

// Public: browse approved, active courses with search, filters and pagination.
export const getAllCourses = async (req, res) => {
  try {
    const { search, category, level, mode, page, limit } = req.query;

    const textFilters = [search, category, level, mode];

    if (
      textFilters.some(
        (value) => value !== undefined && typeof value !== "string"
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Search and filters must be strings",
      });
    }

    const db = getDB();

    // Only approved and active courses are visible to the public.
    const filter = { approvalStatus: "approved", isActive: true };

    if (search?.trim()) {
      const searchRegex = {
        $regex: escapeRegex(search.trim()),
        $options: "i",
      };

      filter.$or = [{ title: searchRegex }, { category: searchRegex }];
    }

    // Exact-ish (case-insensitive, whole-value) category/level filters.
    if (category?.trim()) {
      filter.category = {
        $regex: `^${escapeRegex(category.trim())}$`,
        $options: "i",
      };
    }

    if (level?.trim()) {
      filter.level = {
        $regex: `^${escapeRegex(level.trim())}$`,
        $options: "i",
      };
    }

    if (mode !== undefined) {
      const normalizedMode = normalizeMode(mode);

      if (!normalizedMode) {
        return res.status(400).json({
          success: false,
          message: "Mode must be Online or Offline",
        });
      }

      filter.mode = normalizedMode;
    }

    const pageNumber = normalizePage(page);
    const pageSize = normalizeLimit(limit);

    const coursesCollection = db.collection("courses");
    const total = await coursesCollection.countDocuments(filter);

    const courses = await coursesCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNumber - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    return res.status(200).json({
      success: true,
      courses,
      total,
      page: pageNumber,
      limit: pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("Get All Courses Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve courses",
    });
  }
};

// Public: single approved, active course.
export const getCourseById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid course ID",
      });
    }

    const course = await getDB()
      .collection("courses")
      .findOne({
        _id: new ObjectId(id),
        approvalStatus: "approved",
        isActive: true,
      });

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    return res.status(200).json({ success: true, course });
  } catch (error) {
    console.error("Get Course By ID Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve course",
    });
  }
};

// Instructor: create a course. It stays pending until an admin reviews it.
export const createCourse = async (req, res) => {
  try {
    const {
      title,
      category,
      level,
      mode,
      duration,
      price,
      thumbnail,
      description,
    } = req.body || {};

    // Validate every required field with typeof guards BEFORE calling trim().
    if (
      !isText(title) ||
      !isText(category) ||
      !isText(level) ||
      !isText(duration) ||
      !isText(description) ||
      typeof thumbnail !== "string" ||
      price === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required course fields",
      });
    }

    const normalizedMode = normalizeMode(mode);

    if (!normalizedMode) {
      return res.status(400).json({
        success: false,
        message: "Mode must be Online or Offline",
      });
    }

    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        success: false,
        message: "Price must be a non-negative number",
      });
    }

    const db = getDB();
    const instructor = await getRequestUser(db, req);

    if (!instructor) {
      return res.status(401).json({
        success: false,
        message: "Instructor account not found",
      });
    }

    if (!isText(instructor.email)) {
      return res.status(401).json({
        success: false,
        message: "Invalid instructor information",
      });
    }

    // Free instructors may publish at most two courses; Pro is unlimited.
    if (!isPro(instructor)) {
      const existingCount = await db
        .collection("courses")
        .countDocuments({ instructorEmail: instructor.email });

      if (existingCount >= 2) {
        return res.status(403).json({
          success: false,
          message:
            "Free instructors can create up to 2 courses. Upgrade to Pro for unlimited courses.",
        });
      }
    }

    const course = {
      title: title.trim(),
      category: category.trim(),
      level: level.trim(),
      mode: normalizedMode,
      duration: duration.trim(),
      price,
      thumbnail: thumbnail.trim(),
      description: description.trim(),
      instructorName: instructor.name || "",
      instructorEmail: instructor.email,
      approvalStatus: "pending",
      isActive: true,
      createdAt: new Date(),
    };

    const result = await db.collection("courses").insertOne(course);

    return res.status(201).json({
      success: true,
      message: "Course submitted for approval",
      course: { _id: result.insertedId, ...course },
    });
  } catch (error) {
    console.error("Create Course Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create course",
    });
  }
};

// Instructor: every course owned by the authenticated instructor.
export const getMyCourses = async (req, res) => {
  try {
    const db = getDB();
    const instructor = await getRequestUser(db, req);

    if (!instructor) {
      return res.status(401).json({
        success: false,
        message: "Instructor account not found",
      });
    }

    if (!isText(instructor.email)) {
      return res.status(401).json({
        success: false,
        message: "Invalid instructor information",
      });
    }

    const courses = await db
      .collection("courses")
      .find({ instructorEmail: instructor.email })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      courses,
      total: courses.length,
    });
  } catch (error) {
    console.error("Get My Courses Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve your courses",
    });
  }
};

// Instructor: partial edit of an owned course.
export const updateCourse = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid course ID",
      });
    }

    const { title, category, level, mode, duration, price, thumbnail, description } =
      req.body || {};

    const updates = {};

    // Validate supplied fields with typeof guards before trimming.
    const textFields = {
      title,
      category,
      level,
      duration,
      description,
      thumbnail,
    };

    for (const [field, value] of Object.entries(textFields)) {
      if (value === undefined) continue;

      if (typeof value !== "string") {
        return res.status(400).json({
          success: false,
          message: `${field} must be a string`,
        });
      }

      if (field !== "thumbnail" && !value.trim()) {
        return res.status(400).json({
          success: false,
          message: `${field} cannot be empty`,
        });
      }

      updates[field] = value.trim();
    }

    if (mode !== undefined) {
      const normalizedMode = normalizeMode(mode);

      if (!normalizedMode) {
        return res.status(400).json({
          success: false,
          message: "Mode must be Online or Offline",
        });
      }

      updates.mode = normalizedMode;
    }

    if (price !== undefined) {
      if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
        return res.status(400).json({
          success: false,
          message: "Price must be a non-negative number",
        });
      }

      updates.price = price;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide at least one field to update",
      });
    }

    const db = getDB();
    const instructor = await getRequestUser(db, req);

    if (!instructor || !isText(instructor.email)) {
      return res.status(401).json({
        success: false,
        message: "Instructor account not found",
      });
    }

    const courses = db.collection("courses");
    const filter = {
      _id: new ObjectId(id),
      instructorEmail: instructor.email,
    };

    const result = await courses.updateOne(filter, {
      $set: { ...updates, updatedAt: new Date() },
    });

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found or access denied",
      });
    }

    const course = await courses.findOne({ _id: new ObjectId(id) });

    return res.status(200).json({
      success: true,
      message: "Course updated successfully",
      course,
    });
  } catch (error) {
    console.error("Update Course Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update course",
    });
  }
};

// Instructor: enable/disable an owned course.
export const toggleCourseStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body || {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid course ID",
      });
    }

    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isActive must be a boolean",
      });
    }

    const db = getDB();
    const instructor = await getRequestUser(db, req);

    if (!instructor || !isText(instructor.email)) {
      return res.status(401).json({
        success: false,
        message: "Instructor account not found",
      });
    }

    const courses = db.collection("courses");
    const filter = {
      _id: new ObjectId(id),
      instructorEmail: instructor.email,
    };

    const result = await courses.updateOne(filter, {
      $set: { isActive, updatedAt: new Date() },
    });

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found or access denied",
      });
    }

    const course = await courses.findOne({ _id: new ObjectId(id) });

    return res.status(200).json({
      success: true,
      message: `Course ${isActive ? "activated" : "deactivated"} successfully`,
      course,
    });
  } catch (error) {
    console.error("Toggle Course Status Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update course status",
    });
  }
};

// Instructor: delete an owned course.
export const deleteCourse = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid course ID",
      });
    }

    const db = getDB();
    const instructor = await getRequestUser(db, req);

    if (!instructor || !isText(instructor.email)) {
      return res.status(401).json({
        success: false,
        message: "Instructor account not found",
      });
    }

    const result = await db.collection("courses").deleteOne({
      _id: new ObjectId(id),
      instructorEmail: instructor.email,
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Course not found or access denied",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Course deleted successfully",
    });
  } catch (error) {
    console.error("Delete Course Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete course",
    });
  }
};

// Admin: list every course awaiting review.
export const getPendingCourses = async (req, res) => {
  try {
    const courses = await getDB()
      .collection("courses")
      .find({ approvalStatus: "pending" })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      courses,
      total: courses.length,
    });
  } catch (error) {
    console.error("Get Pending Courses Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve pending courses",
    });
  }
};

// Admin: approve or reject a pending course only.
export const reviewCourse = async (req, res) => {
  try {
    const { id } = req.params;
    const { approvalStatus } = req.body || {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid course ID",
      });
    }

    if (!["approved", "rejected"].includes(approvalStatus)) {
      return res.status(400).json({
        success: false,
        message: "Status must be approved or rejected",
      });
    }

    const courses = getDB().collection("courses");
    const courseId = new ObjectId(id);
    const existing = await courses.findOne({ _id: courseId });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Course not found",
      });
    }

    if (existing.approvalStatus !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Only pending courses can be reviewed",
      });
    }

    const result = await courses.updateOne(
      { _id: courseId, approvalStatus: "pending" },
      {
        $set: {
          approvalStatus,
          isActive: approvalStatus === "approved",
          reviewedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(409).json({
        success: false,
        message: "Only pending courses can be reviewed",
      });
    }

    const course = await courses.findOne({ _id: courseId });

    return res.status(200).json({
      success: true,
      message: `Course ${approvalStatus} successfully`,
      course,
    });
  } catch (error) {
    console.error("Review Course Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to review course",
    });
  }
};
