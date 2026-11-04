const express = require('express');
const router = express.Router();
const multer = require('multer');
const {
    verifySingleEmail,
    verifyBulkEmails,
    uploadBulkFile,
    getEngineHealth,
} = require('../controllers/verifyController');
const { protect } = require('../middlewares/authMiddleware');
const jobs = require('../controllers/jobController');

const upload = multer({ dest: 'uploads/' });

router.get('/health', protect, getEngineHealth);
router.get('/engine-status', protect, getEngineHealth);
router.post('/single', protect, verifySingleEmail);
router.post('/bulk', protect, verifyBulkEmails);
router.post('/upload-bulk', protect, upload.single('file'), uploadBulkFile);

// Server-side runs: create once, then poll — the browser is only a viewer.
router.get('/jobs', protect, jobs.listJobs);
router.post('/jobs', protect, jobs.createJob);
router.get('/jobs/:id', protect, jobs.getJob);
router.post('/jobs/:id/pause', protect, jobs.pauseJob);
router.post('/jobs/:id/resume', protect, jobs.resumeJob);
router.post('/jobs/:id/cancel', protect, jobs.cancelJob);
router.delete('/jobs/:id', protect, jobs.deleteJob);

module.exports = router;
