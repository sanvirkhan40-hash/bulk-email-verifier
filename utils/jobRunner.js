/**
 * Server-side bulk runner.
 *
 * The page used to be the driver: closing the tab stopped the run. Now a job
 * lives in Mongo and this loop walks it, so the work continues while nobody is
 * watching. Safe with several app instances: only one can claim a job at a time
 * (atomic findOneAndUpdate), and a lock older than STALE_MS is reclaimed.
 */
const os = require('os');
const VerifyJob = require('../models/VerifyJob');
const BulkJob = require('../models/BulkJob');
const { runWithVerificationLimit } = require('./verificationLimiter');
const { verifyEmailCombined } = require('./verificationEngine');

const WORKER_ID = os.hostname() + ':' + process.pid;
const STALE_MS = 5 * 60 * 1000;
const IDLE_POLL_MS = 3000;
const MAX_ATTEMPTS = 40;

let ticking = false;
let timer = null;
let running = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function toRow(result) {
    return {
        email: result.email || '',
        status: result.status || 'error',
        valid: result.valid === true,
        domain_valid: result.domain_valid === true,
        mailbox_verified: result.mailbox_verified || 'no_smtp',
        catch_all: result.catch_all === true,
        smtp_response: result.smtp_response || '',
        engine: result.engine || '',
        backend: result.backend || '',
        verdict_summary: result.verdict_summary || '',
        checked_at: new Date(),
    };
}

async function claimNext() {
    return VerifyJob.findOneAndUpdate(
        { status: 'queued' },
        { $set: { status: 'running', workerId: WORKER_ID, lockedAt: new Date() } },
        { returnDocument: 'after', sort: { createdAt: 1 } },
    );
}

async function isStillRunning(id) {
    const doc = await VerifyJob.findById(id).select('status').lean();
    return Boolean(doc && doc.status === 'running');
}

async function checkOne(email) {
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
        attempts += 1;
        try {
            return await runWithVerificationLimit(email, () => verifyEmailCombined(email));
        } catch (error) {
            if (error && error.code === 'LIMITER_WAIT') {
                const wait = Math.min(Math.max(Number(error.retryAfter) || 30, 5), 120);
                await sleep(wait * 1000);
                continue;
            }
            return {
                email,
                status: 'error',
                valid: false,
                domain_valid: false,
                mailbox_verified: 'no_smtp',
                smtp_response: 'Not processed: ' + (error.message || 'error'),
                engine: 'error',
                backend: '',
                verdict_summary: email + ' — not processed: ' + (error.message || 'error'),
            };
        }
    }
    return {
        email,
        status: 'error',
        valid: false,
        domain_valid: false,
        mailbox_verified: 'no_smtp',
        smtp_response: 'Not processed: rate limit',
        engine: 'error',
        backend: '',
    };
}

async function finish(job) {
    const fresh = await VerifyJob.findById(job._id).lean();
    if (!fresh || fresh.status !== 'running') return;

    const results = fresh.results || [];
    const stats = {
        total: results.length,
        valid: results.filter(r => r.valid).length,
        invalid: results.filter(r => !r.valid && r.status !== 'no_smtp' && r.status !== 'risky' && r.status !== 'catch_all').length,
        disposable: results.filter(r => r.status === 'disposable').length,
        noSmtp: results.filter(r => r.mailbox_verified === 'no_smtp').length,
        risky: results.filter(r => r.status === 'risky').length,
        catchAll: results.filter(r => r.catch_all).length,
    };

    await VerifyJob.updateOne({ _id: job._id }, { $set: { status: 'done', finishedAt: new Date() } });

    // Same history entry the browser-side run used to create.
    try {
        await BulkJob.create({
            user: fresh.user,
            fileName: fresh.fileName,
            rows: results.map(r => ({
                email: r.email,
                originalRow: [],
                valid: r.valid,
                domain_valid: r.domain_valid,
                mailbox_verified: r.mailbox_verified,
                catch_all: r.catch_all,
                smtp_response: r.smtp_response,
                status: r.status,
                engine: r.engine,
                backend: r.backend,
            })),
            stats,
        });
    } catch (error) {
        console.warn('Could not save server-run history:', error.message);
    }
}

async function processJob(job) {
    for (let index = job.nextIndex || 0; index < job.emails.length; index += 1) {
        if (!(await isStillRunning(job._id))) return 'stopped';

        const result = await checkOne(job.emails[index]);

        const update = await VerifyJob.updateOne(
            { _id: job._id, status: 'running' },
            {
                $push: { results: toRow(result) },
                $inc: { done: 1 },
                $set: { nextIndex: index + 1, lockedAt: new Date() },
            },
        );
        if (!update || update.matchedCount === 0) return 'stopped';   // paused mid-flight
    }

    await finish(job);
    return 'done';
}

async function tick() {
    if (ticking || !running) return;
    ticking = true;
    try {
        // Reclaim jobs whose worker died (deploy, crash, reboot).
        await VerifyJob.updateMany(
            { status: 'running', lockedAt: { $lt: new Date(Date.now() - STALE_MS) } },
            { $set: { status: 'queued' } },
        );

        let job = await claimNext();
        while (job) {
            try {
                await processJob(job);
            } catch (error) {
                console.error('Job ' + job._id + ' failed:', error.message);
                await VerifyJob.updateOne({ _id: job._id }, { $set: { status: 'error', error: error.message } });
            }
            job = await claimNext();
        }
    } catch (error) {
        console.warn('Job runner tick failed:', error.message);
    } finally {
        ticking = false;
        if (running) timer = setTimeout(tick, IDLE_POLL_MS);
    }
}

function start() {
    if (running) return;
    running = true;
    console.log('🧵 Server-side bulk runner started as ' + WORKER_ID);
    timer = setTimeout(tick, 1000);
}

function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
}

module.exports = {
    start,
    stop,
    processJob,
    WORKER_ID,
    toRow,
    _internals: { claimNext, finish, checkOne },
};
