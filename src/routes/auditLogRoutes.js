const express = require('express');
const router = express.Router();
const { getCaseTimeline } = require('../controllers/auditLogController');
const { authMiddleware } = require('../middlewares/authMiddleware');

router.get('/timeline', authMiddleware, getCaseTimeline);

module.exports = router;
