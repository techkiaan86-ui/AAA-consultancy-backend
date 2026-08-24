const express = require('express');
const { getDocuments, uploadDocument, uploadBatchDocuments, reviewDocument, uploadTranslatedDocument, deleteDocument } = require('../controllers/documentController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');

const router = express.Router();

router.route('/')
  .get(authMiddleware, getDocuments);

router.post('/upload', authMiddleware, upload.any(), uploadDocument);
router.post('/upload-batch', authMiddleware, upload.array('files', 20), uploadBatchDocuments);

router.patch('/:id/verify', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), reviewDocument);
router.patch('/:id/translated', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'consultant']), upload.any(), uploadTranslatedDocument);
router.delete('/:id', authMiddleware, deleteDocument);

module.exports = router;
