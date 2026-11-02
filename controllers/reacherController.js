const ReacherBackend = require('../models/ReacherBackend');
const pool = require('../utils/reacherPool');
const { encryptSecret, decryptSecret, canDecrypt } = require('../utils/secretBox');

const MAX_BACKENDS = 20;

function validateUrl(raw) {
    const url = pool.normalizeUrl(raw);
    if (!url) return { error: 'URL is required (for example https://reacher.softicx.com)' };
    if (!/^https?:\/\//i.test(url)) return { error: 'URL must start with http:// or https://' };
    if (/\/\/[^/]*@/.test(url)) return { error: 'Do not put credentials inside the URL — use the secret field' };
    try {
        // Throws on malformed URLs so we never store something unroutable.
        new URL(url);
    } catch (_) {
        return { error: 'That does not look like a valid URL' };
    }
    return { url };
}

// Per-backend limits. Empty/null means "follow the global row" for that window.
// Any value makes this Reacher use its own sheet; provider rows refine the
// Overall row for that provider.
const LIMIT_PROVIDERS = ['gmail', 'yahoo', 'microsoft', 'other'];
const LIMIT_RANGES = { perSecond: [0, 50], perMinute: [0, 1000], perDay: [0, 200000] };

function isLimitSet(value) {
    return value !== null && value !== undefined;
}

function limitsAreOverridden(own = {}) {
    if (['perSecond', 'perMinute', 'perDay'].some(key => isLimitSet(own[key]))) return true;
    return LIMIT_PROVIDERS.some(name => {
        const row = own.providers && own.providers[name];
        return row && ['perSecond', 'perMinute', 'perDay'].some(key => isLimitSet(row[key]));
    });
}

function normalizeWindow(raw, key, label) {
    if (raw === undefined) return {};
    if (raw === null || raw === '') return { value: null };
    const number = Number(raw);
    const range = LIMIT_RANGES[key];
    if (!Number.isInteger(number) || number < range[0] || number > range[1]) {
        return { error: `${label}${key} must be a whole number ${range[0]}-${range[1]}, or empty to follow global` };
    }
    return { value: number };
}

function normalizeOwnLimits(input) {
    if (input === null || input === undefined) return { value: undefined };
    const value = {};
    for (const key of Object.keys(LIMIT_RANGES)) {
        const result = normalizeWindow(input[key], key, '');
        if (result.error) return result;
        if ('value' in result) value[key] = result.value;
    }
    if (input.providers && typeof input.providers === 'object') {
        value.providers = {};
        for (const name of LIMIT_PROVIDERS) {
            const source = input.providers[name];
            if (!source || typeof source !== 'object') continue;
            const row = {};
            for (const key of Object.keys(LIMIT_RANGES)) {
                const result = normalizeWindow(source[key], key, name + ' ');
                if (result.error) return result;
                if ('value' in result) row[key] = result.value;
            }
            value.providers[name] = row;
        }
    }
    return { value };
}

function limitsPayload(own = {}) {
    return {
        perSecond: own.perSecond ?? null,
        perMinute: own.perMinute ?? null,
        perDay: own.perDay ?? null,
        providers: LIMIT_PROVIDERS.reduce((out, name) => {
            const row = (own.providers && own.providers[name]) || {};
            out[name] = {
                perSecond: row.perSecond ?? null,
                perMinute: row.perMinute ?? null,
                perDay: row.perDay ?? null,
            };
            return out;
        }, {}),
    };
}

// Secrets never leave the server. The UI only learns whether one is stored.
function serialize(doc, health) {
    const lastStatus = doc.lastStatus || {};
    const own = doc.limits || {};
    return {
        id: String(doc._id),
        name: doc.name,
        url: doc.url,
        enabled: doc.enabled !== false,
        locked: doc.locked === true,
        order: doc.order || 0,
        limits: limitsPayload(own),
        limitsOverridden: limitsAreOverridden(own),
        usage: pool.getBackendUsage(String(doc._id)),
        hasSecret: Boolean(doc.secretEnc),
        secretStatus: !doc.secretEnc ? 'missing' : (canDecrypt(doc.secretEnc) ? 'ok' : 'unreadable'),
        lastStatus: {
            ok: Boolean(lastStatus.ok),
            version: lastStatus.version || '',
            latencyMs: lastStatus.latencyMs || 0,
            checkedAt: lastStatus.checkedAt || null,
            error: lastStatus.error || '',
        },
        health: health || null,
        stats: {
            checks: doc.stats?.checks || 0,
            failures: doc.stats?.failures || 0,
            lastUsedAt: doc.stats?.lastUsedAt || null,
            lastError: doc.stats?.lastError || '',
        },
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

function withCachedHealth(docs) {
    return docs.map(doc => serialize(doc, pool.cachedHealthFor(String(doc._id))));
}

const listBackends = async (req, res) => {
    try {
        const docs = await ReacherBackend.find().sort({ order: 1, createdAt: 1 }).select('+secretEnc').lean();
        const backends = withCachedHealth(docs);
        const enabledCount = backends.filter(b => b.enabled).length;
        res.json({
            count: backends.length,
            enabledCount,
            usingEnvironmentFallback: enabledCount === 0 && Boolean(process.env.REACHER_URL),
            environmentFallbackUrl: process.env.REACHER_URL || '',
            backends,
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not load Reacher backends' });
    }
};

const createBackend = async (req, res) => {
    const { name, url, secret, enabled = true, locked = false, order = 0, limits } = req.body || {};
    const trimmedName = String(name || '').trim();
    if (!trimmedName) return res.status(400).json({ message: 'Give this backend a name, for example "Reacher EU"' });

    const check = validateUrl(url);
    if (check.error) return res.status(400).json({ message: check.error });

    const ownLimits = normalizeOwnLimits(limits);
    if (ownLimits.error) return res.status(400).json({ message: ownLimits.error });

    try {
        const total = await ReacherBackend.countDocuments();
        if (total >= MAX_BACKENDS) {
            return res.status(400).json({ message: `Limit reached — ${MAX_BACKENDS} backends maximum` });
        }

        const doc = await ReacherBackend.create({
            name: trimmedName,
            url: check.url,
            secretEnc: secret ? encryptSecret(String(secret)) : '',
            enabled: enabled !== false,
            locked: locked === true,
            order: Number(order) || 0,
            ...(ownLimits.value ? { limits: ownLimits.value } : {}),
        });
        pool.invalidateCache();

        const full = await ReacherBackend.findById(doc._id).select('+secretEnc').lean();
        const health = await pool.probe({ id: String(doc._id), url: check.url, secret: String(secret || '') });
        await ReacherBackend.updateOne({ _id: doc._id }, { $set: { lastStatus: health } });

        res.status(201).json({ message: 'Backend added', backend: serialize({ ...full, lastStatus: health }, health) });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A backend with that name already exists' });
        }
        res.status(500).json({ message: 'Could not add backend', error: error.message });
    }
};

const updateBackend = async (req, res) => {
    const { name, url, secret, enabled, locked, order, clearSecret, limits, resetLimits } = req.body || {};
    try {
        const doc = await ReacherBackend.findById(req.params.id).select('+secretEnc');
        if (!doc) return res.status(404).json({ message: 'Backend not found' });

        if (name !== undefined) {
            const trimmed = String(name).trim();
            if (!trimmed) return res.status(400).json({ message: 'Name cannot be empty' });
            doc.name = trimmed;
        }
        if (url !== undefined) {
            const check = validateUrl(url);
            if (check.error) return res.status(400).json({ message: check.error });
            doc.url = check.url;
        }
        // An empty secret field means "keep the stored secret"; only send a value to replace it.
        if (clearSecret === true) {
            doc.secretEnc = '';
        } else if (secret) {
            doc.secretEnc = encryptSecret(String(secret));
        }
        if (enabled !== undefined) doc.enabled = enabled !== false;
        if (locked !== undefined) doc.locked = locked === true;
        if (order !== undefined) doc.order = Number(order) || 0;
        if (resetLimits === true) {
            doc.limits = { perSecond: null, perMinute: null, perDay: null, providers: {} };
        } else if (limits !== undefined) {
            const ownLimits = normalizeOwnLimits(limits);
            if (ownLimits.error) return res.status(400).json({ message: ownLimits.error });
            const current = limitsPayload(doc.limits);
            const next = { ...current, ...ownLimits.value };
            if (ownLimits.value.providers) {
                next.providers = { ...current.providers };
                for (const name of Object.keys(ownLimits.value.providers)) {
                    next.providers[name] = { ...(current.providers[name] || {}), ...ownLimits.value.providers[name] };
                }
            }
            doc.limits = next;
            doc.markModified('limits');
        }

        await doc.save();
        pool.invalidateCache();

        const fresh = await ReacherBackend.findById(doc._id).select('+secretEnc').lean();
        res.json({ message: 'Backend updated', backend: serialize(fresh) });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'A backend with that name already exists' });
        }
        res.status(500).json({ message: 'Could not update backend', error: error.message });
    }
};

const deleteBackend = async (req, res) => {
    try {
        const doc = await ReacherBackend.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ message: 'Backend not found' });
        pool.invalidateCache();
        res.json({ message: 'Backend removed' });
    } catch (error) {
        res.status(500).json({ message: 'Could not remove backend' });
    }
};

