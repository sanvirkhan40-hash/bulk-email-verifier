const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
    getVerificationSettings,
    updateVerificationSettings,
} = require('../controllers/verificationSettingsController');

router.use(protect);
router.get('/', getVerificationSettings);
router.put('/', updateVerificationSettings);

module.exports = router;
