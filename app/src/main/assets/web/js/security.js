/**
 * Security 模块 - 处理管理密码修改逻辑
 * 使用 CryptoJS SHA-256（兼容 HTTP 环境，Web Crypto API 需要 HTTPS）
 */
const SecurityModule = {
    init() {
        const btn = document.getElementById('btn-change-pwd');
        const newPwdInput = document.getElementById('new-password');

        if (!btn) return;

        // 实时强度检测
        newPwdInput.oninput = () => {
            this.checkStrength(newPwdInput.value);
        };

        btn.onclick = () => this.handleSubmit();
    },

    sha256(message) {
        return CryptoJS.SHA256(message).toString().toUpperCase();
    },

    checkStrength(pwd) {
        const info = document.getElementById('password-strength');
        if (!pwd) {
            if (info) info.textContent = "";
            return false;
        }

        if (pwd.length < 8) {
            info.innerHTML = icon('cross') + " 密码长度至少为 8 位";
            info.style.color = "#ff4d4f";
            return false;
        }

        const hasNum = /\d/.test(pwd);
        const hasLetter = /[a-zA-Z]/.test(pwd);

        if (!hasNum || !hasLetter) {
            info.innerHTML = icon('alert') + " 密码必须包含字母和数字";
            info.style.color = "#fa8c16";
            return false;
        }

        info.innerHTML = icon('check') + " 密码强度合格";
        info.style.color = "#52c41a";
        return true;
    },

    async handleSubmit() {
        const oldPwd = document.getElementById('old-password').value;
        const newPwd = document.getElementById('new-password').value;
        const confirmPwd = document.getElementById('confirm-password').value;

        if (!oldPwd || !newPwd) {
            showAlert("请输入完整信息");
            return;
        }

        if (newPwd !== confirmPwd) {
            showAlert("两次输入的新密码不一致");
            return;
        }

        if (!this.checkStrength(newPwd)) {
            showAlert("新密码强度不符合要求");
            return;
        }

        if (!await showConfirm("修改密码后，当前会话将失效并需要重新登录。确认修改吗？")) {
            return;
        }

        try {
            const hashedOld = this.sha256(oldPwd);
            const hashedNew = this.sha256(newPwd);

            // 通过 POST body 发送，避免哈希出现在 URL 中
            const res = await Api.post('/api/auth/change-password', {
                old: hashedOld,
                new: hashedNew
            });

            if (res && (res.result === "success" || res.result === 0 || res.result === "0")) {
                await showAlert("密码修改成功，请使用新密码重新登录", "成功");
                sessionStorage.clear();
                window.location.href = 'login.html';
            } else {
                showAlert("修改失败: " + (res.msg || "原密码错误或系统拒绝"));
            }
        } catch (e) {
            console.error("Change password error:", e);
            showAlert("加密或请求异常: " + e.message);
        }
    }
};
