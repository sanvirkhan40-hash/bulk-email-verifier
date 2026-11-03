const axios = require('axios');
const ReacherBackend = require('../models/ReacherBackend');
const { decryptSecret, canDecrypt } = require('./secretBox');
const { providerFor, readSettings } = require('./verificationLimiter');

const CACHE_MS = 15000;
const PROBE_TIMEOUT_MS = 4000;
const DEFAULT_MAX_WAIT_MS = 30000;
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

// Effective limits for one backend. Setting ANY value on the backend makes it
// ignore the global row completely (unset pieces then mean "unlimited" for that
// backend). With nothing set, it follows the global row.
function effectiveLimits(backend, settings) {
    const own = backend.limits || {};
    const has = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

    // A provider row refines the Overall row for that provider only.
    const providerLimits = {};
    for (const name of ['gmail', 'yahoo', 'microsoft', 'other']) {
        const row = (own.providers && own.providers[name]) || {};
        if (!['perSecond', 'perMinute', 'perDay'].some(key => has(row[key]))) continue;
        providerLimits[name] = {
            perSecond: has(row.perSecond) ? Math.max(0, Number(row.perSecond)) : 0,
            perMinute: has(row.perMinute) ? Math.max(0, Number(row.perMinute)) : 0,
            perDay: has(row.perDay) ? Math.max(0, Number(row.perDay)) : 0,
        };
    }

    const overridden = ['perSecond', 'perMinute', 'perDay'].some(key => has(own[key]))
        || Object.keys(providerLimits).length > 0;

    if (overridden) {
        return {
            perSecond: has(own.perSecond) ? Math.max(0, Number(own.perSecond)) : 0,
            perMinute: has(own.perMinute) ? Math.max(0, Number(own.perMinute)) : 0,
            perDay: has(own.perDay) ? Math.max(0, Number(own.perDay)) : 0,
            providerLimits,
            overridden: true,
        };
    }
    return {
        perSecond: Math.max(0, num(settings?.globalPerSecond, 1)),
        perMinute: Math.max(0, num(settings?.globalPerMinute, 60)),
        perDay: Math.max(0, num(settings?.globalPerDay, 5000)),
        providerLimits: {},
        overridden: false,
    };
}

// Backends that follow the global row share ONE per-second clock (so two
// Reachers do not double the rate). An overridden backend paces itself.
const sharedSecond = { secLast: 0 };
// Backends without their own limits also share one minute/day budget, so
// "1 per minute" means one check per minute in total, not one per backend.
const sharedBudget = newWindow();
const ownSeconds = new Map();

function secondsState(backend, limits) {
    if (!limits.overridden) return sharedSecond;
    if (!ownSeconds.has(backend.id)) ownSeconds.set(backend.id, { secLast: 0 });
    return ownSeconds.get(backend.id);
}

function secondWait(state, perSecond, now) {
    if (!(perSecond > 0) || !state.secLast) return 0;
    return Math.max(0, state.secLast + 1000 / perSecond - now);
}

function minuteWait(state, perMinute, now) {
    rollDay(state);
    pruneMinute(state, now);
    if (!(perMinute > 0) || state.minStarts.length < perMinute) return 0;
    return Math.max(0, state.minStarts[state.minStarts.length - perMinute] + 60000 - now);
}

function dayWait(state, perDay, now) {
    rollDay(state);
    if (!(perDay > 0) || state.dayCount < perDay) return 0;
    return msUntilNextUtcDay(now);
}

function commitStart(state, now) {
    rollDay(state);
    pruneMinute(state, now);
    state.secLast = now;
    state.minStarts.push(now);
    state.dayCount += 1;
}

