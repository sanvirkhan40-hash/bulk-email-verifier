const mongoose = require('mongoose');

// Per-backend budget. Per-second is deliberately NOT here: that one rate is
// global and shared by every Reacher (VerificationSettings.globalPerSecond).
//   perMinute -> when reached, checks move to the next Reacher and cycle back
//                automatically once the minute window rolls over.
//   perDay    -> when reached, this Reacher is skipped for the rest of the UTC
//                day (a soft lock that clears itself at midnight).
// 0 disables that window.
const LimitsSchema = new mongoose.Schema({
    perMinute: { type: Number, default: 60, min: 0, max: 600 },
    perDay: { type: Number, default: 2000, min: 0, max: 100000 },
}, { _id: false });

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
    limits: { type: LimitsSchema, default: () => ({}) },
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
