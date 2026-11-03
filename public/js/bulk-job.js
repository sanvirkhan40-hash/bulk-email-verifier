/**
 * Bulk run persistence — v2, rebuilt from scratch.
 *
 * Rules this module enforces:
 *  1. Nothing starts without a click. A saved run is restored as *data*; the
 *     page only offers Resume / Discard.
 *  2. "running" is never persisted. If the page goes away mid-run the run is
 *     stored as "paused", so a refresh can only ever offer to continue.
 *  3. Writes are throttled (one every 800ms) and flushed on pause/finish/hide,
 *     so a long run does not hammer localStorage once per email.
 *  4. Only schema 2 is read. The old key is deleted on sight, which also stops
 *     the previous "resume automatically on refresh" behaviour.
 */
(function () {
    const KEY = 'bev.bulkJob.v2';
    const LEGACY_KEYS = ['bulkVerifyJob'];
    const SCHEMA = 2;
    const MAX_BYTES = 4 * 1024 * 1024;
    const SAVE_DELAY_MS = 800;

    let timer = null;
    let active = false;   // a run is executing in this tab right now

    function readRaw(key) {
        try {
            const raw = window.localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function normalize(job) {
        if (!job || job.schema !== SCHEMA) return null;
        if (!Array.isArray(job.emails) || !job.emails.length) return null;
        // A stored run can never be "running": the page that would run it is gone.
        if (job.status !== 'done') job.status = 'paused';
        job.verifyMap = job.verifyMap || {};
        job.fileRows = job.fileRows || [];
        return job;
    }

    function load() {
        LEGACY_KEYS.forEach(key => {
            try { window.localStorage.removeItem(key); } catch (_) { /* ignore */ }
        });
        return normalize(readRaw(KEY));
    }

    function serialize(job) {
        const copy = Object.assign({}, job, {
            status: job.status === 'done' ? 'done' : 'paused',
            updatedAt: Date.now(),
        });
        let text = JSON.stringify(copy);
        if (text.length > MAX_BYTES) {
            copy.fileRows = [];
            text = JSON.stringify(copy);
        }
        return text;
    }

    function flush(job) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!job) return;
        try {
            window.localStorage.setItem(KEY, serialize(job));
        } catch (error) {
            // Quota: keep the results, drop the display rows and try once more.
            try {
                job.fileRows = [];
                window.localStorage.setItem(KEY, serialize(job));
            } catch (_) {
                console.warn('Bulk run could not be saved', error && error.message);
            }
        }
    }

    function save(job) {
        if (!job || timer) return;
        timer = setTimeout(() => {
            timer = null;
            flush(job);
        }, SAVE_DELAY_MS);
    }

    function clear() {
        if (timer) { clearTimeout(timer); timer = null; }
        try { window.localStorage.removeItem(KEY); } catch (_) { /* ignore */ }
    }

    function create(options) {
        return {
            schema: SCHEMA,
            id: 'run-' + Date.now(),
            fileName: options.fileName || 'Uploaded file',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: 'paused',
            emails: options.emails || [],
            fileRows: options.fileRows || [],
            verifyMap: {},
            savedToServer: false,
        };
    }

    function progress(job) {
        const total = job && job.emails ? job.emails.length : 0;
        const done = job && job.verifyMap ? Object.keys(job.verifyMap).length : 0;
        return { total: total, done: done, remaining: Math.max(0, total - done) };
    }

    function describe(job) {
        const state = progress(job);
        const when = job && job.updatedAt ? new Date(job.updatedAt).toLocaleString() : '';
        const label = job && job.status === 'done' ? 'finished' : 'paused';
        return state.done + ' of ' + state.total + ' done · ' + label + (when ? ' ' + when : '');
    }

    function setActive(value) {
        active = Boolean(value);
    }

    function isRunning() {
        return active;
    }

    function guardNavigationWhileRunning() {
        window.addEventListener('beforeunload', event => {
            if (!active) return;
            event.preventDefault();
            event.returnValue = 'Bulk verification is in progress.';
        });

        document.querySelectorAll('.sidebar a.nav-link').forEach(link => {
            link.addEventListener('click', event => {
                if (!active) return;
                const href = link.getAttribute('href');
                if (!href || href.includes('bulk.html') || link.classList.contains('active')) return;
                const ok = window.confirm('Bulk verification is still running. Leave this page? The run is saved and can be resumed.');
                if (!ok) event.preventDefault();
            });
        });
    }

    window.BulkJob = {
        SCHEMA: SCHEMA,
        load: load,
        save: save,
        flush: flush,
        clear: clear,
        create: create,
        progress: progress,
        describe: describe,
        isBulkJobRunning: isRunning,
        setActive: setActive,
        guardNavigationWhileRunning: guardNavigationWhileRunning,
        // names the page still calls
        saveBulkJob: save,
        loadBulkJob: load,
        clearBulkJob: clear,
    };
})();
