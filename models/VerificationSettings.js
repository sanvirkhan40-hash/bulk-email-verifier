const mongoose = require('mongoose');

// 0 means "no limit" for the minute/day windows. Per-second limits keep a minimum
// of 1 because a zero rate would stall the queue forever.
const VerificationSettingsSchema = new mongoose.Schema({
    key: { type: String, default: 'global', unique: true },

    globalPerSecond: { type: Number, default: 1, min: 1, max: 20 },
    globalPerMinute: { type: Number, default: 60, min: 0, max: 1200 },
    globalPerDay: { type: Number, default: 5000, min: 0, max: 100000 },

    maxConcurrent: { type: Number, default: 2, min: 1, max: 20 },

    providerPerSecond: {
        gmail: { type: Number, default: 1, min: 1, max: 10 },
        yahoo: { type: Number, default: 1, min: 1, max: 10 },
        microsoft: { type: Number, default: 1, min: 1, max: 10 },
        other: { type: Number, default: 1, min: 1, max: 10 },
    },
    providerPerMinute: {
        gmail: { type: Number, default: 30, min: 0, max: 600 },
        yahoo: { type: Number, default: 30, min: 0, max: 600 },
        microsoft: { type: Number, default: 30, min: 0, max: 600 },
        other: { type: Number, default: 30, min: 0, max: 600 },
    },
    providerPerDay: {
        gmail: { type: Number, default: 1000, min: 0, max: 50000 },
        yahoo: { type: Number, default: 1000, min: 0, max: 50000 },
        microsoft: { type: Number, default: 1000, min: 0, max: 50000 },
        other: { type: Number, default: 1000, min: 0, max: 50000 },
    },

    updatedBy: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('VerificationSettings', VerificationSettingsSchema);
