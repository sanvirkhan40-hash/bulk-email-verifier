const VerifyJob = require('../models/VerifyJob');

const MAX_EMAILS = 20000;

// @desc   Create a server-side bulk job; the browser only watches it afterwards
const createJob = async (req, res) => {
    try {
        const { fileName, emails, fileRows } = req.body || {};

        if (!Array.isArray(emails) || !emails.length) {
            return res.status(400).json({ message: 'emails must be a non-empty array' });
        }

        // Emails and their original spreadsheet rows are paired by position, so
        // they are filtered together — otherwise a duplicate or invalid address
        // shifts every row after it and the table shows the wrong columns.
        const pairs = [];
        const seen = new Set();
        const incomingRows = Array.isArray(fileRows) ? fileRows : [];

        emails.forEach((raw, index) => {
            const email = String(raw || '').trim().toLowerCase();
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
            if (seen.has(email)) return;
            seen.add(email);
            pairs.push({ email, row: incomingRows[index] || { email } });
        });

        if (!pairs.length) {
            return res.status(400).json({ message: 'No valid addresses in the list' });
        }
        if (pairs.length > MAX_EMAILS) {
            return res.status(400).json({ message: `Too many addresses (${pairs.length}). Limit is ${MAX_EMAILS} per run.` });
        }

        // One run at a time: a second job would sit behind the first and the page
        // could only watch one of them.
        const active = await VerifyJob.findOne({
            user: req.user._id,
            status: { $in: ['queued', 'running', 'paused'] },
        }).select('_id').lean();
        if (active) {
            return res.status(409).json({ message: 'A run is already in progress. Finish or clear it first.' });
        }

        // Mongo documents cap at 16 MB; the original columns are only needed for
        // the CSV export, so drop them rather than fail the whole run.
        let rows = pairs.map(pair => pair.row);
        if (Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024) rows = [];

        const job = await VerifyJob.create({
            user: req.user._id,
            fileName: fileName || 'Uploaded file',
            emails: pairs.map(pair => pair.email),
            fileRows: rows,
            total: pairs.length,
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
            { returnDocument: 'after' },
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

// @desc   Remove a job entirely (Clear). Other devices then see nothing at all.
const deleteJob = async (req, res) => {
    try {
        const result = await VerifyJob.deleteOne({ _id: req.params.id, user: req.user._id });
        if (!result.deletedCount) return res.status(404).json({ message: 'Job not found' });
        res.json({ deleted: true });
    } catch (error) {
        res.status(500).json({ message: 'Could not delete the job', error: error.message });
    }
};

// @desc   Most recent server-side runs for this user
const listJobs = async (req, res) => {
    try {
        const jobs = await VerifyJob.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .limit(20)
            .select('fileName status total done createdAt finishedAt')
            .lean();
        // The client needs a plain `id`; Mongo documents only carry `_id`.
        res.json(jobs.map(job => ({
            id: String(job._id),
            fileName: job.fileName,
            status: job.status,
            total: job.total,
            done: job.done,
            createdAt: job.createdAt,
            finishedAt: job.finishedAt,
        })));
    } catch (error) {
        res.status(500).json({ message: 'Could not list jobs', error: error.message });
    }
};

module.exports = { createJob, getJob, pauseJob, resumeJob, cancelJob, deleteJob, listJobs };
