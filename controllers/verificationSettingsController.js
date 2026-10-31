const VerificationSettings = require('../models/VerificationSettings');
const { getProviderBackoffStatus } = require('../utils/verificationLimiter');

function isAdmin(req) {
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    return Boolean(adminEmail && req.user && String(req.user.email || '').toLowerCase() === adminEmail);
}

const getVerificationSettings = async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ message: 'Admin access required' });
    try {
        const settings = await VerificationSettings.findOneAndUpdate(
            { key: 'global' },
            { $setOnInsert: { key: 'global' } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();
        res.json({
            globalPerSecond: settings.globalPerSecond,
            maxConcurrent: settings.maxConcurrent,
            providerPerSecond: settings.providerPerSecond,
            providerBackoff: getProviderBackoffStatus(),
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load verification settings' });
    }
};

const updateVerificationSettings = async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ message: 'Admin access required' });
    const { globalPerSecond, maxConcurrent, providerPerSecond } = req.body || {};
    const values = [globalPerSecond, maxConcurrent, providerPerSecond?.gmail, providerPerSecond?.yahoo, providerPerSecond?.microsoft, providerPerSecond?.other];
    if (values.some(value => !Number.isInteger(Number(value))) ||
        Number(globalPerSecond) < 1 || Number(globalPerSecond) > 20 ||
        Number(maxConcurrent) < 1 || Number(maxConcurrent) > 20 ||
        ['gmail', 'yahoo', 'microsoft', 'other'].some(key => Number(providerPerSecond[key]) < 1 || Number(providerPerSecond[key]) > 10)) {
        return res.status(400).json({ message: 'Use whole-number limits: global 1–20/sec, concurrency 1–20, providers 1–10/sec.' });
    }
    try {
        const settings = await VerificationSettings.findOneAndUpdate(
            { key: 'global' },
            { $set: {
                globalPerSecond: Number(globalPerSecond),
                maxConcurrent: Number(maxConcurrent),
                providerPerSecond: {
                    gmail: Number(providerPerSecond.gmail),
                    yahoo: Number(providerPerSecond.yahoo),
                    microsoft: Number(providerPerSecond.microsoft),
                    other: Number(providerPerSecond.other),
                },
                updatedBy: req.user.email,
            } },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        ).lean();
        res.json({ message: 'Verification speed settings saved', settings });
    } catch (error) {
        res.status(500).json({ message: 'Could not save verification settings' });
    }
};

module.exports = { getVerificationSettings, updateVerificationSettings };
