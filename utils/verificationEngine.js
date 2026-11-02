const axios = require('axios');
const { mapReacherToReport, checkReacherHealth, REACHER_BASE } = require('./reacherClient');
const { ensureGoVerifier } = require('./spawnGo');
const reacherPool = require('./reacherPool');
const { providerFor } = require('./verificationLimiter');

const GO_BASE = process.env.GO_VERIFIER_URL || 'http://localhost:8080';
const ENGINE_MODE = (process.env.VERIFIER_ENGINE || 'truemail').toLowerCase();
const REACHER_TIMEOUT = parseInt(process.env.REACHER_TIMEOUT_MS || '45000', 10);

let cachedEngine = null;

// Per-engine counters for today. The fallback engine (truemail-go) is shown in
// Settings too, otherwise its usage would be invisible next to the Reachers.
const ENGINE_PROVIDERS = ['gmail', 'yahoo', 'microsoft', 'other'];
let engineUsage = freshEngineUsage();

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function freshEngineUsage() {
    return {
        dayKey: todayKey(),
        go: 0,
        reacher: 0,
        goByProvider: Object.fromEntries(ENGINE_PROVIDERS.map(p => [p, 0])),
        reacherByProvider: Object.fromEntries(ENGINE_PROVIDERS.map(p => [p, 0])),
    };
}

function rollEngineDay() {
    if (engineUsage.dayKey !== todayKey()) engineUsage = freshEngineUsage();
}

function recordEngineUse(engine, email) {
    rollEngineDay();
    const provider = providerFor(email);
    if (engine === 'reacher') {
        engineUsage.reacher += 1;
        if (provider in engineUsage.reacherByProvider) engineUsage.reacherByProvider[provider] += 1;
    } else {
        engineUsage.go += 1;
        if (provider in engineUsage.goByProvider) engineUsage.goByProvider[provider] += 1;
    }
}

function getEngineUsage() {
    rollEngineDay();
    return JSON.parse(JSON.stringify(engineUsage));
}

async function verifyWithGo(email) {
    const url = `${GO_BASE}/v1/${encodeURIComponent(email)}/verification`;
    const { data } = await axios.get(url, { timeout: 120000 });
    return { ...data, engine: data.engine || 'truemail-go', engine_backend: 'truemail-go' };
}

function mapStatus(report) {
    if (report.valid) return 'valid';
    if (report.misc?.disposable) return 'disposable';
    if (report.mailbox_verified === 'no_smtp') return 'no_smtp';
    if (!report.domain_valid) return 'invalid';
    return 'invalid';
}

function wrapResult(report, email) {
    return {
        email: report.email || email,
        domain_valid: report.domain_valid,
        mailbox_verified: report.mailbox_verified,
        valid: report.valid,
        checks: report.checks || [],
        mx_records: report.mx_records || [],
        misc: report.misc || {},
        smtp_host: report.smtp_host || '',
        smtp_response: report.smtp_response || '',
        verdict_summary: report.verdict_summary || '',
        syntax_valid: report.syntax_valid,
        smtp_check_ran: report.smtp_check_ran,
        engine: report.engine || 'unknown',
        backend: report.engine_backend || '',
        status: mapStatus(report),
        report,
    };
}

async function isTruemailUp() {
    try {
        const { data } = await axios.get(`${GO_BASE}/health`, { timeout: 3000 });
        return data?.status === 'ok';
    } catch (_) {
        return false;
    }
}

