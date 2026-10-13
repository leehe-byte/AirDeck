/**
 * 插件管理模块 - 安装(上传/URL) / 启停 / 卸载
 */
const PluginsManagerModule = {
    init() {
        this.list();
        const fileInput = document.getElementById('plugin-file-input');
        if (fileInput) fileInput.addEventListener('change', e => {
            if (e.target.files.length > 0) this.upload(e.target.files[0]);
        });
        const urlBtn = document.getElementById('plugin-install-url-btn');
        if (urlBtn) urlBtn.onclick = () => this.installFromUrl();
    },

    async list() {
        const container = document.getElementById('plugin-list');
        const countEl = document.getElementById('plugin-count');
        if (!container) return;
        try {
            const data = await Api.get('/api/plugins');
            const plugins = Array.isArray(data) ? data : [];
            if (countEl) countEl.textContent = plugins.length + ' 个';
            if (plugins.length === 0) {
                container.innerHTML = '<p style="color: var(--text-sub); font-size: 13px;">尚未安装任何插件，请上传 .owpkg 文件或从 URL 安装。</p>';
                return;
            }
            container.innerHTML = plugins.map(p => `
                <div style="padding: 12px 0; border-bottom: 1px solid var(--border-color);">
                    <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">
                        <div style="flex:1 1 100%; min-width:0;">
                            <b>${p.icon ? escapeHtml(p.icon) : icon('puzzle')} ${escapeHtml(p.name || p.id)}</b>
                            <span style="font-size:11px; color:var(--text-sub);"> v${escapeHtml(p.version || '?')} · ${escapeHtml(p.id)} ${p.signed ? '<span style="color:var(--success);"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> 已签名</span>' : '<span style="color:#faad14;"><svg class="ico" aria-hidden="true"><use href="#i-alert"/></svg> 未签名</span>'}</span>
                            <div style="font-size:12px; color:var(--text-sub); margin-top:2px; word-break:break-all;">${escapeHtml(p.description || '')}</div>
                        </div>
                        <div style="display:flex; gap:6px; flex-wrap:wrap;">
                            <button class="badge" style="border:none; cursor:pointer;" onclick="PluginsManagerModule.run('${p.id}','start')">▶ 启动</button>
                            <button class="badge" style="border:none; cursor:pointer;" onclick="PluginsManagerModule.run('${p.id}','stop')">⏹ 停止</button>
                            <button class="badge" style="background:var(--danger); color:#fff; border:none; cursor:pointer;" onclick="PluginsManagerModule.uninstall('${p.id}')"><svg class="ico" aria-hidden="true"><use href="#i-trash"/></svg> 卸载</button>
                        </div>
                    </div>
                </div>
            `).join('');
        } catch (e) {
            container.innerHTML = '<p style="color: var(--danger); font-size: 13px;">获取插件列表失败</p>';
        }
    },

    async upload(file) {
        if (!file) return;
        const headers = {};
        const token = sessionStorage.getItem('authToken');
        if (token) headers['X-Auth-Token'] = token;

        // 1. 预览解析插件信息（不安装）
        this.setInstalling(true, '正在解析插件包...', 30);
        let info;
        try {
            const form = new FormData();
            form.append('file', file);
            const resp = await fetch('/api/plugins/preview', { method: 'POST', headers, body: form });
            info = await resp.json();
        } catch (e) {
            this.setInstalling(false);
            await showAlert('解析插件失败: ' + escapeHtml(e.message));
            this.resetFileInput();
            return;
        }
        if (!info || info.result !== 'success') {
            this.setInstalling(false);
            await showAlert('插件包解析失败: ' + escapeHtml(info?.msg || '未知错误'));
            this.resetFileInput();
            return;
        }

        // 2. 确认框展示插件信息
        const infoHtml = `
            <div style="text-align:center; margin-bottom:12px;">
                <div style="font-size:32px; line-height:1.2;">${info.icon ? escapeHtml(info.icon) : icon('puzzle')}</div>
                <div style="font-size:16px; font-weight:bold; margin-top:4px;">${escapeHtml(info.name || info.id)}</div>
                <div style="font-size:12px; color:var(--text-sub); margin-top:2px;">v${escapeHtml(info.version || '?')} · ${escapeHtml(info.id)} ${info.signed ? '<span style="color:var(--success);"><svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> 已签名</span>' : '<span style="color:#faad14;"><svg class="ico" aria-hidden="true"><use href="#i-alert"/></svg> 未签名</span>'}${info.requiresRoot ? ' · <span style="color:#fa8c16;">需 root</span>' : ''}</div>
            </div>
            <div style="font-size:12px; color:var(--text-sub); text-align:left; line-height:1.7; border-top:1px solid var(--border-color); padding-top:10px;">${escapeHtml(info.description || '（无描述）')}</div>`;
        const ok = await showConfirm(infoHtml, '确认安装插件');
        if (!ok) {
            this.setInstalling(false);
            this.resetFileInput();
            return;
        }

        // 3. 正式安装
        this.setInstalling(true, '正在安装，请稍候...', 90);
        try {
            const form2 = new FormData();
            form2.append('file', file);
            const resp2 = await fetch('/api/plugins/install', { method: 'POST', headers, body: form2 });
            const res = await resp2.json();
            if (res.result === 'success') {
                await this.applyInstall(res);
                await showAlert(`插件 <b>${escapeHtml(res.plugin?.name || '')}</b> 安装成功！` + this.outputHtml(res));
            } else {
                await showAlert('安装失败: ' + escapeHtml(res.msg || '未知错误'));
            }
        } catch (e) {
            await showAlert('安装请求失败: ' + escapeHtml(e.message));
        }
        this.setInstalling(false);
        this.list();
        if (typeof window.renderPluginNav === 'function') window.renderPluginNav();
        this.resetFileInput();
    },

    async installFromUrl() {
        const url = (document.getElementById('plugin-url-input')?.value || '').trim();
        if (!url) {
            await showAlert('请输入插件下载 URL');
            return;
        }
        this.setInstalling(true, '正在下载并安装插件，请稍候...', 90);
        try {
            const res = await Api.post('/api/plugins/install-url', { url });
            this.setInstalling(false);
            if (res.result === 'success') {
                await this.applyInstall(res);
                await showAlert(`插件 <b>${escapeHtml(res.plugin?.name || '')}</b> 安装成功！` + this.outputHtml(res));
            } else {
                await showAlert('安装失败: ' + escapeHtml(res.msg || ''));
            }
        } catch (e) {
            this.setInstalling(false);
            await showAlert('安装请求失败: ' + escapeHtml(e.message));
        }
        this.list();
        if (typeof window.renderPluginNav === 'function') window.renderPluginNav();
    },

    /** 安装期间显示状态条 + 进度条并禁用操作 */
    setInstalling(active, text, pct) {
        const box = document.getElementById('plugin-install-status');
        const txt = document.getElementById('plugin-install-status-text');
        const bar = document.getElementById('plugin-install-bar');
        const fileInput = document.getElementById('plugin-file-input');
        const urlBtn = document.getElementById('plugin-install-url-btn');
        if (box) box.style.display = active ? 'block' : 'none';
        if (txt) txt.textContent = text || '正在安装...';
        if (bar) bar.style.width = active ? (pct || 90) + '%' : '0%';
        if (fileInput) fileInput.disabled = active;
        if (urlBtn) urlBtn.disabled = active;
    },

    resetFileInput() {
        const fileInput = document.getElementById('plugin-file-input');
        if (fileInput) fileInput.value = '';
    },

    /** 安装脚本输出（install.sh 的回显），转成弹窗里的 pre 展示（统一主题样式） */
    outputHtml(res) {
        if (!res || !res.output || !res.output.trim()) return '';
        return `<div style="margin-top:12px; text-align:left;"><pre style="max-height:280px; overflow:auto; background:var(--inner-bg); color:var(--text-main); font-size:12px; line-height:1.5; padding:12px; border:1px solid var(--border-color); border-radius:6px;">${escapeHtml(res.output)}</pre></div>`;
    },

    async run(id, action) {
        await Api.post(`/api/plugins/${id}/${action}`);
    },

    async uninstall(id) {
        const ok = await showConfirm(`确定卸载插件 <b>${escapeHtml(id)}</b>？此操作不可恢复。`);
        if (!ok) return;
        const res = await Api.post(`/api/plugins/${id}/uninstall`);
        if (res.result === 'success') {
            // 清除插件前端状态，避免下次安装加载旧 JS
            delete PluginRegistry.scriptsLoaded[id];
            delete PluginRegistry.registered[id];
        }
        await showAlert(res.result === 'success' ? '已卸载' : '卸载失败: ' + escapeHtml(res.msg || ''));
        this.list();
        if (typeof window.renderPluginNav === 'function') window.renderPluginNav();
    },

    /**
     * 安装成功后清除旧 JS 缓存并强制加载新版，
     * 解决「重装插件后前端仍运行旧版 plugin.js」的问题。
     */
    async applyInstall(res) {
        if (!res || res.result !== 'success' || !res.plugin || !res.plugin.id) return;
        const id = res.plugin.id;
        delete PluginRegistry.scriptsLoaded[id];
        delete PluginRegistry.registered[id];
        if (res.plugin.entryJs) {
            try {
                await PluginRegistry.loadScript(`/plugins/${id}/www/${res.plugin.entryJs}`);
            } catch (e) {
                console.error('加载新版插件 JS 失败:', id, e);
            }
        }
        if (typeof window.renderPluginNav === 'function') window.renderPluginNav();
    }
};
