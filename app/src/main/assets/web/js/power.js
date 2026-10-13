/**
 * Power Management Module v1.7
 */
const PowerModule = {
    currentConfig: {},
    currentSleepTime: "10",
    pendingSleepTime: "10",

    init: function() {
        console.log("PowerModule Initializing...");
        this.checkDeviceModelAndHideFeatures(); // 新增
        this.syncStatus();
        this.fetchBatteryStats();
        this.fetchSleepStatus();
    },

    checkDeviceModelAndHideFeatures: async function() {
        const isF50 = dataStore.deviceModel === "F50";
        const sleepSection = document.getElementById('sleep-section');
        if (sleepSection) {
            sleepSection.style.display = isF50 ? 'none' : 'block';
        }
    },

    // --- 续航统计逻辑 ---
    fetchBatteryStats: async function() {
        try {
            const history = await Api.get('/api/battery/history');
            const card = document.getElementById('battery-stats-card');
            if (!card) return;
            if (Array.isArray(history) && history.length > 0) {
                card.style.display = 'block';
                const latest = history[0];
                setText('latest-duration', this.formatDuration(latest.duration));
                const listEl = document.getElementById('history-list');
                if (listEl) {
                    listEl.innerHTML = history.map(item => `
                        <div style="display: flex; justify-content: space-between; padding: 8px 0; color: rgba(255,255,255,0.8); font-size: 13px;">
                            <span><svg class="ico" aria-hidden="true"><use href="#i-calendar"/></svg> ${this.formatDate(item.date)}</span>
                            <span style="font-weight: bold; color: #fff;">${this.formatDuration(item.duration)}</span>
                        </div>
                    `).join('');
                }
            } else {
                card.style.display = 'none';
            }
        } catch (e) { console.warn("Fetch battery stats failed", e); }
    },

    formatDuration: function(minutes) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    },

    formatDate: function(timestamp) {
        const d = new Date(timestamp);
        return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    },

    // --- 睡眠状态处理 ---
    fetchSleepStatus: async function() {
        try {
            const data = await Api.get('/api/proxy/goform/goform_get_cmd_process?isTest=false&cmd=sleep_sysIdleTimeToSleep&_=' + Date.now());
            if (data && data.sleep_sysIdleTimeToSleep !== undefined) {
                this.currentSleepTime = data.sleep_sysIdleTimeToSleep;
                this.pendingSleepTime = data.sleep_sysIdleTimeToSleep;
                this.updateSleepPickerLabel(this.currentSleepTime);
            }
        } catch (e) { console.error("Fetch sleep status failed", e); }
    },

    updateSleepPickerLabel: function(val) {
        const labels = { "-1": "从不休眠", "5": "5分钟", "10": "10分钟", "20": "20分钟", "30": "30分钟", "60": "1小时", "120": "2小时" };
        setText('sleep-picker-btn', labels[val] || "未知");
    },

    showSleepPicker: function() {
        const options = [
            { label: '从不休眠', value: '-1' }, { label: '5分钟', value: '5' }, { label: '10分钟', value: '10' },
            { label: '20分钟', value: '20' }, { label: '30分钟', value: '30' }, { label: '1小时', value: '60' }, { label: '2小时', value: '120' }
        ];
        ApiExtra.showPicker('设置自动休眠时间', options, this.pendingSleepTime, (val, label) => {
            this.pendingSleepTime = val;
            this.updateSleepPickerLabel(val);
        });
    },

    applySleepSetting: async function() {
        const labels = { "-1": "从不休眠", "5": "5分钟", "10": "10分钟", "20": "20分钟", "30": "30分钟", "60": "1小时", "120": "2小时" };
        const label = labels[this.pendingSleepTime];
        if (await showConfirm(`确认要将休眠时间设置为【${label}】吗？`)) {
            const res = await Api.post('/api/proxy/goform/goform_set_cmd_process', {
                isTest: 'false',
                goformId: 'SET_WIFI_SLEEP_INFO',
                sleep_sysIdleTimeToSleep: this.pendingSleepTime
            });
            if (res && res.result === 'success') {
                this.currentSleepTime = this.pendingSleepTime;
                showAlert("休眠设置已应用", "成功");
            } else {
                showAlert("设置失败，请重试", "错误");
            }
        }
    },
    // --- 原有硬件控制逻辑 ---
    syncStatus: async function() {
        try {
            const url = '/api/proxy/goform/goform_get_cmd_process?isTest=false&cmd=reboot_schedule_enable,reboot_schedule_mode,reboot_hour1,reboot_hour2,reboot_dow,reboot_dod,indicator_light_switch&multi_data=1';
            const data = await Api.get(url);
            if (data) {
                this.currentConfig = data;
                const lightOn = String(data.indicator_light_switch) === '1';
                const lightSwitch = document.getElementById('light-switch');
                if (lightSwitch) lightSwitch.checked = lightOn;
                setText('light-status-text', lightOn ? '当前状态：已开启' : '当前状态：已关闭');
                const rebootEnabled = String(data.reboot_schedule_enable) === '1';
                const rebootSwitch = document.getElementById('reboot-enable');
                if (rebootSwitch) rebootSwitch.checked = rebootEnabled;
                this.refreshPickerLabels();
                this.toggleUI();
            }
        } catch (e) { console.error("Sync Power Status Error:", e); }
    },

    refreshPickerLabels: function() {
        const data = this.currentConfig;
        const mode = String(data.reboot_schedule_mode || '2');
        setText('reboot-mode-picker', mode === '1' ? '按周循环 (固定星期)' : '按天循环 (间隔天数)');
        const labelEl = document.getElementById('reboot-interval-label');
        if (mode === '1') {
            labelEl.textContent = '重复星期';
            const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            setText('reboot-val-picker', weeks[data.reboot_dow] || '未设置');
        } else {
            labelEl.textContent = '间隔天数';
            setText('reboot-val-picker', `每隔 ${data.reboot_dod || 1} 天`);
        }
        const timeVal = mode === '1' ? data.reboot_hour1 : data.reboot_hour2;
        setText('reboot-time-picker', `${timeVal}:00 - ${parseInt(timeVal)+2}:00`);
    },

    toggleLight: async function() {
        const isChecked = document.getElementById('light-switch').checked;
        const res = await Api.post('/api/proxy/goform/goform_set_cmd_process', {
            isTest: 'false',
            goformId: 'INDICATOR_LIGHT_SETTING',
            indicator_light_switch: isChecked ? '1' : '0'
        });
        if (res && res.result === 'success') {
            setText('light-status-text', isChecked ? '当前状态：已开启' : '当前状态：已关闭');
        } else {
            showAlert("指示灯设置失败");
            document.getElementById('light-switch').checked = !isChecked;
        }
    },

    showModePicker: function() {
        const options = [{ label: '按天循环 (间隔天数)', value: '2' }, { label: '按周循环 (固定星期)', value: '1' }];
        ApiExtra.showPicker('选择重启规则', options, this.currentConfig.reboot_schedule_mode, (val) => {
            this.currentConfig.reboot_schedule_mode = val;
            this.refreshPickerLabels();
        });
    },

    showValPicker: function() {
        const mode = String(this.currentConfig.reboot_schedule_mode || '2');
        let options = [];
        if (mode === '2') {
            for (let i = 1; i <= 30; i++) options.push({ label: `每隔 ${i} 天`, value: i.toString() });
        } else {
            const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            weeks.forEach((name, i) => options.push({ label: name, value: i.toString() }));
        }
        ApiExtra.showPicker('设置重启间隔', options, mode === '1' ? this.currentConfig.reboot_dow : this.currentConfig.reboot_dod, (val) => {
            if (mode === '1') this.currentConfig.reboot_dow = val;
            else this.currentConfig.reboot_dod = val;
            this.refreshPickerLabels();
        });
    },

    showTimePicker: function() {
        let options = [];
        for (let i = 0; i <= 22; i += 2) options.push({ label: `${i}:00 - ${i+2}:00`, value: i.toString() });
        const currentMode = String(this.currentConfig.reboot_schedule_mode || '2');
        const currentVal = currentMode === '1' ? this.currentConfig.reboot_hour1 : this.currentConfig.reboot_hour2;
        ApiExtra.showPicker('选择重启时间段', options, currentVal, (val) => {
            if (currentMode === '1') this.currentConfig.reboot_hour1 = val;
            else this.currentConfig.reboot_hour2 = val;
            this.refreshPickerLabels();
        });
    },

    toggleUI: function() {
        const isEnabled = document.getElementById('reboot-enable').checked;
        const form = document.getElementById('reboot-config-form');
        if (form) form.style.display = isEnabled ? 'block' : 'none';
    },

    action: async function(goformId) {
        if (await showConfirm("确认执行该电源操作吗？")) {
            const res = await Api.post('/api/proxy/goform/goform_set_cmd_process', { isTest: 'false', goformId: goformId });
            if (res && res.result === 'success') showAlert("指令已下发");
        }
    },

    saveSettings: async function() {
        const data = this.currentConfig;
        const mode = String(data.reboot_schedule_mode || '2');
        const params = {
            isTest: 'false',
            goformId: 'FIX_TIME_REBOOT_SCHEDULE',
            reboot_schedule_enable: document.getElementById('reboot-enable').checked ? '1' : '0',
            reboot_schedule_mode: mode,
            reboot_hour1: mode === '1' ? (data.reboot_hour1 || '2') : '2',
            reboot_min1: '0',
            reboot_hour2: mode === '2' ? (data.reboot_hour2 || '2') : '2',
            reboot_min2: '0',
            reboot_timeframe_hours1: '0',
            reboot_timeframe_hours2: '0',
            reboot_dow: mode === '1' ? (data.reboot_dow || '1') : '1',
            reboot_dod: mode === '2' ? (data.reboot_dod || '7') : '7'
        };
        const res = await Api.post('/api/proxy/goform/goform_set_cmd_process', params);
        if (res && res.result === 'success') { showAlert('设置保存成功'); this.syncStatus(); }
    }
};
