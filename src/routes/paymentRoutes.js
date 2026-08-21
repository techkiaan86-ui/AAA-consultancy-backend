const express = require('express');
const { 
  getPayments, 
  generatePaymentLink, 
  updatePaymentStatus,
  getRefundRequests,
  createRefundRequest,
  updateRefundStatus,
  getCommissionRates,
  updateCommissionRate,
  getCommissionsReport,
  createStripeCheckoutSession,
  verifyStripeCheckoutSession,
  getCommissionHistory,
  getClientPackages,
  createPackageCheckout,
  getPaymentBySessionId,
  getRevenueAnalytics
} = require('../controllers/paymentController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/revenue-analytics', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'finance', 'operations', 'consultant']), getRevenueAnalytics);

router.route('/')
  .get(authMiddleware, rbacMiddleware(['super_admin', 'admin', 'finance', 'operations', 'consultant', 'marketing', 'agent', 'case_manager', 'client']), getPayments);

router.post('/generate-link', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'finance', 'operations', 'consultant']), generatePaymentLink);
router.patch('/:id/status', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'finance']), updatePaymentStatus);
router.post('/create-checkout-session', authMiddleware, createStripeCheckoutSession);
router.post('/verify-checkout-session', verifyStripeCheckoutSession);

// Residency Packages Select & Invoicing
router.get('/packages', authMiddleware, getClientPackages);
router.post('/package-checkout', authMiddleware, createPackageCheckout);
router.get('/session/:sessionId', authMiddleware, getPaymentBySessionId);

// Refunds
router.get('/refunds', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'finance', 'consultant', 'agent', 'case_manager', 'client']), getRefundRequests);
router.post('/refunds', authMiddleware, createRefundRequest);
router.patch('/refunds/:id/status', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'finance']), updateRefundStatus);

// Commissions
router.get('/commissions/rates', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'finance', 'operations', 'consultant']), getCommissionRates);
router.patch('/commissions/rates', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'finance']), updateCommissionRate);
router.get('/commissions/report', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'finance', 'consultant']), getCommissionsReport);
router.get('/commissions/history/:agentId', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'finance', 'operations', 'consultant']), getCommissionHistory);

router.get('/zoho-pdf/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const cleanInvoiceId = invoiceId.replace(/\.pdf$/, '');
    const zohoInvoiceService = require('../services/zohoInvoiceService');
    const pdfBuffer = await zohoInvoiceService.getZohoInvoicePdfBuffer(cleanInvoiceId);

    if (!pdfBuffer) {
      return res.status(404).send('Invoice PDF not found');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="AAA_Tax_Invoice_${cleanInvoiceId}.pdf"`);
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('Error streaming Zoho PDF:', err.message);
    res.status(500).send('Error generating invoice PDF');
  }
});

module.exports = router;
