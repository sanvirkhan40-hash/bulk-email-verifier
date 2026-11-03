const ValidationHistory = require('../models/ValidationHistory');
const { verifyEmailCombined } = require('../utils/verificationEngine');
const { runWithVerificationLimit, providerFor, readSettings } = require('../utils/verificationLimiter');
const { parseBulkFile } = require('../utils/csvEmailParser');
const fs = require('fs');

// Result used when a provider is configured to be skipped: no network call, no
// Reacher, just an honest "could not verify".
function skippedResult(email, provider) {
    const summary = email + ' — ' + provider + ' checks are disabled, address not verified';
    return {
        email,
        domain_valid: null,
        mailbox_verified: 'no_smtp',
        valid: false,
        checks: [{
            step: 'provider',
            passed: false,
            message: 'Provider skipped by configuration',
            detail: 'Enable it under Settings → Rate limits → Skip these providers to check this domain.',
        }],
        mx_records: [],
        misc: { disposable: false, role_account: false, free_provider: false },
        smtp_host: '',
        smtp_response: '',
        syntax_valid: true,
        smtp_check_ran: false,
        engine: 'skipped',
        backend: 'skipped',
        status: 'no_smtp',
        skipped: true,
        verdict_summary: summary,
        report: { email, valid: false, mailbox_verified: 'no_smtp', engine: 'skipped', skipped: true, verdict_summary: summary },
    };
}

async function skipList() {
    const settings = await readSettings();
    return Array.isArray(settings.skippedProviders) ? settings.skippedProviders : [];
}

// @desc    Verify single email
// @route   POST /api/verify/single
// @access  Private
const verifySingleEmail = async (req, res) => {
    const { email, source = 'single' } = req.body;
    if (!email) {
        return res.status(400).json({ message: 'Email is required' });
    }

    try {
        const skip = await skipList();
        const provider = providerFor(email);
        const result = skip.includes(provider)
            ? skippedResult(email, provider)
            : await runWithVerificationLimit(email, () => verifyEmailCombined(email));

        const history = await ValidationHistory.create({
            user: req.user._id,
            email,
            status: result.status,
            source,
            details: { report: result.report },
        });

        res.json({
            ...result,
            historyId: history._id,
        });
    } catch (error) {
        if (error.code === 'LIMITER_WAIT') {
            return res.status(429).json({
                message: error.message,
                retryAfter: error.retryAfter,
                provider: error.provider,
                email,
            });
        }
        console.error('Verify Single Email Error:', error.message);
        res.status(500).json({ message: 'Error verifying email', error: error.message });
    }
};

// @desc    Verify multiple emails server-side
// @route   POST /api/verify/bulk
// @access  Private
const verifyBulkEmails = async (req, res) => {
    const { emails, source = 'bulk' } = req.body;
    if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ message: 'emails array is required' });
    }

    const workerCount = Math.min(emails.length, 20);
    const results = new Array(emails.length);

    async function verifyOne(email, index) {
        try {
            const skip = await skipList();
        const provider = providerFor(email);
        const result = skip.includes(provider)
            ? skippedResult(email, provider)
            : await runWithVerificationLimit(email, () => verifyEmailCombined(email));
            await ValidationHistory.create({
                user: req.user._id,
                email,
                status: result.status,
                source,
                details: { report: result.report },
            });
            results[index] = result;
        } catch (err) {
            results[index] = {
                email,
                status: 'error',
                domain_valid: false,
                mailbox_verified: 'no_smtp',
                valid: false,
                error: err.message,
            };
        }
    }

    let nextIndex = 0;
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextIndex < emails.length) {
            const index = nextIndex++;
            await verifyOne(emails[index], index);
        }
    }));

    res.json({ count: results.length, results });
};

// @desc    Parse bulk email file — scan all columns, preserve rows
// @route   POST /api/verify/upload-bulk
// @access  Private
const uploadBulkFile = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: 'Please upload a file' });
    }

    const filePath = req.file.path;

    try {
        const isCsv =
            req.file.mimetype === 'text/csv' ||
            req.file.mimetype === 'application/vnd.ms-excel' ||
            req.file.originalname.endsWith('.csv');
        const isXlsx =
            req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
            req.file.originalname.endsWith('.xlsx');

        if (!isCsv && !isXlsx) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ message: 'Unsupported file format. Use .csv or .xlsx' });
        }

        const parsed = parseBulkFile(filePath, req.file.originalname);
        fs.unlinkSync(filePath);

        res.json({
            emails: parsed.emails,
            rows: parsed.rows,
            emailCount: parsed.emails.length,
            rowCount: parsed.rows.length,
        });
    } catch (error) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).json({ message: 'Error parsing file', error: error.message });
    }
};

// @desc    Backend engine health
// @route   GET /api/verify/health
// @access  Private
const getEngineHealth = async (_req, res) => {
    const { checkBackendHealth } = require('../utils/verificationEngine');
    const health = await checkBackendHealth();
    res.json(health);
};

module.exports = { verifySingleEmail, verifyBulkEmails, uploadBulkFile, getEngineHealth };
