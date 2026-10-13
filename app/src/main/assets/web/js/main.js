/**
 * BridgeLink Manager v2.0.3 - 核心框架逻辑
 */
document.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('isLoggedIn') !== 'true') {
        window.location.href = 'login.html';
        return;
    }
    initAppEngine();
});

let activeTimer = null;
let activeTimerCallback = null;
let activeTimerMs = 3000;
let dataStore = {
    blackMacs: "",
    blackNames: "",
    qos_loaded: false,
    last_qci: "--",
    last_qos_dl: "-- Mbps",
    last_qos_ul: "-- Mbps",
    deviceModel: null
};

async function initAppEngine() {
    await PluginRegistry.loadPlugins();
    initNavigation();
    renderPluginNav();
    initMobileEvents();
    initModalControls();
    initThemeControl();
    initVisibilityHandler();

    const savedStartPage = localStorage.getItem('default_start_page') || 'overview';
    const initialPage = window.location.hash.replace('#', '') || savedStartPage;

    loadPage(initialPage);

    window.onhashchange = () => {
        const pageId = window.location.hash.replace('#', '') || 'overview';
        const currentActive = document.querySelector('.nav-item.active')?.getAttribute('data-page');
        if (pageId !== currentActive) loadPage(pageId);
    };

    document.getElementById('logout-btn').onclick = () => {
        sessionStorage.clear();
        window.location.href = 'login.html';
    };
}

function initVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (activeTimer) {
                clearInterval(activeTimer);
                activeTimer = null;
            }
        } else {
            if (activeTimerCallback && !activeTimer) {
                activeTimerCallback();
                activeTimer = setInterval(activeTimerCallback, activeTimerMs);
            }
        }
    });
}

function startPolling(callback, intervalMs) {
    stopPolling();
    activeTimerCallback = callback;
    activeTimerMs = intervalMs || 3000;
    if (!document.hidden) {
        activeTimer = setInterval(callback, activeTimerMs);
    }
}

function stopPolling() {
    if (activeTimer) {
        clearInterval(activeTimer);
        activeTimer = null;
    }
    activeTimerCallback = null;
}

function initThemeControl() {
    const themeBtn = document.getElementById('theme-btn');
    if (!themeBtn) return;
    themeBtn.onclick = () => {
        const current = localStorage.getItem('theme') || 'auto';
        const options = [
            { label: '浅色模式', value: 'light' },
            { label: '深色模式', value: 'dark' },
            { label: '跟随系统', value: 'auto' }
        ];
        ApiExtra.showPicker('切换主题', options, current, (val) => {
            localStorage.setItem('theme', val);
            applyTheme(val);
        });
    };
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (localStorage.getItem('theme') === 'auto') applyTheme('auto');
    });
}

function applyTheme(theme) {
    if (theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
    }
}

async function loadPage(pageId) {
    const contentArea = document.getElementById('content');
    if (!contentArea) return;

    // 清理所有模块的定时器
    stopPolling();
    if (typeof OverviewModule !== 'undefined') OverviewModule.stop();
    if (typeof NetInfoModule !== 'undefined') NetInfoModule.stop();

    // 1. 内置页面
    let html = null;
    // 1. 插件页面优先（插件 id 不与内置页冲突，避免先请求 pages/*.html 产生 404 噪音）
    const plugin = PluginRegistry.getPlugin(pageId);
    if (plugin && plugin.page) {
        try {
            const response = await fetch(`/plugins/${pageId}/www/${plugin.page}`);
            if (response.ok) html = await response.text();
        } catch (e) { /* 忽略 */ }
    }

    // 2. 内置页面
    if (!html) {
        try {
            const response = await fetch(`pages/${pageId}.html`);
            if (response.ok) html = await response.text();
        } catch (e) { /* 忽略 */ }
    }

    if (!html) {
        contentArea.innerHTML = `<div class="card"><p style="color:red">页面加载失败: ${escapeHtml(pageId)}</p></div>`;
        return;
    }
    contentArea.innerHTML = html;

    // 给通过 <img> 加载的 /api/ 资源附加 token（img 标签无法带自定义 header）
    contentArea.querySelectorAll('img[src^="/api/"]').forEach(img => {
        const raw = img.getAttribute('src');
        if (raw && !raw.includes('token=')) img.setAttribute('src', authedSrc(raw));
    });

    // 插件页面的 <script> 不会通过 innerHTML 自动执行，需手动补挂载
    if (PluginRegistry.getPlugin(pageId)) {
        contentArea.querySelectorAll('script').forEach(s => {
            const n = document.createElement('script');
            if (s.src) n.src = s.src;
            else n.textContent = s.textContent;
            document.head.appendChild(n);
            s.remove();
        });
    }

    updateActiveNavItem(pageId);
    initPageLogic(pageId);

    if (window.location.hash !== '#' + pageId) history.replaceState(null, '', '#' + pageId);
}

