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
        var disp = document.createElementNS(NS, 'feDisplacementMap');
        disp.setAttribute('in', 'SourceGraphic');
        disp.setAttribute('in2', img);
        disp.setAttribute('xChannelSelector', 'R');
        disp.setAttribute('yChannelSelector', 'G');
        disp.setAttribute('scale', map.scale.toFixed(3));
        s.filter.appendChild(img);
        s.filter.appendChild(disp);
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
     * ------------------------------------------------------------------ */
    function bindSheen() {
        var cur = null;
        document.addEventListener('pointermove', function (e) {
            var t = e.target && e.target.closest
                ? e.target.closest('.card, .modal-container, .sms-thread-card')
                : null;
            if (t !== cur) {
                if (cur) cur.classList.remove('lg-sheen');
                cur = t;
                if (cur) {
                    cur.classList.add('lg-sheen');
                    if (!cur.querySelector(':scope > .lg-spec')) {
                        var sp = document.createElement('div');
                        sp.className = 'lg-spec on';
                        cur.insertBefore(sp, cur.firstChild);
                    }
                }
            }
            if (!cur) return;
            var r = cur.getBoundingClientRect();
            cur.style.setProperty('--lg-mx', ((e.clientX - r.left) / r.width * 100) + '%');
            cur.style.setProperty('--lg-my', ((e.clientY - r.top) / r.height * 100) + '%');
        }, { passive: true });

        document.addEventListener('pointerleave', function () {
            if (cur) cur.classList.remove('lg-sheen');
            cur = null;
        }, { passive: true });
    }

    /* ------------------------------------------------------------------ *
     *  4. 开关 / 生命周期
     * ------------------------------------------------------------------ */
    var rafId = null;

    function tick(t) {
        stepBlobs(t);
        for (var i = 0; i < surfaces.length; i++) syncSurface(surfaces[i]);
        if (isOn()) rafId = requestAnimationFrame(tick);
    }

    function isOn() {
        return document.documentElement.getAttribute(SKIN_ATTR) === SKIN_NAME;
    }

    function enable() {
        if (surfaces.length) return;
        var base = document.getElementById('lg-aurora');
        blobGroups = [{ nodes: createBlobSet(base) }];
        surfaces = [];
        for (var i = 0; i < SURFACES.length; i++) {
            var s = createSurface(SURFACES[i], i);
            if (s) surfaces.push(s);
        }
        if (rafId === null) rafId = requestAnimationFrame(tick);
    }

    function disable() {
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        for (var i = 0; i < surfaces.length; i++) {
            var s = surfaces[i];
            s.layer.remove(); s.copy.remove();
            if (s.layer.parentNode) s.layer.parentNode.removeChild(s.layer);
            var tint = s.el.querySelector(':scope > .lg-tint');
            var spec = s.el.querySelector(':scope > .lg-spec');
            var rim = s.el.querySelector(':scope > .lg-rim');
            if (tint) tint.remove();
            if (spec) spec.remove();
            if (rim) rim.remove();
            if (s.filter.parentNode) s.filter.parentNode.removeChild(s.filter);
        }
        surfaces = [];
        var base = document.getElementById('lg-aurora');
        if (base) base.innerHTML = '';
        blobGroups = [];
        document.querySelectorAll('.lg-aurora-copy').forEach(function (n) { n.remove(); });
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
    }

    function updateButton() {
        var b = document.getElementById('lg-skin-btn');
        if (b) b.textContent = isOn() ? '🧊' : '🫧';
        if (b) b.title = isOn() ? '关闭液态玻璃' : '开启液态玻璃';
    }

    /* ------------------------------------------------------------------ *
     *  5. 启动
     * ------------------------------------------------------------------ */
    function boot() {
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

        // 顶栏上的皮肤开关
        var top = document.querySelector('#header .top-status');
        if (top && !document.getElementById('lg-skin-btn')) {
            var btn = document.createElement('button');
            btn.id = 'lg-skin-btn';
            btn.type = 'button';
            btn.addEventListener('click', function () { setSkin(!isOn()); });
            top.insertBefore(btn, top.firstChild);
        }

        bindSheen();

        var saved = null;
        try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
        // 未设置过时默认开启（这是特性分支）
        setSkin(saved === null ? true : saved === '1', false);

        // resize 时重建贴图（防抖）；尺寸没变的话 rebuild 内部会直接返回
        var rzTimer = null;
        window.addEventListener('resize', function () {
            clearTimeout(rzTimer);
            rzTimer = setTimeout(function () {
                for (var i = 0; i < surfaces.length; i++) rebuildSurface(surfaces[i]);
            }, 180);
        }, { passive: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
