import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

const isText = (value) => typeof value === "string" && value.trim().length > 0;

const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Resolve the authenticated account. `userId` is the normal JWT claim, while
 * BetterAuth sessions may only expose `id` or an email.
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

/**
 * Ownership may be stale on enrollment snapshots (for example after an
 * instructor changes email). Accept both the stored email snapshot and any
 * enrollment whose course is currently owned by this instructor.
 */
async function getInstructorOwnership(db, instructorEmail) {
  const ownedCourses = await db
    .collection("courses")
    .find({ instructorEmail }, { projection: { _id: 1 } })
    .toArray();

  // courseId is stored as a string, but tolerate legacy ObjectId snapshots.
  const courseIds = ownedCourses.flatMap((course) => [
    course._id.toString(),
    course._id,
  ]);

  return [
    { instructorEmail },
    ...(courseIds.length ? [{ courseId: { $in: courseIds } }] : []),
  ];
}

// Match either storage shape of courseId without changing stored documents.
const matchCourseId = (courseId) => ({
  $or: [{ courseId }, { courseId: new ObjectId(courseId) }],
});

// Student: apply to an approved, active course.
export const createEnrollment = async (req, res) => {
  try {
    const { courseId, studentPhone, preferredSchedule, note } = req.body || {};

    if (!ObjectId.isValid(courseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid course ID",
      });
    }

    if (!isText(preferredSchedule)) {
      return res.status(400).json({
        success: false,
        message: "Preferred schedule is required",
      });
    }

    if (studentPhone !== undefined && typeof studentPhone !== "string") {
      return res.status(400).json({
        success: false,
        message: "Student phone must be a string",
      });
    }

    if (note !== undefined && typeof note !== "string") {
      return res.status(400).json({
        success: false,
        message: "Note must be a string",
      });
    }

    const db = getDB();
    const student = await getRequestUser(db, req);

    if (!student || !isText(student.email)) {
      return res.status(404).json({
        success: false,
        message: "Student account not found",
      });
    }

    const objectCourseId = new ObjectId(courseId);
    const course = await db.collection("courses").findOne({
      _id: objectCourseId,
      approvalStatus: "approved",
      isActive: true,
    });

    if (!course) {
      return res.status(404).json({
        success: false,
        message: "Approved course not found",
      });
    }

    // One enrollment per course per student.
    const duplicate = await db.collection("enrollments").findOne({
      ...matchCourseId(courseId),
      studentEmail: student.email,
    });

    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "You have already applied to this course",
      });
    }

    const enrollment = {
      // Snapshot identifiers and student details so history survives edits.
      courseId: courseId.toString(),
      courseTitle: course.title,
      instructorEmail: course.instructorEmail || "",
      instructorName: course.instructorName || "",
      studentName: student.name || "",
      studentEmail: student.email,
      studentPhone:
        typeof studentPhone === "string"
          ? studentPhone.trim()
          : student.phone || "",
      preferredSchedule: preferredSchedule.trim(),
      note: typeof note === "string" ? note.trim() : "",
      status: "pending",
      appliedAt: new Date(),
    };

    const result = await db.collection("enrollments").insertOne(enrollment);

    return res.status(201).json({
      success: true,
      message: "Enrollment request submitted successfully",
      enrollmentId: result.insertedId,
      enrollment: { _id: result.insertedId, ...enrollment },
    });
  } catch (error) {
    console.error("Create Enrollment Error:", error);

    // A unique index may also enforce the one-per-course rule.
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "You have already applied to this course",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to submit enrollment request",
    });
  }
};

// Student: all of their own enrollment requests.
export const getMyEnrollments = async (req, res) => {
  try {
    const db = getDB();
    const student = await getRequestUser(db, req);

    if (!student || !isText(student.email)) {
      return res.status(404).json({
        success: false,
        message: "Student account not found",
      });
    }

    const enrollments = await db
      .collection("enrollments")
      .find({ studentEmail: student.email })
      .sort({ appliedAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      enrollments,
      total: enrollments.length,
    });
  } catch (error) {
    console.error("Get My Enrollments Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve enrollments",
    });
  }
};

