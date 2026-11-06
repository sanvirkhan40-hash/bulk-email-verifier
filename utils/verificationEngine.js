const axios = require('axios');
const { mapReacherToReport, checkReacherHealth, REACHER_BASE } = require('./reacherClient');
const microsoftAccount = require('./microsoftAccount');
const reacherPool = require('./reacherPool');
const { providerFor } = require('./verificationLimiter');

const REACHER_TIMEOUT = parseInt(process.env.REACHER_TIMEOUT_MS || '45000', 10);
// truemail-go is disabled for good: every check goes through a Reacher backend.

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

function mapStatus(report) {
    if (report.valid) return 'valid';
    if (report.misc?.disposable) return 'disposable';
    if (report.mailbox_verified === 'catch_all') return 'catch_all';
    if (report.mailbox_verified === 'risky') return 'risky';
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
        catch_all: report.catch_all === true,
        microsoft_account: report.microsoft_account || '',
        smtp_deliverable: report.smtp_deliverable === true,
        engine: report.engine || 'unknown',
        backend: report.engine_backend || '',
        status: mapStatus(report),
        report,
    };
}

async function resolveEngine() {
    // Only Reacher exists now. The pool raises a precise error when no backend
    // is usable, so there is nothing to probe here.
    cachedEngine = 'reacher';
    return 'reacher';
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
    // No fallback engine: if every Reacher fails, the check fails loudly.
    const report = await verifyWithReacherTimed(email);

    // Microsoft 365 answers SMTP probes unreliably; ask the account endpoint
    // instead so a real mailbox is never reported as invalid.
    try {
        await microsoftAccount.applyToReport(report, email);
    } catch (error) {
        console.warn('Microsoft account lookup failed for ' + email + ': ' + error.message);
    }

    recordEngineUse('reacher', email);
    return wrapResult(report, email);
}

async function checkBackendHealth() {
    const health = {
        // Kept for older clients; truemail-go no longer exists.
        go: false,
        go_url: '',
        reacher: false,
        engine: null,
        active_engine: 'reacher',
        smtp_port: null,
        reacher_url: REACHER_BASE,
        mode: 'reacher',
    };

    health.reacher_backends = await reacherPool.loadBackends().then(backends => Promise.all(
        backends.map(async backend => {
            const cached = reacherPool.cachedHealthFor(backend.id);
            const fresh = cached && Date.now() - cached.checkedAt < 15000;
            const status = fresh
                ? cached
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
    health.engine = health.reacher ? 'reacher' : null;

    return health;
}

function resetEngineCache() {
    cachedEngine = null;
}

module.exports = {
    verifyEmailCombined,
    checkBackendHealth,
    mapStatus,
    resolveEngine,
    resetEngineCache,
    getEngineUsage,
};
