
const express = require('express');
const router = express.Router();
const { authUser } = require('../controllers/authController');

// Public registration disabled.
// Only existing accounts can sign in.
router.post('/login', authUser);

module.exports = router;
