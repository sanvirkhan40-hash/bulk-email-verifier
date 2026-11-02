const VerificationSettings = require('../models/VerificationSettings');

const PROVIDERS = ['gmail', 'yahoo', 'microsoft', 'other'];

const DEFAULTS = {
    globalPerSecond: 1,
    globalPerMinute: 60,
    globalPerDay: 5000,
    maxConcurrent: 2,
    providerPerSecond: { gmail: 1, yahoo: 1, microsoft: 1, other: 1 },
    providerPerMinute: { gmail: 30, yahoo: 30, microsoft: 30, other: 30 },
    providerPerDay: { gmail: 1000, yahoo: 1000, microsoft: 1000, other: 1000 },
    skippedProviders: [],
};

const queue = [];
const providerHealth = new Map();
// scope -> { secLast, minStarts[], dayKey, dayCount }. Scope "global" plus one per provider.
const windows = new Map();
let active = 0;
let timer = null;
let pumping = false;

const SETTINGS_CACHE_MS = 750;
let settingsCache = { at: 0, value: null };

function providerFor(email) {
    const domain = String(email || '').split('@').pop().toLowerCase();
    if (['gmail.com', 'googlemail.com'].includes(domain)) return 'gmail';
    if (['yahoo.com', 'ymail.com', 'rocketmail.com'].includes(domain)) return 'yahoo';
    if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'microsoft';
    return 'other';
}

function utcDayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function msUntilNextUtcDay(now) {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return Math.max(1000, next.getTime() - now);
}

function windowState(scope) {
    let state = windows.get(scope);
    if (!state) {
        state = { secLast: 0, minStarts: [], dayKey: utcDayKey(), dayCount: 0 };
        windows.set(scope, state);
    }
    return state;
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

async function readSettings() {
    if (settingsCache.value && Date.now() - settingsCache.at < SETTINGS_CACHE_MS) {
        return settingsCache.value;
    }
    let value = DEFAULTS;
    try {
        const saved = await VerificationSettings.findOne({ key: 'global' }).lean();
        if (saved) {
            const pick = (source, fallback) => (Number.isFinite(Number(source)) ? Number(source) : fallback);
            value = {
                globalPerSecond: pick(saved.globalPerSecond, DEFAULTS.globalPerSecond) || 1,
                globalPerMinute: pick(saved.globalPerMinute, DEFAULTS.globalPerMinute),
                globalPerDay: pick(saved.globalPerDay, DEFAULTS.globalPerDay),
                maxConcurrent: pick(saved.maxConcurrent, DEFAULTS.maxConcurrent) || 1,
                providerPerSecond: { ...DEFAULTS.providerPerSecond, ...(saved.providerPerSecond || {}) },
                providerPerMinute: { ...DEFAULTS.providerPerMinute, ...(saved.providerPerMinute || {}) },
                providerPerDay: { ...DEFAULTS.providerPerDay, ...(saved.providerPerDay || {}) },
                skippedProviders: Array.isArray(saved.skippedProviders) ? saved.skippedProviders : [],
            };
        }
    } catch (error) {
        console.error('Could not read verification settings, using defaults:', error.message);
    }
    settingsCache = { at: Date.now(), value };
    return value;
}

function invalidateSettingsCache() {
    settingsCache = { at: 0, value: null };
}

// Only infrastructure/provider throttling signals count. A normal 550 mailbox rejection
// is a valid verification outcome and must not trigger provider backoff.
function isTransientProviderFailure(result, error) {
    const report = result?.report || result || {};
    const raw = report.reacher_raw || {};
    const parts = [
        error?.message,
        report.smtp_response,
        report.verdict_summary,
        raw.smtp?.error?.type,
        raw.smtp?.error?.message,
        raw.smtp?.error?.detail,
        ...(Array.isArray(report.checks) ? report.checks.map(x => x.detail || x.message) : []),
    ].filter(Boolean).join(' ').toLowerCase();

    if (/\b550\b|5\.1\.1|user unknown|mailbox does not exist|recipient address rejected/.test(parts)) return false;
    return /\b421\b|\b450\b|\b451\b|\b452\b|\b4\d\d\b|too many|rate.?limit|throttl|temporar|try again later|timeout|timed out|connection refused|connection reset|network unreachable|headlesserror|webdriver|disconnected|renderer|no_smtp|is_reachable.{0,12}unknown/.test(parts);
}

function recordOutcome(provider, result, error) {
    const state = providerHealth.get(provider) || { failures: 0, pausedUntil: 0, lastError: '' };
    if (!isTransientProviderFailure(result, error)) {
        if (!error && result) {
            state.failures = 0;
            state.pausedUntil = 0;
            state.lastError = '';
        }
        providerHealth.set(provider, state);
        return;
    }

    state.failures += 1;
    state.lastError = String(error?.message || result?.smtp_response || result?.report?.smtp_response || 'Temporary provider/network failure').slice(0, 180);
    if (state.failures >= 3) {
        const pauseMs = Math.min(5 * 60 * 1000, 15000 * (2 ** Math.min(state.failures - 3, 4)));
        state.pausedUntil = Date.now() + pauseMs;
        console.warn(`Provider ${provider} paused for ${Math.ceil(pauseMs / 1000)}s after ${state.failures} temporary failures`);
    }
    providerHealth.set(provider, state);
}

// How long this scope must wait before another check may start.
// Every limit is evaluated independently; the largest wait wins.
function scopeWait(scope, limits, now) {
    const state = windowState(scope);
    rollDay(state);
    pruneMinute(state, now);

    let wait = 0;

    const perSecond = Number(limits.perSecond) || 0;
    if (perSecond > 0 && state.secLast) {
        wait = Math.max(wait, state.secLast + 1000 / perSecond - now);
    }

    const perMinute = Number(limits.perMinute) || 0;
    if (perMinute > 0 && state.minStarts.length >= perMinute) {
        const oldestInWindow = state.minStarts[state.minStarts.length - perMinute];
        wait = Math.max(wait, oldestInWindow + 60000 - now);
    }

    const perDay = Number(limits.perDay) || 0;
    if (perDay > 0 && state.dayCount >= perDay) {
        wait = Math.max(wait, msUntilNextUtcDay(now));
    }

    return Math.max(0, wait);
}

function commitStart(scope, now) {
    const state = windowState(scope);
    rollDay(state);
    pruneMinute(state, now);
    state.secLast = now;
    state.minStarts.push(now);
    state.dayCount += 1;
}

function providerLimits(settings, provider) {
    // Only provider gates live here. The global row is enforced per backend by
    // the Reacher pool (each backend may override it), so applying it here too
    // would double-count it.
    return {
        perSecond: settings.providerPerSecond?.[provider],
        perMinute: settings.providerPerMinute?.[provider],
        perDay: settings.providerPerDay?.[provider],
    };
}

// Providers are served round-robin so a long run of one provider never starves
// the others. rotation defines the order; lastProvider remembers where we are.
const ROTATION = ['gmail', 'microsoft', 'other', 'yahoo'];
let lastProvider = null;

function isPaused(provider, now) {
    return (providerHealth.get(provider)?.pausedUntil || 0) > now;
}

function orderedProviders(now) {
    const active = ROTATION.filter(p => queue.some(i => i.provider === p) && !isPaused(p, now));
    if (!active.length) return [];
    const start = lastProvider ? (ROTATION.indexOf(lastProvider) + 1) % ROTATION.length : 0;
    const ordered = [];
    for (let i = 0; i < ROTATION.length; i++) {
        const p = ROTATION[(start + i) % ROTATION.length];
        if (active.includes(p)) ordered.push(p);
    }
    return ordered;
}

function earliestPauseWait(now) {
    const waits = queue.map(item => {
        const until = providerHealth.get(item.provider)?.pausedUntil || 0;
        return until > now ? until - now : 1000;
    });
    return Math.max(50, Math.min(...waits));
}

function schedulePump(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; pump(); }, Math.max(10, delay));
    if (timer.unref) timer.unref();
}

