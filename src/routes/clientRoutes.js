const express = require('express');
const { getClients, createClient, updateClient, updateClientStatus, selectPackage, generateCredentials, clientLogin, changeClientPassword, updateClientDependents, getClientProfile, submitGoogleReviewStatus, deleteClient, sendRebookLink } = require('../controllers/clientController');

const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.route('/')
  .get(authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant', 'finance', 'agent', 'case_manager']), getClients)
  .post(authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant', 'agent', 'case_manager']), createClient);

router.post('/login', clientLogin);
router.get('/profile/me', authMiddleware, getClientProfile);
router.post('/:id/credentials', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant', 'agent', 'case_manager']), generateCredentials);
router.post('/:id/send-rebook-link', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant', 'agent', 'case_manager']), sendRebookLink);
router.put('/:id/change-password', authMiddleware, changeClientPassword);
router.patch('/:id/status', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant', 'agent', 'case_manager']), updateClientStatus);
router.post('/:id/select-package', authMiddleware, selectPackage);
router.patch('/:id/dependents', authMiddleware, updateClientDependents);
router.post('/:id/google-review', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant', 'agent', 'case_manager']), submitGoogleReviewStatus);
router.put('/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant', 'agent', 'case_manager']), updateClient);
router.delete('/:id', authMiddleware, rbacMiddleware(['super_admin']), deleteClient);

module.exports = router;
