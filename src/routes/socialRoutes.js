const express = require('express');
const router = express.Router();
const socialController = require('../controllers/socialController');
const { authMiddleware, rbacMiddleware } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/uploadMiddleware');

router.get('/conversations', authMiddleware, socialController.getConversations);
router.get('/messages/:phone', authMiddleware, socialController.getMessagesByPhone);
router.post('/messages/send', authMiddleware, socialController.sendSocialMessage);
router.post('/upload-media', authMiddleware, upload.single('file'), socialController.uploadMedia);
router.get('/media-proxy', socialController.proxyTwilioMedia);

// Delete Routes (Super Admin, Admin & Operations)
router.delete('/messages/:id', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations']), socialController.deleteMessage);
router.delete('/conversations/:phone', authMiddleware, rbacMiddleware(['super_admin', 'admin', 'operations', 'agent']), socialController.clearChat);

module.exports = router;
