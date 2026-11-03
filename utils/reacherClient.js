
const axios = require('axios');

const REACHER_BASE = (process.env.REACHER_URL || 'http://localhost:8081').replace(/\/$/, '');
const REACHER_SECRET = process.env.REACHER_SECRET || '';

function reacherHeaders() {
    return REACHER_SECRET
        ? { 'x-reacher-secret': REACHER_SECRET }
        : {};
}

function isErrorBlock(obj) {
    return obj && typeof obj === 'object' && obj.type === 'error';
}

// Reacher reports SMTP/browser failures in two shapes: a legacy error block
// ({type:'error', error:{...}}) and a plain smtp object that carries an error
// plus a description such as "IpBlacklisted".
function smtpFailure(smtp) {
    if (!smtp || typeof smtp !== 'object') return null;
    if (!smtp.error) return null;
    const error = typeof smtp.error === 'object'
        ? smtp.error
        : { message: String(smtp.error) };
    return {
        type: error.type || smtp.description || 'SmtpError',
        description: smtp.description || '',
        message: error.message || error.detail || '',
    };
}

function mapReacherToReport(data, email) {
    const syntax = data.syntax || {};
    const mx = isErrorBlock(data.mx) ? {} : data.mx || {};
    const smtp = isErrorBlock(data.smtp) ? {} : data.smtp || {};
    const misc = isErrorBlock(data.misc) ? {} : data.misc || {};

    const syntaxValid = syntax.is_valid_syntax !== false;
    const mxRecords = (mx.records || []).map((host, i) => ({
        host: String(host).replace(/\.$/, ''),
        priority: (i + 1) * 10,
    }));

    const disposable = !!misc.is_disposable;
    const checks = [];

    // Microsoft 365 (custom domains included) answers a probe it dislikes with
    // the same generic 5xx it uses for "no such mailbox": DBEB, alias-only
    // recipients and policy blocks are indistinguishable from a missing user.
    // The rejection therefore cannot be read as "invalid".
    const microsoftHosted = mxRecords.some(record => /\.mail\.protection\.outlook\.com$/i.test(record.host));
    // Treat an unknown/absent debug block as the SMTP path: headless is the only
    // other method and it never produces a bare 5xx for Microsoft domains.
    const smtpMethod = String(data?.debug?.smtp?.verif_method?.type || 'smtp').toLowerCase();
    const microsoftProbe = microsoftHosted && smtpMethod !== 'headless';

    checks.push({
        step: 'syntax',
        passed: syntaxValid,
        message: syntaxValid
            ? 'The Email Address Syntax is correct'
            : 'The Email Address Syntax is incorrect',
    });

    checks.push({
        step: 'misc',
        passed: !disposable,
        message: disposable
            ? 'Disposable / temporary email domain detected'
            : 'Not a known disposable domain',
    });

    if (misc.is_role_account) {
        checks.push({
            step: 'misc',
            passed: false,
            message: 'Role-based email account',
        });
    }

    if (!mx.accepts_mail || mxRecords.length === 0) {
        checks.push({
            step: 'mx',
            passed: false,
            message: 'No MX records found for domain',
        });
    } else {
        mxRecords.forEach(mx => {
            checks.push({
                step: 'mx',
                passed: true,
                message: `MX record found: ${mx.host} (Priority ${mx.priority})`,
            });
        });
    }

    const smtpRan = smtp.can_connect_smtp === true;
    const deliverable = smtp.is_deliverable === true;
    const reachable = data.is_reachable || 'unknown';
    const catchAll = smtpRan && smtp.is_catch_all === true;

    // Reacher reports a broken browser/SMTP attempt as an error block. Without
    // this, the result is a silent "no_smtp" and the real reason is lost.
    const smtpFailureInfo = smtpFailure(data.smtp);
    const smtpErrorText = smtpFailureInfo
        ? `Reacher could not run the SMTP check: ${smtpFailureInfo.type}`
            + (smtpFailureInfo.description && smtpFailureInfo.description !== smtpFailureInfo.type
                ? ` (${smtpFailureInfo.description})` : '')
            + (smtpFailureInfo.message ? ` — ${smtpFailureInfo.message}` : '')
        : '';

    if (smtpRan) {
        checks.push({
            step: 'smtp',
            passed: deliverable,
            message: deliverable
                ? 'SMTP mailbox confirmed (Reacher)'
                : (reachable === 'risky'
                    ? 'SMTP accepted the address but flagged it (Reacher)'
                    : 'SMTP mailbox not confirmed (Reacher)'),
            detail: deliverable
                ? '250 OK / is_deliverable'
                : (catchAll
                    ? `is_reachable: ${reachable} — domain is catch-all`
                    : (microsoftProbe && reachable === 'invalid'
                        ? 'is_reachable: invalid — Microsoft 365 rejection is not conclusive (DBEB / policy block)'
                        : `is_reachable: ${reachable}`)),
        });
    } else if (smtpErrorText) {
        checks.push({
            step: 'smtp',
            passed: false,
            message: 'SMTP check could not run',
            detail: smtpErrorText,
        });
    }

    const domainValid = syntaxValid && mx.accepts_mail && !disposable;

    let mailboxVerified = 'no_smtp';

    if (catchAll) {
        // The domain answers 250 for addresses that do not exist, so a positive
        // reply cannot prove that this particular mailbox exists.
        mailboxVerified = 'catch_all';
    } else if (reachable === 'safe' || deliverable) {
        mailboxVerified = 'yes';
    } else if (reachable === 'risky') {
        // Reacher accepted the recipient but flagged it (role account,
        // catch-all, full inbox). The mailbox exists; it is not "invalid".
        mailboxVerified = 'risky';
    } else if (reachable === 'invalid' && smtpRan) {
        mailboxVerified = microsoftProbe ? 'no_smtp' : 'no';
    } else if (smtpRan && !deliverable) {
        mailboxVerified = microsoftProbe ? 'no_smtp' : 'no';
    }

    const valid = mailboxVerified === 'yes';

    let verdictSummary = `${email} seems not to be valid`;

    if (valid) {
        verdictSummary = `${email} seems to be valid`;
    } else if (mailboxVerified === 'catch_all') {
        verdictSummary =
            `${email} — the domain accepts every address (catch-all), so this mailbox cannot be confirmed`;
    } else if (mailboxVerified === 'risky') {
        verdictSummary =
            `${email} exists but is a risky mailbox (role account or catch-all) — not confirmed for outreach`;
    } else if (mailboxVerified === 'no_smtp' && domainValid && microsoftProbe && reachable === 'invalid') {
        verdictSummary =
            `${email} — Microsoft 365 rejected the probe, so the mailbox could not be confirmed either way`;
    } else if (mailboxVerified === 'no_smtp' && domainValid) {
        verdictSummary =
            `${email} — domain OK but mailbox could not be verified (SMTP blocked or unknown)`;
    }

    return {
        email: data.input || email,
        domain_valid: domainValid,
        mailbox_verified: mailboxVerified,
        valid,
        checks,
        mx_records: mxRecords,
        misc: {
            disposable,
            role_account: !!misc.is_role_account,
            free_provider: false,
        },
        smtp_host: mxRecords[0]?.host || '',
        smtp_response: smtpRan
            ? `is_reachable=${reachable}, is_deliverable=${deliverable}`
            : smtpErrorText,
        engine_error: smtpFailureInfo ? `${smtpFailureInfo.type}: ${smtpFailureInfo.message}`.trim() : '',
        verdict_summary: verdictSummary,
        syntax_valid: syntaxValid,
        smtp_check_ran: smtpRan,
        smtp_deliverable: deliverable,
        catch_all: catchAll,
        microsoft_unverified: Boolean(microsoftProbe && reachable === 'invalid'),
        engine: 'reacher',
        reacher_raw: data,
    };
}

async function checkReacherHealth() {
    try {
        const { data } = await axios.get(
            `${REACHER_BASE}/version`,
            {
                timeout: 5000,
                headers: reacherHeaders(),
            }
        );

        return !!data;
    } catch (_) {
        return false;
    }
}

async function verifyWithReacher(email) {
    const proxy = process.env.SMTP_PROXY;

    const body = {
        to_email: email,
        hello_name: 'reacher.app',
    };

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

    const timeout = parseInt(
        process.env.REACHER_TIMEOUT_MS || '45000',
        10
    );

    const { data } = await axios.post(
        `${REACHER_BASE}/v0/check_email`,
        body,
        {
            timeout,
            headers: reacherHeaders(),
        }
    );

    return mapReacherToReport(data, email);
}

module.exports = {
    verifyWithReacher,
    checkReacherHealth,
    REACHER_BASE,
    mapReacherToReport,
};
