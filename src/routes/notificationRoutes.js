const express = require('express');
const { getMyNotifications, getUnreadCount, markRead, markAllRead } = require('../controllers/notificationController');
const { authMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/my', authMiddleware, getMyNotifications);
router.get('/unread-count', authMiddleware, getUnreadCount);
router.patch('/read-all', authMiddleware, markAllRead);
router.patch('/:id/read', authMiddleware, markRead);

module.exports = router;
