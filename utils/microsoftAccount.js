// Microsoft account lookup.
//
// Microsoft 365 refuses SMTP probes for reasons that look identical to "no such
// mailbox" (DBEB, alias-only recipients, sender-IP policy), and Reacher does not
// return the response code. The login endpoint Microsoft's own sign-in page uses
// answers the real question — does this account exist — without any SMTP traffic.
const axios = require('axios');

const ENDPOINT = 'https://login.microsoftonline.com/common/GetCredentialType?mkt=en-US';
const EXISTING_RESULTS = new Set([0, 5, 6]); // 0 = exists, 5/6 = exists via another IdP/federation

function isMicrosoftHosted(mxRecords = []) {
    return (mxRecords || []).some(record => {
        const host = String(record && record.host ? record.host : record || '').toLowerCase().replace(/\.$/, '');
        return host.endsWith('.protection.outlook.com') || host === 'protection.outlook.com';
    });
}

async function lookupAccount(email) {
    try {
        const { data } = await axios.post(
            ENDPOINT,
            { Username: email, IsOtherIdpSupported: true, CheckPhones: false },
            { timeout: 10000, headers: { 'Content-Type': 'application/json' }, validateStatus: status => status < 500 },
        );

        const throttle = Number(data?.ThrottleStatus || 0);
        if (throttle !== 0) return { state: 'unknown', reason: 'Microsoft throttled the lookup' };

        const result = Number(data?.IfExistsResult);
        if (result === 1) return { state: 'missing', code: result };
        if (EXISTING_RESULTS.has(result)) return { state: 'exists', code: result };
        return { state: 'unknown', reason: `unexpected result ${result}`, code: result };
    } catch (error) {
        return { state: 'unknown', reason: error.message };
    }
}

// Only touches a report that is not already valid: a positive SMTP/headless
// answer is never downgraded by this lookup.
async function applyToReport(report, email) {
    if (!report || !isMicrosoftHosted(report.mx_records)) return report;

    const account = await lookupAccount(email);
    report.microsoft_account = account.state;

    if (account.state === 'exists' && !report.valid) {
        report.valid = true;
        report.mailbox_verified = 'yes';
        report.microsoft_unverified = false;
        report.verdict_summary = email + ' seems to be valid (Microsoft 365 account confirmed)';
        (report.checks = report.checks || []).push({
            step: 'account',
            passed: true,
            message: 'Microsoft 365 account lookup',
            detail: 'the account exists',
        });
    } else if (account.state === 'missing' && !report.valid) {
        report.valid = false;
        report.mailbox_verified = 'no';
        report.microsoft_unverified = false;
        report.verdict_summary = email + ' does not exist (Microsoft 365 account lookup)';
        (report.checks = report.checks || []).push({
            step: 'account',
            passed: false,
            message: 'Microsoft 365 account lookup',
            detail: 'no such account',
        });
    } else if (account.state === 'unknown') {
        (report.checks = report.checks || []).push({
            step: 'account',
            passed: false,
            message: 'Microsoft 365 account lookup unavailable',
            detail: account.reason || 'no answer',
        });
    }

    return report;
}

module.exports = { isMicrosoftHosted, lookupAccount, applyToReport };
