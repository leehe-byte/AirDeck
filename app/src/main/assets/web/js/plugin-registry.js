/**
 * PluginRegistry - AirDeck 插件注册表
 *
 * 插件前端入口（manifest.json 的 entryJs）调用 PluginRegistry.register({...}) 注册自身。
 * 核心框架只依赖该注册表渲染菜单 / 加载页面 / 刷新 overview 卡片，插件可完全动态增删。
 */
const PluginRegistry = {
    plugins: [],          // 后端 /api/plugins 返回的插件元数据列表
    registered: {},       // id -> 插件定义（entryJs register() 注册的）
    scriptsLoaded: {},    // 已加载过 entryJs 的插件 id

    /** 从后端拉取插件列表并加载各插件 entryJs */
    async loadPlugins() {
        try {
            const list = await Api.get('/api/plugins');
            this.plugins = Array.isArray(list) ? list : [];
            for (const p of this.plugins) {
                if (p.entryJs && !this.scriptsLoaded[p.id]) {
                    await this.loadScript(`/plugins/${p.id}/www/${p.entryJs}`);
                    this.scriptsLoaded[p.id] = true;
                }
            }
        } catch (e) {
            console.error('加载插件列表失败', e);
            this.plugins = [];
        }
        return this.plugins;
    },

    /** 动态加载插件脚本（带时间戳防浏览器/WebView 缓存旧版） */
    loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src + (src.includes('?') ? '&' : '?') + '_=' + Date.now();
            s.onload = resolve;
            s.onerror = () => {
                console.error('插件脚本加载失败:', src);
                reject(new Error('插件脚本加载失败'));
            };
            document.head.appendChild(s);
        });
    },

    /**
     * 插件入口调用此方法注册自身
     * @param {{id:string, title:string, icon?:string, menu?:object|false, page?:string, init?:Function, cards?:Array}} pluginDef
     */
    register(pluginDef) {
        if (!pluginDef || !pluginDef.id) {
            console.error('插件注册失败: 缺少 id');
            return;
        }
        this.registered[pluginDef.id] = pluginDef;
        if (typeof window.renderPluginNav === 'function') window.renderPluginNav();
    },

    getPlugin(id) { return this.registered[id] || null; },

    /** 收集全部插件声明的 overview 卡片（overview:false 的卡片不进总览，可只用作其他渲染） */
    getCards() {
        const cards = [];
        for (const p of Object.values(this.registered)) {
            if (p.cards && Array.isArray(p.cards)) {
                for (const c of p.cards) {
                    if (c.overview === false) continue;
                    cards.push({ pluginId: p.id, title: c.title || p.title, ...c });
                }
            }
        }
        return cards;
    },

    /**
     * 刷新插件卡片（overview 轮询时调用）。
     * refreshMs 语义：缺省 5000；0 = 一次性（仅在 renderCards 时渲染一次，不轮询）。
     */
    refreshCards() {
        for (const card of this.getCards()) {
            if (card.refreshMs === 0) continue;
            try {
                if (typeof card.render === 'function') card.render();
            } catch (e) {
                console.error('插件卡片渲染失败:', card.pluginId, e);
            }
        }
    },

    /** 将插件卡片渲染进 overview 的 #plugin-cards 容器 */
    renderCards() {
        const container = document.getElementById('plugin-cards');
        if (!container) return;
        container.innerHTML = '';
        const cards = this.getCards();
        if (cards.length === 0) return;
        for (const card of cards) {
            const bodyId = `plugin-card-body-${card.pluginId}-${card.id}`;
            const box = document.createElement('div');
            box.className = 'card';
            box.style.marginBottom = '15px';
            box.innerHTML =
                `<div class="card-header"><h3>${card.icon ? escapeHtml(card.icon) : icon('puzzle')} ${escapeHtml(card.title || '')}</h3></div>` +
                `<div class="card-body" id="${bodyId}"></div>`;
            container.appendChild(box);
        }
        // 一次性卡片（refreshMs=0）在此渲染一次；其余交由 refreshCards 轮询
        for (const card of cards) {
            if (card.refreshMs === 0 && typeof card.render === 'function') {
                try { card.render(); } catch (e) {
                    console.error('插件卡片渲染失败:', card.pluginId, e);
                }
            }
        }
        this.refreshCards();
    }
};
