const express = require('express');
const { getCommunications, createCommunicationLog } = require('../controllers/communicationController');
const { authMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/', authMiddleware, getCommunications);
router.post('/', authMiddleware, createCommunicationLog);

module.exports = router;
