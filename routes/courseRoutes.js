import express from "express";

import {
  getAllCourses,
  getCourseById,
  createCourse,
  getMyCourses,
  updateCourse,
  toggleCourseStatus,
  deleteCourse,
  getPendingCourses,
  reviewCourse,
} from "../controllers/courseController.js";

import {
  verifyToken,
  verifyInstructor,
  verifyAdmin,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// Public: browse approved, active courses.
router.get("/", getAllCourses);

// Instructor: create a course (pending admin approval).
router.post("/", verifyToken, verifyInstructor, createCourse);

// Static routes MUST be registered before "/:id" or they get shadowed.
router.get("/my-courses", verifyToken, verifyInstructor, getMyCourses);
router.get("/admin/pending", verifyToken, verifyAdmin, getPendingCourses);
router.patch("/admin/review/:id", verifyToken, verifyAdmin, reviewCourse);

// Public: single course, kept after the static GET routes.
router.get("/:id", getCourseById);

// Instructor: manage only courses owned by their email.
router.patch("/:id", verifyToken, verifyInstructor, updateCourse);
router.patch("/:id/status", verifyToken, verifyInstructor, toggleCourseStatus);
router.delete("/:id", verifyToken, verifyInstructor, deleteCourse);

export { router as courseRoutes };
export default router;
