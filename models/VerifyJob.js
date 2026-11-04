const mongoose = require('mongoose');

// One row of a finished check, trimmed to what the UI and the CSV need.
const JobResultSchema = new mongoose.Schema({
    email: String,
    status: String,
    valid: Boolean,
    domain_valid: Boolean,
    mailbox_verified: String,
    catch_all: Boolean,
    smtp_response: String,
    engine: String,
    backend: String,
    verdict_summary: String,
    checked_at: Date,
}, { _id: false });

/**
 * A server-side bulk run. The page creates it and then only watches: closing
 * the browser leaves the job in Mongo and the worker keeps going.
 */
const VerifyJobSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fileName: { type: String, default: 'Uploaded file' },
    // queued -> running -> done; paused / cancelled can be set by the user.
    status: { type: String, default: 'queued', index: true },
    emails: { type: [String], default: [] },
    fileRows: { type: [mongoose.Schema.Types.Mixed], default: [] },
    total: { type: Number, default: 0 },
    nextIndex: { type: Number, default: 0 },
    results: { type: [JobResultSchema], default: [] },
    done: { type: Number, default: 0 },
    error: { type: String, default: '' },
    workerId: { type: String, default: '' },
    lockedAt: Date,
    finishedAt: Date,
}, { timestamps: true });

module.exports = mongoose.model('VerifyJob', VerifyJobSchema);
