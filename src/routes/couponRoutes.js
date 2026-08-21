const express = require('express');
const { 
  createCoupon, 
  getCoupons, 
  deactivateCoupon, 
  validateCoupon,
  deleteCoupon 
} = require('../controllers/couponController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

// Public / Client Coupon Validation
router.post('/validate', validateCoupon);

// Super Admin Coupon Management
router.post('/', authMiddleware, rbacMiddleware(['super_admin']), createCoupon);
router.get('/', authMiddleware, rbacMiddleware(['super_admin', 'admin']), getCoupons);
router.delete('/:id', authMiddleware, rbacMiddleware(['super_admin']), deactivateCoupon);
router.delete('/:id/permanent', authMiddleware, rbacMiddleware(['super_admin']), deleteCoupon);
router.patch('/:id/deactivate', authMiddleware, rbacMiddleware(['super_admin']), deactivateCoupon);

module.exports = router;
