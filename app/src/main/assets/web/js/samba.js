/**
 * Samba Module
 */
const SambaModule = {
    shares: [],

    init() {
        this.syncStatus();
        this.loadShares();
        this.bindEvents();
    },

    async syncStatus() {
        try {
            const data = await Api.get('/api/proxy/goform/goform_get_cmd_process?isTest=false&cmd=samba_switch&_=' + Date.now());
            if (data && data.samba_switch !== undefined) {
                const sambaSwitch = document.getElementById('samba-switch');
                const statusTxt = document.getElementById('samba-status-text');
                const isEnabled = data.samba_switch === "1";

                if (sambaSwitch) {
                    if (!sambaSwitch.dataset.bound) {
                        sambaSwitch.dataset.bound = "true";
                        sambaSwitch.onchange = async () => {
                            const targetVal = sambaSwitch.checked ? "1" : "0";
                            try {
                                await Api.post('/api/proxy/goform/goform_set_cmd_process', {
                                    goformId: 'SAMBA_SETTING',
                                    isTest: 'false',
                                    samba_switch: targetVal
                                });
                                if (statusTxt) {
                                    statusTxt.textContent = sambaSwitch.checked ? "服务已运行" : "服务已关闭";
                                    statusTxt.style.color = sambaSwitch.checked ? "var(--success)" : "var(--text-sub)";
                                }
                            } catch (e) {
                                showAlert("Samba 设置失败: " + e.message);
                                sambaSwitch.checked = !sambaSwitch.checked;
                            }
                        };
                    }

                    if (sambaSwitch.checked !== isEnabled) {
                        const handler = sambaSwitch.onchange;
                        sambaSwitch.onchange = null;
                        sambaSwitch.checked = isEnabled;
                        sambaSwitch.onchange = handler;
                    }
                }
                if (statusTxt) {
                    statusTxt.textContent = isEnabled ? "服务已运行" : "服务已关闭";
                    statusTxt.style.color = isEnabled ? "var(--success)" : "var(--text-sub)";
                }

                // 显示/隐藏共享相关 UI
                const addressBar = document.getElementById('samba-address-bar');
                const addressText = document.getElementById('samba-address-text');
                const addBtn = document.getElementById('samba-add-share-btn');
                const shareList = document.getElementById('samba-share-list');
                if (addressBar) addressBar.style.display = isEnabled ? 'block' : 'none';
                if (addressText) addressText.textContent = '\\\\' + window.location.hostname;
                if (addBtn) addBtn.style.display = isEnabled ? 'inline-flex' : 'none';
                if (shareList) shareList.style.display = isEnabled ? 'block' : 'none';
            }
        } catch (e) {
            console.error("Sync Samba status failed", e);
        }
    },

    async loadShares() {
        try {
            const data = await Api.get('/api/samba/shares');
            this.shares = Array.isArray(data) ? data : [];
        } catch (e) {
            console.error("Load shares failed", e);
            this.shares = [];
        }
        this.renderShares();
    },

    renderShares() {
        const container = document.getElementById('samba-share-list');
        const emptyHint = document.getElementById('samba-empty-hint');
        if (!container) return;

        if (this.shares.length === 0) {
            container.innerHTML = '';
            if (emptyHint) emptyHint.style.display = 'block';
            return;
        }

        if (emptyHint) emptyHint.style.display = 'none';

        let html = '';
        this.shares.forEach((share, index) => {
            const name = escapeHtml(share.name) || 'Unnamed';
            const path = escapeHtml(share.path) || '/sdcard';
            const comment = escapeHtml(share.comment) || '';
            const writable = share.writable === 'yes';
            const browseable = share.browseable === 'yes';
            const isPublic = share.public === 'yes';

            html += `
                <div class="share-item" data-share-index="${index}" style="display: flex; align-items: center; justify-content: space-between; padding: 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--bg-card);">
                    <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                        <span style="font-size: 24px;"><svg class="ico" aria-hidden="true"><use href="#i-folder"/></svg></span>
                        <div style="flex: 1; min-width: 0;">
                            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--text);">${name}</span>
                                <span style="font-size: 11px; color: var(--text-sub); font-family: monospace;">${path}</span>
                            </div>
                            ${comment ? '<div style="font-size: 12px; color: var(--text-sub); margin-top: 2px;">' + comment + '</div>' : ''}
                            <div style="display: flex; gap: 8px; margin-top: 4px;">
                                ${writable ? '<span style="font-size: 11px; padding: 1px 6px; background: #e8f8e8; color: #34c759; border-radius: 4px;">W</span>' : ''}
                                ${browseable ? '<span style="font-size: 11px; padding: 1px 6px; background: #e8f0fe; color: #007aff; border-radius: 4px;">B</span>' : ''}
                                ${isPublic ? '<span style="font-size: 11px; padding: 1px 6px; background: #fff3e0; color: #ff9500; border-radius: 4px;">公开</span>' : ''}
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; gap: 4px; flex-shrink: 0; margin-left: 8px;">
                        <button class="btn btn-sm btn-secondary samba-edit-btn" data-share-index="${index}" style="padding: 4px 10px; font-size: 12px;"><svg class="ico" aria-hidden="true"><use href="#i-pencil"/></svg></button>
                        <button class="btn btn-sm btn-danger samba-delete-btn" data-share-index="${index}" style="padding: 4px 10px; font-size: 12px;"><svg class="ico" aria-hidden="true"><use href="#i-trash"/></svg></button>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;
    },

    bindEvents() {
        // 使用事件委托监听共享列表中的编辑/删除按钮点击
        const shareList = document.getElementById('samba-share-list');
        if (shareList) {
            shareList.addEventListener('click', (e) => {
                const btn = e.target.closest('.samba-edit-btn, .samba-delete-btn');
                if (!btn) return;
                const index = parseInt(btn.dataset.shareIndex);
                if (isNaN(index)) return;
                if (btn.classList.contains('samba-edit-btn')) {
                    this.openEditModal(index);
                } else if (btn.classList.contains('samba-delete-btn')) {
                    this.deleteShare(index);
                }
            });
        }

        const addBtn = document.getElementById('samba-add-share-btn');
        if (addBtn) {
            addBtn.onclick = () => {
                document.getElementById('samba-add-modal').style.display = 'flex';
            };
        }

        const confirmAddBtn = document.getElementById('samba-confirm-add-btn');
        if (confirmAddBtn) {
            confirmAddBtn.onclick = async () => {
                const name = document.getElementById('samba-new-name').value.trim();
                const path = document.getElementById('samba-new-path').value.trim();
                const comment = document.getElementById('samba-new-comment').value.trim();
                if (!name || !path) { showAlert('请填写共享名称和路径'); return; }
                try {
                    const res = await Api.post('/api/samba/share/add', { name, path, comment });
                    if (res && res.result === 'saved') {
                        document.getElementById('samba-add-modal').style.display = 'none';
                        await this.loadShares();
                        showAlert('<svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> 共享已添加，请重启 Samba 服务生效');
                    } else if (res && res.result === 'exists') {
                        showAlert('共享名称已存在');
                    } else {
                        showAlert('添加失败');
                    }
                } catch (e) { showAlert('添加失败: ' + e.message); }
            };
        }

        const confirmEditBtn = document.getElementById('samba-confirm-edit-btn');
        if (confirmEditBtn) {
            confirmEditBtn.onclick = async () => {
                const originalName = document.getElementById('samba-edit-original-name').value;
                const name = document.getElementById('samba-edit-name').value.trim();
                const path = document.getElementById('samba-edit-path').value.trim();
                const comment = document.getElementById('samba-edit-comment').value.trim();
                const writable = document.getElementById('samba-edit-writable').checked;
                const browseable = document.getElementById('samba-edit-browseable').checked;
                const isPublic = document.getElementById('samba-edit-public').checked;
                if (!name || !path) { showAlert('请填写共享名称和路径'); return; }
                try {
                    if (originalName !== name) {
                        await Api.post('/api/samba/share/remove', { name: originalName });
                    }
                    const idx = this.shares.findIndex(s => s.name === originalName);
                    if (idx >= 0) {
                        this.shares[idx] = { name, path, comment, writable: writable ? 'yes' : 'no', browseable: browseable ? 'yes' : 'no', public: isPublic ? 'yes' : 'no', valid_users: '' };
                    }
                    const res = await Api.post('/api/samba/shares', { shares: this.shares });
                    if (res && res.result === 'saved') {
                        document.getElementById('samba-edit-modal').style.display = 'none';
                        await this.loadShares();
                        showAlert('<svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> 共享已更新，请重启 Samba 服务生效');
                    } else { showAlert('保存失败'); }
                } catch (e) { showAlert('编辑失败: ' + e.message); }
            };
        }
    },

    openEditModal(index) {
        const share = this.shares[index];
        if (!share) return;
        document.getElementById('samba-edit-original-name').value = share.name || '';
        document.getElementById('samba-edit-name').value = share.name || '';
        document.getElementById('samba-edit-path').value = share.path || '';
        document.getElementById('samba-edit-comment').value = share.comment || '';
        document.getElementById('samba-edit-writable').checked = share.writable === 'yes';
        document.getElementById('samba-edit-browseable').checked = share.browseable === 'yes';
        document.getElementById('samba-edit-public').checked = share.public === 'yes';
        document.getElementById('samba-edit-modal').style.display = 'flex';
    },

    async deleteShare(index) {
        const share = this.shares[index];
        if (!share) return;
        if (!await showConfirm('确定删除共享「' + escapeHtml(share.name) + '」吗？', '删除确认')) return;
        try {
            const res = await Api.post('/api/samba/share/remove', { name: share.name });
            if (res && res.result === 'saved') {
                await this.loadShares();
                showAlert('<svg class="ico" aria-hidden="true"><use href="#i-check"/></svg> 共享已删除，请重启 Samba 服务生效');
            } else { showAlert('删除失败'); }
        } catch (e) { showAlert('删除失败: ' + e.message); }
    }
};
