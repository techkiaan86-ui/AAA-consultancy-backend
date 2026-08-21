const express = require('express');
const { 
  getCustomizationSettings, 
  updateCustomizationSettings,
  getLeadStages,
  updateLeadStages,
  getCompanySettings,
  updateCompanySettings,
  getVisaServices,
  updateVisaServices,
  getPackages,
  createPackage,
  deletePackage,
  updatePackages,
  getEmailTemplates,
  updateEmailTemplates,
  getWhatsappTemplates,
  updateWhatsappTemplates,
  getIntegrations,
  saveIntegrations,
  purgeAllData,
  purgeFinanceData
} = require('../controllers/settingsController');
const { authMiddleware } = require('../middlewares/authMiddleware');

const router = express.Router();

router.delete('/purge-all-data', authMiddleware, purgeAllData);
router.delete('/purge-finance', authMiddleware, purgeFinanceData);

router.route('/customization')
  .get(getCustomizationSettings)
  .put(authMiddleware, updateCustomizationSettings);

router.route('/lead-stages')
  .get(authMiddleware, getLeadStages)
  .put(authMiddleware, updateLeadStages);

router.route('/company')
  .get(getCompanySettings)
  .put(authMiddleware, updateCompanySettings);

router.route('/services')
  .get(authMiddleware, getVisaServices)
  .put(authMiddleware, updateVisaServices);

router.route('/packages')
  .get(authMiddleware, getPackages)
  .post(authMiddleware, createPackage)
  .put(authMiddleware, updatePackages);

router.route('/packages/:id')
  .delete(authMiddleware, deletePackage);

router.route('/templates/email')
  .get(authMiddleware, getEmailTemplates)
  .put(authMiddleware, updateEmailTemplates);

router.route('/templates/whatsapp')
  .get(authMiddleware, getWhatsappTemplates)
  .put(authMiddleware, updateWhatsappTemplates);

router.route('/integrations')
  .get(authMiddleware, getIntegrations)
  .put(authMiddleware, saveIntegrations)
  .post(authMiddleware, saveIntegrations);

module.exports = router;