function initPageLogic(pageId) {
    if (pageId === 'overview' && typeof OverviewModule !== 'undefined') {
        OverviewModule.init();
    } else if (pageId === 'net-info' && typeof NetInfoModule !== 'undefined') {
        NetInfoModule.init();
    } else if (pageId === 'security' && typeof SecurityModule !== 'undefined') {
        SecurityModule.init();
    } else if (pageId === 'lan' && typeof LanModule !== 'undefined') {
        LanModule.init();
    } else if (pageId === 'samba' && typeof SambaModule !== 'undefined') {
        SambaModule.init();
        startPolling(() => SambaModule.syncStatus(), 3000);
    } else if (pageId === 'usb-port' && typeof UsbPortModule !== 'undefined') {
        UsbPortModule.init();
        startPolling(() => UsbPortModule.syncStatus(), 3000);
    } else if (pageId === 'wifi' && typeof WifiModule !== 'undefined') {
        WifiModule.init();
    } else if (pageId === 'sms' && typeof SmsModule !== 'undefined') {
        SmsModule.init();
        startPolling(() => SmsModule.syncStatus(), 3000);
    } else if (pageId === 'at-command' && typeof AtCommandModule !== 'undefined') {
        AtCommandModule.init();
    } else if (pageId === 'remote' && typeof initRemoteScrcpy === 'function') {
        initRemoteScrcpy();
    } else if (pageId === 'power' && typeof PowerModule !== 'undefined') {
        PowerModule.init();
    } else if (pageId === 'terminal' && typeof TerminalModule !== 'undefined') {
        TerminalModule.init();
    } else if (pageId === 'about') {
        AboutModule.init();
    } else if (pageId === 'plugins-manager' && typeof PluginsManagerModule !== 'undefined') {
        PluginsManagerModule.init();
    } else {
        // 插件页面：插件入口注册的 init() 由插件自行实现
        const plugin = PluginRegistry.getPlugin(pageId);
        if (plugin && typeof plugin.init === 'function') {
            plugin.init();
        }
    }
}

// --- 通用工具函数 ---

/**
 * 给通过 <img> 等无法携带自定义 header 的资源附加鉴权 token。
 * 仅对 /api/ 路径生效，后端 checkAuth 支持从 query 读取 token。
 */
function authedSrc(src) {
    const token = sessionStorage.getItem('authToken');
    if (!token || !src || !src.startsWith('/api/')) return src;
    const sep = src.indexOf('?') >= 0 ? '&' : '?';
    return src + sep + 'token=' + encodeURIComponent(token);
}

function escapeHtml(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '--';
}

function updateProgressBar(id, val) {
    const el = document.getElementById(id + '-bar');
    if (el) el.style.width = (val || 0) + '%';
    const txt = document.getElementById(id + '-text');
    if (txt) txt.textContent = (val || 0) + '%';
}

function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(2) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
}

function formatSpeed(v) {
    return formatBytes(parseFloat(v || 0)) + '/s';
}

// Unicode-safe base64 (替代 btoa，支持中文/emoji)
function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    const binStr = Array.from(bytes, b => String.fromCharCode(b)).join('');
    return btoa(binStr);
}

function syncMaskedField(target) {
    const el = document.querySelector(`[data-target="${target}"]`);
    if (el && typeof dataStore[target] !== 'undefined' && !el.textContent.includes('*')) {
        el.textContent = dataStore[target] || '--';
    }
}

