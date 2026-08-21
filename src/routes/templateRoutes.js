const express = require('express');
const router = express.Router();
const templateController = require('../controllers/templateController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

// Get active templates for chat inbox & UI
router.get('/', templateController.getTemplates);

// Admin Template Management Routes
router.get('/all', authMiddleware, rbacMiddleware(['super_admin', 'admin']), templateController.getAllTemplatesAdmin);
router.get('/check-status/:id', authMiddleware, templateController.checkApprovalStatus);
router.post('/', authMiddleware, rbacMiddleware(['super_admin', 'admin']), templateController.createTemplate);
router.put('/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin']), templateController.updateTemplate);
router.delete('/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin']), templateController.deleteTemplate);

module.exports = router;
