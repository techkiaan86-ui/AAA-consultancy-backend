const express = require('express');
const { login, getMe } = require('../controllers/authController');
const { authMiddleware } = require('../middlewares/authMiddleware');
const { rateLimit } = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Reasonable limit per IP
  message: { message: 'Too many login attempts from this IP, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = express.Router();

router.post('/login', loginLimiter, login);
router.get('/me', authMiddleware, getMe);

module.exports = router;
