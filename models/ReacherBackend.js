const mongoose = require('mongoose');

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
    limits: {
        perSecond: { type: Number, default: null, min: 0, max: 50 },
        perMinute: { type: Number, default: null, min: 0, max: 1000 },
        perDay: { type: Number, default: null, min: 0, max: 200000 },
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
