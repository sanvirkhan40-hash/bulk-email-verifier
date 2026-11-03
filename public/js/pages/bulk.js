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
            const rows = job.fileRows || [];
            results = [];
            const stats = { valid: 0, invalid: 0, disposable: 0, noSmtp: 0, risky: 0, catchAll: 0, completed: 0 };
            const map = job.verifyMap || {};

            rows.forEach(row => {
                const v = map[row.email];
                if (!v) return;
                const item = {
                    email: row.email,
                    originalRow: row.originalRow,
                    domain_valid: !!v.domain_valid,
                    mailbox_verified: v.mailbox_verified || 'no_smtp',
                    valid: !!v.valid,
                    smtp_response: v.smtp_response || '',
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

        async function runVerificationLoop(job) {
            jobRunning = true;
            BulkJob.setActive(true);
            const emails = job.emails || [];
            let nextEmailIndex = job.nextEmailIndex || 0;
            job.verifyMap = job.verifyMap || {};

            progressArea.classList.remove('d-none');
            document.getElementById('resultsTableSection').classList.remove('d-none');
            uploadBtn.disabled = true;
            fileInput.disabled = true;
            job.status = 'running';
            BulkJob.saveBulkJob(job);

            const pending = interleaveByProvider(emails.filter(email => !job.verifyMap[email]));
            let cursor = 0;
            let completed = Object.keys(job.verifyMap || {}).length;

            async function worker() {
                while (cursor < pending.length) {
                    const email = pending[cursor];
                    cursor += 1;

                    // The server answers 429 when a provider cap is too far away to
                    // wait on this connection. Sleep for the hinted time and retry
                    // instead of turning the address into a bogus result.
                    let attempts = 0;
                    let stored = false;
                    while (!stored && attempts < 10) {
                        attempts += 1;
                        try {
                            const res = await axios.post('/api/verify/single', { email, source: 'bulk' }, { timeout: 60000 });
                            job.verifyMap[email] = res.data;
                            stored = true;
                        } catch (error) {
                            const status = error.response && error.response.status;

                            if (status === 429) {
                                const hint = Number(error.response.data && error.response.data.retryAfter) || 30;
                                const wait = Math.min(Math.max(hint, 5), 120);
                                progressText.textContent = `Rate limit — waiting ${wait}s…`;
                                await new Promise(resolve => setTimeout(resolve, wait * 1000));
                                continue;
                            }

                            // Network blips and 5xx are worth another try before we
                            // write the address off.
                            const transient = !error.response || status >= 500;
                            if (transient && attempts < 3) {
                                progressText.textContent = `Retrying ${email}…`;
                                await new Promise(resolve => setTimeout(resolve, 3000));
                                continue;
                            }

                            const data = (error.response && error.response.data) || {};
                            const reason = data.message || data.error || error.message || 'request failed';
                            job.verifyMap[email] = {
                                email,
                                valid: false,
                                domain_valid: false,
                                mailbox_verified: 'no_smtp',
                                status: 'error',
                                engine: 'error',
                                smtp_response: 'Not processed: ' + reason,
                                verdict_summary: email + ' — not processed: ' + reason,
                            };
                            stored = true;
                        }
                    }

                    if (!stored) {
                        job.verifyMap[email] = { email, valid: false, domain_valid: true, mailbox_verified: 'no_smtp', status: 'no_smtp' };
                    }

                    completed += 1;
                    job.completedCount = completed;
                    syncResultsUI(job);
                    BulkJob.saveBulkJob(job);
                }
            }

            await Promise.all(Array.from({ length: CONCURRENCY }, worker));

            job.status = 'done';
            jobRunning = false;
            BulkJob.setActive(false);
            BulkJob.saveBulkJob(job);
            await persistBulkJob(job);
            showToast('Bulk verification complete!', 'success');
            exportBtn.classList.remove('d-none');
            exportValidBtn.classList.remove('d-none');
            uploadBtn.textContent = '🔄 Verify Another File';
            uploadBtn.disabled = false;
            fileInput.disabled = false;
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
        }

        function dismissBanner() {
            const banner = document.getElementById('resumeBanner');
            if (banner) banner.classList.add('d-none');
        }

        // A saved run is data, never a command: it is shown with its progress and
        // waits for Resume or Discard.
        function offerSavedRun(job) {
            const banner = document.getElementById('resumeBanner');
            if (!banner || !job) return;
            const state = BulkJob.progress(job);
            const finished = job.status === 'done';

            banner.classList.remove('d-none');
            document.getElementById('resumeBannerText').textContent =
                (finished ? 'Finished run: ' : 'Unfinished run: ') + job.fileName +
                ' — ' + state.done + ' of ' + state.total + ' checked · ' + BulkJob.describe(job);

            const resume = document.getElementById('resumeJobBtn');
            resume.textContent = finished ? 'Show results' : 'Resume';
            resume.onclick = () => {
                dismissBanner();
                if (finished) {
                    showResults(job);
                    return;
                }
                runVerificationLoop(job);
            };

            const discard = document.getElementById('discardJobBtn');
            if (discard) {
                discard.onclick = () => {
                    BulkJob.clear();
                    currentJob = null;
                    results = [];
                    fileRows = [];
                    document.getElementById('resultsTableBody').innerHTML = '';
                    document.getElementById('resultsTableSection').classList.add('d-none');
                    progressArea.classList.add('d-none');
                    document.getElementById('fileNameDisplay').classList.add('d-none');
                    dismissBanner();
                    showToast('Saved run discarded', 'info');
                };
            }
        }

        document.addEventListener('DOMContentLoaded', () => {
            const saved = BulkJob.loadBulkJob();
            if (saved) offerSavedRun(saved);
        });

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

                const job = BulkJob.create({ fileName: file.name, emails: emails, fileRows: fileRows });
                job.status = 'running';
                job.results = [];
                job.stats = { valid: 0, invalid: 0, disposable: 0, noSmtp: 0, risky: 0, catchAll: 0, completed: 0 };
                currentJob = job;
                BulkJob.saveBulkJob(job);
                await runVerificationLoop(job);
            } catch (err) {
                showToast(err.response?.data?.message || 'Upload failed', 'error');
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
