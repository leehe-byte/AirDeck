/**
 * AirDeck API 驱动框架
 */
const Api = {
    // 通用请求
    async request(uri, method = 'GET', data = null) {
        const headers = {
            'X-Requested-With': 'XMLHttpRequest'
        };
        const token = sessionStorage.getItem('authToken');
        if (token) headers['X-Auth-Token'] = token;

        let body = null;
        if (data && method === 'POST') {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            body = 'postData=' + encodeURIComponent(typeof data === 'string' ? data : JSON.stringify(data));
        }

        try {
            const response = await fetch(uri, { method, headers, body });
            
            if (response.status === 401) {
                sessionStorage.clear();
                window.location.href = 'login.html';
                return null;
            }

            const text = await response.text();
            if (!text || text.trim() === '') return {};
            try {
                return JSON.parse(text);
            } catch (e) {
                // 非 JSON 响应，尝试提取 result
                if (text.includes('success') || text.includes('"result"')) {
                    return { result: 'success', raw: text };
                }
                return { result: text.trim(), raw: text };
            }
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    },

    async get(uri) { return this.request(uri, 'GET'); },
    async post(uri, data) { return this.request(uri, 'POST', data); },

    // 登录
    async login(password) {
        try {
            const body = 'postData=' + encodeURIComponent(JSON.stringify({ password: password }));
            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });
            const data = await response.json();
            if (data.result === 0) {
                sessionStorage.setItem('isLoggedIn', 'true');
                if (data.token) sessionStorage.setItem('authToken', data.token);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }
};
