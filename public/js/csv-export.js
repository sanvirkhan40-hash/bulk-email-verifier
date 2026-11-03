function fileBaseName(fileName) {
    if (!fileName) return 'email_verification';
    return String(fileName).replace(/\.[^.]+$/, '') || 'email_verification';
}

function engineLabel(row) {
    const engine = String(row.engine || '').toLowerCase();
    if (!engine) return 'unknown';               // never invent an engine name
    if (engine === 'reacher') return row.backend || 'Reacher';
    return row.engine;
}

function buildVerificationCsv(rows, validOnly) {
    const filtered = validOnly ? rows.filter(r => r.valid) : rows;
    if (!filtered.length) return '';

    const maxCols = Math.max(...filtered.map(r => (r.originalRow || []).length), 0);
    const origHeaders = Array.from({ length: maxCols }, (_, i) => `col_${i + 1}`);
    const header = ['valid', 'mailbox_verified', 'catch_all', 'domain_valid', 'email', 'checked_by', 'engine', ...origHeaders, 'smtp_response'].join(',');
    const lines = [header];

    filtered.forEach(r => {
        const orig = r.originalRow || [];
        const padded = origHeaders.map((_, i) => `"${String(orig[i] || '').replace(/"/g, '""')}"`);
        lines.push([
            r.valid ? 'yes' : 'no',
            r.mailbox_verified || 'no_smtp',
            r.catch_all ? 'yes' : 'no',
            r.domain_valid ? 'yes' : 'no',
            `"${r.email}"`,
            `"${engineLabel(r)}"`,
            `"${r.engine || 'unknown'}"`,
            ...padded,
            `"${String(r.smtp_response || '').replace(/"/g, '""')}"`,
        ].join(','));
    });

    return lines.join('\n');
}

function downloadCsv(content, name) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

function exportJobCsv(job, validOnly) {
    const rows = job.rows || [];
    const csv = buildVerificationCsv(rows, validOnly);
    if (!csv) return false;

    const base = fileBaseName(job.fileName);
    const suffix = validOnly ? '_valid' : '_all';
    downloadCsv(csv, `${base}${suffix}.csv`);
    return true;
}

window.CsvExport = { fileBaseName, buildVerificationCsv, downloadCsv, exportJobCsv, engineLabel };
