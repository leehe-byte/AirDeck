/* ============================================================================
 *  Liquid Glass 皮肤 · 运行时代码
 *
 *  做三件事：
 *   1. 铺一层动态极光背景（基础层 + 每块玻璃内部的副本，用同一个 rAF 驱动，保证同步）
 *   2. 给顶栏 / 侧边栏做**真折射**：复制极光 + SVG 位移滤镜
 *      （用普通 filter: url()，不是 backdrop-filter —— 后者喂不进自定义位移贴图）
 *   3. 卡片 / 按钮的指针跟随高光
 *
 *  开关：document.documentElement 上的 data-skin="glass"
 * ========================================================================== */
(function () {
    'use strict';

    var SKIN_ATTR = 'data-skin';
    var SKIN_NAME = 'glass';
    var MARGIN = 48;                       // 与 CSS 里 .lg-refract 的 inset:-48px 对应
    var STORE_KEY = 'lg-skin';
    var NS = 'http://www.w3.org/2000/svg';

    /* ------------------------------------------------------------------ *
     *  0. 工具
     * ------------------------------------------------------------------ */
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

    /** 圆角矩形有符号距离场：<0 内部，=0 边界，>0 外部 */
    function sdRoundRect(px, py, hw, hh, r) {
        var qx = Math.abs(px) - hw + r;
        var qy = Math.abs(py) - hh + r;
        var mx = Math.max(qx, 0), my = Math.max(qy, 0);
        return Math.min(Math.max(qx, qy), 0) + Math.hypot(mx, my) - r;
    }

    /**
     * SDF 的解析梯度（指向外部的单位法线）。
     *
     * 不要用数值中心差分：圆角矩形 SDF 内部是 max(|px|-hw, |py|-hh)，
     * 这个 max 在对角线上有折点，差分跨过折点会把两边方向平均成 45°，
     * 导致高光/折射在对角线上出现一条假的亮线或暗线。
     */
    function gradSdRoundRect(px, py, hw, hh, r) {
        var qx = Math.abs(px) - hw + r;
        var qy = Math.abs(py) - hh + r;
        var sx = px < 0 ? -1 : 1;
        var sy = py < 0 ? -1 : 1;
        if (qx >= 0 || qy >= 0) {
            var mx = Math.max(qx, 0), my = Math.max(qy, 0);
            var l = Math.hypot(mx, my);
            if (l < 1e-6) return [sx, 0];
            return [sx * mx / l, sy * my / l];
        }
        var gx = qx >= qy ? 1 : 0;
        return [sx * gx, sy * (1 - gx)];
    }

    /** 侧壁剖面：酷安 AGSL 里的 circleMap(1-t)，等价于 1 - √(1-(1-t)²) */
    function circleProfile(t) {
        var u = 1 - clamp(t, 0, 1);
        return 1 - Math.sqrt(Math.max(0, 1 - u * u));
    }

    /**
     * 生成位移贴图：R 通道存 x 位移、G 通道存 y 位移，128 表示不动。
     * 返回 { href, scale }：href 是 data URL，scale 是 feDisplacementMap 的 scale。
     */
    function buildDisplacementMap(mapW, mapH, glassW, glassH, radius, bezel, refraction, depthEffect) {
        var cv = document.createElement('canvas');
        cv.width = mapW; cv.height = mapH;
        var ctx = cv.getContext('2d', { willReadFrequently: true });
        var img = ctx.createImageData(mapW, mapH);
        var d = img.data;

        var hw = glassW / 2, hh = glassH / 2;
        var r = clamp(radius, 0, Math.min(hw, hh));
        var vec = new Float32Array(mapW * mapH * 2);
        var maxMag = 1e-6;

        for (var y = 0; y < mapH; y++) {
            for (var x = 0; x < mapW; x++) {
                var px = x + 0.5 - mapW / 2;
                var py = y + 0.5 - mapH / 2;
                var sd = sdRoundRect(px, py, hw, hh, r);
                var vx = 0, vy = 0;

                if (sd < 0) {
                    var t = clamp(-sd / bezel, 0, 1);
                    var mag = refraction * bezel * circleProfile(t);
                    var g = gradSdRoundRect(px, py, hw, hh, r);
                    var nx = g[0], ny = g[1];

                    if (depthEffect > 0) {
                        var cl = Math.hypot(px, py) || 1;
                        nx += depthEffect * (px / cl);
                        ny += depthEffect * (py / cl);
                        var l2 = Math.hypot(nx, ny) || 1;
                        nx /= l2; ny /= l2;
                    }
                    vx = -nx * mag;
                    vy = -ny * mag;
                    if (Math.hypot(vx, vy) > maxMag) maxMag = Math.hypot(vx, vy);
                }
                var i = (y * mapW + x) * 2;
                vec[i] = vx; vec[i + 1] = vy;
            }
        }

        for (var p = 0; p < mapW * mapH; p++) {
            var o = p * 4;
            d[o] = clamp(128 + (vec[p * 2] / maxMag) * 127, 0, 255);
            d[o + 1] = clamp(128 + (vec[p * 2 + 1] / maxMag) * 127, 0, 255);
            d[o + 2] = 128;
            d[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return { href: cv.toDataURL('image/png'), scale: maxMag * 255 / 127 };
    }

    /* ------------------------------------------------------------------ *
     *  1. 极光背景
     * ------------------------------------------------------------------ */
    var BLOBS = [
        { cls: 'b1', bx: -0.34, by: -0.30, ampX: 0.16, ampY: 0.13, sp: 0.00011, ph: 0.00 },
        { cls: 'b2', bx: 0.38, by: -0.22, ampX: 0.14, ampY: 0.16, sp: 0.00014, ph: 2.10 },
        { cls: 'b3', bx: -0.22, by: 0.38, ampX: 0.17, ampY: 0.12, sp: 0.00009, ph: 4.20 },
        { cls: 'b4', bx: 0.34, by: 0.34, ampX: 0.13, ampY: 0.15, sp: 0.00016, ph: 1.05 }
    ];

    /** 造一组 blob 元素。基础层和玻璃副本各造一份，动画由同一个循环驱动。 */
    function createBlobSet(host) {
        var nodes = [];
        for (var i = 0; i < BLOBS.length; i++) {
            var el = document.createElement('i');
            el.className = 'lg-blob ' + BLOBS[i].cls;
            host.appendChild(el);
            nodes.push(el);
        }
        // 暗化层也要跟着复制一份，否则玻璃内部那份会比外面亮
        var dim = document.createElement('i');
        dim.className = 'lg-dim';
        host.appendChild(dim);
        return nodes;
    }

    var blobGroups = [];   // [{ nodes: [...] }, ...]

    function stepBlobs(t) {
        var m = Math.min(window.innerWidth, window.innerHeight);
        for (var gi = 0; gi < blobGroups.length; gi++) {
            var nodes = blobGroups[gi].nodes;
            for (var i = 0; i < BLOBS.length; i++) {
                var b = BLOBS[i];
                var a = t * b.sp + b.ph;
                var x = (b.bx + Math.cos(a) * b.ampX) * m;
                var y = (b.by + Math.sin(a * 0.83) * b.ampY) * m;
                var s = 1 + 0.12 * Math.sin(a * 0.7);
                nodes[i].style.transform =
                    'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) scale(' + s.toFixed(3) + ')';
            }
        }
    }

    /* ------------------------------------------------------------------ *
     *  2. 真折射玻璃面
     * ------------------------------------------------------------------ */
    /* bezel 是折射带宽度，refraction 是强度（都按 px 走，不再乘一次设备像素比）。
       顶栏只有 60px 高，折射带要窄；侧边栏宽，可以用大一点。 */
    var SURFACES = [
        { sel: '#header', bezel: 16, refraction: 1.10, radius: 0, depth: 0.10 },
        { sel: '#sidebar', bezel: 26, refraction: 0.95, radius: 0, depth: 0.22 }
    ];

    var surfaces = [];

    function createSurface(cfg, index) {
        var el = document.querySelector(cfg.sel);
        if (!el) return null;

        el.querySelectorAll(':scope > .lg-refract, :scope > .lg-tint, :scope > .lg-spec, :scope > .lg-rim')
            .forEach(function (n) { n.remove(); });

        var layer = document.createElement('div');
        layer.className = 'lg-refract';
        var copy = document.createElement('div');
        copy.className = 'lg-aurora lg-aurora-copy';
        copy.style.position = 'absolute';
        layer.appendChild(copy);

        var tint = document.createElement('div');
        tint.className = 'lg-tint';
        var spec = document.createElement('div');
        spec.className = 'lg-spec';
        var rim = document.createElement('div');
        rim.className = 'lg-rim';

        // 插到最前面，保证内容盖在玻璃之上
        el.insertBefore(rim, el.firstChild);
        el.insertBefore(spec, el.firstChild);
        el.insertBefore(tint, el.firstChild);
        el.insertBefore(layer, el.firstChild);

        var filter = document.createElementNS(NS, 'filter');
        filter.setAttribute('id', 'lg-f' + index);
        filter.setAttribute('filterUnits', 'userSpaceOnUse');
        filter.setAttribute('color-interpolation-filters', 'sRGB');
        document.getElementById('lg-defs').appendChild(filter);

        // 关键：--fid 只放 url(#id) 本体，filter 属性直接引用，不要再套一层 url()
        layer.style.filter = 'url(#lg-f' + index + ')';
        layer.style.webkitFilter = 'url(#lg-f' + index + ')';

        var s = {
            cfg: cfg, el: el, layer: layer, copy: copy, filter: filter,
            feImage: null, blobNodes: createBlobSet(copy)
        };
        blobGroups.push({ nodes: s.blobNodes });
        rebuildSurface(s);
        return s;
    }

    /** 元素尺寸变了才需要重建贴图（这一步不便宜，只在 resize 时做） */
    function rebuildSurface(s) {
        var rect = s.el.getBoundingClientRect();
        var gw = Math.max(4, Math.round(rect.width));
        var gh = Math.max(4, Math.round(rect.height));
        if (gw === s._gw && gh === s._gh) return;
        s._gw = gw; s._gh = gh;

        var mw = gw + MARGIN * 2;
        var mh = gh + MARGIN * 2;

        var box = [['x', 0], ['y', 0], ['width', mw], ['height', mh]];
        for (var i = 0; i < box.length; i++) {
            s.filter.setAttribute(box[i][0], box[i][1]);
        }

        var map = buildDisplacementMap(
            mw, mh, gw, gh, s.cfg.radius,
            Math.max(1, s.cfg.bezel), s.cfg.refraction, s.cfg.depth
        );

        while (s.filter.firstChild) s.filter.removeChild(s.filter.firstChild);
        var img = document.createElementNS(NS, 'feImage');
        img.setAttribute('x', 0); img.setAttribute('y', 0);
        img.setAttribute('width', mw); img.setAttribute('height', mh);
        img.setAttribute('preserveAspectRatio', 'none');
        img.setAttribute('href', map.href);
        img.setAttribute('result', 'map');
        var disp = document.createElementNS(NS, 'feDisplacementMap');
        disp.setAttribute('in', 'SourceGraphic');
        // 必须用 result 名字符串引用。
        // 不能写 setAttribute('in2', img) —— 那会把元素字符串化成
        // "[object SVGFEImageElement]"，匹配不到任何 result，位移贴图等于没接上，
        // 而因为折射层显示的就是同一张背景，肉眼根本看不出它是空的。
        disp.setAttribute('in2', 'map');
        disp.setAttribute('xChannelSelector', 'R');
        disp.setAttribute('yChannelSelector', 'G');
        disp.setAttribute('scale', map.scale.toFixed(3));
        s.filter.appendChild(img);
        s.filter.appendChild(disp);
        s._scale = map.scale;
    }

    /** 每帧：把玻璃内部的极光副本和真实视口对齐（位置变化时必须更新） */
    function syncSurface(s) {
        var r = s.layer.getBoundingClientRect();
        s.copy.style.left = (-Math.round(r.left)) + 'px';
        s.copy.style.top = (-Math.round(r.top)) + 'px';
        s.copy.style.width = window.innerWidth + 'px';
        s.copy.style.height = window.innerHeight + 'px';
    }

    /* ------------------------------------------------------------------ *
     *  3. 指针跟随高光
     *
     *  不只点亮指针正下方那张卡：指针落在卡片之间的缝隙里时，
     *  两侧的卡片都会亮起来，光看起来是"跨过去"的，而不是被卡片边界切断。
     *
     *  只在有精确指针的设备上启用 —— 触屏上的 pointermove 会在拖动时乱触发，
     *  给一堆卡片插上 .lg-spec，既没用又加重合成负担。
     * ------------------------------------------------------------------ */
    var SHEEN_RADIUS = 220;      // 触发半径（px）

    function ensureSpec(card) {
        if (card.querySelector(':scope > .lg-spec')) return;
        var sp = document.createElement('div');
        sp.className = 'lg-spec';
        card.insertBefore(sp, card.firstChild);
    }

    function clearSheen() {
        var on = document.querySelectorAll('.lg-sheen');
        for (var i = 0; i < on.length; i++) on[i].classList.remove('lg-sheen');
    }

    function bindSheen() {
        if (!window.matchMedia ||
            !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

        var pending = null, rafId2 = null;

        function apply() {
            rafId2 = null;
            var e = pending; pending = null;
            if (!e || !isOn()) return;

            var px = e.clientX, py = e.clientY;
            var cards = document.querySelectorAll('.card, .modal-container, .sms-thread-card');

            // 先把所有几何读完（读阶段），再统一写样式（写阶段），
            // 避免读写交错反复触发同步布局
            var geo = [];
            for (var i = 0; i < cards.length; i++) {
                var c = cards[i], r = c.getBoundingClientRect();
                var dx = Math.max(r.left - px, 0, px - r.right);
                var dy = Math.max(r.top - py, 0, py - r.bottom);
                geo.push([c, r, Math.sqrt(dx * dx + dy * dy)]);
            }
            for (var j = 0; j < geo.length; j++) {
                var el = geo[j][0], rr = geo[j][1], dist = geo[j][2];
                if (dist <= SHEEN_RADIUS) {
                    ensureSpec(el);
                    // 百分比允许超出 0~100%：指针在卡片外时，光心落在卡片之外，
                    // 卡片上只露出一部分渐变，视觉上就是光"跨"过来了
                    el.style.setProperty('--lg-mx', ((px - rr.left) / rr.width * 100).toFixed(1) + '%');
                    el.style.setProperty('--lg-my', ((py - rr.top) / rr.height * 100).toFixed(1) + '%');
                    el.classList.add('lg-sheen');
                } else if (el.classList.contains('lg-sheen')) {
                    el.classList.remove('lg-sheen');
                }
            }
        }

        document.addEventListener('pointermove', function (e) {
            pending = e;
            if (rafId2 === null) rafId2 = requestAnimationFrame(apply);
        }, { passive: true });

        document.addEventListener('pointerleave', clearSheen, { passive: true });
    }

    /* ------------------------------------------------------------------ *
     *  3b. 侧边栏滑动 —— 动画期间把折射层摘掉
     *
     *  #sidebar 里挂着一个 335×700+ 的 SVG 位移滤镜。
     *  滑动时浏览器每帧都要重新栅格化它，而且 filter 会改变 backdrop root，
     *  连带页面上所有 backdrop-filter 卡片一起重算背景 ——
     *  表现就是掉帧 + 闪白 + 内容偶发空白。
     *  所以滑动期间用 .lg-motion 把折射层 visibility:hidden，动画结束后再挂回来。
     * ------------------------------------------------------------------ */
    function watchSidebarMotion() {
        var sb = document.querySelector('#sidebar');
        if (!sb) return;
        var wasOpen = document.body.classList.contains('sidebar-open');
        var safety = null;

        function endMotion() {
            clearTimeout(safety);
            if (!sb.classList.contains('lg-motion')) return;
            sb.classList.remove('lg-motion');
            syncAll();                     // 落位后再对一次，避免错位
        }
        function beginMotion() {
            sb.classList.add('lg-motion');
            clearTimeout(safety);
            safety = setTimeout(endMotion, 600);   // transitionend 万一不触发，兜底
        }

        new MutationObserver(function () {
            var open = document.body.classList.contains('sidebar-open');
            if (open === wasOpen) return;
            wasOpen = open;
            beginMotion();
        }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

        sb.addEventListener('transitionend', function (e) {
            if (e.target === sb && e.propertyName === 'transform') endMotion();
        });
        sb.addEventListener('transitioncancel', endMotion);
    }

    /* ------------------------------------------------------------------ *
     *  3c. 背景设置（极光 / 纯色 / 自定义图片）
     * ------------------------------------------------------------------ */
    var BG_KEY = 'lg-bg';
    var bg = { mode: 'aurora', solid: '#0b1020', image: '', url: '', blur: true, dim: 0.25, motion: true };
    var IMAGE_MAX_EDGE = 1600;
    var IMAGE_SOFT_LIMIT = 3.6 * 1024 * 1024;   // localStorage 一般 5MB，留点余量

    function loadBg() {
        var raw = null;
        try { raw = localStorage.getItem(BG_KEY); } catch (e) {}

        // 首次运行且是小屏：默认关掉卡片的毛玻璃。
        // backdrop-filter 在 DOM 刷新时要重新采样背景，是手机上闪烁/掉帧的主要来源；
        // 顶栏和侧边栏用的是 SVG 折射滤镜，不受影响，招牌的折射效果还在。
        if (raw === null && window.innerWidth <= 768) bg.blur = false;

        try {
            if (raw) {
                var o = JSON.parse(raw);
                if (o && typeof o === 'object') {
                    if (o.mode) bg.mode = o.mode;
                    if (o.solid) bg.solid = o.solid;
                    if (typeof o.image === 'string') bg.image = o.image;
                    if (typeof o.blur === 'boolean') bg.blur = o.blur;
                    if (typeof o.dim === 'number') bg.dim = Math.min(0.8, Math.max(0, o.dim));
                    if (typeof o.motion === 'boolean') bg.motion = o.motion;
                    if (typeof o.url === 'string') bg.url = o.url;
                }
            }
        } catch (e) {}
    }

    function saveBg() {
        try { localStorage.setItem(BG_KEY, JSON.stringify(bg)); return true; }
        catch (e) { return false; }
    }

    function applyBg() {
        var root = document.documentElement;
        if (bg.mode === 'image' && bg.image) {
            root.style.setProperty('--lg-bg-image', 'url("' + bg.image + '")');
            root.setAttribute('data-lg-bg', 'image');
        } else if (bg.mode === 'solid') {
            root.style.setProperty('--lg-bg-solid', bg.solid);
            root.setAttribute('data-lg-bg', 'solid');
        } else {
            root.setAttribute('data-lg-bg', 'aurora');
        }
        root.setAttribute('data-lg-blur', bg.blur ? 'on' : 'off');
        // 一层半透明黑，纯合成；不用 filter: brightness()（全屏滤镜，代价高）
        root.style.setProperty('--lg-dim-op', bg.dim.toFixed(3));
        startMotion();
    }

    /** 读图 → 等比缩到 1600px 内 → 转 JPEG，避免把大图塞进 localStorage */
    function readImageFile(file, done) {
        if (!file || !/^image\//.test(file.type)) { done(null, '不是图片文件'); return; }
        var reader = new FileReader();
        reader.onerror = function () { done(null, '读取失败'); };
        reader.onload = function () {
            var img = new Image();
            img.onerror = function () { done(null, '图片解码失败'); };
            img.onload = function () {
                var s = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
                var cv = document.createElement('canvas');
                cv.width = Math.max(1, Math.round(img.width * s));
                cv.height = Math.max(1, Math.round(img.height * s));
                cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
                done(cv.toDataURL('image/jpeg', 0.82), null);
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    }

    /* ------------------------------------------------------------------ *
     *  4. 开关 / 生命周期
     * ------------------------------------------------------------------ */
    var rafId = null;
    var active = false;          // 独立标志：登录页没有玻璃面，不能靠 surfaces.length 判重

    /* 每帧只做 blob 的 transform（纯合成，不触发布局）。
       玻璃层与视口的对齐只在尺寸/位置真的变了时才重算 —— 之前每帧调
       getBoundingClientRect() 会强制同步布局，是卡顿的另一个来源。 */
    /* 极光动得很慢，不需要 60fps。
       而且背景每变一次，页面上所有 backdrop-filter 都要重新采样一次背景 ——
       锁到 ~15fps 能省掉大约 3/4 的开销，视觉上看不出区别。 */
    var BLOB_INTERVAL = 66;
    var lastBlobTs = -1e9;

    function tick(t) {
        if (!bg.motion || document.hidden || !isOn()) { rafId = null; return; }
        if (t - lastBlobTs >= BLOB_INTERVAL) {
            lastBlobTs = t;
            stepBlobs(t);
        }
        rafId = requestAnimationFrame(tick);
    }

    function startMotion() {
        if (!isOn() || !bg.motion || document.hidden) return;
        if (rafId === null) { lastBlobTs = -1e9; rafId = requestAnimationFrame(tick); }
    }

    function stopMotion() {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function syncAll() {
        for (var i = 0; i < surfaces.length; i++) syncSurface(surfaces[i]);
    }

    function isOn() {
        return document.documentElement.getAttribute(SKIN_ATTR) === SKIN_NAME;
    }

    function enable() {
        if (active) return;
        active = true;
        var base = document.getElementById('lg-aurora');
        blobGroups = [{ nodes: createBlobSet(base) }];
        surfaces = [];
        for (var i = 0; i < SURFACES.length; i++) {
            var s = createSurface(SURFACES[i], i);
            if (s) surfaces.push(s);
        }
        syncAll();
        startMotion();
    }

    function disable() {
        if (!active) return;
        active = false;
        stopMotion();
        for (var i = 0; i < surfaces.length; i++) {
            var s = surfaces[i];
            if (s.layer.parentNode) s.layer.parentNode.removeChild(s.layer);
            if (s.filter.parentNode) s.filter.parentNode.removeChild(s.filter);
            ['lg-tint', 'lg-spec', 'lg-rim'].forEach(function (c) {
                var n = s.el.querySelector(':scope > .' + c);
                if (n) n.remove();
            });
        }
        surfaces = [];
        var base = document.getElementById('lg-aurora');
        if (base) base.innerHTML = '';
        blobGroups = [];
        document.querySelectorAll('.lg-aurora-copy').forEach(function (n) { n.remove(); });

        // 关闭后不能留残留：这时 .card 没有 position:relative，
        // 残留的 .lg-spec 会以别的祖先为定位基准，跑到奇怪的地方去
        clearSheen();
        document.querySelectorAll('.lg-spec').forEach(function (n) { n.remove(); });
    }

    function setSkin(on, persist) {
        if (on) {
            document.documentElement.setAttribute(SKIN_ATTR, SKIN_NAME);
            enable();
        } else {
            document.documentElement.removeAttribute(SKIN_ATTR);
            disable();
        }
        if (persist !== false) {
            try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (e) {}
        }
        updateButton();
        syncSettingsUI();
    }

    /* 内联 SVG：不依赖设备字体。
       之前关闭时把文字换成 🫧(U+1FAE7)，那是 Emoji 14 才有的字形，
       老设备上直接渲染成豆腐块。 */
    var ICON =
        '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 2.6 20 7v10l-8 4.4L4 17V7z"/>' +
        '<path d="M12 2.6V12m0 0 8-5m-8 5-8-5m8 5v9.4"/></svg>';

    function updateButton() {
        var b = document.getElementById('lg-skin-btn');
        if (!b) return;
        if (b.getAttribute('data-icon') !== '1') {
            b.innerHTML = ICON;
            b.setAttribute('data-icon', '1');
        }
        // 开关状态用透明度表示，不再换字形
        b.classList.toggle('lg-off', !isOn());
        b.title = '外观设置';
    }

    /* ------------------------------------------------------------------ *
     *  4b. 外观设置面板
     * ------------------------------------------------------------------ */
    function buildSettings() {
        if (document.getElementById('lg-settings')) return;
        var m = document.createElement('div');
        m.id = 'lg-settings';
        m.className = 'lg-modal';
        m.innerHTML =
            '<div class="lg-modal-box" role="dialog" aria-label="外观设置">' +
            '  <div class="lg-modal-head"><h3>外观设置</h3>' +
            '    <button class="lg-x" type="button" data-act="close">✕</button></div>' +
            '  <div class="lg-modal-body">' +
            '    <div class="lg-row"><span>液态玻璃</span>' +
            '      <label class="lg-switch"><input type="checkbox" id="lg-opt-skin"><i></i></label></div>' +
            '    <div class="lg-row"><span>毛玻璃模糊<small>关掉可明显提升老设备流畅度</small></span>' +
            '      <label class="lg-switch"><input type="checkbox" id="lg-opt-blur"><i></i></label></div>' +
            '    <div class="lg-row"><span>背景动效<small>数据刷新频繁时，关掉可以消除闪烁</small></span>' +
            '      <label class="lg-switch"><input type="checkbox" id="lg-opt-motion"><i></i></label></div>' +
            '    <div class="lg-sub">背景</div>' +
            '    <div class="lg-seg" id="lg-bg-seg">' +
            '      <button type="button" data-mode="aurora">极光</button>' +
            '      <button type="button" data-mode="solid">纯色</button>' +
            '      <button type="button" data-mode="image">图片</button>' +
            '    </div>' +
            '    <div class="lg-row" id="lg-solid-row"><span>背景色</span>' +
            '      <input type="color" id="lg-opt-solid"></div>' +
            '    <div class="lg-row" id="lg-image-row"><span>自定义图片</span>' +
            '      <button type="button" class="lg-file-btn" data-act="pick">选择图片</button></div>' +
            '    <div class="lg-row"><span>背景暗化<small>自定义图片偏亮时，靠它拉回对比度</small></span>' +
            '      <input type="range" id="lg-opt-dim" min="0" max="70" step="5" class="lg-range"></div>' +
            '    <input type="file" accept="image/*" id="lg-file-input" hidden>' +
            '    <div class="lg-hint" id="lg-hint">图片会自动缩到 1600px 内并压缩后保存在本机。</div>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(m);

        var $ = function (id) { return document.getElementById(id); };

        m.addEventListener('click', function (e) {
            if (e.target === m || (e.target.closest && e.target.closest('[data-act="close"]'))) {
                closeSettings();
                return;
            }
            var seg = e.target.closest && e.target.closest('#lg-bg-seg button');
            if (seg) {
                bg.mode = seg.getAttribute('data-mode');
                saveBg(); applyBg(); syncSettingsUI();
            }
            if (e.target.closest && e.target.closest('[data-act="pick"]')) {
                $('lg-file-input').click();
            }
        });

        $('lg-opt-skin').addEventListener('change', function () { setSkin(this.checked); });
        $('lg-opt-blur').addEventListener('change', function () {
            bg.blur = this.checked; saveBg(); applyBg();
        });
        $('lg-opt-solid').addEventListener('input', function () {
            bg.solid = this.value; bg.mode = 'solid'; saveBg(); applyBg(); syncSettingsUI();
        });
        $('lg-opt-dim').addEventListener('input', function () {
            bg.dim = (+this.value) / 100; saveBg(); applyBg();
        });
        $('lg-opt-motion').addEventListener('change', function () {
            bg.motion = this.checked; saveBg();
            if (bg.motion) startMotion(); else stopMotion();
        });
        $('lg-file-input').addEventListener('change', function () {
            var f = this.files && this.files[0];
            this.value = '';
            if (!f) return;
            var hint = $('lg-hint');
            hint.textContent = '处理中…';
            readImageFile(f, function (dataUrl, err) {
                if (err || !dataUrl) { hint.textContent = '图片处理失败：' + (err || '未知错误'); return; }
                if (dataUrl.length > IMAGE_SOFT_LIMIT) {
                    hint.textContent = '图片太大，压缩后仍超出本机存储上限，换一张小一点的吧。';
                    return;
                }
                bg.image = dataUrl; bg.mode = 'image';
                if (!saveBg()) { hint.textContent = '保存失败：本机存储空间不足。'; return; }
                applyBg(); syncSettingsUI();
                hint.textContent = '已应用。背景有细节时，顶栏/侧边栏的折射会明显得多。';
            });
        });
    }

    function syncSettingsUI() {
        var $ = function (id) { return document.getElementById(id); };
        if (!$('lg-settings')) return;
        $('lg-opt-skin').checked = isOn();
        $('lg-opt-blur').checked = bg.blur;
        $('lg-opt-motion').checked = bg.motion;
        $('lg-opt-solid').value = bg.solid;
        $('lg-opt-dim').value = Math.round(bg.dim * 100);
        $$('#lg-bg-seg button').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-mode') === bg.mode);
        });
        $('lg-solid-row').style.display = bg.mode === 'solid' ? '' : 'none';
        $('lg-image-row').style.display = bg.mode === 'image' ? '' : 'none';
    }

    function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

    function openSettings() {
        buildSettings();
        syncSettingsUI();
        document.getElementById('lg-settings').classList.add('active');
    }
    function closeSettings() {
        var m = document.getElementById('lg-settings');
        if (m) m.classList.remove('active');
    }

    /* ------------------------------------------------------------------ *
     *  5. 启动
     * ------------------------------------------------------------------ */
    function boot() {
        loadBg();

        // 极光基础层 + SVG 容器
        if (!document.getElementById('lg-aurora')) {
            var base = document.createElement('div');
            base.id = 'lg-aurora';
            base.className = 'lg-aurora';
            base.setAttribute('aria-hidden', 'true');
            document.body.insertBefore(base, document.body.firstChild);
        }
        if (!document.getElementById('lg-defs')) {
            var defs = document.createElementNS(NS, 'svg');
            defs.setAttribute('id', 'lg-defs');
            defs.setAttribute('width', '0');
            defs.setAttribute('height', '0');
            defs.style.position = 'absolute';
            defs.style.pointerEvents = 'none';
            document.body.appendChild(defs);
        }

        // 顶栏按钮：打开外观设置
        var top = document.querySelector('#header .top-status');
        if (top && !document.getElementById('lg-skin-btn')) {
            var btn = document.createElement('button');
            btn.id = 'lg-skin-btn';
            btn.type = 'button';
            btn.addEventListener('click', openSettings);
            top.insertBefore(btn, top.firstChild);
        }

        // 登录页没有顶栏，放一个浮动入口
        if (!top && !document.getElementById('lg-skin-fab') && document.querySelector('.login-box')) {
            var fab = document.createElement('button');
            fab.id = 'lg-skin-fab';
            fab.type = 'button';
            fab.title = '外观设置';
            fab.innerHTML = ICON;
            fab.addEventListener('click', openSettings);
            document.body.appendChild(fab);
        }

        bindSheen();
        watchSidebarMotion();

        var saved = null;
        try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
        applyBg();
        // 未设置过时默认开启（这是特性分支）
        setSkin(saved === null ? true : saved === '1', false);

        // 尺寸变化才需要重建贴图（重建内部会比对尺寸，没变直接返回）
        var rzTimer = null;
        window.addEventListener('resize', function () {
            clearTimeout(rzTimer);
            rzTimer = setTimeout(function () {
                for (var i = 0; i < surfaces.length; i++) rebuildSurface(surfaces[i]);
                syncAll();
            }, 180);
        }, { passive: true });
        window.addEventListener('orientationchange', function () {
            setTimeout(function () { syncAll(); }, 300);
        }, { passive: true });

        // 页面不可见时停掉背景动画，省电也省得回来时闪一下
        document.addEventListener('visibilitychange', function () {
            if (document.hidden) stopMotion(); else startMotion();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
