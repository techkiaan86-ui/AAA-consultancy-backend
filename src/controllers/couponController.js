const prisma = require('../config/db');

/**
 * Super Admin: Create a new percentage-based coupon valid for 24 hours
 */
const createCoupon = async (req, res) => {
  try {
    const { code, discountPercent } = req.body;

    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ success: false, message: 'Coupon code is required.' });
    }

    const cleanCode = code.trim().toUpperCase();

    // Enforce strict alphanumeric and hyphen characters only
    if (!/^[A-Z0-9_-]+$/.test(cleanCode)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Coupon code must contain only letters, numbers, hyphens, or underscores.' 
      });
    }

    const percent = Number(discountPercent);
    if (isNaN(percent) || !isFinite(percent) || percent <= 0 || percent >= 100) {
      return res.status(400).json({ 
        success: false, 
        message: 'Discount percentage must be a number strictly greater than 0 and less than 100.' 
      });
    }

    // Server-side calculation of 24-hour expiration
    const now = new Date();
    const expiryDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Check if code already exists in database
    const existing = await prisma.discountCode.findUnique({
      where: { code: cleanCode }
    });

    if (existing) {
      const isExpired = now >= new Date(existing.expiryDate);

      // If existing coupon is still ACTIVE (not used and not expired), prevent duplicate creation
      if (!existing.isUsed && !isExpired) {
        return res.status(400).json({ 
          success: false, 
          message: `Coupon code "${cleanCode}" is already active and valid until ${new Date(existing.expiryDate).toLocaleString()}.` 
        });
      }

      // If existing coupon is EXPIRED or already USED, regenerate it with fresh 24h validity
      const updatedCoupon = await prisma.discountCode.update({
        where: { id: existing.id },
        data: {
          discountPercent: percent,
          expiryDate: expiryDate,
          isUsed: false,
          usedAt: null,
          usedByClientId: null,
          usedInPaymentId: null,
          clientId: null,
          createdById: req.user?.id || null,
          createdAt: now,
          updatedAt: now
        },
        include: {
          creator: {
            select: { id: true, fullName: true, email: true }
          }
        }
      });

      return res.status(200).json({
        success: true,
        message: `Coupon code "${cleanCode}" has been regenerated with a fresh 24-hour validity!`,
        coupon: {
          ...updatedCoupon,
          status: 'ACTIVE'
        }
      });
    }

    const coupon = await prisma.discountCode.create({
      data: {
        code: cleanCode,
        discountPercent: percent,
        expiryDate: expiryDate,
        isUsed: false,
        createdById: req.user?.id || null
      },
      include: {
        creator: {
          select: { id: true, fullName: true, email: true }
        }
      }
    });

    return res.status(201).json({
      success: true,
      message: 'Coupon created successfully.',
      coupon: {
        ...coupon,
        status: 'ACTIVE'
      }
    });
  } catch (error) {
    console.error('[createCoupon Error]:', error);
    return res.status(500).json({ success: false, message: 'Server error creating coupon.', error: error.message });
  }
};

/**
 * Super Admin / Admin: List all coupons with calculated statuses
 */
