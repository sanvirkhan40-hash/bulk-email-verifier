const VerifyJob = require('../models/VerifyJob');

const MAX_EMAILS = 20000;

// @desc   Create a server-side bulk job; the browser only watches it afterwards
const createJob = async (req, res) => {
    try {
        const { fileName, emails, fileRows } = req.body || {};

        if (!Array.isArray(emails) || !emails.length) {
            return res.status(400).json({ message: 'emails must be a non-empty array' });
        }
        if (emails.length > MAX_EMAILS) {
            return res.status(400).json({ message: `Too many addresses (${emails.length}). Limit is ${MAX_EMAILS} per run.` });
        }

        const clean = emails
            .map(email => String(email || '').trim().toLowerCase())
            .filter(email => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email));

        if (!clean.length) {
            return res.status(400).json({ message: 'No valid addresses in the list' });
        }

        const job = await VerifyJob.create({
            user: req.user._id,
            fileName: fileName || 'Uploaded file',
            emails: clean,
            fileRows: Array.isArray(fileRows) ? fileRows.slice(0, clean.length) : [],
            total: clean.length,
        });

        res.status(201).json({ id: job._id, total: job.total, status: job.status });
    } catch (error) {
        res.status(500).json({ message: 'Could not create the job', error: error.message });
    }
};

// @desc   Progress + results after `since` (so polling stays small)
const getJob = async (req, res) => {
    try {
        const job = await VerifyJob.findOne({ _id: req.params.id, user: req.user._id }).lean();
        if (!job) return res.status(404).json({ message: 'Job not found' });

        const since = Math.max(0, parseInt(req.query.since || '0', 10) || 0);
        const payload = {
            id: String(job._id),
            fileName: job.fileName,
            status: job.status,
            total: job.total,
            done: job.done,
            error: job.error || '',
            results: (job.results || []).slice(since),
            nextIndex: (job.results || []).length,
        };
        // First call also hands back the list, so a fresh browser can rebuild
        // the table exactly as it was.
        if (since === 0) {
            payload.emails = job.emails || [];
            payload.fileRows = job.fileRows || [];
        }
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: 'Could not load the job', error: error.message });
    }
};

async function setStatus(req, res, from, to, message) {
    try {
        const job = await VerifyJob.findOneAndUpdate(
            { _id: req.params.id, user: req.user._id, status: { $in: from } },
            { $set: { status: to } },
            { new: true },
        );
        if (!job) return res.status(409).json({ message: 'That job cannot be changed right now' });
        res.json({ id: String(job._id), status: job.status });
    } catch (error) {
        res.status(500).json({ message: message + ' failed', error: error.message });
    }
}

const pauseJob = (req, res) => setStatus(req, res, ['queued', 'running'], 'paused', 'Pause');
const resumeJob = (req, res) => setStatus(req, res, ['paused', 'error'], 'queued', 'Resume');
const cancelJob = (req, res) => setStatus(req, res, ['queued', 'running', 'paused'], 'cancelled', 'Cancel');

// @desc   Most recent server-side runs for this user
const listJobs = async (req, res) => {
    try {
        const jobs = await VerifyJob.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .limit(20)
            .select('fileName status total done createdAt finishedAt');
        res.json(jobs);
    } catch (error) {
        res.status(500).json({ message: 'Could not list jobs', error: error.message });
    }
};

module.exports = { createJob, getJob, pauseJob, resumeJob, cancelJob, listJobs };
