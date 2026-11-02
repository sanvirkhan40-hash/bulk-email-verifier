const mongoose = require('mongoose');

function providerLimitsSchema() {
    return {
        perSecond: { type: Number, default: null, min: 0, max: 50 },
        perMinute: { type: Number, default: null, min: 0, max: 1000 },
        perDay: { type: Number, default: null, min: 0, max: 200000 },
    };
}

const ReacherBackendSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, unique: true, maxlength: 80 },
    url: { type: String, required: true, trim: true, maxlength: 300 },
    // Secrets are encrypted with utils/secretBox and never returned by the API.
    secretEnc: { type: String, default: '', select: false },
    enabled: { type: Boolean, default: true },
    // Manual "do not use" switch from the UI. A locked backend stays configured
    // and keeps its history, but the pool never dispatches checks to it.
    locked: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    // Optional per-backend limits. null = follow the global rate limits.
    // When ANY value is set here, this backend ignores the global values
    // entirely and uses only what is set (missing pieces become unlimited).
    // null everywhere = follow the global row. Any number here makes this
    // Reacher use its own sheet instead of the global one. Provider rows
    // refine the Overall row for that provider only.
    limits: {
        perSecond: { type: Number, default: null, min: 0, max: 50 },
        perMinute: { type: Number, default: null, min: 0, max: 1000 },
        perDay: { type: Number, default: null, min: 0, max: 200000 },
        providers: {
            gmail: providerLimitsSchema(),
            yahoo: providerLimitsSchema(),
            microsoft: providerLimitsSchema(),
            other: providerLimitsSchema(),
        },
    },
    lastStatus: {
        ok: { type: Boolean, default: false },
        version: { type: String, default: '' },
        latencyMs: { type: Number, default: 0 },
        checkedAt: { type: Date, default: null },
        error: { type: String, default: '' },
    },
    stats: {
        checks: { type: Number, default: 0 },
        failures: { type: Number, default: 0 },
        lastUsedAt: { type: Date, default: null },
        lastError: { type: String, default: '' },
    },
}, { timestamps: true });

module.exports = mongoose.model('ReacherBackend', ReacherBackendSchema);