const getCoupons = async (req, res) => {
  try {
    const coupons = await prisma.discountCode.findMany({
      include: {
        creator: {
          select: { id: true, fullName: true, email: true }
        },
        client: {
          select: { id: true, clientCode: true, firstName: true, lastName: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const now = new Date();
    const mapped = coupons.map(c => {
      let status = 'ACTIVE';
      if (c.isUsed) {
        status = 'USED';
      } else if (now >= new Date(c.expiryDate)) {
        status = 'EXPIRED';
      }

      return {
        id: c.id,
        code: c.code,
        discountPercent: c.discountPercent,
        createdAt: c.createdAt,
        expiryDate: c.expiryDate,
        isUsed: c.isUsed,
        usedAt: c.usedAt,
        usedByClientId: c.usedByClientId || c.clientId,
        usedInPaymentId: c.usedInPaymentId,
        createdById: c.createdById,
        creatorName: c.creator ? c.creator.fullName : 'System',
        clientName: c.client ? `${c.client.firstName} ${c.client.lastName}` : null,
        clientCode: c.client?.clientCode || null,
        status
      };
    });

    return res.status(200).json(mapped);
  } catch (error) {
    console.error('[getCoupons Error]:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching coupons.', error: error.message });
  }
};

/**
 * Super Admin: Deactivate a coupon manually
 */
const deactivateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.discountCode.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Coupon not found.' });
    }

    const updated = await prisma.discountCode.update({
      where: { id },
      data: {
        expiryDate: new Date() // Force expiration
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Coupon deactivated successfully.',
      coupon: updated
    });
  } catch (error) {
    console.error('[deactivateCoupon Error]:', error);
    return res.status(500).json({ success: false, message: 'Server error deactivating coupon.' });
  }
};

/**
 * Public / Client Portal: Validate a coupon code and calculate discounted pricing preview
 */
const validateCoupon = async (req, res) => {
  try {
    const { code, amount } = req.body;

    if (!code || typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ success: false, valid: false, message: 'Please enter a coupon code.' });
    }

    const cleanCode = code.trim().toUpperCase();

    const coupon = await prisma.discountCode.findUnique({
      where: { code: cleanCode }
    });

    if (!coupon) {
      return res.status(404).json({ success: false, valid: false, message: 'Invalid coupon code.' });
    }

    if (coupon.isUsed) {
      return res.status(400).json({ success: false, valid: false, message: 'This coupon has already been used.' });
    }

    const now = new Date();
    if (now >= new Date(coupon.expiryDate)) {
      return res.status(400).json({ success: false, valid: false, message: 'This coupon has expired.' });
    }

    const baseAmount = Number(amount) || 0;
    const discountPercent = coupon.discountPercent || 0;
    const discountAmount = Math.round((baseAmount * (discountPercent / 100)) * 100) / 100;
    const netAmount = Math.max(0, Math.round((baseAmount - discountAmount) * 100) / 100);

    // Fetch company settings for VAT rate (default 5%)
    let vatRate = 5;
    try {
      const settings = await prisma.companySetting.findFirst();
      if (settings && typeof settings.vatRate === 'number') {
        vatRate = settings.vatRate;
      }
    } catch (sErr) {
      console.warn('[validateCoupon] Settings lookup fallback to 5%:', sErr.message);
    }

    const vatAmount = Math.round((netAmount * (vatRate / 100)) * 100) / 100;
    const finalTotal = Math.round((netAmount + vatAmount) * 100) / 100;

    return res.status(200).json({
      success: true,
      valid: true,
      couponId: coupon.id,
      code: coupon.code,
      discountPercent: coupon.discountPercent,
      originalAmount: baseAmount,
      discountAmount,
      netAmount,
      vatRate,
      vatAmount,
      finalTotal,
      expiryDate: coupon.expiryDate,
      message: `Coupon ${coupon.code} applied! (${coupon.discountPercent}% discount)`
    });
  } catch (error) {
    console.error('[validateCoupon Error]:', error);
    return res.status(500).json({ success: false, valid: false, message: 'Server error validating coupon.' });
  }
};

/**
 * Super Admin: Permanently delete a coupon
 */
const deleteCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.discountCode.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Coupon not found.' });
    }

    await prisma.discountCode.delete({ where: { id } });

    return res.status(200).json({
      success: true,
      message: 'Coupon deleted successfully.'
    });
  } catch (error) {
    console.error('[deleteCoupon Error]:', error);
    return res.status(500).json({ success: false, message: 'Server error deleting coupon.' });
  }
};

module.exports = {
  createCoupon,
  getCoupons,
  deactivateCoupon,
  validateCoupon,
  deleteCoupon
};