async function ensureTruemailReady() {
    if (!(await isTruemailUp())) {
        await ensureGoVerifier();
        for (let i = 0; i < 15; i++) {
            if (await isTruemailUp()) return true;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return isTruemailUp();
}

async function resolveEngine() {
    // Default & auto: truemail-go only (fast, works on Gmail in ~15s)
    if (ENGINE_MODE === 'truemail' || ENGINE_MODE === 'auto') {
        if (await ensureTruemailReady()) {
            cachedEngine = 'truemail-go';
            return 'truemail-go';
        }
        throw new Error('truemail-go not running. Restart with: npm start');
    }

    if (ENGINE_MODE === 'reacher') {
        if (await checkReacherHealth()) {
            cachedEngine = 'reacher';
            return 'reacher';
        }
        console.warn('⚠️  Reacher unavailable — using truemail-go');
        if (await ensureTruemailReady()) return 'truemail-go';
        throw new Error('Reacher down. Run: docker compose up -d  OR  npm start');
    }

    if (cachedEngine) return cachedEngine;
    if (await ensureTruemailReady()) {
        cachedEngine = 'truemail-go';
        return cachedEngine;
    }
    throw new Error('No verifier available. Run: npm start');
}

async function verifyWithReacherTimed(email) {
    const proxy = process.env.SMTP_PROXY;
    const body = { to_email: email, hello_name: 'reacher.app' };
    if (proxy) {
        try {
            const u = new URL(proxy);
            body.proxy = {
                host: u.hostname,
                port: parseInt(u.port || '1080', 10),
                username: u.username || undefined,
                password: u.password || undefined,
            };
        } catch (_) {}
    }

    const { data, backend } = await reacherPool.verifyWithPool(body, { timeoutMs: REACHER_TIMEOUT });
    const report = mapReacherToReport(data, email);
    report.engine_backend = backend.name;
    report.engine_backend_url = backend.url;
    return report;
}

async function verifyEmailCombined(email) {
    const engine = await resolveEngine();
    let report;

    try {
        if (engine === 'reacher') {
            report = await verifyWithReacherTimed(email);
        } else {
            report = await verifyWithGo(email);
        }
    } catch (primaryErr) {
        const failedReacher = engine === 'reacher';
        const canFallback =
            failedReacher &&
            (primaryErr.code === 'ECONNABORTED' || String(primaryErr.message).includes('timeout'));

        if (canFallback || failedReacher) {
            if (await ensureTruemailReady()) {
                console.warn(`Reacher failed for ${email} — using truemail-go`);
                report = await verifyWithGo(email);
                report.engine = 'truemail-go';
                report.fallback_from = 'reacher';
            } else {
                throw new Error(`Reacher failed: ${primaryErr.message}. truemail-go is not running.`);
            }
        } else {
            throw new Error(`truemail-go failed: ${primaryErr.message}`);
        }
    }

    recordEngineUse(report.engine === 'reacher' ? 'reacher' : 'truemail-go', email);
    return wrapResult(report, email);
}

async function checkBackendHealth() {
    const health = {
        go: false,
        reacher: false,
        engine: null,
        active_engine: null,
        smtp_port: null,
        go_url: GO_BASE,
        reacher_url: REACHER_BASE,
        mode: ENGINE_MODE,
    };

    try {
        const { data } = await axios.get(`${GO_BASE}/health`, { timeout: 5000 });
        health.go = data?.status === 'ok';
        health.smtp_port = data?.smtp_port || null;
        if (health.go) health.engine = data?.engine || 'truemail-go';
    } catch (_) {}

    health.reacher_backends = await reacherPool.loadBackends().then(backends => Promise.all(
        backends.map(async backend => {
            const cached = reacherPool.cachedHealthFor(backend.id);
            const fresh = cached && Date.now() - cached.checkedAt < 15000;
            const status = fresh || ENGINE_MODE === 'truemail'
                ? (cached || { ok: false, version: '', latencyMs: 0, error: 'not checked yet' })
                : await reacherPool.probe(backend);
            return {
                id: backend.id,
                name: backend.name,
                url: backend.url,
                legacy: Boolean(backend.legacy),
                ok: Boolean(status.ok),
                version: status.version || '',
                latencyMs: status.latencyMs || 0,
                error: status.error || '',
            };
        })
    ));

    health.reacher = health.reacher_backends.some(backend => backend.ok);

    try {
        health.active_engine = await resolveEngine();
    } catch (_) {
        health.active_engine = health.go ? 'truemail-go' : null;
    }

    return health;
}

function resetEngineCache() {
    cachedEngine = null;
}

module.exports = {
    verifyEmailCombined,
    checkBackendHealth,
    verifyWithGo,
    GO_BASE,
    mapStatus,
    resolveEngine,
    resetEngineCache,
    getEngineUsage,
};
