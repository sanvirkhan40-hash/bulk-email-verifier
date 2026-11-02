/* Dashboard: stats, distribution, engine health, recent activity. */
(function () {
    'use strict';

    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };

    function checkedBy(record) {
        const report = (record.details && record.details.report) || {};
        if (report.fallback_from) return 'truemail-go (fallback)';
        const backend = report.engine_backend || '';
        if (backend && backend !== 'truemail-go') return backend;
        if (backend === 'truemail-go') return 'truemail-go';
        return report.engine === 'reacher' ? 'Reacher' : '—';
    }

    function statusChip(record) {
        const status = String(record.status || '').toLowerCase();
        const map = {
            valid: ['ok', 'Valid'],
            invalid: ['bad', 'Invalid'],
            disposable: ['warn', 'Disposable'],
            no_smtp: ['warn', 'Unknown'],
        };
        const pair = map[status] || ['neutral', status || '—'];
        return '<span class="chip ' + pair[0] + '">' + pair[1] + '</span>';
    }

    function renderStats(stats) {
        const total = Number(stats.total) || 0;
        const valid = Number(stats.valid) || 0;
        const invalid = Number(stats.invalid) || 0;
        const unknown = Number(stats.unknown) || 0;

        setText('statTotal', total.toLocaleString());
        setText('statValid', valid.toLocaleString());
        setText('statInvalid', invalid.toLocaleString());
        setText('statUnknown', unknown.toLocaleString());
        setText('donutTotal', total.toLocaleString());
        setText('legendValid', valid.toLocaleString());
        setText('legendInvalid', invalid.toLocaleString());
        setText('legendUnknown', unknown.toLocaleString());

        const pct = n => (total ? (n / total) * 100 : 0);
        const donut = document.getElementById('donut');
        if (donut) {
            const a = pct(valid);
            const b = a + pct(invalid);
            const c = b + pct(unknown);
            donut.style.setProperty('--a', a + '%');
            donut.style.setProperty('--b', b + '%');
            donut.style.setProperty('--c', c + '%');
        }

        const rate = document.getElementById('validRate');
        if (rate) {
            rate.textContent = total
                ? Math.round((valid / total) * 100) + '% of checks are valid'
                : 'No checks yet';
        }
    }

    function renderHealth(health) {
        const state = document.getElementById('engineState');
        const detail = document.getElementById('engineDetail');
        const list = document.getElementById('backendList');
        if (!state) return;

        const active = health.active_engine || 'none';
        const backends = health.reacher_backends || [];
        const online = backends.filter(b => b.ok).length;

        state.className = 'chip ' + (active && active !== 'none' ? 'ok' : 'bad');
        state.textContent = active === 'none' ? 'No engine' : 'Active: ' + active;

        if (detail) {
            detail.textContent = backends.length
                ? online + '/' + backends.length + ' Reacher backends reachable · go verifier ' + (health.go ? 'ready' : 'down')
                : 'No Reacher backends configured · go verifier ' + (health.go ? 'ready' : 'down');
        }

        if (!list) return;
        if (!backends.length) {
            list.innerHTML = '<div class="empty"><i class="fa-solid fa-server"></i><p>No Reacher backends yet. Add one in Settings.</p></div>';
            return;
        }

        list.innerHTML = backends.map(b => {
            const version = b.legacy ? 'from environment' : (b.version ? 'v' + b.version : b.url);
            return '<div class="eng-row">'
                + '<span class="chip ' + (b.ok ? 'ok' : 'bad') + '"><span class="dot"></span>' + (b.ok ? 'Online' : 'Offline') + '</span>'
                + '<div><div class="eng-name">' + b.name + '</div><div class="eng-meta">' + version + '</div></div>'
                + '<div class="eng-usage"><b>' + (b.today ?? 0) + '</b><div class="eng-meta">today</div></div>'
                + '</div>';
        }).join('');
    }

    function renderRecent(records) {
        const body = document.getElementById('recentBody');
        const empty = document.getElementById('recentEmpty');
        if (!body) return;
        const rows = (records || []).slice(0, 8);
        if (!rows.length) {
            body.innerHTML = '';
            if (empty) empty.classList.remove('d-none');
            return;
        }
        if (empty) empty.classList.add('d-none');
        body.innerHTML = rows.map(r => '<tr>'
            + '<td class="text-break">' + r.email + '</td>'
            + '<td>' + statusChip(r) + '</td>'
            + '<td class="small text-muted text-nowrap">' + checkedBy(r) + '</td>'
            + '<td class="small text-muted text-nowrap">' + new Date(r.timestamp).toLocaleString() + '</td>'
            + '</tr>').join('');
    }

    async function load() {
        const results = await Promise.allSettled([
            axios.get('/api/history/stats'),
            axios.get('/api/verify/health'),
            axios.get('/api/history'),
        ]);

        if (results[0].status === 'fulfilled') {
            renderStats(results[0].value.data);
        } else {
            setText('validRate', 'Could not load stats');
        }

        if (results[1].status === 'fulfilled') {
            renderHealth(results[1].value.data);
        } else {
            const state = document.getElementById('engineState');
            if (state) { state.className = 'chip bad'; state.textContent = 'Health unavailable'; }
        }

        if (results[2].status === 'fulfilled') {
            const data = results[2].value.data;
            renderRecent(Array.isArray(data) ? data : (data.records || []));
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        load();
        const refresh = document.getElementById('refreshDashboard');
        if (refresh) refresh.addEventListener('click', load);
    });
})();