// Instructor: applicants for courses owned by this instructor.
export const getInstructorApplicants = async (req, res) => {
  try {
    const db = getDB();
    const instructor = await getRequestUser(db, req);

    if (!instructor || !isText(instructor.email)) {
      return res.status(404).json({
        success: false,
        message: "Instructor account not found",
      });
    }

    const ownership = await getInstructorOwnership(db, instructor.email);

    const applicants = await db
      .collection("enrollments")
      .find({ $or: ownership })
      .sort({ appliedAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      applicants,
      total: applicants.length,
    });
  } catch (error) {
    console.error("Get Instructor Applicants Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to retrieve applicants",
    });
  }
};

// Instructor: accept or reject a pending enrollment.
export const updateEnrollmentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid enrollment ID",
      });
    }

    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be accepted or rejected",
      });
    }

    const db = getDB();
    const instructor = await getRequestUser(db, req);

    if (!instructor || !isText(instructor.email)) {
      return res.status(404).json({
        success: false,
        message: "Instructor account not found",
      });
    }

    const ownership = await getInstructorOwnership(db, instructor.email);
    const enrollmentId = new ObjectId(id);
    const enrollments = db.collection("enrollments");

    const existing = await enrollments.findOne({
      _id: enrollmentId,
      $or: ownership,
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Enrollment not found or access denied",
      });
    }

    if (existing.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "This enrollment has already been reviewed",
      });
    }

    const result = await enrollments.updateOne(
      { _id: enrollmentId, status: "pending", $or: ownership },
      { $set: { status, reviewedAt: new Date() } }
    );

    if (result.modifiedCount === 0) {
      return res.status(409).json({
        success: false,
        message: "Enrollment status could not be updated",
      });
    }

    const enrollment = await enrollments.findOne({ _id: enrollmentId });

    return res.status(200).json({
      success: true,
      message: `Enrollment ${status} successfully`,
      status,
      enrollment,
    });
  } catch (error) {
    console.error("Update Enrollment Status Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update enrollment status",
    });
  }
};

// Student: cancel an enrollment while it is still pending.
export const deleteEnrollment = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid enrollment ID",
      });
    }

    const db = getDB();
    const student = await getRequestUser(db, req);

    if (!student || !isText(student.email)) {
      return res.status(404).json({
        success: false,
        message: "Student account not found",
      });
    }

    const enrollments = db.collection("enrollments");
    const filter = {
      _id: new ObjectId(id),
      studentEmail: student.email,
    };

    const existing = await enrollments.findOne(filter);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Enrollment not found",
      });
    }

    if (existing.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Only pending enrollments can be cancelled",
      });
    }

    await enrollments.deleteOne(filter);

    return res.status(200).json({
      success: true,
      message: "Enrollment cancelled successfully",
    });
  } catch (error) {
    console.error("Delete Enrollment Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to cancel enrollment",
    });
  }
};

// Student: restore a rejected enrollment to pending for another review.
export const restoreEnrollment = async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid enrollment ID",
      });
    }

    const db = getDB();
    const student = await getRequestUser(db, req);

    if (!student || !isText(student.email)) {
      return res.status(404).json({
        success: false,
        message: "Student account not found",
      });
    }

    const filter = {
      _id: new ObjectId(id),
      studentEmail: student.email,
    };
    const enrollments = db.collection("enrollments");
    const existing = await enrollments.findOne(filter);

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Enrollment not found",
      });
    }

    if (existing.status !== "rejected") {
      return res.status(409).json({
        success: false,
        message: "Only rejected enrollments can be restored",
      });
    }

    const restoredAt = new Date();
    const result = await enrollments.updateOne(
      { ...filter, status: "rejected" },
      {
        $set: { status: "pending", restoredAt },
        $unset: { reviewedAt: "" },
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(409).json({
        success: false,
        message: "Enrollment status could not be restored",
      });
    }

    const enrollment = await enrollments.findOne({ _id: new ObjectId(id) });

    return res.status(200).json({
      success: true,
      message: "Enrollment restored to pending",
      status: "pending",
      enrollment,
    });
  } catch (error) {
    console.error("Restore Enrollment Error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to restore enrollment",
    });
  }
};
