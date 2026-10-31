const VerificationSettings = require('../models/VerificationSettings');

const DEFAULTS = {
    globalPerSecond: 1,
    maxConcurrent: 2,
    providerPerSecond: { gmail: 1, yahoo: 1, microsoft: 1, other: 1 },
};

const queue = [];
const lastGlobalStart = { value: 0 };
const lastProviderStart = new Map();
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

function schedulePump(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; pump(); }, Math.max(10, delay));
    if (timer.unref) timer.unref();
}

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (queue.length) {
            const settings = await readSettings();
            if (active >= settings.maxConcurrent) break;

            const item = queue[0];
            const now = Date.now();
            const globalGap = 1000 / settings.globalPerSecond;
            const providerRate = settings.providerPerSecond[item.provider] || 1;
            const providerGap = 1000 / providerRate;
            const providerLast = lastProviderStart.get(item.provider) || 0;
            const dueAt = Math.max(lastGlobalStart.value + globalGap, providerLast + providerGap);

            if (now < dueAt) {
                schedulePump(dueAt - now);
                break;
            }

            queue.shift();
            active += 1;
            lastGlobalStart.value = now;
            lastProviderStart.set(item.provider, now);

            Promise.resolve()
                .then(item.task)
                .then(item.resolve, item.reject)
                .finally(() => {
                    active = Math.max(0, active - 1);
                    pump();
                });
        }
    } catch (error) {
        const item = queue.shift();
        if (item) item.reject(error);
        if (queue.length) schedulePump(250);
    } finally {
        pumping = false;
    }
}

function runWithVerificationLimit(email, task) {
    return new Promise((resolve, reject) => {
        queue.push({ provider: providerFor(email), task, resolve, reject });
        pump();
    });
}

module.exports = { runWithVerificationLimit, providerFor };