// A backend is usable when its per-second clock, per-minute budget and daily
// budget all allow another start.
function backendWait(backend, provider, now, settings) {
    const limits = effectiveLimits(backend, settings);
    const entry = usageEntry(backend.id);

    const budget = limits.overridden ? entry.global : sharedBudget;

    let wait = Math.max(
        secondWait(secondsState(backend, limits), limits.perSecond, now),
        minuteWait(budget, limits.perMinute, now),
        dayWait(budget, limits.perDay, now),
    );

    // A provider row on this backend is an extra cap on top of its Overall row.
    const own = limits.providerLimits[provider];
    if (own) {
        const state = entry.providers[provider] || (entry.providers[provider] = newWindow());
        wait = Math.max(
            wait,
            secondWait(state, own.perSecond, now),
            minuteWait(state, own.perMinute, now),
            dayWait(state, own.perDay, now),
        );
    }
    return wait;
}

function recordStart(backend, provider, now, settings) {
    const limits = effectiveLimits(backend, settings);
    const entry = usageEntry(backend.id);
    secondsState(backend, limits).secLast = now;
    // Always count per backend for the usage display, but only charge the shared
    // budget when this backend is not running on its own numbers.
    commitStart(entry.global, now);
    if (!limits.overridden) commitStart(sharedBudget, now);
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
                perSecond: doc.limits?.perSecond ?? null,
                perMinute: doc.limits?.perMinute ?? null,
                perDay: doc.limits?.perDay ?? null,
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
// Serialises the gate-check + reserve step so concurrent checks cannot both
// slip through the same per-second slot.
let admission = Promise.resolve();
function admit(task) {
    const next = admission.then(task, task);
    admission = next.then(() => undefined, () => undefined);
    return next;
}

async function verifyWithPool(body, { timeoutMs, provider } = {}) {
    const scope = provider || providerFor(body?.to_email || '');
    const backends = await orderedBackends();
    if (!backends.length) {
        throw new Error('No Reacher backend available. Add one in Settings or unlock a backend.');
    }

    // Limits for each backend: its own values if set, otherwise the global row.
    const settings = await readSettings();
    const maxWait = num(process.env.REACHER_POOL_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS);
    const deadline = Date.now() + maxWait;
    const attempts = [];
    const tried = new Set();

    while (Date.now() <= deadline) {
        // Admission is serialised: two concurrent checks must not both pass the
        // per-second gate before either has recorded a start.
        const ticket = await admit(() => {
            const now = Date.now();
            const candidates = backends.filter(backend => !tried.has(backend.id));
            if (!candidates.length) return { exhausted: true };

            const ready = candidates.filter(backend => backendWait(backend, scope, now, settings) === 0);
            if (!ready.length) {
                const soonest = Math.min(...candidates.map(backend => backendWait(backend, scope, now, settings)));
                return { wait: soonest };
            }

            const backend = ready[0];
            tried.add(backend.id);
            recordStart(backend, scope, now, settings);
            return { backend };
        });

        if (ticket.exhausted) break;
        if (ticket.wait !== undefined) {
            if (ticket.wait <= 0) continue;
            if (Date.now() + ticket.wait > deadline) {
                const limitError = new Error('All Reacher backends are at their configured limits for ' + scope);
                limitError.code = 'LIMITER_WAIT';
                limitError.provider = scope;
                limitError.retryAfter = Math.min(60, Math.max(10, Math.ceil(ticket.wait / 1000)));
                throw limitError;
            }
            await sleep(Math.min(Math.max(ticket.wait, 50), 1000));
            continue;
        }

        const backend = ticket.backend;
        try {
            const { data } = await axios.post(backend.url + '/v0/check_email', body, {
                timeout: timeoutMs,
                headers: headersFor(backend),
            });
            recordSuccess(backend);
            return { data, backend };
        } catch (error) {
            const message = describeError(error);
            attempts.push(backend.name + ': ' + message);
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

    const detail = attempts.length ? ' — ' + attempts.join('; ') : '';
    throw new Error('All Reacher backends exhausted or failing' + detail);
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
    effectiveLimits,
};
