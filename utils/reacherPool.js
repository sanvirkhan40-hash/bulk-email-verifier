const axios = require('axios');
const ReacherBackend = require('../models/ReacherBackend');
const { decryptSecret, canDecrypt } = require('./secretBox');
const { providerFor } = require('./verificationLimiter');

const CACHE_MS = 15000;
const PROBE_TIMEOUT_MS = 4000;
const DEFAULT_MAX_WAIT_MS = 60000;
const PROVIDER_SCOPES = ['gmail', 'yahoo', 'microsoft', 'other'];

let cache = { at: 0, list: [] };
let roundRobin = 0;
const liveHealth = new Map(); // backend id -> { ok, version, latencyMs, checkedAt, error }

// Per-backend usage windows, in process memory: how many checks each backend
// started, overall and per provider. Mirrors the limiter's window style.
const usage = new Map(); // id -> { global: window, providers: { gmail, yahoo, ... } }

function normalizeUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
}

function utcDayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function msUntilNextUtcDay(now) {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return Math.max(1000, next.getTime() - now);
}

function newWindow() {
    return { secLast: 0, minStarts: [], dayKey: utcDayKey(), dayCount: 0 };
}

function rollDay(state) {
    const key = utcDayKey();
    if (state.dayKey !== key) {
        state.dayKey = key;
        state.dayCount = 0;
    }
}

function pruneMinute(state, now) {
    while (state.minStarts.length && state.minStarts[0] <= now - 60000) state.minStarts.shift();
}

function usageEntry(id) {
    let entry = usage.get(id);
    if (!entry) {
        entry = { global: newWindow(), providers: Object.fromEntries(PROVIDER_SCOPES.map(p => [p, newWindow()])) };
        usage.set(id, entry);
    }
    return entry;
}

function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function limitsOf(backend) {
    if (backend.legacy) return { perMinute: 0, perDay: 0 };
    const limits = backend.limits || {};
    return {
        perMinute: Math.max(0, num(limits.perMinute, 60)),
        perDay: Math.max(0, num(limits.perDay, 2000)),
    };
}

// Milliseconds until this window may accept another start. There is no per-second
// gate per backend: that rate is enforced globally by verificationLimiter.
function windowWait(state, limits, now) {
    rollDay(state);
    pruneMinute(state, now);

    let wait = 0;
    if (limits.perMinute > 0 && state.minStarts.length >= limits.perMinute) {
        const oldest = state.minStarts[state.minStarts.length - limits.perMinute];
        wait = Math.max(wait, oldest + 60000 - now);
    }
    if (limits.perDay > 0 && state.dayCount >= limits.perDay) {
        wait = Math.max(wait, msUntilNextUtcDay(now));
    }
    return Math.max(0, wait);
}

function commitStart(state, now) {
    rollDay(state);
    pruneMinute(state, now);
    state.secLast = now;
    state.minStarts.push(now);
    state.dayCount += 1;
}

// A backend is usable for this provider only when BOTH its overall window and
// that provider's window have room.
function backendWait(backend, provider, now) {
    const limits = limitsOf(backend);
    const entry = usageEntry(backend.id);
    return Math.max(
        windowWait(entry.global, limits, now),
        windowWait(entry.providers[provider] || (entry.providers[provider] = newWindow()), limits, now)
    );
}

function recordStart(backend, provider, now) {
    const entry = usageEntry(backend.id);
    commitStart(entry.global, now);
    commitStart(entry.providers[provider] || (entry.providers[provider] = newWindow()), now);
}

function getBackendUsage(id) {
    const entry = usage.get(id);
    const now = Date.now();
    if (!entry) {
        return {
            minute: 0,
            today: 0,
            active: 0,
            byProvider: Object.fromEntries(PROVIDER_SCOPES.map(p => [p, { minute: 0, today: 0 }])),
        };
    }
    rollDay(entry.global);
    pruneMinute(entry.global, now);
    const byProvider = {};
    for (const provider of PROVIDER_SCOPES) {
        const state = entry.providers[provider] || newWindow();
        rollDay(state);
        pruneMinute(state, now);
        byProvider[provider] = { minute: state.minStarts.length, today: state.dayCount };
    }
    return {
        minute: entry.global.minStarts.length,
        today: entry.global.dayCount,
        active: 0,
        byProvider,
    };
}

function getAllUsage() {
    const ids = new Set([...usage.keys(), ...cache.list.map(b => b.id)]);
    const out = {};
    for (const id of ids) out[id] = getBackendUsage(id);
    return out;
}

// Legacy single backend from Coolify environment variables. Only used when the
// database holds no usable backends, so existing deployments keep working while
// the operator migrates endpoints into the UI.
function legacyBackend() {
    const url = normalizeUrl(process.env.REACHER_URL);
    if (!url) return null;
    return {
        id: 'env',
        name: 'Environment variable (REACHER_URL)',
        url,
        secret: process.env.REACHER_SECRET || '',
        enabled: true,
        locked: false,
        order: 9999,
        limits: { perMinute: 0, perDay: 0 },
        legacy: true,
    };
}

async function loadBackends({ force = false } = {}) {
    if (!force && cache.list.length && Date.now() - cache.at < CACHE_MS) return cache.list;

    let list = [];
    try {
        const docs = await ReacherBackend.find({ enabled: true, locked: false })
            .sort({ order: 1, createdAt: 1 })
            .select('+secretEnc')
            .lean();
        list = docs.map(doc => ({
            id: String(doc._id),
            name: doc.name,
            url: normalizeUrl(doc.url),
            secret: decryptSecret(doc.secretEnc),
            secretStored: Boolean(doc.secretEnc),
            secretUnreadable: Boolean(doc.secretEnc) && !canDecrypt(doc.secretEnc),
            enabled: doc.enabled !== false,
            locked: doc.locked === true,
            limits: {
                perMinute: num(doc.limits?.perMinute, 60),
                perDay: num(doc.limits?.perDay, 2000),
            },
            order: doc.order || 0,
            legacy: false,
        })).filter(item => item.url);
    } catch (error) {
        console.error('Could not load Reacher backends:', error.message);
        list = [];
    }

    if (!list.length) {
        const legacy = legacyBackend();
        if (legacy) list = [legacy];
    }

    cache = { at: Date.now(), list };
    return list;
}

