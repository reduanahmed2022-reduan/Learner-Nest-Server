import express from 'express';
import {
  getStats,
  getUsers,
  updateUserRole,
  getTransactions,
} from '../controllers/adminController.js';
import { verifyToken, verifyAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();

// Every admin endpoint requires a valid token and an admin role.
router.use(verifyToken, verifyAdmin);

router.get('/stats', getStats);
router.get('/users', getUsers);
router.patch('/users/:id/role', updateUserRole);
router.get('/transactions', getTransactions);

export default router;
