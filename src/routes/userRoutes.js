const express = require('express');
const { getAgents, createUser, updateUser, deleteUser, resetUserPassword, updateSuperAdminProfile } = require('../controllers/userController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.put('/profile/super-admin', authMiddleware, rbacMiddleware(['super_admin']), updateSuperAdminProfile);

router.route('/')
  .post(authMiddleware, rbacMiddleware(['super_admin', 'admin']), createUser);

router.route('/agents')
  .get(authMiddleware, getAgents);

router.route('/:id')
  .put(authMiddleware, rbacMiddleware(['super_admin', 'admin']), updateUser)
  .delete(authMiddleware, rbacMiddleware(['super_admin', 'admin']), deleteUser);

router.route('/:id/password')
  .put(authMiddleware, rbacMiddleware(['super_admin', 'admin']), resetUserPassword);

module.exports = router;