async function pump() {
    if (pumping) return;
    pumping = true;
    let nextDelay = 1000;
    try {
        while (queue.length) {
            const settings = await readSettings();
            if (active >= settings.maxConcurrent) break;

            const now = Date.now();
            // Round-robin across the providers that have queued work and are not
            // paused. First provider with room wins, so a long Gmail run can
            // never block Outlook/Other behind it.
            const providers = orderedProviders(now);
            if (!providers.length) {
                nextDelay = earliestPauseWait(now);
                break;
            }

            let chosenProvider = null;
            let soonestWait = Infinity;
            for (const candidate of providers) {
                const wait = scopeWait(candidate, providerLimits(settings, candidate), now);
                if (wait === 0) { chosenProvider = candidate; break; }
                soonestWait = Math.min(soonestWait, wait);
            }

            if (!chosenProvider) {
                nextDelay = Number.isFinite(soonestWait) ? soonestWait : 1000;
                break;
            }

            const index = queue.findIndex(entry => entry.provider === chosenProvider);
            if (index < 0) continue;
            const item = queue[index];
            queue.splice(index, 1);
            lastProvider = chosenProvider;
            active += 1;
            commitStart(chosenProvider, now);

            Promise.resolve()
                .then(item.task)
                .then(result => {
                    recordOutcome(item.provider, result, null);
                    item.resolve(result);
                }, error => {
                    recordOutcome(item.provider, null, error);
                    item.reject(error);
                })
                .finally(() => {
                    active = Math.max(0, active - 1);
                    pump();
                });
        }
    } catch (error) {
        const item = queue.shift();
        if (item) item.reject(error);
        if (queue.length) nextDelay = 250;
    } finally {
        pumping = false;
        if (queue.length && active < 20) schedulePump(nextDelay);
    }
}

function runWithVerificationLimit(email, task) {
    return new Promise((resolve, reject) => {
        queue.push({ provider: providerFor(email), task, resolve, reject });
        pump();
    });
}

function getProviderBackoffStatus() {
    const now = Date.now();
    return Object.fromEntries(PROVIDERS.map(provider => {
        const state = providerHealth.get(provider) || { failures: 0, pausedUntil: 0, lastError: '' };
        return [provider, {
            consecutiveTemporaryFailures: state.failures,
            paused: state.pausedUntil > now,
            resumeInSeconds: state.pausedUntil > now ? Math.ceil((state.pausedUntil - now) / 1000) : 0,
            lastError: state.lastError,
        }];
    }));
}

// Rolling counters so the settings page can show real usage against the limits.
function getLimiterUsage() {
    const now = Date.now();
    const usage = {};
    ['global', ...PROVIDERS].forEach(scope => {
        const state = windowState(scope);
        rollDay(state);
        pruneMinute(state, now);
        usage[scope] = {
            lastMinute: state.minStarts.length,
            today: state.dayCount,
            dayKey: state.dayKey,
            active: scope === 'global' ? active : undefined,
            queued: scope === 'global' ? queue.length : undefined,
        };
    });
    return usage;
}

// Shared with the Reacher pool so per-backend budgets come from one place.
const getEffectiveSettings = readSettings;

module.exports = {
    runWithVerificationLimit,
    providerFor,
    getProviderBackoffStatus,
    isTransientProviderFailure,
    getLimiterUsage,
    invalidateSettingsCache,
    readSettings: getEffectiveSettings,
    PROVIDERS,
};
