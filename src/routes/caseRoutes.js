const express = require('express');
const {
  getActiveCases,
  getClosedCases,
  getCyclesByClient,
  createCycle,
  updateCycle,
  getCycleChecklist,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  uploadChecklistDoc,
  reviewChecklistDoc,
  resubmitCycle,
  recordGovernmentDecision,
  generateDefaultChecklist
} = require('../controllers/caseController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');

const router = express.Router();

// Case list endpoints
router.get('/active', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance']), getActiveCases);
router.get('/closed', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance']), getClosedCases);

// Cycle Creation
router.post('/cycles', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), createCycle);

// Specific Cycle Action Sub-routes (Placed BEFORE generic GET /cycles/:clientId to prevent route parameter shadowing)
router.get('/cycles/:cycleId/checklist', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance', 'client']), getCycleChecklist);
router.get('/cycles/:id/checklist', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance', 'client']), getCycleChecklist);

router.post('/cycles/:id/generate-checklist', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), generateDefaultChecklist);
router.post('/cycles/:cycleId/generate-checklist', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), generateDefaultChecklist);

router.post('/cycles/:id/resubmit', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), resubmitCycle);
router.post('/cycles/:cycleId/resubmit', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), resubmitCycle);

router.post('/cycles/:id/government-decision', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations']), recordGovernmentDecision);
router.post('/cycles/:cycleId/government-decision', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations']), recordGovernmentDecision);

router.patch('/cycles/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), updateCycle);
router.patch('/cycles/:cycleId', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), updateCycle);

// Generic Client Cycles Lookup (Placed AFTER specific sub-routes)
router.get('/cycles/:clientId', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'operations', 'finance', 'client']), getCyclesByClient);

// Checklist Item Management Endpoints
router.post('/checklists/item', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), addChecklistItem);
router.patch('/checklists/item/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), updateChecklistItem);
router.delete('/checklists/item/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant']), deleteChecklistItem);

// Checklist Upload & Operations Review Endpoints
router.post('/checklists/item/:id/upload', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'consultant', 'client']), upload.single('file'), uploadChecklistDoc);
router.patch('/documents/:documentId/review', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations']), reviewChecklistDoc);

module.exports = router;
