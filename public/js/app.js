/* Shared shell: theme, auth, toasts, command palette, quick verify. */
(function () {
    'use strict';

    const root = document.documentElement;
    const THEME_KEY = 'theme';

    // ── theme ────────────────────────────────────────────────────────────
    function savedTheme() {
        return localStorage.getItem(THEME_KEY) || 'system';
    }

    function applyTheme(mode) {
        const dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        root.setAttribute('data-theme', dark ? 'dark' : 'light');
        const btn = document.getElementById('themeBtn');
        if (btn) {
            const icon = btn.querySelector('i');
            if (icon) icon.className = dark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
            btn.setAttribute('title', dark ? 'Switch to light' : 'Switch to dark');
        }
    }

    function setTheme(mode) {
        localStorage.setItem(THEME_KEY, mode);
        applyTheme(mode);
    }

    function cycleTheme() {
        const order = ['light', 'dark', 'system'];
        const next = order[(order.indexOf(savedTheme()) + 1) % order.length];
        setTheme(next);
        toast(`Theme: ${next}`, 'ok');
    }

    applyTheme(savedTheme());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (savedTheme() === 'system') applyTheme('system');
    });

    // ── toasts ───────────────────────────────────────────────────────────
    function toast(message, kind) {
        let host = document.querySelector('.toast-host');
        if (!host) {
            host = document.createElement('div');
            host.className = 'toast-host';
            document.body.appendChild(host);
        }
        const el = document.createElement('div');
        el.className = 'toast ' + (kind === 'error' || kind === 'bad' ? 'bad' : kind === 'success' || kind === 'ok' ? 'ok' : '');
        el.textContent = message;
        host.appendChild(el);
        setTimeout(() => el.remove(), 3600);
    }
    window.showToast = toast;
    window.toast = toast;

    // ── axios: auth header + 401 handling ────────────────────────────────
    if (window.axios) {
        axios.interceptors.request.use(config => {
            const token = localStorage.getItem('token');
            if (token) config.headers.Authorization = `Bearer ${token}`;
            return config;
        });
        axios.interceptors.response.use(
            response => response,
            error => {
                if (error.response && error.response.status === 401) {
                    const path = window.location.pathname;
                    if (path !== '/' && path !== '/index.html') {
                        localStorage.removeItem('token');
                        localStorage.removeItem('user');
                        window.location.href = '/?expired=1';
                    }
                }
                return Promise.reject(error);
            }
        );
    }

    // ── auth guard ───────────────────────────────────────────────────────
    function isPublicPage() {
        const path = window.location.pathname;
        return path === '/' || path === '/index.html';
    }

    (function guard() {
        const token = localStorage.getItem('token');
        if (!token && !isPublicPage()) window.location.replace('/');
        if (token && isPublicPage()) window.location.replace('/dashboard.html');
    })();

    function logout() {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/';
    }
    window.logout = logout;

    // ── sidebar state ────────────────────────────────────────────────────
    document.querySelectorAll('.side-link[data-path]').forEach(link => {
        const target = link.getAttribute('data-path');
        const here = window.location.pathname;
        if (target === here || (target === '/dashboard.html' && (here === '/' && false))) {
            link.classList.add('is-active');
        }
    });

    // ── quick verify (topbar) ────────────────────────────────────────────
    const quickInput = document.getElementById('quickEmail');
    const quickBtn = document.getElementById('quickGo');
    function quickGo() {
        const value = (quickInput && quickInput.value || '').trim();
        if (!value) { quickInput && quickInput.focus(); return; }
        window.location.href = '/single.html?email=' + encodeURIComponent(value);
    }
    if (quickBtn) quickBtn.addEventListener('click', quickGo);
    if (quickInput) quickInput.addEventListener('keydown', e => { if (e.key === 'Enter') quickGo(); });

    // ── command palette ──────────────────────────────────────────────────
    const commands = [
        { label: 'Go to Dashboard', icon: 'fa-chart-pie', href: '/dashboard.html' },
        { label: 'Go to Single Verify', icon: 'fa-magnifying-glass', href: '/single.html' },
        { label: 'Go to Bulk Verify', icon: 'fa-file-csv', href: '/bulk.html' },
        { label: 'Go to History', icon: 'fa-clock-rotate-left', href: '/history.html' },
        { label: 'Go to Settings', icon: 'fa-gear', href: '/settings.html' },
        { label: 'Toggle theme', icon: 'fa-circle-half-stroke', run: cycleTheme },
        { label: 'Log out', icon: 'fa-right-from-bracket', run: logout },
    ];

    let palette, paletteInput, paletteList, selected = 0, items = [];

    function buildPalette() {
        palette = document.createElement('div');
        palette.className = 'palette-backdrop';
        palette.innerHTML = `
            <div class="palette" role="dialog" aria-label="Command palette">
                <input type="text" placeholder="Search pages and actions…" autocomplete="off">
                <div class="palette-list"></div>
            </div>`;
        document.body.appendChild(palette);
        paletteInput = palette.querySelector('input');
        paletteList = palette.querySelector('.palette-list');

        paletteInput.addEventListener('input', renderPalette);
        paletteInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') closePalette();
            if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); renderPalette(); }
            if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); renderPalette(); }
            if (e.key === 'Enter') { e.preventDefault(); runItem(items[selected]); }
        });
        palette.addEventListener('click', e => { if (e.target === palette) closePalette(); });
    }

    function commandList() {
        const value = (paletteInput.value || '').trim();
        const list = commands.slice();
        if (value) {
            if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                list.unshift({
                    label: `Verify ${value}`,
                    icon: 'fa-paper-plane',
                    href: '/single.html?email=' + encodeURIComponent(value),
                });
            }
            list.push({ label: `Search history for “${value}”`, icon: 'fa-clock-rotate-left', href: '/history.html?q=' + encodeURIComponent(value) });
        }
        return list.filter(c => !value || c.label.toLowerCase().includes(value.toLowerCase()));
    }

    function renderPalette() {
        items = commandList();
        selected = Math.min(selected, Math.max(items.length - 1, 0));
        if (!items.length) {
            paletteList.innerHTML = '<div class="palette-empty">Nothing matches</div>';
            return;
        }
        paletteList.innerHTML = items.map((c, i) => `
            <div class="palette-item ${i === selected ? 'is-sel' : ''}" data-i="${i}">
                <i class="fa-solid ${c.icon}"></i><span>${c.label}</span>
            </div>`).join('');
        paletteList.querySelectorAll('.palette-item').forEach(el => {
            el.addEventListener('click', () => runItem(items[Number(el.getAttribute('data-i'))]));
        });
    }

    function runItem(item) {
        if (!item) return;
        closePalette();
        if (item.href) window.location.href = item.href;
        else if (item.run) item.run();
    }

    function openPalette() {
        if (!palette) buildPalette();
        palette.classList.add('is-open');
        paletteInput.value = '';
        selected = 0;
        renderPalette();
        paletteInput.focus();
    }

    function closePalette() {
        if (palette) palette.classList.remove('is-open');
    }
    window.openPalette = openPalette;

    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openPalette();
        }
    });

    // ── profile in sidebar ───────────────────────────────────────────────
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const nameEl = document.getElementById('userNameDisplay');
    if (nameEl) nameEl.textContent = user.name || 'Signed in';
    const mailEl = document.getElementById('userEmailDisplay');
    if (mailEl) mailEl.textContent = user.email || '';

    // ── wiring ───────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        const themeBtn = document.getElementById('themeBtn');
        if (themeBtn) themeBtn.addEventListener('click', cycleTheme);
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) logoutBtn.addEventListener('click', e => { e.preventDefault(); logout(); });
        const paletteBtn = document.getElementById('paletteBtn');
        if (paletteBtn) paletteBtn.addEventListener('click', openPalette);

        if (window.location.search.includes('expired=1')) {
            setTimeout(() => toast('Session expired — sign in again.', 'bad'), 250);
        }
    });
})();
