
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { isDbReady } = require('../config/db');
const mongoose = require('mongoose');

const generateToken = (id) => {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is not configured');
    }

    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d'
    });
};

// @desc    Authenticate existing user
// @route   POST /api/auth/login
// @access  Public
const authUser = async (req, res) => {
    const { email, password } = req.body;

    if (!isDbReady() || mongoose.connection.readyState !== 1) {
        return res.status(503).json({
            message: 'Database still starting — wait a few seconds and try again.',
        });
    }

    try {
        const user = await User.findOne({ email });

        if (user && (await user.matchPassword(password))) {
            return res.json({
                _id: user._id,
                name: user.name,
                email: user.email,
                token: generateToken(user._id)
            });
        }

        return res.status(401).json({
            message: 'Invalid email or password'
        });
    } catch (error) {
        return res.status(500).json({
            message: 'Login failed. Please try again.'
        });
    }
};

module.exports = { authUser };