function invalidateCache() {
    cache = { at: 0, list: [] };
}

function describeError(error) {
    if (!error) return 'unknown error';
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return 'timeout';
    if (error.code === 'ECONNREFUSED') return 'connection refused';
    if (error.code === 'ENOTFOUND') return 'host not found';
    if (error.response?.status === 401 || error.response?.status === 403) return 'secret rejected';
    if (error.response?.status) return `HTTP ${error.response.status}`;
    return error.message || 'request failed';
}

function headersFor(backend) {
    return backend.secret ? { 'x-reacher-secret': backend.secret } : {};
}

async function probe(backend, timeoutMs = PROBE_TIMEOUT_MS) {
    const started = Date.now();
    try {
        const { data } = await axios.get(`${backend.url}/version`, {
            timeout: timeoutMs,
            headers: headersFor(backend),
        });
        const result = {
            ok: true,
            version: data?.version || 'unknown',
            latencyMs: Date.now() - started,
            checkedAt: Date.now(),
            error: '',
        };
        liveHealth.set(backend.id, result);
        return result;
    } catch (error) {
        const result = {
            ok: false,
            version: '',
            latencyMs: Date.now() - started,
            checkedAt: Date.now(),
            error: describeError(error),
        };
        liveHealth.set(backend.id, result);
        return result;
    }
}

async function probeAll() {
    const backends = await loadBackends({ force: true });
    const results = await Promise.all(backends.map(async backend => {
        const health = await probe(backend);
        if (!backend.legacy) {
            ReacherBackend.updateOne({ _id: backend.id }, { $set: { lastStatus: health } }).catch(() => {});
        }
        return { ...backend, health };
    }));
    return results;
}

function cachedHealthFor(id) {
    return liveHealth.get(id) || null;
}

// Round-robin start point so load spreads across backends that still have room.
async function orderedBackends() {
    const backends = (await loadBackends()).slice();
    if (backends.length < 2) return backends;
    const start = roundRobin % backends.length;
    roundRobin += 1;
    return backends.slice(start).concat(backends.slice(0, start));
}

function recordSuccess(backend) {
    if (backend.legacy) return;
    ReacherBackend.updateOne(
        { _id: backend.id },
        { $inc: { 'stats.checks': 1 }, $set: { 'stats.lastUsedAt': new Date() } }
    ).catch(() => {});
}

function recordFailure(backend, message) {
    if (backend.legacy) return;
    ReacherBackend.updateOne(
        { _id: backend.id },
        {
            $inc: { 'stats.failures': 1 },
            $set: { 'stats.lastError': String(message || '').slice(0, 180) },
        }
    ).catch(() => {});
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Picks backends that still have room under their own limits, trying the next one
// when an endpoint fails. If every backend is at its limit, waits for the soonest
// to free up (bounded) instead of failing the batch instantly.
async function verifyWithPool(body, { timeoutMs, provider } = {}) {
    const scope = provider || providerFor(body?.to_email || '');
    const backends = await orderedBackends();
    if (!backends.length) {
        throw new Error('No Reacher backend available. Add one in Settings or unlock a backend.');
    }

    const maxWait = num(process.env.REACHER_POOL_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS);
    const deadline = Date.now() + maxWait;
    const attempts = [];
    // Backends that already failed for this check are not retried, so a dead
    // endpoint cannot eat the whole wait budget.
    const tried = new Set();

    while (Date.now() <= deadline) {
        const now = Date.now();
        const candidates = backends.filter(backend => !tried.has(backend.id));
        if (!candidates.length) break;

        const ready = candidates.filter(backend => backendWait(backend, scope, now) === 0);
        for (const backend of ready) {
            tried.add(backend.id);
            try {
                const { data } = await axios.post(`${backend.url}/v0/check_email`, body, {
                    timeout: timeoutMs,
                    headers: headersFor(backend),
                });
                recordStart(backend, scope, Date.now());
                recordSuccess(backend);
                return { data, backend };
            } catch (error) {
                const message = describeError(error);
                attempts.push(`${backend.name}: ${message}`);
                recordFailure(backend, message);
                liveHealth.set(backend.id, {
                    ok: false,
                    version: '',
                    latencyMs: 0,
                    checkedAt: Date.now(),
                    error: message,
                });
            }
        }

        const pending = backends.filter(backend => !tried.has(backend.id));
        if (!pending.length) break;

        const soonest = Math.min(...pending.map(backend => backendWait(backend, scope, Date.now())));
        if (soonest <= 0) continue;
        if (Date.now() + soonest > deadline) {
            throw new Error(`All Reacher backends are at their configured limits for ${scope}`);
        }
        await sleep(Math.min(Math.max(soonest, 50), 1000));
    }

    const detail = attempts.length ? ` — ${attempts.join('; ')}` : '';
    throw new Error(`All Reacher backends exhausted or failing${detail}`);
}

module.exports = {
    loadBackends,
    invalidateCache,
    probeAll,
    probe,
    cachedHealthFor,
    verifyWithPool,
    normalizeUrl,
    getBackendUsage,
    getAllUsage,
    limitsOf,
};
