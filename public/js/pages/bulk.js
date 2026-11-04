const uploadForm    = document.getElementById('uploadForm');
        const fileInput     = document.getElementById('fileInput');
        const uploadBtn     = document.getElementById('uploadBtn');
        const progressArea  = document.getElementById('progressArea');
        const progressText  = document.getElementById('progressText');
        const progressBar   = document.getElementById('progressBar');
        const exportBtn     = document.getElementById('exportBtn');
        const exportValidBtn = document.getElementById('exportValidBtn');
        const dropZone      = document.getElementById('dropZone');

        let results = [];
        let fileRows = [];
        let jobRunning = false;
        const CONCURRENCY = 3;

        // Run controls. Pause/Stop only affect the queue: a check already in
        // flight is always allowed to finish, so nothing is left half-recorded.
        const runControl = { paused: false, stopped: false };

        const pauseBtn = document.getElementById('bulkPauseBtn');
        const stopBtn = document.getElementById('bulkStopBtn');
        const restartBtn = document.getElementById('bulkRestartBtn');
        const clearBtn = document.getElementById('bulkClearBtn');

        function setControlState(mode) {
            const running = mode === 'running';
            const paused = mode === 'paused';
            const idle = mode === 'idle';

            if (pauseBtn) {
                pauseBtn.disabled = !(running || paused);
                pauseBtn.innerHTML = paused
                    ? '<i class="fa-solid fa-play"></i>Resume'
                    : '<i class="fa-solid fa-pause"></i>Pause';
            }
            if (stopBtn) stopBtn.disabled = !(running || paused);
            if (restartBtn) restartBtn.disabled = running || idle;
            if (clearBtn) clearBtn.disabled = running;
        }

        // Group by provider, then round-robin so a file sorted by domain does
        // not send all Gmail first and leave Outlook/Other waiting.
        function providerOf(email) {
            const domain = String(email || '').split('@').pop().toLowerCase();
            if (['gmail.com', 'googlemail.com'].includes(domain)) return 'gmail';
            if (['yahoo.com', 'ymail.com', 'rocketmail.com'].includes(domain)) return 'yahoo';
            if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'microsoft';
            return 'other';
        }

        function interleaveByProvider(emails) {
            const buckets = { gmail: [], microsoft: [], other: [], yahoo: [] };
            emails.forEach(email => { (buckets[providerOf(email)] || buckets.other).push(email); });
            const order = ['gmail', 'microsoft', 'other', 'yahoo'];
            const out = [];
            let added = true;
            while (added) {
                added = false;
                for (const key of order) {
                    const next = buckets[key].shift();
                    if (next) { out.push(next); added = true; }
                }
            }
            return out;
        }

        BulkJob.guardNavigationWhileRunning();

        function updateStatsUI(stats, total) {
            document.getElementById('pValid').textContent = stats.valid;
            document.getElementById('pInvalid').textContent = stats.invalid;
            document.getElementById('pDisposable').textContent = stats.disposable;
            document.getElementById('pNoSmtp').textContent = stats.noSmtp;
            const riskyEl = document.getElementById('pRisky');
            if (riskyEl) riskyEl.textContent = stats.risky || 0;
            const catchAllEl = document.getElementById('pCatchAll');
            if (catchAllEl) catchAllEl.textContent = stats.catchAll || 0;
            const pct = total ? Math.round((stats.completed / total) * 100) : 0;
            progressBar.style.width = pct + '%';
            progressText.textContent = `${stats.completed} / ${total}`;
        }

        function renderAllRows() {
            document.getElementById('resultsTableBody').innerHTML = '';
            rowIndex = 0;
            results.forEach(item => addResultRow(item));
        }

        function syncResultsUI(job) {
            let rows = job.fileRows || [];
            const map = job.verifyMap || {};

            // A job picked up from the server may not have fileRows (older runs,
            // another device): fall back to the results themselves.
            if (!rows.length && Object.keys(map).length) {
                rows = Object.keys(map).map(email => ({ email: email }));
                job.fileRows = rows;
            }

            results = [];
            const stats = { valid: 0, invalid: 0, disposable: 0, noSmtp: 0, risky: 0, catchAll: 0, completed: 0 };

            rows.forEach(row => {
                const key = String(row.email || '');
                const v = map[key] || map[key.toLowerCase()];
                if (!v) return;
                const item = {
                    email: row.email,
                    originalRow: row.originalRow,
                    domain_valid: !!v.domain_valid,
                    mailbox_verified: v.mailbox_verified || 'no_smtp',
                    valid: !!v.valid,
                    smtp_response: v.smtp_response || '',
                    catch_all: Boolean(v.catch_all),
                    status: v.status || 'invalid',
                    engine: v.engine || '',
                    backend: v.backend || '',
                    fallback: Boolean(v.report && v.report.fallback_from),
                };
                results.push(item);
                stats.completed++;
                if (item.valid) stats.valid++;
                else if (item.status === 'disposable' || v.misc?.disposable) stats.disposable++;
                else if (item.mailbox_verified === 'no_smtp') stats.noSmtp++;
                else if (item.status === 'risky' || item.mailbox_verified === 'risky') stats.risky++;
                else if (item.status === 'catch_all' || item.mailbox_verified === 'catch_all') stats.catchAll++;
                else stats.invalid++;
            });

            job.results = results;
            job.stats = stats;
            document.getElementById('resultsTableBody').innerHTML = '';
            rowIndex = 0;
            results.forEach(item => addResultRow(item));
            updateStatsUI(stats, rows.length);
        }

        function showResults(job) {
            currentJob = job;
            fileRows = job.fileRows || [];
            document.getElementById('fileNameText').textContent = job.fileName || 'Uploaded file';
            document.getElementById('fileNameDisplay').classList.remove('d-none');
            progressArea.classList.remove('d-none');
            document.getElementById('resultsTableSection').classList.remove('d-none');
            syncResultsUI(job);
            exportBtn.classList.remove('d-none');
            exportValidBtn.classList.remove('d-none');
            setControlState(job.status === 'done' ? 'done' : 'paused');
        }

        function dismissBanner() {
            const banner = document.getElementById('resumeBanner');
            if (banner) banner.classList.add('d-none');
        }

        // Every run lives on the server. On load we attach to it — running or
        // paused — and just watch. Nothing is started from the browser.
        async function attachToJob(id, localJob) {
            const { data } = await axios.get('/api/verify/jobs/' + id + '?since=0');
            const job = localJob || BulkJob.create({
                fileName: data.fileName || 'Uploaded file',
                emails: data.emails || [],
                fileRows: data.fileRows || [],
            });

            job.serverJobId = id;
            job.fileName = data.fileName || job.fileName;
            if (Array.isArray(data.emails) && data.emails.length) job.emails = data.emails;
            if (Array.isArray(data.fileRows) && data.fileRows.length) job.fileRows = data.fileRows;
            job.verifyMap = job.verifyMap || {};
            (data.results || []).forEach(row => { job.verifyMap[row.email] = row; });
            job.resultCount = (data.results || []).length;
            job.total = data.total;
            job.status = data.status === 'done' ? 'done' : (data.status === 'cancelled' ? 'paused' : 'running');

            serverJobId = id;
            pollIndex = job.resultCount;
            currentJob = job;
            jobRunning = false;

            showResults(job);
            progressArea.classList.remove('d-none');
            progressText.textContent = data.done + ' / ' + data.total;

            if (data.status === 'done' || data.status === 'cancelled' || data.status === 'error') {
                BulkJob.saveBulkJob(job);
                setControlState(data.status === 'done' ? 'done' : 'paused');
                return true;
            }

            BulkJob.saveBulkJob(job);
            runControl.paused = data.status === 'paused';
            setControlState(data.status === 'paused' ? 'paused' : 'running');
            if (data.status !== 'paused') startPolling();
            return true;
        }

        let restoring = false;

        async function restoreOnLoad() {
            if (restoring) return;
            restoring = true;
            try {
                // 1. the run this browser was last attached to
                const saved = BulkJob.loadBulkJob();
                if (saved && saved.serverJobId) {
                    try {
                        await attachToJob(saved.serverJobId, saved);
                        return;
                    } catch (reason) {
                        // The job was cleared elsewhere: forget the local copy.
                        BulkJob.clear();
                    }
                }

                // 2. any active run on the server (new browser, other device)
                const { data: jobs } = await axios.get('/api/verify/jobs');
                const list = Array.isArray(jobs) ? jobs : [];
                const active = list.find(job => ['queued', 'running', 'paused'].includes(job.status));
                if (active) {
                    await attachToJob(active.id || active._id);
                    return;
                }

                // 3. last finished run, so the page is not empty
                const finished = list.find(job => job.status === 'done' || job.status === 'cancelled');
                if (finished) await attachToJob(finished.id || finished._id);
            } catch (error) {
                // offline or not logged in — leave the page alone
            } finally {
                restoring = false;
            }
        }

        document.addEventListener('DOMContentLoaded', restoreOnLoad);

        // Leaving the page pauses the run instead of leaving it marked "running",
        // so a refresh can only ever offer to continue.
        window.addEventListener('pagehide', () => {
            if (currentJob && jobRunning) {
                currentJob.status = 'paused';
                jobRunning = false;
                BulkJob.setActive(false);
                BulkJob.flush(currentJob);
            }
        });

        /* ── Server-side runs (keep going after the tab closes) ── */
        let serverJobId = null;
        let pollTimer = null;
        let pollIndex = 0;
        let pollBusy = false;

        function stopPolling() {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
            pollBusy = false;
        }

        function startPolling() {
            stopPolling();
            pollTimer = setInterval(pollServerJob, 2500);
            pollServerJob();
        }

        async function pollServerJob() {
            if (!serverJobId || pollBusy || !currentJob) return;
            pollBusy = true;
            try {
                const { data } = await axios.get('/api/verify/jobs/' + serverJobId + '?since=' + pollIndex);
                (data.results || []).forEach(row => { currentJob.verifyMap[row.email] = row; });
                pollIndex += (data.results || []).length;
                currentJob.resultCount = pollIndex;
                currentJob.total = data.total;
                syncResultsUI(currentJob);
                BulkJob.saveBulkJob(currentJob);
                progressText.textContent = data.done + ' / ' + data.total + ' (server)';

                if (data.status === 'done') finishServerRun('done');
                else if (data.status === 'cancelled') finishServerRun('cancelled');
                else if (data.status === 'error') finishServerRun('error', data.error);
                else if (data.status === 'paused') setControlState('paused');
            } catch (error) {
                // A job deleted here or on another device: stop watching it.
                if (error.response && error.response.status === 404) {
                    stopPolling();
                    serverJobId = null;
                    BulkJob.clear();
                    currentJob = null;
                    progressArea.classList.add('d-none');
                    document.getElementById('resultsTableSection').classList.add('d-none');
                    setControlState('idle');
                }
            } finally {
                pollBusy = false;
            }
        }

        async function startServerJob(fileName, emails, rows) {
            const job = BulkJob.create({ fileName: fileName, emails: emails, fileRows: rows });
            try {
                // Very wide files can push the payload past the body limit; the
                // original columns are only used for the CSV, so drop them before
                // the request rather than losing the run.
                let fileRows = rows;
                const probe = JSON.stringify({ fileName: fileName, emails: emails, fileRows: fileRows });
                if (probe.length > 8 * 1024 * 1024) fileRows = [];

                const { data } = await axios.post('/api/verify/jobs', {
                    fileName: fileName,
                    emails: emails,
                    fileRows: fileRows,
                });
                job.serverJobId = data.id;
                job.status = 'running';
                job.resultCount = 0;
                serverJobId = data.id;
                pollIndex = 0;
                currentJob = job;
                jobRunning = false;             // the server owns the work
                BulkJob.setActive(false);
                showResults(job);
                setControlState('running');
                progressText.textContent = '0 / ' + data.total + ' (server)';
                BulkJob.saveBulkJob(job);
                startPolling();
                showToast('Run started on the server — you can close this tab', 'success');
            } catch (error) {
                const status = error.response && error.response.status;
                const message = status === 413
                    ? 'That list is too large to send in one request. Split the file and try again.'
                    : ((error.response && error.response.data && error.response.data.message) || 'Could not start the server run');
                showToast(message, 'error');
                resetUI();
            }
        }

        function watchServerJob(job) {
            serverJobId = job.serverJobId;
            pollIndex = Number(job.resultCount || 0);
            currentJob = job;
            showResults(job);
            setControlState('running');
            startPolling();
        }

        function finishServerRun(status, error) {
            stopPolling();
            if (currentJob) {
                currentJob.status = status === 'done' ? 'done' : 'paused';
                if (status === 'done') currentJob.savedToServer = true;   // history already written
                BulkJob.saveBulkJob(currentJob);
            }
            exportBtn.classList.remove('d-none');
            exportValidBtn.classList.remove('d-none');
            uploadBtn.disabled = false;
            fileInput.disabled = false;
            setControlState(status === 'done' ? 'done' : 'paused');
            if (status === 'done') showToast('Server run finished', 'success');
            else if (status === 'cancelled') showToast('Server run cancelled', 'info');
            else if (status === 'error') showToast('Server run failed: ' + (error || 'unknown'), 'error');
        }

        function clearEverything() {
            BulkJob.clear();
            stopPolling();
            serverJobId = null;
            pollIndex = 0;
            currentJob = null;
            results = [];
            fileRows = [];
            document.getElementById('resultsTableBody').innerHTML = '';
            document.getElementById('resultsTableSection').classList.add('d-none');
            progressArea.classList.add('d-none');
            document.getElementById('fileNameDisplay').classList.add('d-none');
            exportBtn.classList.add('d-none');
            exportValidBtn.classList.add('d-none');
            uploadBtn.textContent = 'Verify file';
            uploadBtn.disabled = false;
            fileInput.disabled = false;
            dismissBanner();
            setControlState('idle');
            showToast('Cleared', 'info');
        }

        pauseBtn?.addEventListener('click', async () => {
            if (serverJobId) {
                try {
                    const next = !runControl.paused;
                    await axios.post('/api/verify/jobs/' + serverJobId + (next ? '/pause' : '/resume'));
                    runControl.paused = next;
                    setControlState(next ? 'paused' : 'running');
                    progressText.textContent = next ? 'Paused (server)' : 'Resumed (server)';
                    if (next) stopPolling();
                    else startPolling();
                } catch (error) {
                    showToast('Could not change the server run', 'error');
                }
                return;
            }
            if (!jobRunning) return;
            runControl.paused = !runControl.paused;
            setControlState(runControl.paused ? 'paused' : 'running');
            progressText.textContent = runControl.paused ? 'Paused' : 'Resumed';
        });

        stopBtn?.addEventListener('click', async () => {
            if (serverJobId) {
                if (!window.confirm('Stop the server run? Addresses already checked are kept.')) return;
                try {
                    await axios.post('/api/verify/jobs/' + serverJobId + '/cancel');
                    finishServerRun('cancelled');
                } catch (error) {
                    showToast('Could not cancel the server run', 'error');
                }
                return;
            }
            if (!jobRunning) return;
            if (!window.confirm('Stop this run? Addresses already checked are kept — you can resume or restart later.')) return;
            runControl.stopped = true;
            runControl.paused = false;
            progressText.textContent = 'Stopping…';
        });

        restartBtn?.addEventListener('click', async () => {
            if (jobRunning || !currentJob) return;
            if (!window.confirm('Restart this run from the beginning? Every result for this file is cleared and checked again.')) return;

            const emails = currentJob.emails || [];
            const rows = currentJob.fileRows || [];
            const name = currentJob.fileName || 'Uploaded file';

            if (currentJob.serverJobId) {
                try { await axios.post('/api/verify/jobs/' + currentJob.serverJobId + '/cancel'); } catch (_) { /* ignore */ }
            }
            stopPolling();
            serverJobId = null;
            pollIndex = 0;
            BulkJob.clear();
            await startServerJob(name, emails, rows);
        });

        clearBtn?.addEventListener('click', async () => {
            if (jobRunning) return;
            if (!window.confirm('Clear this run and all of its results?')) return;
            if (serverJobId) {
                try { await axios.delete('/api/verify/jobs/' + serverJobId); }
                catch (_) { try { await axios.post('/api/verify/jobs/' + serverJobId + '/cancel'); } catch (__) { /* ignore */ } }
                stopPolling();
                serverJobId = null;
            }
            clearEverything();
        });

        /* ── File drag & drop ─────────────────────────── */
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            if (e.dataTransfer.files.length) {
                fileInput.files = e.dataTransfer.files;
                updateFileDisplay(e.dataTransfer.files[0].name);
            }
        });

        fileInput.addEventListener('change', () => {
            if (fileInput.files.length) updateFileDisplay(fileInput.files[0].name);
        });

        function updateFileDisplay(name) {
            document.getElementById('fileNameText').textContent = name;
            document.getElementById('fileNameDisplay').classList.remove('d-none');
        }

        function ynBadge(val, yesClass = 'bg-success', noClass = 'bg-danger') {
            return `<span class="badge ${val ? yesClass : noClass}">${val ? 'yes' : 'no'}</span>`;
        }

        function mailboxBadge(val) {
            const map = { yes: 'bg-success', no: 'bg-danger', no_smtp: 'bg-warning text-dark', risky: 'bg-warning text-dark', catch_all: 'bg-warning text-dark' };
            const labels = { yes: 'yes', no: 'no', no_smtp: 'no SMTP', risky: 'risky', catch_all: 'catch-all' };
            return `<span class="badge ${map[val] || 'bg-secondary'}">${labels[val] || val || '—'}</span>`;
        }

        function truncate(str, n = 48) {
            if (!str) return '—';
            return str.length > n ? str.slice(0, n) + '…' : str;
        }

        function engineLabel(item) {
            if (!item.engine) return '—';
            if (item.engine === 'reacher') return item.backend || 'Reacher';
            return item.fallback ? 'truemail-go (fallback)' : 'truemail-go';
        }

        let rowIndex = 0;
        function addResultRow(item) {
            rowIndex++;
            const tbody = document.getElementById('resultsTableBody');
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="text-muted small">${rowIndex}</td>
                <td class="fw-medium text-break">${item.email}</td>
                <td>${ynBadge(item.domain_valid)}</td>
                <td>${mailboxBadge(item.mailbox_verified)}</td>
                <td>${ynBadge(item.valid)}</td>
                <td class="small text-muted text-nowrap">${engineLabel(item)}</td>
                <td class="small text-muted" title="${item.smtp_response || ''}">${truncate(item.smtp_response)}</td>
            `;
            tbody.appendChild(tr);
            document.getElementById('resultsTableSection').classList.remove('d-none');
        }

        function buildCsv(rows, validOnly) {
            return CsvExport.buildVerificationCsv(rows, validOnly);
        }

        function downloadCsv(content, name) {
            CsvExport.downloadCsv(content, name);
        }

        function exportFileName(job, validOnly) {
            const base = CsvExport.fileBaseName(job.fileName);
            return validOnly ? `${base}_valid.csv` : `${base}_all.csv`;
        }

        async function persistBulkJob(job) {
            if (job.savedToServer || !job.results?.length) return;
            try {
                await axios.post('/api/history/bulk-jobs', {
                    fileName: job.fileName,
                    rows: job.results,
                    stats: job.stats,
                });
                job.savedToServer = true;
                BulkJob.saveBulkJob(job);
            } catch (err) {
                console.warn('Could not save bulk job to history', err);
            }
        }

        /* ── Form Submit ──────────────────────────────── */
        uploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const file = fileInput.files[0];
            if (!file) return;
            if (jobRunning) {
                showToast('A job is already running', 'warning');
                return;
            }

            BulkJob.clearBulkJob();
            exportBtn.classList.add('d-none');
            exportValidBtn.classList.add('d-none');
            document.getElementById('resultsTableBody').innerHTML = '';
            rowIndex = 0;
            results = [];
            fileRows = [];

            uploadBtn.disabled = true;
            const formData = new FormData();
            formData.append('file', file);

            try {
                showToast('Parsing file...', 'info');
                const res = await axios.post('/api/verify/upload-bulk', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' },
                });

                const { emails, rows } = res.data;
                fileRows = rows || [];
                if (!emails?.length) {
                    showToast('No valid emails found in file', 'error');
                    resetUI();
                    return;
                }

                updateFileDisplay(file.name);
                showToast(`Found ${emails.length} unique emails (${fileRows.length} rows). Verifying...`, 'info');

                // One row per unique address, in the same order as `emails`, so the
                // server can pair them safely.
                const byEmail = new Map();
                fileRows.forEach(row => {
                    const key = String(row.email || '').toLowerCase();
                    if (key && !byEmail.has(key)) byEmail.set(key, row);
                });
                const aligned = emails.map(email => byEmail.get(String(email).toLowerCase()) || { email: email, originalRow: [] });

                await startServerJob(file.name, emails, aligned);
            } catch (err) {
                const status = err.response && err.response.status;
                const message = status === 413
                    ? 'That file is too large to upload. Split it into smaller files.'
                    : (err.response?.data?.message || 'Upload failed');
                showToast(message, 'error');
                resetUI();
            }
        });

        function resetUI() {
            uploadBtn.disabled = false;
            fileInput.disabled = false;
        }

        let currentJob = null;

        exportBtn.addEventListener('click', () => {
            if (!results.length) return;
            const csv = buildCsv(results, false);
            const name = currentJob ? exportFileName(currentJob, false) : `email_verification_all_${new Date().toISOString().slice(0, 10)}.csv`;
            downloadCsv(csv, name);
        });

        exportValidBtn.addEventListener('click', () => {
            const validRows = results.filter(r => r.valid);
            if (!validRows.length) {
                showToast('No valid emails to export', 'warning');
                return;
            }
            const csv = buildCsv(results, true);
            const name = currentJob ? exportFileName(currentJob, true) : `email_verification_valid_${new Date().toISOString().slice(0, 10)}.csv`;
            downloadCsv(csv, name);
        });

/* ── Result filtering (added with the UI rebuild) ─────────────────────── */
(function () {
    function applyFilters() {
        const query = ((document.getElementById('resultFilter') || {}).value || '').toLowerCase();
        const status = ((document.getElementById('resultStatus') || {}).value) || 'all';
        document.querySelectorAll('#resultsTableBody tr').forEach(function (row) {
            const cells = row.children;
            const mailbox = ((cells[3] && cells[3].textContent) || '').trim();
            const valid = ((cells[4] && cells[4].textContent) || '').trim();
            let matchesStatus = true;
            if (status === 'valid') matchesStatus = valid === 'yes';
            else if (status === 'invalid') matchesStatus = mailbox === 'no';
            else if (status === 'unknown') matchesStatus = mailbox === 'no_smtp';
            const matchesText = !query || row.textContent.toLowerCase().indexOf(query) !== -1;
            row.style.display = matchesStatus && matchesText ? '' : 'none';
        });
    }
    document.addEventListener('DOMContentLoaded', function () {
        const input = document.getElementById('resultFilter');
        const select = document.getElementById('resultStatus');
        if (input) input.addEventListener('input', applyFilters);
        if (select) select.addEventListener('change', applyFilters);
    });
})();
