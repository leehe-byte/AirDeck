/**
 * WiFi Management Module v6.0 - 完整 WiFi 管理
 * 
 * 操作逻辑：
 * - 关闭 WiFi: goformId=switchWiFiModule&SwitchOption=0
 * - 切换频段/打开 WiFi: goformId=switchWiFiChip&ChipEnum=chip1/2&GuestEnable=0
 * - 修改 WiFi 参数: goformId=setAccessPointInfo&...
 * 
 * save() 根据用户操作类型自动判断：
 * 1. 只切换模式 → 只发 switchWiFiChip 或 switchWiFiModule
 * 2. 只改参数   → 只发 setAccessPointInfo
 * 3. 既切换又改参数 → 先发 switchWiFiChip，再发 setAccessPointInfo
 */
const WifiModule = {
    apData: [],
    currentMode: 'off',
    currentAuth: 'WPA2PSK',
    // 跟踪用户是否修改了模式或参数
    modeChanged: false,
    paramsChanged: false,

    async init() {
        console.log("WiFi Module Initializing...");
        this.modeChanged = false;
        this.paramsChanged = false;
        await this.fetchData();
        this.bindInputEvents();
    },

    async fetchData() {
        try {
            const url = `/api/proxy/goform/goform_get_cmd_process?isTest=false&cmd=wifi_onoff_state,queryAccessPointInfo&multi_data=1&_=${Date.now()}`;
            const data = await Api.get(url);
            if (data) {
                this.wifiOn = data.wifi_onoff_state === "1";
                if (data.ResponseList) {
                    this.apData = data.ResponseList;
                }
                this.updateUI();
            }
        } catch (e) {
            console.error("Fetch WiFi data failed:", e);
        }
    },

    updateUI() {
        const ap0 = this.apData[0];
        const ap1 = this.apData[1];
        if (!ap0 || !ap1) return;

        // 判断当前模式
        if (this.wifiOn === false) {
            this.currentMode = 'off';
        } else {
            if (ap0.AccessPointSwitchStatus === "1") this.currentMode = '2.4';
            else if (ap1.AccessPointSwitchStatus === "1") this.currentMode = '5';
            else this.currentMode = 'off';
        }

        const modeBtn = document.getElementById('wifi-mode-picker-btn');
        if (modeBtn) {
            const modeLabels = { 'off': '关闭 WiFi', '2.4': '开启 2.4GHz', '5': '开启 5GHz' };
            modeBtn.textContent = modeLabels[this.currentMode];
            modeBtn.dataset.value = this.currentMode;
        }

        // 填充表单
        const activeAp = (this.currentMode === '5') ? ap1 : ap0;
        this.currentAuth = activeAp.AuthMode;
        this.fillFormFields(activeAp);
        this.refreshStatusDisplay();
    },

    fillFormFields(ap) {
        if (!ap) return;
        setVal('wifi-ssid', ap.SSID);
        setVal('wifi-max-station', ap.ApMaxStationNumber);

        const authBtn = document.getElementById('wifi-auth-picker-btn');
        if (authBtn) {
            const authLabels = { 'OPEN': '无密码 (OPEN)', 'WPA2PSK': 'WPA2-PSK', 'WPA3PSK': 'WPA3-SAE', 'WPA2PSKWPA3PSK': 'WPA2/WPA3 混合' };
            authBtn.textContent = authLabels[ap.AuthMode] || ap.AuthMode;
            authBtn.dataset.value = ap.AuthMode;
        }

        const broadcastCheckbox = document.getElementById('wifi-broadcast');
        if (broadcastCheckbox) broadcastCheckbox.checked = ap.ApBroadcastDisabled === "0";

        const passInput = document.getElementById('wifi-password');
        if (passInput && ap.Password) {
            try { passInput.value = atob(ap.Password); } catch (e) { passInput.value = ap.Password; }
        }
    },

    // 绑定表单输入事件，检测参数变化
    bindInputEvents() {
        const inputs = ['wifi-ssid', 'wifi-password', 'wifi-max-station'];
        inputs.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('input', () => this.onParamChange());
        });
        const broadcast = document.getElementById('wifi-broadcast');
        if (broadcast) broadcast.addEventListener('change', () => this.onParamChange());
    },

    onParamChange() {
        if (!this.paramsChanged) {
            this.paramsChanged = true;
            this.markAsDirty();
        }
    },

    // --- 唤起自定义选择器 ---
    showModePicker() {
        const options = [
            { label: '关闭 WiFi', value: 'off' },
            { label: '开启 2.4GHz', value: '2.4' },
            { label: '开启 5GHz', value: '5' }
        ];
        ApiExtra.showPicker('选择 WiFi 模式', options, this.currentMode, (val, label) => {
            const btn = document.getElementById('wifi-mode-picker-btn');
            btn.textContent = label;
            btn.dataset.value = val;
            this.onModeChange(val);
        });
    },

    showAuthPicker() {
        const options = [
            { label: '无密码 (OPEN)', value: 'OPEN' },
            { label: 'WPA2-PSK', value: 'WPA2PSK' },
            { label: 'WPA3-SAE', value: 'WPA3PSK' },
            { label: 'WPA2/WPA3 混合', value: 'WPA2PSKWPA3PSK' }
        ];
        ApiExtra.showPicker('选择加密模式', options, this.currentAuth, (val, label) => {
            const btn = document.getElementById('wifi-auth-picker-btn');
            btn.textContent = label;
            btn.dataset.value = val;
            this.currentAuth = val;
            this.onParamChange();
        });
    },

    refreshStatusDisplay() {
        const statusEl = document.getElementById('wifi-global-status');
        const fieldsArea = document.getElementById('wifi-config-fields');
        if (this.currentMode === 'off') {
            statusEl.textContent = "WiFi 已关闭";
            statusEl.style.color = "var(--text-sub)";
            if (fieldsArea) fieldsArea.style.opacity = "0.5";
        } else {
            statusEl.textContent = `${this.currentMode}GHz 已开启`;
            statusEl.style.color = "var(--success)";
            if (fieldsArea) fieldsArea.style.opacity = "1";
        }
    },

    onModeChange(newMode) {
        this.currentMode = newMode;
        this.modeChanged = true;
        if (newMode === '5' && this.apData[1]) this.fillFormFields(this.apData[1]);
        else if (newMode === '2.4' && this.apData[0]) this.fillFormFields(this.apData[0]);
        this.refreshStatusDisplay();
        this.markAsDirty();
    },

    markAsDirty() {
        const saveBtn = document.getElementById('wifi-save-btn');
        if (saveBtn) {
            saveBtn.textContent = "保存并生效 (待提交)";
            saveBtn.style.background = "var(--warning)";
        }
    },

    togglePass() {
        const input = document.getElementById('wifi-password');
        const icon = input.nextElementSibling;
        if (input.type === 'password') {
            input.type = 'text'; icon.innerHTML = icon('unlock');
        } else {
            input.type = 'password'; icon.innerHTML = icon('lock');
        }
    },

    /**
     * 核心保存逻辑
     * 根据用户操作类型决定发送什么请求：
     * 
     * 情况 A: 只切换了模式（没改参数）
     *   - 关闭 WiFi → switchWiFiModule&SwitchOption=0
     *   - 切换频段 → switchWiFiChip&ChipEnum=chip1/2
     * 
     * 情况 B: 只改了参数（没切换模式）
     *   - setAccessPointInfo&...
     * 
     * 情况 C: 既切换模式又改了参数
     *   - 先 switchWiFiChip 切换频段
     *   - 再 setAccessPointInfo 提交参数
     */
    async save() {
        const hasModeChange = this.modeChanged;
        const hasParamChange = this.paramsChanged;

        if (!hasModeChange && !hasParamChange) {
            await showAlert("没有需要保存的更改");
            return;
        }

        const btn = document.getElementById('wifi-save-btn');
        btn.disabled = true;
        btn.textContent = '正在提交...';

        try {
            // ===== 情况 A: 只切换模式 =====
            if (hasModeChange && !hasParamChange) {
                await this.applyModeOnly();
                return;
            }

            // ===== 情况 B: 只改参数 =====
            if (!hasModeChange && hasParamChange) {
                await this.applyParamsOnly();
                return;
            }

            // ===== 情况 C: 既切换模式又改参数 =====
            if (hasModeChange && hasParamChange) {
                await this.applyModeAndParams();
                return;
            }
        } catch (e) {
            await showAlert("网络异常: " + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = '保存 WiFi 修改';
            btn.style.background = "var(--primary)";
        }
    },

    /**
     * 只切换模式（关闭 WiFi 或切换频段）
     */
    async applyModeOnly() {
        const mode = this.currentMode;
        let params;
        if (mode === 'off') {
            params = { goformId: 'switchWiFiModule', isTest: 'false', SwitchOption: '0' };
        } else {
            const chip = mode === '5' ? 'chip2' : 'chip1';
            params = { goformId: 'switchWiFiChip', isTest: 'false', ChipEnum: chip, GuestEnable: '0' };
        }

        const res = await Api.post('/api/proxy/goform/goform_set_cmd_process', params);
        if (res && res.result === 'success') {
            await showAlert(`WiFi 已${mode === 'off' ? '关闭' : '切换至 ' + mode + 'GHz'}`, "操作成功");
            setTimeout(() => this.init(), 1500);
        } else {
            await showAlert("操作失败: " + (res?.result || "未知错误"));
        }
    },

    /**
     * 只修改 WiFi 参数（SSID/密码等）
     */
    async applyParamsOnly() {
        const targetChip = (this.currentMode === '5') ? 1 : 0;
        const authMode = this.currentAuth;
        const rawPass = document.getElementById('wifi-password').value;

        const params = {
            goformId: 'setAccessPointInfo',
            isTest: 'false',
            ChipIndex: targetChip.toString(),
            AccessPointIndex: '0',
            SSID: document.getElementById('wifi-ssid').value,
            ApIsolate: '0',
            AuthMode: authMode,
            ApBroadcastDisabled: document.getElementById('wifi-broadcast').checked ? '0' : '1',
            ApMaxStationNumber: document.getElementById('wifi-max-station').value,
            EncrypType: (authMode === 'OPEN') ? 'NONE' : 'CCMP',
            Password: toBase64(rawPass)
        };

        const res = await Api.post('/api/proxy/goform/goform_set_cmd_process', params);
        if (res && (res.result === 'success' || res.result === '0')) {
            await showAlert("WiFi 设置已提交！请等待无线服务重启。", "保存成功");
            setTimeout(() => this.init(), 2000);
        } else {
            await showAlert("保存失败: " + (res?.result || "未知错误"));
        }
    },

    /**
     * 既切换模式又修改参数
     * 先切换频段，再提交参数
     */
    async applyModeAndParams() {
        const mode = this.currentMode;

        // Step 1: 切换频段
        if (mode === 'off') {
            // 关闭 WiFi 不需要提交参数
            const params = { goformId: 'switchWiFiModule', isTest: 'false', SwitchOption: '0' };
            const res = await Api.post('/api/proxy/goform/goform_set_cmd_process', params);
            if (res && res.result === 'success') {
                await showAlert("WiFi 已关闭", "操作成功");
                setTimeout(() => this.init(), 1500);
            } else {
                await showAlert("操作失败: " + (res?.result || "未知错误"));
            }
            return;
        }

        // 先切换频段
        const chip = mode === '5' ? 'chip2' : 'chip1';
        const modeRes = await Api.post('/api/proxy/goform/goform_set_cmd_process', {
            goformId: 'switchWiFiChip', isTest: 'false', ChipEnum: chip, GuestEnable: '0'
        });

        if (!modeRes || modeRes.result !== 'success') {
            await showAlert("频段切换失败: " + (modeRes?.result || "未知错误"));
            return;
        }

        // Step 2: 提交参数
        const targetChip = (mode === '5') ? 1 : 0;
        const authMode = this.currentAuth;
        const rawPass = document.getElementById('wifi-password').value;

        const params = {
            goformId: 'setAccessPointInfo',
            isTest: 'false',
            ChipIndex: targetChip.toString(),
            AccessPointIndex: '0',
            SSID: document.getElementById('wifi-ssid').value,
            ApIsolate: '0',
            AuthMode: authMode,
            ApBroadcastDisabled: document.getElementById('wifi-broadcast').checked ? '0' : '1',
            ApMaxStationNumber: document.getElementById('wifi-max-station').value,
            EncrypType: (authMode === 'OPEN') ? 'NONE' : 'CCMP',
            Password: toBase64(rawPass)
        };

        const paramRes = await Api.post('/api/proxy/goform/goform_set_cmd_process', params);
        if (paramRes && (paramRes.result === 'success' || paramRes.result === '0')) {
            await showAlert(`WiFi 已切换至 ${mode}GHz 并应用新参数`, "操作成功");
            setTimeout(() => this.init(), 2000);
        } else {
            await showAlert("频段已切换，但参数保存失败: " + (paramRes?.result || "未知错误"));
        }
    }
};
