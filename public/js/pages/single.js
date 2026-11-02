const verifyForm    = document.getElementById('verifyForm');
        const emailInput    = document.getElementById('emailInput');
        const verifyBtn     = document.getElementById('verifyBtn');
        const resultArea    = document.getElementById('resultArea');
        const loader        = document.getElementById('loader');
        let lastReportText  = '';

        function badge(el, text, cls) {
            el.className = `badge fs-6 px-3 py-2 ${cls}`;
            el.textContent = text;
        }

        function renderChecks(checks) {
            const container = document.getElementById('checksContainer');
            container.innerHTML = '';
            (checks || []).forEach(c => {
                const row = document.createElement('div');
                row.className = 'check-row';
                const icon = c.passed ? 'fa-circle-check text-success' : 'fa-circle-xmark text-danger';
                row.innerHTML = `
                    <div class="check-icon"><i class="fa-solid ${icon}"></i></div>
                    <div class="flex-grow-1">
                        <div class="check-label">${c.message}</div>
                        ${c.detail ? `<div class="check-value text-muted small mt-1">${c.detail}</div>` : ''}
                    </div>
                `;
                container.appendChild(row);
            });
        }

        function renderMisc(misc) {
            const el = document.getElementById('miscContainer');
            const items = [
                { label: 'Disposable', value: misc?.disposable ? 'Yes' : 'No', bad: misc?.disposable },
                { label: 'Role account', value: misc?.role_account ? 'Yes' : 'No', bad: misc?.role_account },
                { label: 'Free provider', value: misc?.free_provider ? 'Yes' : 'No', bad: false },
            ];
            el.innerHTML = items.map(i => `
                <span class="badge ${i.bad ? 'bg-warning text-dark' : 'bg-light text-dark border'} me-2 mb-2">
                    ${i.label}: ${i.value}
                </span>
            `).join('');
        }

        function buildReportText(data) {
            const lines = [data.verdict_summary || '', ''];
            (data.checks || []).forEach(c => {
                lines.push((c.passed ? '✓' : '✗') + ' ' + c.message);
                if (c.detail) lines.push('  ' + c.detail);
            });
            if (data.smtp_response) lines.push('', 'Server Response: ' + data.smtp_response);
            if (data.engine) lines.push('', 'Checked by: ' + (data.engine === 'reacher' ? (data.backend || 'Reacher') : 'truemail-go'));
            return lines.join('\n');
        }

        function renderResult(data) {
            document.getElementById('emailDisplay').textContent = data.email;
            document.getElementById('verdictSummary').textContent = data.verdict_summary || '';

            badge(document.getElementById('validBadge'),
                data.valid ? 'Valid: YES' : 'Valid: NO',
                data.valid ? 'bg-success' : 'bg-danger');

            badge(document.getElementById('domainBadge'),
                data.domain_valid ? 'Domain: Valid' : 'Domain: Invalid',
                data.domain_valid ? 'bg-success' : 'bg-danger');

            const mbMap = { yes: ['Mailbox: Verified', 'bg-success'], no: ['Mailbox: Not verified', 'bg-danger'], no_smtp: ['Mailbox: SMTP unavailable', 'bg-warning text-dark'] };
            const [mbText, mbCls] = mbMap[data.mailbox_verified] || mbMap.no_smtp;
            badge(document.getElementById('mailboxBadge'), mbText, mbCls);

            // Which engine actually served this check.
            const usedReacher = data.engine === 'reacher';
            const fallback = Boolean(data.report && data.report.fallback_from);
            const engineLabel = usedReacher
                ? `Checked by ${data.backend || 'Reacher'}`
                : `Checked by truemail-go${fallback ? ' (Reacher failed, fell back)' : ''}`;
            badge(document.getElementById('engineBadge'), engineLabel, 'bg-light text-dark border');

            const smtpBox = document.getElementById('smtpResponseBox');
            if (data.smtp_response) {
                smtpBox.classList.remove('d-none');
                document.getElementById('smtpResponseText').textContent = data.smtp_response;
            } else {
                smtpBox.classList.add('d-none');
            }

            renderChecks(data.checks);
            renderMisc(data.misc);
            lastReportText = buildReportText(data);
            resultArea.classList.remove('d-none');
        }

        verifyForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = emailInput.value.trim();
            if (!email) return;

            verifyBtn.disabled = true;
            resultArea.classList.add('d-none');
            loader.classList.remove('d-none');

            try {
                const res = await axios.post('/api/verify/single', { email }, { timeout: 180000 });
                renderResult(res.data);
                showToast('Verification complete!', 'success');
            } catch (err) {
                showToast(err.response?.data?.message || 'Verification failed', 'error');
            } finally {
                verifyBtn.disabled = false;
                loader.classList.add('d-none');
            }
        });

        document.getElementById('verifyAnotherBtn').addEventListener('click', () => {
            resultArea.classList.add('d-none');
            emailInput.value = '';
            emailInput.focus();
        });

        document.getElementById('copyResultBtn').addEventListener('click', () => {
            if (!lastReportText) return;
            navigator.clipboard.writeText(lastReportText).then(() => showToast('Report copied', 'success'));
        });

/* ── ?email= deep link: verify straight away (added with the UI rebuild) ─ */
(function () {
    document.addEventListener('DOMContentLoaded', function () {
        const email = new URLSearchParams(window.location.search).get('email');
        if (!email) return;
        const input = document.getElementById('emailInput');
        const form = document.getElementById('verifyForm');
        if (!input || !form) return;
        input.value = email;
        form.dispatchEvent(new Event('submit', { cancelable: true }));
    });
})();