window.toggleVisibility = (target) => {
    const el = document.querySelector(`[data-target="${target}"]`);
    if (!el) return;
    const iconEl = el.nextElementSibling;
    if (el.textContent.includes('*')) {
        el.textContent = dataStore[target] || '--';
        if (iconEl) iconEl.innerHTML = icon('unlock');
    } else {
        el.textContent = '***********';
        if (iconEl) iconEl.innerHTML = icon('lock');
    }
};

// --- UI 组件逻辑 ---
const ApiExtra = {
    showPicker: function(title, options, currentVal, callback) {
        const picker = document.getElementById('custom-picker');
        const list = document.getElementById('picker-list');
        document.getElementById('picker-title').textContent = title;
        list.innerHTML = options.map(opt =>
            `<div class="picker-item ${opt.value == currentVal ? 'selected' : ''}" onclick="ApiExtra.handlePick('${escapeAttr(opt.value)}', '${escapeAttr(opt.label)}')">
                ${escapeHtml(opt.label)}
            </div>`
        ).join('');
        this.currentCallback = callback;
        picker.classList.add('active');
    },
    handlePick: function(val, label) {
        document.getElementById('custom-picker').classList.remove('active');
        if (this.currentCallback) this.currentCallback(val, label);
    }
};

// 生成一个图标。用于 JS 动态拼 HTML 的地方（模板字符串里没法写死 <use>）。
// 图标定义在 index.html 的 #lg-icons 精灵图里。
function icon(name, extraClass) {
    return '<svg class="ico' + (extraClass ? ' ' + extraClass : '') +
        '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
}

const AboutModule = {
    init() {
        const saved = localStorage.getItem('default_start_page') || 'overview';
        const labels = { 'overview': '状态总览', 'net-info': '网络详情', 'power': '电源管理', 'remote': '远程控制', 'sms': '短信列表' };
        setText('start-page-picker', labels[saved] || '状态总览');
        this.loadVersion();
    },
    // 版本号从服务端 /api/app 取（源头是 app/build.gradle.kts 的 versionName），
    // 这样发版只要改 gradle，不用回来改页面。
    loadVersion() {
        Api.get('/api/app').then(res => {
            const v = res && res.versionName;
            if (v) setText('about-version', 'v' + v + ' Stable');
        }).catch(() => {
            // 取不到就明确说不知道，不要留一个 "…"，也不要显示假版本
            setText('about-version', '版本未知');
        });
    },
    showStartPagePicker() {
        const options = [{ label: '状态总览', value: 'overview' }, { label: '网络详情', value: 'net-info' }, { label: '电源管理', value: 'power' }, { label: '远程控制', value: 'remote' }, { label: '短信列表', value: 'sms' }];
        const current = localStorage.getItem('default_start_page') || 'overview';
        ApiExtra.showPicker('设置默认启动页', options, current, (val, label) => {
            localStorage.setItem('default_start_page', val);
            setText('start-page-picker', label);
            showAlert("设置已保存，下次登录生效");
        });
    }
};

function initModalControls() {
    const modal = document.getElementById('custom-modal');
    if (modal) {
        document.getElementById('modal-cancel').onclick = () => modal.classList.remove('active');
        document.getElementById('modal-confirm').onclick = () => modal.classList.remove('active');
    }
}

function showAlert(content, title = '提示') {
    const modal = document.getElementById('custom-modal');
    if (!modal) return;
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-content').innerHTML = content;
    document.getElementById('modal-cancel').style.display = 'none';
    modal.classList.add('active');
    return new Promise(resolve => {
        document.getElementById('modal-confirm').onclick = () => {
            modal.classList.remove('active');
            resolve(true);
        };
    });
}

function showConfirm(content, title = '请确认') {
    const modal = document.getElementById('custom-modal');
    if (!modal) return;
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-content').innerHTML = content;
    document.getElementById('modal-cancel').style.display = 'inline-block';
    modal.classList.add('active');
    return new Promise(resolve => {
        document.getElementById('modal-cancel').onclick = () => {
            modal.classList.remove('active');
            resolve(false);
        };
        document.getElementById('modal-confirm').onclick = () => {
            modal.classList.remove('active');
            resolve(true);
        };
    });
}

