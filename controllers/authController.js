import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { getDB } from '../config/db.js';

const SALT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ALLOWED_ROLES = ['student', 'instructor'];

function fail(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function getSecret() {
  return process.env.JWT_SECRET || 'learnnest-dev-secret-change-me';
}

function getExpiresIn() {
  return process.env.JWT_EXPIRES_IN || '7d';
}

function signToken(user) {
  return jwt.sign(
    { userId: String(user._id), role: user.role },
    getSecret(),
    { expiresIn: getExpiresIn() }
  );
}

// Shape used by register/login responses.
function toPublicUser(user) {
  return {
    id: String(user._id),
    name: user.name || '',
    email: user.email || '',
    role: user.role || 'student',
    plan: user.plan || 'free',
    image: user.image || user.profileImage || '',
  };
}

// Shape used by /me endpoints (includes editable profile fields).
function toMeUser(user) {
  return {
    ...toPublicUser(user),
    phone: user.phone || '',
    bio: user.bio || '',
  };
}

// verifyToken may expose the id as userId, id or _id depending on middleware.
function authUserId(req) {
  const source = req.user || req.auth || {};
  if (typeof source === 'string') return source;
  return source.userId || source.id || source._id || req.userId || null;
}

export const register = async (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};

    if (typeof name !== 'string' || !name.trim()) {
      return fail(res, 400, 'Name is required and must be a string');
    }
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return fail(res, 400, 'A valid email address is required');
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return fail(res, 400, 'Password must be between 8 and 128 characters');
    }

    // Role defaults to student when omitted.
    const normalizedRole = role === undefined || role === null || role === '' ? 'student' : role;
    if (!ALLOWED_ROLES.includes(normalizedRole)) {
      return fail(res, 400, 'Role must be either student or instructor');
    }

    const users = getDB().collection('users');
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await users.findOne({ email: normalizedEmail });
    if (existing) {
      return fail(res, 409, 'An account with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const newUser = {
      name: name.trim(),
      email: normalizedEmail,
      password: passwordHash,
      role: normalizedRole,
      plan: 'free',
      image: '',
      phone: '',
      bio: '',
      createdAt: new Date(),
    };

    let insertedId;
    try {
      const result = await users.insertOne(newUser);
      insertedId = result.insertedId;
    } catch (error) {
      // Guard against a unique index race condition.
      if (error && error.code === 11000) {
        return fail(res, 409, 'An account with this email already exists');
      }
      throw error;
    }

    const user = { ...newUser, _id: insertedId };
    return res.status(201).json({
      success: true,
      token: signToken(user),
      user: toPublicUser(user),
    });
  } catch (error) {
    console.error('auth register error:', error);
    return fail(res, 500, 'Server error');
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return fail(res, 400, 'Email and password are required');
    }

    const users = getDB().collection('users');
    const user = await users.findOne({ email: email.trim().toLowerCase() });

    if (!user || typeof user.password !== 'string') {
      return fail(res, 401, 'Invalid email or password');
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return fail(res, 401, 'Invalid email or password');
    }

    return res.json({
      success: true,
      token: signToken(user),
      user: toPublicUser(user),
    });
  } catch (error) {
    console.error('auth login error:', error);
    return fail(res, 500, 'Server error');
  }
};

export const getMe = async (req, res) => {
  try {
    const id = authUserId(req);
    if (!id || !ObjectId.isValid(String(id))) {
      return fail(res, 401, 'Unauthorized');
    }

    const user = await getDB()
      .collection('users')
      .findOne({ _id: new ObjectId(String(id)) }, { projection: { password: 0 } });

    if (!user) {
      return fail(res, 404, 'User not found');
    }

    return res.json({ success: true, user: toMeUser(user) });
  } catch (error) {
    console.error('auth getMe error:', error);
    return fail(res, 500, 'Server error');
  }
};

export const updateMe = async (req, res) => {
  try {
    const id = authUserId(req);
    if (!id || !ObjectId.isValid(String(id))) {
      return fail(res, 401, 'Unauthorized');
    }

    const body = req.body || {};
    const allowedFields = ['name', 'phone', 'bio', 'image'];
    const update = {};

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        if (typeof body[field] !== 'string') {
          return fail(res, 400, `${field} must be a string`);
        }
        update[field] = body[field].trim();
      }
    }

    if (Object.prototype.hasOwnProperty.call(update, 'name') && !update.name) {
      return fail(res, 400, 'Name cannot be empty');
    }

    const users = getDB().collection('users');
    let user = null;

    if (Object.keys(update).length > 0) {
      const result = await users.findOneAndUpdate(
        { _id: new ObjectId(String(id)) },
        { $set: update },
        { returnDocument: 'after', projection: { password: 0 } }
      );
      // Driver 6+ returns the document directly; older drivers wrap it in `value`.
      user = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
    } else {
      user = await users.findOne(
        { _id: new ObjectId(String(id)) },
        { projection: { password: 0 } }
      );
    }

    if (!user) {
      return fail(res, 404, 'User not found');
    }

    return res.json({ success: true, user: toMeUser(user) });
  } catch (error) {
    console.error('auth updateMe error:', error);
    return fail(res, 500, 'Server error');
  }
};

// Google OAuth is handled by BetterAuth on other routes; expose a legacy stub.
export const googleStatus = (req, res) => {
  return res.json({ success: true, enabled: false, provider: 'google' });
};

export const googleStart = (req, res) => {
  const clientUrl = (process.env.CLIENT_URL || 'http://localhost:3000')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
  return res.redirect(`${clientUrl}/login`);
};

// Aliases for callers that use longer handler names.
export const registerUser = register;
export const loginUser = login;
export const getCurrentUser = getMe;
export const updateCurrentUser = updateMe;

export default {
  register,
  login,
  getMe,
  updateMe,
  googleStatus,
  googleStart,
  registerUser,
  loginUser,
  getCurrentUser,
  updateCurrentUser,
};
