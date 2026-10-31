const mongoose = require('mongoose');

const VerificationSettingsSchema = new mongoose.Schema({
    key: { type: String, default: 'global', unique: true },
    globalPerSecond: { type: Number, default: 1, min: 1, max: 20 },
    maxConcurrent: { type: Number, default: 2, min: 1, max: 20 },
    providerPerSecond: {
        gmail: { type: Number, default: 1, min: 1, max: 10 },
        yahoo: { type: Number, default: 1, min: 1, max: 10 },
        microsoft: { type: Number, default: 1, min: 1, max: 10 },
        other: { type: Number, default: 1, min: 1, max: 10 },
    },
    updatedBy: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('VerificationSettings', VerificationSettingsSchema);