function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(link => {
        link.onclick = () => {
            const pageId = link.getAttribute('data-page');
            if (pageId) loadPage(pageId);
            document.body.classList.remove('sidebar-open');
        };
    });
}

/** 创建单个插件导航项 */
function makePluginNavItem(p) {
    const a = document.createElement('a');
    a.className = 'nav-item plugin-nav-item';
    a.href = 'javascript:void(0)';
    a.setAttribute('data-page', p.id);
    a.innerHTML = `<p>${p.icon ? escapeHtml(p.icon) : icon('puzzle')}</p> ${escapeHtml(p.title || p.name || p.id)}`;
    a.onclick = () => {
        loadPage(p.id);
        document.body.classList.remove('sidebar-open');
    };
    return a;
}

/** 归一化分组名用于匹配（去掉空白与控制字符） */
function normalizeSection(text) {
    return (text || '').replace(/\s+/g, '').trim();
}

/**
 * 渲染插件导航（幂等）。
 * 分组策略：若已存在同名分组（内置或先前新建），插件项并入其中；否则在底部新建分组。
 */
function renderPluginNav() {
    const nav = document.querySelector('.nav-menu');
    if (!nav) return;

    // 清理上次插件生成的导航项，避免重复
    nav.querySelectorAll('.plugin-nav-item').forEach(el => el.remove());

    let container = document.getElementById('plugin-nav');
    if (!container) {
        container = document.createElement('div');
        container.id = 'plugin-nav';
        nav.appendChild(container);
    }
    container.innerHTML = '';

    // 收集插件分组
    const groups = {};
    for (const p of Object.values(PluginRegistry.registered)) {
        if (p.menu === false) continue;
        const section = (p.menu && p.menu.section) || '插件';
        if (!groups[section]) groups[section] = [];
        groups[section].push(p);
    }

    // 已存在的分组（静态侧边栏，排除 plugin-nav 容器内）
    const existingSections = Array.from(nav.querySelectorAll('.nav-section'))
        .filter(el => !container.contains(el));

    for (const [section, items] of Object.entries(groups)) {
        const sorted = items.sort((a, b) => ((a.menu && a.menu.order) || 99) - ((b.menu && b.menu.order) || 99));

        const existing = existingSections.find(el => normalizeSection(el.textContent) === normalizeSection(section));
        if (existing) {
            const content = existing.nextElementSibling;
            if (content && content.classList.contains('section-content')) {
                // 可折叠分组：插入到其 section-content 内
                sorted.forEach(p => content.appendChild(makePluginNavItem(p)));
            } else {
                // 非可折叠分组：插入到分组标题之后、下一分组之前
                const ref = existing.nextElementSibling;
                sorted.forEach(p => nav.insertBefore(makePluginNavItem(p), ref));
            }
            continue;
        }

        // 无同名分组：在底部新建
        const secEl = document.createElement('div');
        secEl.className = 'nav-section';
        secEl.textContent = section;
        container.appendChild(secEl);
        sorted.forEach(p => container.appendChild(makePluginNavItem(p)));
    }
}

window.renderPluginNav = renderPluginNav;

function updateActiveNavItem(pageId) {
    document.querySelectorAll('.nav-item').forEach(l => l.classList.toggle('active', l.getAttribute('data-page') === pageId));
}

function initMobileEvents() {
    const toggle = document.getElementById('menu-toggle');
    const overlay = document.getElementById('sidebar-overlay');
    if (toggle) toggle.onclick = () => document.body.classList.toggle('sidebar-open');
    if (overlay) overlay.onclick = () => document.body.classList.remove('sidebar-open');
}

window.showSignalHelp = (type) => {
    const content = type === 'rsrp'
        ? `<b>RSRP (参考信号接收功率)</b><br><br>这是衡量网络覆盖的核心指标。<br>-80dBm 以上: 信号极强<br>-80 至 -95: 信号良好<br>-95 至 -110: 信号一般<br>-110dBm 以下: 信号较差`
        : `<b>RSSI (接收信号强度指示)</b><br><br>反映整个频段的总能量强度。`;
    showAlert(content, "参数说明");
};
