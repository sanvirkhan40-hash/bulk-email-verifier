const VerificationSettings = require('../models/VerificationSettings');

const DEFAULTS = {
    globalPerSecond: 1,
    maxConcurrent: 2,
    providerPerSecond: { gmail: 1, yahoo: 1, microsoft: 1, other: 1 },
};

const queue = [];
const lastGlobalStart = { value: 0 };
const lastProviderStart = new Map();
const providerHealth = new Map();
let active = 0;
let timer = null;
let pumping = false;

function providerFor(email) {
    const domain = String(email || '').split('@').pop().toLowerCase();
    if (['gmail.com', 'googlemail.com'].includes(domain)) return 'gmail';
    if (['yahoo.com', 'ymail.com', 'rocketmail.com'].includes(domain)) return 'yahoo';
    if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'microsoft';
    return 'other';
}

async function readSettings() {
    const saved = await VerificationSettings.findOne({ key: 'global' }).lean();
    if (!saved) return DEFAULTS;
    return {
        globalPerSecond: saved.globalPerSecond || DEFAULTS.globalPerSecond,
        maxConcurrent: saved.maxConcurrent || DEFAULTS.maxConcurrent,
        providerPerSecond: { ...DEFAULTS.providerPerSecond, ...(saved.providerPerSecond || {}) },
    };
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
            // Find the first queued provider that is not currently paused.
            const index = queue.findIndex(item => (providerHealth.get(item.provider)?.pausedUntil || 0) <= now);
            if (index < 0) {
                const earliest = Math.min(...queue.map(item => providerHealth.get(item.provider)?.pausedUntil || now + 1000));
                nextDelay = Math.max(50, earliest - now);
                break;
            }

            const item = queue[index];
            const globalGap = 1000 / settings.globalPerSecond;
            const providerRate = settings.providerPerSecond[item.provider] || 1;
            const providerGap = 1000 / providerRate;
            const providerLast = lastProviderStart.get(item.provider) || 0;
            const dueAt = Math.max(lastGlobalStart.value + globalGap, providerLast + providerGap);

            if (now < dueAt) {
                nextDelay = dueAt - now;
                break;
            }

            queue.splice(index, 1);
            active += 1;
            lastGlobalStart.value = now;
            lastProviderStart.set(item.provider, now);

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
    return Object.fromEntries(['gmail', 'yahoo', 'microsoft', 'other'].map(provider => {
        const state = providerHealth.get(provider) || { failures: 0, pausedUntil: 0, lastError: '' };
        return [provider, {
            consecutiveTemporaryFailures: state.failures,
            paused: state.pausedUntil > now,
            resumeInSeconds: state.pausedUntil > now ? Math.ceil((state.pausedUntil - now) / 1000) : 0,
            lastError: state.lastError,
        }];
    }));
}

module.exports = { runWithVerificationLimit, providerFor, getProviderBackoffStatus, isTransientProviderFailure };