const testBackend = async (req, res) => {
    try {
        const doc = await ReacherBackend.findById(req.params.id).select('+secretEnc').lean();
        if (!doc) return res.status(404).json({ message: 'Backend not found' });

        // Probed directly rather than through the pool: a locked or disabled
        // backend must still be testable so it can be checked before unlocking.
        const target = {
            id: String(doc._id),
            name: doc.name,
            url: pool.normalizeUrl(doc.url),
            secret: decryptSecret(doc.secretEnc),
        };
        const health = await pool.probe(target);
        await ReacherBackend.updateOne({ _id: doc._id }, { $set: { lastStatus: health } });
        res.json({ backend: serialize({ ...doc, lastStatus: health }, health) });
    } catch (error) {
        res.status(500).json({ message: 'Could not test backend', error: error.message });
    }
};

const checkAllBackends = async (_req, res) => {
    try {
        const probed = await pool.probeAll();
        const summary = probed.map(item => ({
            id: item.id,
            name: item.name,
            url: item.url,
            ok: item.health.ok,
            version: item.health.version,
            latencyMs: item.health.latencyMs,
            error: item.health.error,
        }));
        res.json({
            healthy: summary.filter(b => b.ok).length,
            total: summary.length,
            backends: summary,
        });
    } catch (error) {
        res.status(500).json({ message: 'Could not check backends', error: error.message });
    }
};

module.exports = {
    listBackends,
    createBackend,
    updateBackend,
    deleteBackend,
    testBackend,
    checkAllBackends,
};
