const express = require('express');
const { getMarketingSpend, updateMarketingSpend } = require('../controllers/marketingController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

// Only Super Admin should update spend
router.route('/spend')
  .get(authMiddleware, getMarketingSpend)
  .post(authMiddleware, rbacMiddleware(['super_admin']), updateMarketingSpend);

module.exports = router;
