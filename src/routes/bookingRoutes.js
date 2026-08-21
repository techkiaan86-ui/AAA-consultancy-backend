const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { rateLimit } = require('express-rate-limit');

const upload = require('../middlewares/uploadMiddleware');

// DDoS Protection
const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per `window`
  message: 'Too many booking requests from this IP, please try again after 15 minutes',
});

// Eligibility Booking
router.post('/eligibility', bookingLimiter, bookingController.createEligibilityBooking);
router.get('/prefill', bookingController.verifyPrefillToken);

// Reschedule Endpoints
router.get('/reschedule/:token', bookingController.getRescheduleDetails);
router.patch('/reschedule/:token', bookingController.rescheduleBooking);
router.post('/reschedule/:token', bookingController.rescheduleBooking);

// Cancel Endpoints
router.post('/cancel/:token', bookingController.cancelBooking);
router.patch('/cancel/:token', bookingController.cancelBooking);

// Translation Endpoints (Disk / S3 Storage - Supports Multiple Documents)
router.post('/translation/upload', upload.any(), bookingController.uploadTranslationDocument);
router.post('/translation/checkout', upload.any(), bookingController.checkoutTranslationDocument);

module.exports = router;
