const PROVIDERS = ['gmail', 'yahoo', 'microsoft', 'other'];
        const PROVIDER_LABELS = { gmail: 'Gmail', yahoo: 'Yahoo', microsoft: 'Microsoft', other: 'Other' };
        const capitalize = value => value.charAt(0).toUpperCase() + value.slice(1);
        const num = id => Number(document.getElementById(id).value);

        function renderCompareTable() {
            const tbody = document.getElementById('engineCompareBody');
            const rows = [
                { name: 'Reacher (Docker)', smtp: 'Yes — best for bulk', used: 'Yes — primary', cls: 'table-success' },
                { name: 'truemail-go', smtp: 'Removed', used: 'No — disabled', cls: '' },
                { name: 'AfterShip email-verifier', smtp: 'Lists only', used: 'Yes (with truemail)', cls: '' },
                { name: 'validate_email', smtp: 'No', used: 'No', cls: '' },
                { name: 'KnowEmail.exe', smtp: 'Partial', used: 'No — desktop only', cls: '' },
                { name: 'Paid SaaS APIs', smtp: 'Cloud', used: 'No — self-hosted only', cls: '' },
            ];
            tbody.innerHTML = rows.map(r => `
                <tr class="${r.cls}">
                    <td class="fw-medium">${r.name}</td>
                    <td>${r.smtp}</td>
                    <td>${r.used}</td>
                </tr>
            `).join('');
        }

        async function checkEngineHealth() {
            const el = document.getElementById('goEngineStatus');
            const text = document.getElementById('goStatusText');
            const detail = document.getElementById('goStatusDetail');
            try {
                const res = await axios.get('/api/verify/health');
                const d = res.data;
                const active = d.active_engine;
                const backends = d.reacher_backends || [];
                const healthy = backends.filter(b => b.ok);

                if (active) {
                    el.className = 'engine-status online mb-3';
                    text.textContent = `Active engine: ${active}`;
                    const parts = [];
                    if (backends.length) parts.push(`${healthy.length}/${backends.length} Reacher backends healthy`);
                    detail.innerHTML = `
                        <strong>Mode:</strong> ${d.mode || 'auto'}<br>
                        ${parts.join(' · ') || 'No verifier reachable'}
                    `;
                } else {
                    el.className = 'engine-status offline mb-3';
                    text.textContent = 'No verifier running';
                    detail.innerHTML = 'Add a Reacher backend below — it is the only engine.';
                }
            } catch {
                el.className = 'engine-status offline mb-3';
                text.textContent = 'Cannot reach API — log in first';
                detail.textContent = 'Settings health check requires you to be logged in.';
            }
        }

        // ---------- rate limits ----------

        async function loadVerificationSpeed() {
            const card = document.getElementById('verificationSpeedCard');
            try {
                const { data } = await axios.get('/api/verification-settings');
                card.style.display = '';
                document.getElementById('globalPerSecond').value = data.globalPerSecond;
                document.getElementById('globalPerMinute').value = data.globalPerMinute;
                document.getElementById('globalPerDay').value = data.globalPerDay;
                document.getElementById('maxConcurrent').value = data.maxConcurrent;
                PROVIDERS.forEach(p => {
                    document.getElementById('sec' + capitalize(p)).value = data.providerPerSecond[p];
                    document.getElementById('min' + capitalize(p)).value = data.providerPerMinute[p];
                    document.getElementById('day' + capitalize(p)).value = data.providerPerDay[p];
                });
                const skipped = data.skippedProviders || [];
                PROVIDERS.forEach(function (p) {
                    const el = document.getElementById('skip' + capitalize(p));
                    if (el) el.checked = skipped.indexOf(p) !== -1;
                });
                renderProviderBackoff(data.providerBackoff || {});
                renderLimiterUsage(data.usage || {});
                renderEngineUsage(data.engineUsage);
            } catch (error) {
                if (error.response?.status === 403) card.style.display = 'none';
                else document.getElementById('verificationSpeedStatus').textContent = 'Could not load settings. Check your database connection.';
            }
        }

        function renderProviderBackoff(states) {
            const el = document.getElementById('providerBackoffStatus');
            el.innerHTML = '<strong>Provider protection:</strong> ' + PROVIDERS.map(key => {
                const state = states[key] || {};
                const name = PROVIDER_LABELS[key];
                return state.paused
                    ? name + ' paused (' + state.resumeInSeconds + 's remaining)'
                    : name + ' active';
            }).join(' · ');
        }

        function renderLimiterUsage(usage) {
            const el = document.getElementById('limiterUsage');
            const global = usage.global || {};
            const bits = [`This minute: ${global.lastMinute ?? 0} started`, `Today: ${global.today ?? 0} started`];
            if (global.active !== undefined) bits.push(`${global.active} running`);
            if (global.queued) bits.push(`${global.queued} queued`);
            el.textContent = bits.join(' · ');
        }

        // Totals per engine, including the truemail-go fallback.
        function renderEngineUsage(usage) {
            const el = document.getElementById('engineUsage');
            if (!usage) { el.textContent = ''; return; }
            const byProvider = PROVIDERS
                .map(p => `${PROVIDER_LABELS[p]} ${usage.goByProvider?.[p] ?? 0}`)
                .join(' · ');
            el.innerHTML = `<strong>Today:</strong> Reacher ${usage.reacher ?? 0} · truemail-go ${usage.go ?? 0}`
                + `<div class="small">truemail-go by provider: ${byProvider}</div>`;
        }

        document.getElementById('saveVerificationSpeed').addEventListener('click', async () => {
            const status = document.getElementById('verificationSpeedStatus');
            const payload = {
                globalPerSecond: num('globalPerSecond'),
                globalPerMinute: num('globalPerMinute'),
                globalPerDay: num('globalPerDay'),
                maxConcurrent: num('maxConcurrent'),
                providerPerSecond: {},
                providerPerMinute: {},
                providerPerDay: {},
                skippedProviders: PROVIDERS.filter(function (p) {
                    const el = document.getElementById('skip' + capitalize(p));
                    return el && el.checked;
                }),
            };
            PROVIDERS.forEach(p => {
                payload.providerPerSecond[p] = num('sec' + capitalize(p));
                payload.providerPerMinute[p] = num('min' + capitalize(p));
                payload.providerPerDay[p] = num('day' + capitalize(p));
            });
            try {
                await axios.put('/api/verification-settings', payload);
                status.textContent = 'Saved. New limits apply to queued checks.';
                showToast('Rate limits saved');
                await loadVerificationSpeed();
            } catch (error) {
                status.textContent = error.response?.data?.message || 'Could not save settings.';
            }
        });

        // ---------- Reacher backends ----------

        let backends = [];

        function statusCell(b) {
            const health = b.health || b.lastStatus || {};
            if (b.locked) {
                return '<span class="badge bg-secondary"><i class="fa-solid fa-lock me-1"></i>Locked</span>';
            }
            if (!b.enabled) {
                return '<span class="badge bg-secondary">Disabled</span>';
            }
            if (health.ok) {
                const latency = health.latencyMs ? ` · ${health.latencyMs}ms` : '';
                const version = health.version ? `v${health.version}${latency}` : 'online';
                return `<span class="badge bg-success">Online</span> <span class="small text-muted">${version}</span>`;
            }
            const error = health.error ? `<div class="small text-danger">${health.error}</div>` : '';
            return `<span class="badge bg-danger">Offline</span>${error}`;
        }

        function usageCell(b) {
            const usage = b.usage || {};
            const used = usage.today ?? 0;
            const perProvider = PROVIDERS
                .map(p => `${PROVIDER_LABELS[p]} ${usage.byProvider?.[p]?.today ?? 0}`)
                .join(' · ');
            return `
                <div class="fw-medium">${used}</div>
                <div class="small text-muted">${perProvider}</div>
            `;
        }

        function limitsSummary(b) {
            if (!b.limitsOverridden) return 'follows the global limits';
            const bits = [];
            const rowText = (row, label) => {
                if (!row) return null;
                const parts = [];
                if (row.perSecond !== null && row.perSecond !== undefined) parts.push(row.perSecond + '/s');
                if (row.perMinute !== null && row.perMinute !== undefined) parts.push(row.perMinute + '/min');
                if (row.perDay !== null && row.perDay !== undefined) parts.push(row.perDay + '/day');
                if (!parts.length) return null;
                return (label ? label + ' ' : '') + parts.join(' \u00b7 ');
            };
            const overall = rowText(b.limits, '');
            if (overall) bits.push(overall);
            PROVIDERS.forEach(name => {
                const text = rowText(b.limits && b.limits.providers && b.limits.providers[name], PROVIDER_LABELS[name]);
                if (text) bits.push(text);
            });
            return bits.join(' \u00b7 ') || 'own limits \u2014 unlimited';
        }

        const LIMIT_WINDOWS = [['perSecond', 'Per second'], ['perMinute', 'Per minute'], ['perDay', 'Per day']];
        let limitsBackend = null;

        function buildLimitsGrid() {
            const grid = document.getElementById('limitsGrid');
            if (!grid || grid.dataset.ready) return;
            const rows = [{ key: 'overall', label: 'Overall' }].concat(PROVIDERS.map(name => ({ key: name, label: PROVIDER_LABELS[name] })));
            grid.innerHTML = `
                <table class="table">
                    <thead><tr><th>Apply to</th>${LIMIT_WINDOWS.map(w => `<th>${w[1]}</th>`).join('')}</tr></thead>
                    <tbody>
                        ${rows.map(r => `<tr>
                            <td class="fw-medium">${r.label}</td>
                            ${LIMIT_WINDOWS.map(w => `<td><input class="input sm" data-scope="${r.key}" data-window="${w[0]}" placeholder="auto" style="width:74px"></td>`).join('')}
                        </tr>`).join('')}
                    </tbody>
                </table>`;
            grid.dataset.ready = '1';

            const limitsDialog = document.getElementById('limitsDialog');
            const askDialog = document.getElementById('askLimitsDialog');
            [limitsDialog, askDialog].forEach(dialog => {
                if (!dialog) return;
                dialog.addEventListener('click', event => { if (event.target === dialog) hideDialog(dialog); });
            });

            document.getElementById('limitsCustom').addEventListener('change', event => {
                grid.querySelectorAll('input').forEach(input => { input.disabled = !event.target.checked; });
            });
            document.getElementById('limitsCancel').addEventListener('click', () => {
                hideDialog(document.getElementById('limitsDialog'));
            });
            document.getElementById('limitsSave').addEventListener('click', async () => {
                if (!limitsBackend) return;
                const custom = document.getElementById('limitsCustom').checked;
                try {
                    if (!custom) {
                        await axios.put('/api/reacher-backends/' + limitsBackend.id, { resetLimits: true });
                    } else {
                        const payload = { providers: {} };
                        grid.querySelectorAll('input').forEach(input => {
                            const raw = (input.value || '').trim();
                            const value = raw === '' ? null : Number(raw);
                            if (input.dataset.scope === 'overall') {
                                payload[input.dataset.window] = value;
                            } else {
                                payload.providers[input.dataset.scope] = payload.providers[input.dataset.scope] || {};
                                payload.providers[input.dataset.scope][input.dataset.window] = value;
                            }
                        });
                        await axios.put('/api/reacher-backends/' + limitsBackend.id, { limits: payload });
                    }
                    hideDialog(document.getElementById('limitsDialog'));
                    showToast('Limits saved');
                    await loadBackends();
                } catch (error) {
                    showToast((error.response && error.response.data && error.response.data.message) || 'Could not save limits', 'error');
                }
            });
        }

        function hideDialog(dialog) {
            if (!dialog) return;
            if (typeof dialog.close === 'function') {
                try { if (dialog.open) dialog.close(); } catch (_) { /* ignore */ }
            }
            dialog.removeAttribute('open');
        }

        function showDialog(dialog) {
            if (!dialog) return;
            hideDialog(dialog);
            if (typeof dialog.showModal === 'function') {
                try {
                    dialog.showModal();
                    return;
                } catch (_) { /* fall through to the plain open attribute */ }
            }
            dialog.setAttribute('open', '');
        }

        function openLimitsModal(backend) {
            buildLimitsGrid();
            limitsBackend = backend;
            document.getElementById('limitsName').textContent = backend.name;
            const custom = Boolean(backend.limitsOverridden);
            document.getElementById('limitsCustom').checked = custom;
            document.querySelectorAll('#limitsGrid input').forEach(input => {
                const scope = input.dataset.scope;
                const key = input.dataset.window;
                const source = scope === 'overall'
                    ? backend.limits
                    : (backend.limits && backend.limits.providers && backend.limits.providers[scope]);
                const value = source ? source[key] : null;
                input.value = value === null || value === undefined ? '' : value;
                input.disabled = !custom;
            });
            showDialog(document.getElementById('limitsDialog'));
        }

        function renderBackends(data) {
            backends = data.backends || [];
            const summary = document.getElementById('reacherSummary');
            const list = document.getElementById('backendsList');
            if (!list) return;

            backendCache = backends;

            if (!backends.length) {
                list.innerHTML = '<div class="notice">No backends yet. Add the URL of your Reacher service below.</div>';
            } else {
                list.innerHTML = backends.map(b => `
                    <div class="backend-card" data-id="${b.id}">
                        <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap">
                            <div>
                                <div class="fw-medium">${b.name} ${statusCell(b)}</div>
                                <div class="small text-muted backend-url">${b.url}</div>
                                <div class="small text-muted">${b.hasSecret ? (b.secretStatus === 'ok' ? 'secret saved' : 'secret unreadable — re-enter') : 'no secret'}</div>
                            </div>
                            <div class="d-flex align-items-center gap-1">
                                <button class="btn btn-sm ${b.locked ? 'btn-warning' : 'btn-outline-secondary'}" data-action="lock" title="${b.locked ? 'Unlock backend' : 'Lock backend (do not use)'}">
                                    <i class="fa-solid ${b.locked ? 'fa-lock' : 'fa-lock-open'}"></i>
                                </button>
                                <button class="btn btn-sm btn-outline-primary" data-action="test" title="Test connection"><i class="fa-solid fa-vial"></i></button>
                                <button class="btn btn-sm btn-outline-danger" data-action="delete" title="Remove backend"><i class="fa-solid fa-trash"></i></button>
                            </div>
                        </div>

                        <div class="mt-2">${usageCell(b)}</div>

                        <div class="backend-limits d-flex align-items-center justify-content-between gap-2 flex-wrap">
                            <div class="small"><span class="text-muted">Limits:</span> <span class="${b.limitsOverridden ? 'text-warning fw-medium' : ''}">${limitsSummary(b)}</span></div>
                            <button class="btn sm" data-action="edit-limits"><i class="fa-solid fa-sliders"></i>Limits</button>
                        </div>
                    </div>
                `).join('');
            }

            const active = backends.filter(b => b.enabled && !b.locked).length;
            const healthy = backends.filter(b => (b.health || b.lastStatus || {}).ok && !b.locked).length;
            summary.textContent = backends.length
                ? `${active} usable · ${healthy} online · each Reacher follows the Rate limits above: hit the per-minute cap and checks move to the next one, hit the daily cap and it is skipped until tomorrow (UTC)`
                : '';
            note.textContent = data.usingEnvironmentFallback
                ? `Using REACHER_URL from the environment (${data.environmentFallbackUrl}) because no backend is saved here. Add one above to manage it from the UI.`
                : '';
            backends.forEach((b, index) => {
                if ((b.health || b.lastStatus || {}).ok && !b.locked) backends[index]._online = true;
            });
        }

        let backendCache = [];

        async function loadBackends() {
            const card = document.getElementById('reacherCard');
            try {
                const { data } = await axios.get('/api/reacher-backends');
                card.style.display = '';
                renderBackends(data);
            } catch (error) {
                if (error.response?.status === 403) card.style.display = 'none';
                else document.getElementById('reacherNote').textContent = 'Could not load Reacher backends.';
            }
        }

        document.getElementById('backendsList').addEventListener('click', async event => {
            const button = event.target.closest('button[data-action]');
            if (!button) return;
            const row = button.closest('[data-id]');
            const id = row.getAttribute('data-id');
            const backend = backends.find(b => b.id === id);
            if (!backend) return;
            const action = button.getAttribute('data-action');

            if (action === 'lock') {
                try {
                    await axios.put(`/api/reacher-backends/${id}`, { locked: !backend.locked });
                    showToast(backend.locked ? 'Backend unlocked' : 'Backend locked — it will not be used');
                    await loadBackends();
                } catch (error) {
                    showToast(error.response?.data?.message || 'Could not update lock', 'error');
                }
                return;
            }

            if (action === 'test') {
                button.disabled = true;
                try {
                    const { data } = await axios.post(`/api/reacher-backends/${id}/test`);
                    const health = data.backend.health || {};
                    showToast(health.ok ? `Online${health.version ? ' · v' + health.version : ''}` : `Offline: ${health.error || 'unknown error'}`, health.ok ? 'success' : 'error');
                    await loadBackends();
                } catch (error) {
                    showToast(error.response?.data?.message || 'Test failed', 'error');
                } finally {
                    button.disabled = false;
                }
                return;
            }

            if (action === 'delete') {
                if (!confirm(`Remove "${backend.name}"? Its counters are lost.`)) return;
                try {
                    await axios.delete(`/api/reacher-backends/${id}`);
                    showToast('Backend removed');
                    await loadBackends();
                } catch (error) {
                    showToast(error.response?.data?.message || 'Could not remove backend', 'error');
                }
                return;
            }

            if (action === 'edit-limits') {
                const backend = backendCache.find(item => item.id === id);
                if (backend) openLimitsModal(backend);
                return;
            }

            if (action === 'save-limits') {
                const readLimit = role => {
                    const el = row.querySelector('[data-role="' + role + '"]');
                    const raw = (el && el.value || '').trim();
                    return raw === '' ? null : Number(raw);
                };
                try {
                    await axios.put('/api/reacher-backends/' + id, {
                        limits: { perSecond: readLimit('perSecond'), perMinute: readLimit('perMinute'), perDay: readLimit('perDay') },
                    });
                    showToast('Limits saved');
                    await loadBackends();
                } catch (error) {
                    showToast((error.response && error.response.data && error.response.data.message) || 'Could not save limits', 'error');
                }
                return;
            }

            if (action === 'reset-limits') {
                try {
                    await axios.put('/api/reacher-backends/' + id, { resetLimits: true });
                    showToast('Backend follows the global limits again');
                    await loadBackends();
                } catch (error) {
                    showToast('Could not reset limits', 'error');
                }
                return;
            }
        });

        document.getElementById('addBackendBtn').addEventListener('click', async () => {
            const name = document.getElementById('newName').value.trim();
            const url = document.getElementById('newUrl').value.trim();
            const secret = document.getElementById('newSecret').value;
            if (!name || !url) {
                showToast('Name and URL are required', 'error');
                return;
            }
            try {
                const { data } = await axios.post('/api/reacher-backends', { name, url, secret });
                showToast('Backend added');
                ['newName', 'newUrl', 'newSecret'].forEach(id => { document.getElementById(id).value = ''; });
                await loadBackends();

                const created = backendCache.find(item => item.id === (data && data.id))
                    || { id: data && data.id, name: name, limitsOverridden: false, limits: null };
                document.getElementById('askName').textContent = name;
                document.getElementById('askYes').onclick = () => {
                    hideDialog(document.getElementById('askLimitsDialog'));
                    openLimitsModal(created);
                };
                document.getElementById('askNo').onclick = () => {
                    hideDialog(document.getElementById('askLimitsDialog'));
                };
                showDialog(document.getElementById('askLimitsDialog'));
            } catch (error) {
                showToast(error.response?.data?.message || 'Could not add backend', 'error');
            }
        });

        document.getElementById('refreshBackendsBtn').addEventListener('click', async () => {
            const button = document.getElementById('refreshBackendsBtn');
            button.disabled = true;
            try {
                const { data } = await axios.post('/api/reacher-backends/check-all');
                showToast(`${data.healthy}/${data.total} backends online`, data.healthy ? 'success' : 'error');
                await loadBackends();
            } catch (error) {
                showToast(error.response?.data?.message || 'Could not check backends', 'error');
            } finally {
                button.disabled = false;
            }
        });

        document.addEventListener('DOMContentLoaded', () => {
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            document.getElementById('profileName').value = user.name || '';
            document.getElementById('profileEmail').value = user.email || '';
            renderCompareTable();
            checkEngineHealth();
            loadVerificationSpeed();
            loadBackends();
        });

        document.getElementById('refreshHealthBtn').addEventListener('click', checkEngineHealth);

/* ── Tabs (added with the UI rebuild) ─────────────────────────────────── */
(function () {
    document.addEventListener('DOMContentLoaded', function () {
        const tabs = document.querySelectorAll('.tab[data-tab]');
        tabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                tabs.forEach(function (t) { t.classList.remove('is-active'); });
                document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('is-active'); });
                tab.classList.add('is-active');
                const panel = document.querySelector('.tab-panel[data-panel="' + tab.getAttribute('data-tab') + '"]');
                if (panel) panel.classList.add('is-active');
            });
        });
    });
})();
