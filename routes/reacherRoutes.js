const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { requireAdmin } = require('../middlewares/adminMiddleware');
const {
    listBackends,
    createBackend,
    updateBackend,
    deleteBackend,
    testBackend,
    checkAllBackends,
} = require('../controllers/reacherController');

// Backend URLs and secrets are administrative data: login + ADMIN_EMAIL required.
router.use(protect, requireAdmin);

router.get('/', listBackends);
router.post('/', createBackend);
router.post('/check-all', checkAllBackends);
router.post('/:id/test', testBackend);
router.put('/:id', updateBackend);
router.delete('/:id', deleteBackend);

module.exports = router;
