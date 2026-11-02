const crypto = require('crypto');

// Backend secrets are stored encrypted at rest and never sent back to the browser.
// Key material comes from SETTINGS_ENCRYPTION_KEY when set, otherwise from JWT_SECRET,
// so an existing deployment works without adding another environment variable.
function keyMaterial() {
    const raw = process.env.SETTINGS_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
    if (!raw) {
        throw new Error('SETTINGS_ENCRYPTION_KEY or JWT_SECRET must be set to store backend secrets');
    }
    return crypto.createHash('sha256').update(`reacher-backend-secret:${raw}`).digest();
}

function encryptSecret(plain) {
    if (!plain) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return [
        'v1',
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        enc.toString('base64'),
    ].join(':');
}

// Returns '' when the blob is missing, corrupt, or was encrypted under a different key.
// Callers treat an empty secret as "configured without a secret" and surface a hint.
function decryptSecret(blob) {
    if (!blob) return '';
    const parts = String(blob).split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return '';
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(parts[1], 'base64'));
        decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
    } catch (_) {
        return '';
    }
}

function canDecrypt(blob) {
    if (!blob) return false;
    return decryptSecret(blob) !== '';
}

module.exports = { encryptSecret, decryptSecret, canDecrypt };
