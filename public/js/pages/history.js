let fullHistory = [];
        let filteredHistory = [];
        let bulkJobs = [];
        let selectedJobIds = new Set();
        let currentPage = 1;
        const itemsPerPage = 15;

        function isValidRecord(record) {
            const s = String(record.status || '').toLowerCase();
            if (s === 'valid' || s === 'ok') return true;
            return record.details?.report?.valid === true;
        }

        // Which engine/backend produced this record (stored on the saved report).
        function checkedBy(record) {
            const report = record.details && record.details.report ? record.details.report : {};
            const backend = report.engine_backend || '';
            if (report.fallback_from) return 'truemail-go (fallback)';
            if (backend && backend !== 'truemail-go') return backend;
            return backend === 'truemail-go' ? 'truemail-go' : (report.engine === 'reacher' ? 'Reacher' : '—');
        }

        function statusBadgeClass(record) {
            if (isValidRecord(record)) return 'bg-success';
            const s = String(record.status || '').toLowerCase();
            if (s === 'fail' || s === 'error' || s === 'invalid') return 'bg-danger';
            if (s === 'disposable' || s === 'catch_all') return 'bg-warning text-dark';
            if (s === 'unknown' || s === 'no_smtp') return 'bg-secondary';
            return 'bg-danger';
        }

        function statusLabel(record) {
            return isValidRecord(record) ? 'VALID' : String(record.status || 'unknown').toUpperCase();
        }

        function updateExportButtons() {
            const hasSelection = selectedJobIds.size > 0;
            document.getElementById('exportSelectedAllBtn').disabled = !hasSelection;
            document.getElementById('exportSelectedValidBtn').disabled = !hasSelection;
        }

        function syncSelectAllCheckbox() {
            const checkbox = document.getElementById('selectAllJobsCheckbox');
            if (!bulkJobs.length) {
                checkbox.checked = false;
                checkbox.indeterminate = false;
                return;
            }
            checkbox.checked = selectedJobIds.size === bulkJobs.length;
            checkbox.indeterminate = selectedJobIds.size > 0 && selectedJobIds.size < bulkJobs.length;
        }

        async function exportJobs(jobIds, validOnly) {
            let exported = 0;
            for (const id of jobIds) {
                try {
                    const res = await axios.get(`/api/history/bulk-jobs/${id}`);
                    const ok = CsvExport.exportJobCsv(res.data, validOnly);
                    if (ok) exported++;
                } catch (err) {
                    showToast(`Could not export job`, 'error');
                }
            }
            if (exported) {
                showToast(`Downloaded ${exported} file${exported > 1 ? 's' : ''}`, 'success');
            } else {
                showToast(validOnly ? 'No valid emails in selected jobs' : 'Nothing to export', 'warning');
            }
        }

        function renderJobsTable() {
            const tbody = document.getElementById('jobsBody');
            tbody.innerHTML = '';

            if (!bulkJobs.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No bulk jobs yet. Run a bulk verification to see downloadable results here.</td></tr>';
                updateExportButtons();
                syncSelectAllCheckbox();
                return;
            }

            bulkJobs.forEach(job => {
                const tr = document.createElement('tr');
                const checked = selectedJobIds.has(job._id) ? 'checked' : '';
                const stats = job.stats || {};
                tr.innerHTML = `
                    <td><input type="checkbox" class="form-check-input job-select" data-id="${job._id}" ${checked}></td>
                    <td class="fw-medium"><i class="fa-solid fa-file-csv me-2 text-primary"></i>${job.fileName}</td>
                    <td>${stats.total ?? '—'}</td>
                    <td class="text-success fw-semibold">${stats.valid ?? '—'}</td>
                    <td class="text-danger fw-semibold">${stats.invalid ?? '—'}</td>
                    <td class="text-muted small">${new Date(job.completedAt).toLocaleString()}</td>
                    <td>
                        <div class="btn-group btn-group-sm">
                            <button type="button" class="btn btn-outline-success job-export-all" data-id="${job._id}" title="Download all results">
                                <i class="fa-solid fa-download"></i>
                            </button>
                            <button type="button" class="btn btn-success job-export-valid" data-id="${job._id}" title="Download valid only">
                                <i class="fa-solid fa-check"></i>
                            </button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });

            tbody.querySelectorAll('.job-select').forEach(cb => {
                cb.addEventListener('change', e => {
                    const id = e.target.dataset.id;
                    if (e.target.checked) selectedJobIds.add(id);
                    else selectedJobIds.delete(id);
                    updateExportButtons();
                    syncSelectAllCheckbox();
                });
            });

            tbody.querySelectorAll('.job-export-all').forEach(btn => {
                btn.addEventListener('click', () => exportJobs([btn.dataset.id], false));
            });

            tbody.querySelectorAll('.job-export-valid').forEach(btn => {
                btn.addEventListener('click', () => exportJobs([btn.dataset.id], true));
            });

            updateExportButtons();
            syncSelectAllCheckbox();
        }

        document.getElementById('selectAllJobsCheckbox').addEventListener('change', e => {
            selectedJobIds.clear();
            if (e.target.checked) bulkJobs.forEach(job => selectedJobIds.add(job._id));
            renderJobsTable();
        });

        document.getElementById('selectAllJobsBtn').addEventListener('click', () => {
            selectedJobIds.clear();
            bulkJobs.forEach(job => selectedJobIds.add(job._id));
            renderJobsTable();
        });

        document.getElementById('exportSelectedAllBtn').addEventListener('click', () => {
            exportJobs([...selectedJobIds], false);
        });

        document.getElementById('exportSelectedValidBtn').addEventListener('click', () => {
            exportJobs([...selectedJobIds], true);
        });

        document.addEventListener('DOMContentLoaded', async () => {
            let historyOk = false;
            let jobsOk = false;

            try {
                const historyRes = await axios.get('/api/history');
                fullHistory = historyRes.data;
                filteredHistory = [...fullHistory];
                historyOk = true;
                renderTable();
            } catch (err) {
                document.getElementById('historyBody').innerHTML =
                    '<tr><td colspan="4" class="text-center text-danger">Error loading verification log</td></tr>';
                showToast(err.response?.data?.message || 'Failed to load verification log', 'error');
            }

            try {
                const jobsRes = await axios.get('/api/history/bulk-jobs');
                bulkJobs = jobsRes.data;
                jobsOk = true;
                renderJobsTable();
            } catch (err) {
                const msg = err.response?.status === 404
                    ? 'Bulk job downloads require a server restart — run npm start again.'
                    : (err.response?.data?.message || 'Failed to load bulk jobs');
                document.getElementById('jobsBody').innerHTML =
                    `<tr><td colspan="7" class="text-center text-muted">${msg}</td></tr>`;
                if (err.response?.status !== 404) showToast(msg, 'error');
            }

            if (!historyOk && !jobsOk) {
                showToast('Failed to load history', 'error');
            }
        });

        document.getElementById('searchInput').addEventListener('input', e => {
            const term = e.target.value.toLowerCase();
            filteredHistory = fullHistory.filter(h =>
                h.email.toLowerCase().includes(term) ||
                String(h.status).toLowerCase().includes(term)
            );
            currentPage = 1;
            renderTable();
        });

        document.getElementById('prevBtn').addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderTable();
            }
        });

        document.getElementById('nextBtn').addEventListener('click', () => {
            const totalPages = Math.ceil(filteredHistory.length / itemsPerPage);
            if (currentPage < totalPages) {
                currentPage++;
                renderTable();
            }
        });

        function renderTable() {
            const tbody = document.getElementById('historyBody');
            tbody.innerHTML = '';

            if (filteredHistory.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No records found.</td></tr>';
                document.getElementById('paginationControls').classList.add('d-none');
                return;
            }

            const totalPages = Math.ceil(filteredHistory.length / itemsPerPage);
            document.getElementById('pageSpan').innerText = currentPage;
            document.getElementById('totalPagesSpan').innerText = totalPages;
            document.getElementById('paginationControls').classList.remove('d-none');

            document.getElementById('prevBtn').disabled = currentPage === 1;
            document.getElementById('nextBtn').disabled = currentPage === totalPages;

            const startIdx = (currentPage - 1) * itemsPerPage;
            const paginated = filteredHistory.slice(startIdx, startIdx + itemsPerPage);

            paginated.forEach(record => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td class="fw-medium text-break">${record.email}</td>
                    <td><span class="badge ${statusBadgeClass(record)}">${statusLabel(record)}</span></td>
                    <td class="small text-muted text-nowrap">${checkedBy(record)}</td>
                    <td><span class="badge bg-light text-dark border">${record.source.toUpperCase()}</span></td>
                    <td class="text-muted small">${new Date(record.timestamp).toLocaleString()}</td>
                `;
                tbody.appendChild(tr);
            });
        }

/* ── ?q= deep link from the command palette ───────────────────────────── */
(function () {
    document.addEventListener('DOMContentLoaded', function () {
        const q = new URLSearchParams(window.location.search).get('q');
        const input = document.getElementById('searchInput');
        if (!q || !input) return;
        input.value = q;
        input.dispatchEvent(new Event('input'));
    });
})();
