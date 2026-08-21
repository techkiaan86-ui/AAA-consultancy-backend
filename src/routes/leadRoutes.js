const express = require('express');
const { 
  getLeads, 
  createLead, 
  assignLead, 
  updateLeadStatus, 
  deleteLead,
  getLeadById, 
  updateLead, 
  getPublicLeadDetails, 
  updateMeetingPreference 
} = require('../controllers/leadController');
const { authMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.route('/')
  .get(authMiddleware, getLeads)
  .post(createLead); // Webhook/Form doesn't need auth

// Public route — no auth needed — for self-fill form
router.get('/:id/public-details', getPublicLeadDetails);

router.route('/:id')
  .get(authMiddleware, getLeadById)
  .put(authMiddleware, updateLead)
  .patch(authMiddleware, updateLead)
  .delete(authMiddleware, deleteLead);

// Public route — no auth — lead submits meeting preference form
router.patch('/:id/meeting-preference', updateMeetingPreference);

router.post('/assign', authMiddleware, assignLead);
router.post('/status', authMiddleware, updateLeadStatus);

module.exports = router;

