/**
 * AirDeck - 登录逻辑
 */
document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const passwordInput = document.getElementById('password');
    const submitBtn = document.getElementById('submit-btn');
    const errorMsg = document.getElementById('error-msg');

    if (!loginForm) return;

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const password = passwordInput.value;
        if (!password) return;

        // UI 状态
        submitBtn.disabled = true;
        submitBtn.textContent = '身份验证中...';
        errorMsg.textContent = '';

        try {
            // 调用 Api.js 的登录接口
            // 后端 Ktor 接收到请求后，会自动启动 BridgeProtocol 的双重哈希逻辑
            const success = await Api.login(password);

            if (success) {
                errorMsg.style.color = '#52c41a';
                errorMsg.textContent = '验证成功，正在进入...';
                
                // 存储登录态并跳转
                sessionStorage.setItem('isLoggedIn', 'true');
                
                setTimeout(() => {
                    window.location.href = 'index.html';
                }, 800);
            } else {
                errorMsg.style.color = '#ff4d4f';
                errorMsg.textContent = '登录失败：密码错误或网关未响应';
                submitBtn.disabled = false;
                submitBtn.textContent = '进入面板';
            }
        } catch (error) {
            console.error('Login Exception:', error);
            errorMsg.style.color = '#ff4d4f';
            errorMsg.textContent = '系统异常：无法连接后端服务';
            submitBtn.disabled = false;
            submitBtn.textContent = '进入面板';
        }
    });
});
