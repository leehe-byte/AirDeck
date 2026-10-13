/**
 * About 页面逻辑
 *
 * 注意：这个模块原来写在 pages/about.html 的**内联 <script>** 里，
 * 而 loadPage() 是用 contentArea.innerHTML = html 注入页面的 ——
 * **通过 innerHTML 插入的 <script> 不会执行**，框架只对插件页面做了手动补挂载。
 * 所以那段脚本从来没跑过，AboutModule 一直是 undefined，
 * initPageLogic 里那句 `AboutModule.init()` 每次都在抛 ReferenceError。
 * 之前没暴露是因为版本号是写死在 HTML 里的。
 *
 * 现在按其他页面的统一做法放进独立文件，由 index.html 全局加载。
 */
const AboutModule = {
    init() {
        const saved = localStorage.getItem('default_start_page') || 'overview';
        const labels = { 'overview': '状态总览', 'net-info': '网络详情', 'power': '电源管理', 'remote': '远程控制', 'sms': '短信列表' };
        setText('start-page-picker', labels[saved] || '状态总览');
        this.loadVersion();
    },

    // 版本号从服务端 /api/app 取（源头是 app/build.gradle.kts 的 versionName），
    // 这样发版只要改 gradle，不用再回来改页面。
    loadVersion() {
        Api.get('/api/app').then(res => {
            const v = res && res.versionName;
            if (v) setText('about-version', 'v' + v + ' Stable');
        }).catch(() => {
            // 取不到就保持占位，不要显示一个假的版本号
            setText('about-version', '版本未知');
        });
    },

    showStartPagePicker() {
        const options = [
            { label: '状态总览', value: 'overview' },
            { label: '网络详情', value: 'net-info' },
            { label: '电源管理', value: 'power' },
            { label: '远程控制', value: 'remote' },
            { label: '短信列表', value: 'sms' }
        ];
        const current = localStorage.getItem('default_start_page') || 'overview';
        ApiExtra.showPicker('设置默认启动页', options, current, (val, label) => {
            localStorage.setItem('default_start_page', val);
            setText('start-page-picker', label);
            showAlert('设置已保存，下次登录生效');
        });
    }
};
