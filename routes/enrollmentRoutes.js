import express from "express";

import {
  createEnrollment,
  getMyEnrollments,
  getInstructorApplicants,
  updateEnrollmentStatus,
  deleteEnrollment,
  restoreEnrollment,
} from "../controllers/enrollmentController.js";

import {
  verifyToken,
  verifyStudent,
  verifyInstructor,
} from "../middleware/authMiddleware.js";

const router = express.Router();

// Student: submit an enrollment request.
router.post("/", verifyToken, verifyStudent, createEnrollment);

// Static routes before any "/:id" route.
router.get("/my-enrollments", verifyToken, verifyStudent, getMyEnrollments);
router.get(
  "/instructor-applicants",
  verifyToken,
  verifyInstructor,
  getInstructorApplicants
);

// Instructor: review an applicant for one of their courses.
router.patch("/:id/status", verifyToken, verifyInstructor, updateEnrollmentStatus);

// Student: cancel a pending enrollment, or restore a rejected one.
router.delete("/:id", verifyToken, verifyStudent, deleteEnrollment);
router.patch("/:id/restore", verifyToken, verifyStudent, restoreEnrollment);

export { router as enrollmentRoutes };
export default router;
