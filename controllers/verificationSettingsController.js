const VerificationSettings = require('../models/VerificationSettings');
const { getProviderBackoffStatus, getLimiterUsage, invalidateSettingsCache, PROVIDERS } = require('../utils/verificationLimiter');
const { getEngineUsage } = require('../utils/verificationEngine');
const { isAdmin } = require('../middlewares/adminMiddleware');

const RANGE = {
    globalPerSecond: [1, 20],
    globalPerMinute: [0, 1200],
    globalPerDay: [0, 100000],
    maxConcurrent: [1, 20],
    providerPerSecond: [1, 10],
    providerPerMinute: [0, 600],
    providerPerDay: [0, 50000],
};

// Documents written before per-minute/per-day limits existed have no such fields,
// so reads merge these defaults instead of showing blanks or failing validation.
const FALLBACK = {
    globalPerSecond: 1,
    globalPerMinute: 60,
    globalPerDay: 5000,
    maxConcurrent: 2,
    providerPerSecond: { gmail: 1, yahoo: 1, microsoft: 1, other: 1 },
    providerPerMinute: { gmail: 30, yahoo: 30, microsoft: 30, other: 30 },
    providerPerDay: { gmail: 1000, yahoo: 1000, microsoft: 1000, other: 1000 },
};

function toInt(value) {
    const number = Number(value);
    // No truncation: 1.5 must fail the integer range check, not silently become 1.
    return Number.isFinite(number) ? number : NaN;
}

function inRange(value, [min, max]) {
    return Number.isInteger(value) && value >= min && value <= max;
}

function pickProviderGroup(source, current, range, fallback) {
    const result = {};
    for (const provider of PROVIDERS) {
        const raw = source?.[provider] ?? current?.[provider] ?? fallback?.[provider];
        const value = toInt(raw);
        if (!inRange(value, range)) return { error: `${provider} must be a whole number between ${range[0]} and ${range[1]}` };
        result[provider] = value;
    }
    return { value: result };
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
            globalPerSecond: settings.globalPerSecond ?? FALLBACK.globalPerSecond,
            globalPerMinute: settings.globalPerMinute ?? FALLBACK.globalPerMinute,
            globalPerDay: settings.globalPerDay ?? FALLBACK.globalPerDay,
            maxConcurrent: settings.maxConcurrent ?? FALLBACK.maxConcurrent,
            providerPerSecond: { ...FALLBACK.providerPerSecond, ...(settings.providerPerSecond || {}) },
            providerPerMinute: { ...FALLBACK.providerPerMinute, ...(settings.providerPerMinute || {}) },
            providerPerDay: { ...FALLBACK.providerPerDay, ...(settings.providerPerDay || {}) },
            providerBackoff: getProviderBackoffStatus(),
            usage: getLimiterUsage(),
            engineUsage: getEngineUsage(),
            updatedAt: settings.updatedAt,
            updatedBy: settings.updatedBy || '',
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load verification settings' });
    }
};

const updateVerificationSettings = async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ message: 'Admin access required' });
    const body = req.body || {};

    try {
        // Merge with what is stored so a partial payload never silently resets a limit.
        const current = await VerificationSettings.findOne({ key: 'global' }).lean();

        const scalar = {};
        for (const key of ['globalPerSecond', 'globalPerMinute', 'globalPerDay', 'maxConcurrent']) {
            const value = toInt(body[key] ?? current?.[key] ?? FALLBACK[key]);
            if (!inRange(value, RANGE[key])) {
                const [min, max] = RANGE[key];
                return res.status(400).json({ message: `${key} must be a whole number between ${min} and ${max}` });
            }
            scalar[key] = value;
        }

        const perSecond = pickProviderGroup(body.providerPerSecond, current?.providerPerSecond, RANGE.providerPerSecond, FALLBACK.providerPerSecond);
        if (perSecond.error) return res.status(400).json({ message: perSecond.error });

        const perMinute = pickProviderGroup(body.providerPerMinute, current?.providerPerMinute, RANGE.providerPerMinute, FALLBACK.providerPerMinute);
        if (perMinute.error) return res.status(400).json({ message: perMinute.error });

        const perDay = pickProviderGroup(body.providerPerDay, current?.providerPerDay, RANGE.providerPerDay, FALLBACK.providerPerDay);
        if (perDay.error) return res.status(400).json({ message: perDay.error });

        const settings = await VerificationSettings.findOneAndUpdate(
            { key: 'global' },
            {
                $set: {
                    ...scalar,
                    providerPerSecond: perSecond.value,
                    providerPerMinute: perMinute.value,
                    providerPerDay: perDay.value,
                    updatedBy: req.user.email,
                },
            },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        ).lean();

        // Rate changes take effect for the next queued check, not just after a restart.
        invalidateSettingsCache();

        res.json({ message: 'Limits saved', settings });
    } catch (error) {
        res.status(500).json({ message: 'Could not save verification settings', error: error.message });
    }
};

module.exports = { getVerificationSettings, updateVerificationSettings };
