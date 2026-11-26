import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';

const VALID_ROLES = ['student', 'instructor', 'admin'];

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// verifyToken may expose the id as userId, id or _id depending on middleware.
function authUserId(req) {
  const source = req.user || req.auth || {};
  if (typeof source === 'string') return source;
  return source.userId || source.id || source._id || req.userId || null;
}

function paginationFrom(query) {
  const page = Math.max(parseInt(query?.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query?.limit, 10) || 50, 1), 200);
  return { page, limit };
}

export const getStats = async (req, res) => {
  try {
    const db = getDB();
    const users = db.collection('users');
    const courses = db.collection('courses');
    const enrollments = db.collection('enrollments');
    const payments = db.collection('payments');

    // Accept the common status flag shapes used by course/enrollment documents.
    const pendingCourseFilter = {
      $or: [
        { status: 'pending' },
        { approvalStatus: 'pending' },
        { approved: false },
        { isApproved: false },
      ],
    };
    const approvedCourseFilter = {
      $or: [
        { status: 'approved' },
        { approvalStatus: 'approved' },
        { approved: true },
        { isApproved: true },
      ],
    };
    const acceptedEnrollmentFilter = {
      $or: [
        { status: 'accepted' },
        { status: 'approved' },
        { status: 'enrolled' },
        { approved: true },
      ],
    };
    const pendingEnrollmentFilter = {
      $or: [{ status: 'pending' }, { approved: false }],
    };

    const [
      totalUsers,
      totalInstructors,
      totalStudents,
      pendingCourses,
      approvedCourses,
      totalEnrollments,
      acceptedEnrollments,
      pendingEnrollments,
      revenue,
    ] = await Promise.all([
      users.countDocuments({}),
      users.countDocuments({ role: 'instructor' }),
      users.countDocuments({ role: 'student' }),
      courses.countDocuments(pendingCourseFilter),
      courses.countDocuments(approvedCourseFilter),
      enrollments.countDocuments({}),
      enrollments.countDocuments(acceptedEnrollmentFilter),
      enrollments.countDocuments(pendingEnrollmentFilter),
      payments
        .aggregate([
          {
            $group: {
              _id: null,
              total: { $sum: { $ifNull: ['$amount', '$amountTotal', '$total', 0] } },
            },
          },
        ])
        .toArray(),
    ]);

    return res.json({
      success: true,
      stats: {
        totalUsers,
        totalInstructors,
        totalStudents,
        pendingCourses,
        approvedCourses,
        totalEnrollments,
        totalRevenue: revenue[0]?.total || 0,
        acceptedEnrollments,
        pendingEnrollments,
      },
    });
  } catch (error) {
    console.error('admin getStats error:', error);
    return fail(res, 500, 'Server error');
  }
};

export const getUsers = async (req, res) => {
  try {
    const query = req.query || {};
    const filter = {};

    if (typeof query.role === 'string' && VALID_ROLES.includes(query.role)) {
      filter.role = query.role;
    }
    if (typeof query.search === 'string' && query.search.trim()) {
      const pattern = new RegExp(escapeRegex(query.search.trim()), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }];
    }

    const { page, limit } = paginationFrom(query);
    const users = getDB().collection('users');

    const total = await users.countDocuments(filter);
    const userList = await users
      .find(filter, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    return res.json({ success: true, total, users: userList });
  } catch (error) {
    console.error('admin getUsers error:', error);
    return fail(res, 500, 'Server error');
  }
};

export const updateUserRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body || {};

    if (!id || !ObjectId.isValid(String(id))) {
      return fail(res, 400, 'Invalid user id');
    }
    if (!VALID_ROLES.includes(role)) {
      return fail(res, 400, 'Role must be student, instructor or admin');
    }

    const users = getDB().collection('users');
    const objectId = new ObjectId(String(id));
    const target = await users.findOne({ _id: objectId });

    if (!target) {
      return fail(res, 404, 'User not found');
    }

    const actorId = authUserId(req);
    if (actorId && String(actorId) === String(target._id) && role !== 'admin') {
      return fail(res, 403, 'You cannot change your own role');
    }

    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = await users.countDocuments({ role: 'admin' });
      if (adminCount <= 1) {
        return fail(res, 403, 'Cannot remove the last administrator');
      }
    }

    const result = await users.findOneAndUpdate(
      { _id: objectId },
      { $set: { role } },
      { returnDocument: 'after', projection: { password: 0 } }
    );
    // Driver 6+ returns the document directly; older drivers wrap it in `value`.
    const updated = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;

    if (!updated) {
      return fail(res, 404, 'User not found');
    }

    return res.json({
      success: true,
      message: `User role updated to ${role}`,
      user: {
        _id: updated._id,
        id: String(updated._id),
        name: updated.name,
        email: updated.email,
        role: updated.role,
      },
    });
  } catch (error) {
    console.error('admin updateUserRole error:', error);
    return fail(res, 500, 'Server error');
  }
};

export const getTransactions = async (req, res) => {
  try {
    const query = req.query || {};
    const filter = {};

    if (typeof query.status === 'string' && query.status.trim()) {
      filter.status = query.status.trim();
    }
    if (typeof query.search === 'string' && query.search.trim()) {
      const pattern = new RegExp(escapeRegex(query.search.trim()), 'i');
      filter.$or = [
        { email: pattern },
        { transactionId: pattern },
        { paymentIntentId: pattern },
        { userId: pattern },
      ];
    }

    const { page, limit } = paginationFrom(query);
    const payments = getDB().collection('payments');

    const total = await payments.countDocuments(filter);
    const transactions = await payments
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    return res.json({ success: true, total, transactions });
  } catch (error) {
    console.error('admin getTransactions error:', error);
    return fail(res, 500, 'Server error');
  }
};

// Aliases for callers that use shorter handler names.
export const stats = getStats;
export const listUsers = getUsers;
export const patchUserRole = updateUserRole;
export const transactions = getTransactions;

export default {
  getStats,
  getUsers,
  updateUserRole,
  getTransactions,
  stats,
  listUsers,
  patchUserRole,
  transactions,
};
