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
    /* 顶栏 / 侧边栏：位置固定，启动时建一次 */
    var CHROME_SURFACES = [
        // depth=0 是关键：中间完全不畸变，只有贴边那一圈在弯 ——
        // 就是 demo 里那种「边缘看得出扭曲、中间背景看得清」的观感。
        { sel: '#header', bezel: 18, refraction: 1.70, radius: 0, depth: 0 },
        { sel: '#sidebar', bezel: 30, refraction: 1.45, radius: 0, depth: 0 }
    ];

    /* 内容卡片。 #content 没有背景色，卡片背后就是那层背景，
       和顶栏/侧边栏是同一种情况，所以同样能做真折射。
       比顶栏小一号，参数收敛一点。圆角从计算样式读，跟 CSS 保持一致。 */
    var CARD_CFG = {
        bezel: 18, refraction: 1.15, depth: 0,
        radius: 0, radiusFromStyle: true
    };

    var surfaces = [];        // 顶栏 + 侧边栏
    var cardSurfaces = [];    // 内容卡片（随页面内容动态增删）

    /* 位移贴图只跟元素的尺寸 / 圆角 / 参数有关，与位置无关。
       同一行卡片尺寸相同，所以按尺寸缓存后几张卡能共用一张贴图和一条滤镜 ——
       否则 6 张卡就是 6 张贴图、约 136 万像素，手机上启动会明显卡。 */
    var filterCache = {};
    var filterSeq = 0;

    function getGlassFilter(gw, gh, radius, bezel, refraction, depth) {
        var key = [gw, gh, radius, bezel, refraction, depth].join('|');
        if (filterCache[key]) return filterCache[key];

        var mw = gw + MARGIN * 2;
        var mh = gh + MARGIN * 2;
        var map = buildDisplacementMap(mw, mh, gw, gh, radius, bezel, refraction, depth);

        var id = 'lg-f' + (++filterSeq);
        var filter = document.createElementNS(NS, 'filter');
        filter.setAttribute('id', id);
        filter.setAttribute('filterUnits', 'userSpaceOnUse');
        filter.setAttribute('color-interpolation-filters', 'sRGB');
        filter.setAttribute('x', 0); filter.setAttribute('y', 0);
        filter.setAttribute('width', mw); filter.setAttribute('height', mh);

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

        filter.appendChild(img);
        filter.appendChild(disp);
        document.getElementById('lg-defs').appendChild(filter);

        var rec = { id: id, filter: filter, gw: gw, gh: gh };
        filterCache[key] = rec;
        return rec;
    }

    function clearFilterCache() {
        for (var k in filterCache) {
            if (!filterCache.hasOwnProperty(k)) continue;
            var f = filterCache[k].filter;
            if (f.parentNode) f.parentNode.removeChild(f);
        }
        filterCache = {};
        filterSeq = 0;
    }

    /** 给元素装上玻璃层：折射 + 底色 + 边缘高光 + 指针高光 */
    function buildGlassLayers(el, cfg) {
        el.querySelectorAll(':scope > .lg-refract, :scope > .lg-frost, :scope > .lg-tint, :scope > .lg-spec, :scope > .lg-rim')
            .forEach(function (n) { n.remove(); });

        var layer = document.createElement('div');
        layer.className = 'lg-refract';
        var copy = document.createElement('div');
        copy.className = 'lg-aurora lg-aurora-copy';
        copy.style.position = 'absolute';
        layer.appendChild(copy);

        var tint = document.createElement('div');
        tint.className = 'lg-tint';
        var frost = document.createElement('div');
        frost.className = 'lg-frost';
        var spec = document.createElement('div');
        spec.className = 'lg-spec';
        var rim = document.createElement('div');
        rim.className = 'lg-rim';

        // 插到最前面，保证内容盖在玻璃之上。
        // 插入顺序决定绘制顺序：refract → frost → tint → spec → rim
        el.insertBefore(rim, el.firstChild);
        el.insertBefore(spec, el.firstChild);
        el.insertBefore(tint, el.firstChild);
        el.insertBefore(frost, el.firstChild);
        el.insertBefore(layer, el.firstChild);

        var group = { nodes: createBlobSet(copy) };
        blobGroups.push(group);

        var s = { cfg: cfg, el: el, layer: layer, copy: copy, group: group, filterId: null };
        applySurfaceFilter(s);
        return s;
    }

    /** 按元素尺寸取（或建）滤镜并挂上。
     *  gw/gh 可由调用方传入，避免在写样式的循环里再读一次布局。 */
    function applySurfaceFilter(s, gw, gh) {
        if (bg.glass !== 'liquid') return;
        if (gw === undefined) {
            var r0 = s.el.getBoundingClientRect();
            gw = r0.width; gh = r0.height;
        }
        gw = Math.max(4, Math.round(gw));
        gh = Math.max(4, Math.round(gh));
        if (gw <= 4 || gh <= 4) return;                      // 还没布局
        // 圆角读完就缓存：getComputedStyle 也会让布局失效
        if (s.radius === undefined) {
            s.radius = s.cfg.radiusFromStyle
                ? Math.round(parseFloat(getComputedStyle(s.el).borderTopLeftRadius) || 0)
                : (s.cfg.radius || 0);
        }
        var rec = getGlassFilter(gw, gh, s.radius, s.cfg.bezel, s.cfg.refraction, s.cfg.depth);
        if (s.filterId === rec.id) return;
        s.filterId = rec.id;
        // 关键：直接引用 url(#id)，不要再套一层 url() —— 那会变成 url(url(#id))，
        // CSS 判定非法，filter 静默算成 none。
        s.layer.style.filter = 'url(#' + rec.id + ')';
        s.layer.style.webkitFilter = 'url(#' + rec.id + ')';
    }

    function setSurfaceFilterOff(s) {
        if (!s.filterId) return;
        s.filterId = null;
        s.layer.style.filter = 'none';
        s.layer.style.webkitFilter = 'none';
    }

    function destroySurface(s) {
        if (s.layer && s.layer.parentNode) s.layer.parentNode.removeChild(s.layer);
        if (s.el) {
            ['lg-frost', 'lg-tint', 'lg-spec', 'lg-rim'].forEach(function (c) {
                var n = s.el.querySelector(':scope > .' + c);
                if (n) n.remove();
            });
        }
        if (s.group) {
            var gi = blobGroups.indexOf(s.group);
            if (gi >= 0) blobGroups.splice(gi, 1);
        }
    }

    /* ---- 内容卡片：随页面内容动态增删 ----
       main.js 的 loadPage 用 contentArea.innerHTML = html 整块替换内容，
       所以卡片引用会整体失效，必须重新收集。 */
    function refreshCardSurfaces() {
        var host = document.querySelector('#content');
        if (!host) return;

        var live = Array.prototype.slice.call(host.querySelectorAll('.card, .sms-thread-card'));

        // 先摘掉已经不在文档里的；以及玻璃层被内容替换冲掉的
        // （插件卡片若整体重建 .card 的 innerHTML，注入的层会一起消失）
        cardSurfaces = cardSurfaces.filter(function (s) {
            if (!s.el.isConnected || !s.layer.parentNode) {
                destroySurface(s);
                return false;
            }
            return live.indexOf(s.el) >= 0;
        });

        if (bg.glass !== 'liquid' || bg.cardLens === false) {
            cardSurfaces.forEach(destroySurface);
            cardSurfaces = [];
            return;
        }

        var has = [];
        cardSurfaces.forEach(function (s) { has.push(s.el); });
        for (var i = 0; i < live.length; i++) {
            if (has.indexOf(live[i]) >= 0) continue;
            cardSurfaces.push(buildGlassLayers(live[i], CARD_CFG));
        }
    }

    /** 把玻璃内部的背景副本和真实视口对齐。
     *  用 transform 而不是 left/top —— left/top 每帧都要重新布局，
     *  滚动时跟不上合成器，表现为"玻璃里的背景滑动有延迟"。
     *
     *  但照片/纯色背景根本不用走这条路：CSS 里的
     *  [data-lg-bg="image"|"url"|"solid"] .lg-aurora-copy 用了
     *  background-attachment: fixed，浏览器自己把 background 锚定到视口，
     *  与 .lg-aurora 天然一致，**没有延迟**。
     *  极光是会动的 DOM 元素，用不了这招，才需要每帧对位。 */
    function needsJsAlign() {
        return bg.mode !== 'image' && bg.mode !== 'url' && bg.mode !== 'solid';
    }

    function syncSurface(s, r) {
        if (!needsJsAlign()) return;
        if (!r) r = s.layer.getBoundingClientRect();
        s.copy.style.transform =
            'translate(' + (-Math.round(r.left)) + 'px,' + (-Math.round(r.top)) + 'px)';
    }

    /* 视口尺寸只写一次到 :root，副本靠 CSS 变量取用，
       省掉每帧给每个副本写 width/height。 */
    var vpW = 0, vpH = 0;
    function syncViewportVars() {
        var w = window.innerWidth, h = window.innerHeight;
        if (w === vpW && h === vpH) return;
        vpW = w; vpH = h;
        var st = document.documentElement.style;
        st.setProperty('--lg-vp-w', w + 'px');
        st.setProperty('--lg-vp-h', h + 'px');
    }

    /* 滚动时卡片在动：既要重新对位，也要把视口外的卡片滤镜摘掉。
       摘掉之后 .lg-refract 显示的仍是与背景对齐的副本，视觉上等于没有这一层，
       所以看不出来 —— 但省下了合成开销。

       **读和写必须分开**：先把所有 rect 一次性读完，再统一写样式。
       混着做的话，每次写样式都会让布局失效，下一个 getBoundingClientRect
       又要强制一次全量布局 —— 6 张卡就是十几次同步布局，
       这才是滚动卡顿的主因。 */
    function syncCards() {
        var n = cardSurfaces.length;
        if (!n) return;
        var vh = window.innerHeight;
        var rects = new Array(n);
        for (var i = 0; i < n; i++) rects[i] = cardSurfaces[i].layer.getBoundingClientRect();
        for (var j = 0; j < n; j++) {
            var s = cardSurfaces[j], r = rects[j];
            if (r.bottom > -200 && r.top < vh + 200) {
                // .lg-refract 是 inset:-48px，所以元素尺寸 = 层尺寸 - 2*MARGIN
                applySurfaceFilter(s, r.width - MARGIN * 2, r.height - MARGIN * 2);
            } else {
                setSurfaceFilterOff(s);
            }
            syncSurface(s, r);
        }
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
     *  3d. 内容卡片的生命周期
     *
     *  loadPage 用 contentArea.innerHTML = html 整块替换内容，
     *  卡片引用会整体失效，所以要重新收集。
     * ------------------------------------------------------------------ */
    function bindContentHost() {
        var host = document.querySelector('#content');
        if (!host) return;

        // 滚动时卡片在动：重新对位 + 视口外摘掉滤镜
        var pend = false;
        host.addEventListener('scroll', function () {
            if (pend) return;
            pend = true;
            requestAnimationFrame(function () { pend = false; syncCards(); });
        }, { passive: true });

        // 只看直接子节点：loadPage 换的是 #content 的直接内容。
        // 不用 subtree —— 页面每 2 秒轮询更新文本，subtree 会被高频触发。
        var t = null;
        new MutationObserver(function () {
            clearTimeout(t);
            t = setTimeout(function () {
                refreshCardSurfaces();
                syncCards();
                // 设备列表这类内容是 innerHTML 动态生成的，
                // 里面的「拉黑 / 移出」按钮要跟着一起处理
                glassifyInlineBadges(host);
            }, 60);
        }).observe(host, { childList: true });
    }

    /* ------------------------------------------------------------------ *
     *  3f. 内联颜色的小按钮
     *
     *  页面里这类按钮用内联颜色表达语义，例如：
     *      <button class="badge" style="background:#fff1f0; color:#f5222d">拉黑</button>
     *      <button class="badge" style="background:#f6ffed; color:#52c41a">移出</button>
     *      <button class="badge" style="background:var(--primary); color:#fff">应用更改</button>
     *  用一条 CSS 一刀切刷成主色，会把「红=危险 / 绿=恢复」的语义抹掉。
     *  所以读出内联色当作强调色，换算成同色系玻璃再写回内联样式。
     * ------------------------------------------------------------------ */
    function parseColor(str) {
        if (!str) return null;
        var m = /^#([0-9a-f]{6})$/i.exec(str);
        if (m) {
            var n = parseInt(m[1], 16);
            return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }
        m = /^#([0-9a-f]{3})$/i.exec(str);
        if (m) {
            return {
                r: parseInt(m[1][0] + m[1][0], 16),
                g: parseInt(m[1][1] + m[1][1], 16),
                b: parseInt(m[1][2] + m[1][2], 16)
            };
        }
        m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(str);
        if (m) return { r: +m[1], g: +m[2], b: +m[3] };
        return null;
    }

    function isNearWhite(c) { return c.r > 200 && c.g > 200 && c.b > 200; }

    function glassifyInlineBadges(scope) {
        var list = (scope || document).querySelectorAll('button.badge[style]');
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            if (el.getAttribute('data-lg-btn')) continue;

            // 内联值可能是 var(--primary)，取不到时用计算值兜底
            var bg = parseColor(el.style.backgroundColor)
                || parseColor(el.style.background)
                || parseColor(getComputedStyle(el).backgroundColor);
            if (!bg) continue;

            // 强调色优先取内联字色；字是白的说明底色本身就是强调色
            var accent = parseColor(el.style.color) || parseColor(getComputedStyle(el).color) || bg;
            if (isNearWhite(accent)) accent = bg;

            var a = accent.r + ',' + accent.g + ',' + accent.b;
            var lit = function (v) { return Math.min(255, v + 90); };

            el.setAttribute('data-lg-orig', el.getAttribute('style') || '');
            el.setAttribute('data-lg-btn', '1');
            el.style.background = 'rgba(' + a + ',.20)';
            el.style.border = '1px solid rgba(' + a + ',.50)';
            el.style.color = 'rgb(' + lit(accent.r) + ',' + lit(accent.g) + ',' + lit(accent.b) + ')';
            el.style.borderRadius = '99px';
            el.style.backdropFilter = 'blur(8px) saturate(160%)';
            el.style.webkitBackdropFilter = 'blur(8px) saturate(160%)';
            el.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,.18)';
            el.style.textShadow = '0 1px 3px rgba(0,0,0,.40)';
        }
    }

    function unglassifyInlineBadges() {
        var list = document.querySelectorAll('button.badge[data-lg-btn]');
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            var orig = el.getAttribute('data-lg-orig');
            if (orig) el.setAttribute('style', orig); else el.removeAttribute('style');
            el.removeAttribute('data-lg-btn');
            el.removeAttribute('data-lg-orig');
        }
    }

    /* ------------------------------------------------------------------ *
     *  3e. 侧边栏导航的「液态玻璃气泡」
     *
     *  点哪个就滑到哪个。这里用 backdrop-filter 而不是 SVG 折射：
     *  气泡里的背景正好是侧边栏**已经折射过的结果**（#sidebar 有
     *  isolation:isolate，backdrop-filter 采样的是它内部已绘制的内容），
     *  所以等于「玻璃上再叠一层玻璃」，而且天然对齐，
     *  不用每帧重算位移贴图 —— 那对一个每帧都在移动的元素来说太贵了。
     * ------------------------------------------------------------------ */
    var navBubble = null;

    function buildNavBubble() {
        if (navBubble) return;
        var menu = document.querySelector('#sidebar .nav-menu');
        if (!menu) return;
        navBubble = document.createElement('div');
        navBubble.id = 'lg-nav-bubble';
        navBubble.setAttribute('aria-hidden', 'true');
        menu.insertBefore(navBubble, menu.firstChild);
        moveNavBubble();
    }

    function destroyNavBubble() {
        if (navBubble && navBubble.parentNode) navBubble.parentNode.removeChild(navBubble);
        navBubble = null;
    }

    function moveNavBubble() {
        if (!navBubble) return;
        var item = document.querySelector('#sidebar .nav-item.active');
        if (!item) { navBubble.style.opacity = '0'; return; }
        // 用 offsetLeft/offsetTop（相对 offsetParent = .nav-menu），
        // 不额外触发强制布局，也不受侧边栏滑动动画影响
        navBubble.style.width = item.offsetWidth + 'px';
        navBubble.style.height = item.offsetHeight + 'px';
        navBubble.style.transform = 'translate(' + item.offsetLeft + 'px,' + item.offsetTop + 'px)';
        navBubble.style.opacity = '1';
    }

    function watchNav() {
        var menu = document.querySelector('#sidebar .nav-menu');
        if (!menu) return;
        // main.js 的 loadPage 用 classList.toggle('active') 切选中项，
        // 所以监听 class 变化就能跟着滑过去
        new MutationObserver(function () { moveNavBubble(); })
            .observe(menu, { subtree: true, attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', moveNavBubble, { passive: true });
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
    var bg = {
        mode: 'aurora', solid: '#0b1020', image: '',
        url: '', urlStamp: 0,          // 服务端缓存的背景图：源地址 + 落盘时间（做缓存失效）
        glass: 'liquid',               // 玻璃档位：'liquid' 液态折射 / 'frost' 毛玻璃 / 'off' 关闭
        blur: true, dim: 0.25, motion: true,
        cardLens: true,                // 内容卡片是否也做折射（关掉可省性能）
        saved: false                   // 本机是否手动设置过；没设置过时跟随服务端
    };
    var IMAGE_MAX_EDGE = 1600;
    var IMAGE_SOFT_LIMIT = 3.6 * 1024 * 1024;   // localStorage 一般 5MB，留点余量

    function loadBg() {
        var raw = null;
        try { raw = localStorage.getItem(BG_KEY); } catch (e) {}
        bg.saved = raw !== null;

        // 首次运行且是小屏：默认关掉卡片的毛玻璃。
        // backdrop-filter 在 DOM 刷新时要重新采样背景，是手机上闪烁/掉帧的主要来源；
        // 顶栏和侧边栏用的是 SVG 折射滤镜，不受影响，招牌的折射效果还在。
        if (raw === null && window.innerWidth <= 768) bg.blur = false;

        // 兼容旧的开关键（lg-skin：'1' 开 / '0' 关）
        if (raw === null) {
            try {
                if (localStorage.getItem(STORE_KEY) === '0') bg.glass = 'off';
            } catch (e) {}
        }

        try {
            if (raw) {
                var o = JSON.parse(raw);
                if (o && typeof o === 'object') {
                    if (o.mode) bg.mode = o.mode;
                    if (o.glass) bg.glass = o.glass;
                    if (o.solid) bg.solid = o.solid;
                    if (typeof o.image === 'string') bg.image = o.image;
                    if (typeof o.blur === 'boolean') bg.blur = o.blur;
                    if (typeof o.dim === 'number') bg.dim = Math.min(0.8, Math.max(0, o.dim));
                    if (typeof o.motion === 'boolean') bg.motion = o.motion;
                    if (typeof o.cardLens === 'boolean') bg.cardLens = o.cardLens;
                    if (typeof o.url === 'string') bg.url = o.url;
                    if (typeof o.urlStamp === 'number') bg.urlStamp = o.urlStamp;
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
        // 玻璃档位决定 data-skin / data-lg-glass 两个属性，全部视觉分支都挂在这上面
        if (bg.glass === 'off') {
            root.removeAttribute(SKIN_ATTR);
            root.removeAttribute('data-lg-glass');
        } else {
            root.setAttribute(SKIN_ATTR, SKIN_NAME);
            root.setAttribute('data-lg-glass', bg.glass);
        }
        if (bg.mode === 'url') {
            // 用服务端缓存的那张。带上 savedAt 做缓存失效 ——
            // 重新抓取后立刻换新，平时刷新/重启拿到的都是同一张。
            root.style.setProperty('--lg-bg-image',
                'url("/api/appearance/background?v=' + (bg.urlStamp || 0) + '")');
            root.setAttribute('data-lg-bg', 'url');
        } else if (bg.mode === 'image' && bg.image) {
            root.style.setProperty('--lg-bg-image', 'url("' + bg.image + '")');
            root.setAttribute('data-lg-bg', 'image');
        } else if (bg.mode === 'solid') {
            root.style.setProperty('--lg-bg-solid', bg.solid);
            root.setAttribute('data-lg-bg', 'solid');
        } else {
            root.setAttribute('data-lg-bg', 'aurora');
        }
        root.setAttribute('data-lg-blur', bg.blur ? 'on' : 'off');
        root.setAttribute('data-lg-cardlens', bg.cardLens === false ? 'off' : 'on');
        syncViewportVars();
        // 一层半透明黑，纯合成；不用 filter: brightness()（全屏滤镜，代价高）
        root.style.setProperty('--lg-dim-op', bg.dim.toFixed(3));
        if (isOn()) startMotion(); else stopMotion();
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
        for (var j = 0; j < cardSurfaces.length; j++) syncSurface(cardSurfaces[j]);
    }

    function isOn() {
        return bg.glass !== 'off';
    }

    function enable() {
        if (active) return;
        active = true;
        var base = document.getElementById('lg-aurora');
        blobGroups = [{ nodes: createBlobSet(base) }];
        surfaces = [];
        for (var i = 0; i < CHROME_SURFACES.length; i++) {
            var el = document.querySelector(CHROME_SURFACES[i].sel);
            if (el) surfaces.push(buildGlassLayers(el, CHROME_SURFACES[i]));
        }
        refreshCardSurfaces();
        buildNavBubble();
        glassifyInlineBadges();
        syncAll();
        startMotion();
    }

    function disable() {
        if (!active) return;
        active = false;
        stopMotion();
        destroyNavBubble();
        unglassifyInlineBadges();
        cardSurfaces.forEach(destroySurface);
        cardSurfaces = [];
        surfaces.forEach(destroySurface);
        surfaces = [];
        clearFilterCache();
        var base = document.getElementById('lg-aurora');
        if (base) base.innerHTML = '';
        blobGroups = [];
        document.querySelectorAll('.lg-aurora-copy').forEach(function (n) { n.remove(); });

        // 关闭后不能留残留：这时 .card 没有 position:relative，
        // 残留的 .lg-spec 会以别的祖先为定位基准，跑到奇怪的地方去
        clearSheen();
        document.querySelectorAll('.lg-spec').forEach(function (n) { n.remove(); });
    }

    /** 切换玻璃档位：'liquid' 液态折射 / 'frost' 毛玻璃 / 'off' 关闭 */
    function setGlass(mode, persist) {
        if (['liquid', 'frost', 'off'].indexOf(mode) < 0) mode = 'liquid';
        var wasOn = isOn();
        bg.glass = mode;
        if (persist !== false) saveBg();
        applyBg();                                   // 先定属性，再建/拆玻璃层
        if (isOn() && !wasOn) enable();
        if (!isOn() && wasOn) disable();
        // 切到液态时补建滤镜，并给内容卡片装上玻璃层
        if (bg.glass === 'liquid') {
            surfaces.forEach(function (s) { s.filterId = null; applySurfaceFilter(s); });
            refreshCardSurfaces();
            syncAll();
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

            '    <div class="lg-sub">玻璃效果</div>' +
            '    <div class="lg-seg" id="lg-glass-seg">' +
            '      <button type="button" data-glass="liquid">液态</button>' +
            '      <button type="button" data-glass="frost">毛玻璃</button>' +
            '      <button type="button" data-glass="off">关闭</button>' +
            '    </div>' +
            '    <div class="lg-hint" id="lg-glass-hint"></div>' +
            '    <div class="lg-row" id="lg-row-blur"><span>卡片毛玻璃模糊' +
            '      <small>关掉可明显提升老设备流畅度</small></span>' +
            '      <label class="lg-switch"><input type="checkbox" id="lg-opt-blur"><i></i></label></div>' +
            '    <div class="lg-row" id="lg-row-cardlens"><span>内容卡片折射' +
            '      <small>卡片也做边缘折射，更接近 demo；关了更省性能</small></span>' +
            '      <label class="lg-switch"><input type="checkbox" id="lg-opt-cardlens"><i></i></label></div>' +

            '    <div class="lg-sub">背景</div>' +
            '    <div class="lg-seg" id="lg-bg-seg">' +
            '      <button type="button" data-mode="aurora">极光</button>' +
            '      <button type="button" data-mode="solid">纯色</button>' +
            '      <button type="button" data-mode="image">图片</button>' +
            '      <button type="button" data-mode="url">网址</button>' +
            '    </div>' +

            '    <div class="lg-row" id="lg-solid-row"><span>背景色</span>' +
            '      <input type="color" id="lg-opt-solid"></div>' +

            '    <div class="lg-row" id="lg-image-row"><span>自定义图片</span>' +
            '      <button type="button" class="lg-file-btn" data-act="pick">选择图片</button></div>' +

            '    <div id="lg-url-row">' +
            '      <div class="lg-hint" style="margin-top:8px;margin-bottom:8px">' +
            '        抓一次存到服务端，刷新和重启都不会变，所有设备共用同一张。' +
            '        直接填图片地址，或接口地址（Bing 每日一图 ' +
            '        <code>HPImageArchive.aspx?format=js&amp;idx=0&amp;n=1</code>，会自动取 JSON 里的图片地址）。</div>' +
            '      <div class="lg-row" style="flex-direction:column;align-items:stretch;gap:8px">' +
            '        <input type="text" id="lg-opt-url" class="lg-input" spellcheck="false" ' +
            '          placeholder="https://www.bing.com/HPImageArchive.aspx?format=js&amp;idx=0&amp;n=1">' +
            '        <div style="display:flex;gap:8px">' +
            '          <button type="button" class="lg-file-btn" data-act="fetch">抓取并应用</button>' +
            '          <button type="button" class="lg-file-btn" data-act="clearbg">清除</button>' +
            '        </div>' +
            '      </div>' +
            '    </div>' +

            '    <div class="lg-row" id="lg-dim-row"><span>背景暗化' +
            '      <small>背景偏亮时，靠它拉回对比度</small></span>' +
            '      <input type="range" id="lg-opt-dim" min="0" max="70" step="5" class="lg-range"></div>' +

            '    <div class="lg-row" id="lg-motion-row"><span>背景动效' +
            '      <small>数据刷新频繁时，关掉可消除闪烁</small></span>' +
            '      <label class="lg-switch"><input type="checkbox" id="lg-opt-motion"><i></i></label></div>' +

            '    <input type="file" accept="image/*" id="lg-file-input" hidden>' +
            '    <div class="lg-hint" id="lg-hint"></div>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(m);

        var $ = function (id) { return document.getElementById(id); };

        m.addEventListener('click', function (e) {
            if (e.target === m || (e.target.closest && e.target.closest('[data-act="close"]'))) {
                closeSettings();
                return;
            }
            var gs = e.target.closest && e.target.closest('#lg-glass-seg button');
            if (gs) { setGlass(gs.getAttribute('data-glass')); return; }

            var seg = e.target.closest && e.target.closest('#lg-bg-seg button');
            if (seg) {
                var mode = seg.getAttribute('data-mode');
                // 选了「图片」但还没选过图 → 直接打开文件选择器。
                // 否则会出现「分段控件显示图片已选中、实际背景还是极光」的错位状态。
                if (mode === 'image' && !bg.image) { $('lg-file-input').click(); return; }
                bg.mode = mode;
                saveBg(); applyBg(); syncSettingsUI();
                if (mode === 'url') { var u = $('lg-opt-url'); if (u) u.focus(); }
                return;
            }
            if (e.target.closest && e.target.closest('[data-act="pick"]')) {
                $('lg-file-input').click();
            }
            if (e.target.closest && e.target.closest('[data-act="fetch"]')) doFetchBg();
            if (e.target.closest && e.target.closest('[data-act="clearbg"]')) doClearBg();
        });

        $('lg-opt-blur').addEventListener('change', function () {
            bg.blur = this.checked; saveBg(); applyBg();
        });
        $('lg-opt-cardlens').addEventListener('change', function () {
            bg.cardLens = this.checked; saveBg();
            applyBg();                 // 更新 data-lg-cardlens，CSS 分支靠它切换
            refreshCardSurfaces();
            syncCards();
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

        // 玻璃档位
        $$('#lg-glass-seg button').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-glass') === bg.glass);
        });
        var gh = $('lg-glass-hint');
        if (gh) {
            gh.textContent = bg.glass === 'liquid'
                ? '顶栏和侧边栏做真实折射：边缘能看到背景被弯折，中间保持清晰。'
                : bg.glass === 'frost'
                    ? '只做背景模糊，不做折射。老设备上更省。'
                    : '不使用玻璃效果，回到原始外观。';
        }
        // 卡片模糊只在玻璃开启时有意义；卡片折射只在液态档有意义
        $('lg-row-blur').style.display = bg.glass === 'off' ? 'none' : '';
        $('lg-row-cardlens').style.display = bg.glass === 'liquid' ? '' : 'none';
        $('lg-opt-cardlens').checked = bg.cardLens !== false;

        $('lg-opt-blur').checked = bg.blur;
        $('lg-opt-motion').checked = bg.motion;
        $('lg-opt-solid').value = bg.solid;
        $('lg-opt-dim').value = Math.round(bg.dim * 100);
        var u = $('lg-opt-url');
        if (u && !u.value) u.value = bg.url;

        $$('#lg-bg-seg button').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-mode') === bg.mode);
        });

        // 只显示当前背景模式相关的项，其余收起来
        var m = bg.mode;
        $('lg-solid-row').style.display   = m === 'solid' ? '' : 'none';
        $('lg-image-row').style.display   = m === 'image' ? '' : 'none';
        $('lg-url-row').style.display     = m === 'url' ? '' : 'none';
        $('lg-dim-row').style.display     = (m === 'image' || m === 'url') ? '' : 'none';
        $('lg-motion-row').style.display  = m === 'aurora' ? '' : 'none';
    }

    function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

    function setHint(msg) {
        var h = document.getElementById('lg-hint');
        if (h) h.textContent = msg;
    }

    /** 让服务端抓取并缓存背景图。返回后立刻刷新 --lg-bg-image。 */
    function doFetchBg() {
        var inp = document.getElementById('lg-opt-url');
        var url = inp ? inp.value.trim() : '';
        if (!url) { setHint('先填一个图片地址或接口地址。'); return; }
        if (typeof Api === 'undefined' || !Api.post) { setHint('Api 还没就绪，稍后再试。'); return; }
        setHint('抓取中…接口地址需要几秒。');
        Api.post('/api/appearance/background', { url: url }).then(function (r) {
            if (!r || !r.ok) {
                setHint('抓取失败：' + ((r && r.msg) || '未知错误'));
                return;
            }
            bg.url = r.url || url;
            bg.urlStamp = r.savedAt || Date.now();
            bg.mode = 'url';
            saveBg(); applyBg(); syncSettingsUI();
            setHint('已应用。服务端缓存 ' + Math.round((r.bytes || 0) / 1024) + ' KB 到 ' +
                (r.resolvedUrl || url));
        }).catch(function (e) {
            setHint('抓取失败：' + (e && e.message ? e.message : e));
        });
    }

    function doClearBg() {
        if (typeof Api === 'undefined' || !Api.request) return;
        setHint('清除中…');
        Api.request('/api/appearance/background', 'DELETE').then(function () {
            bg.url = ''; bg.urlStamp = 0;
            if (bg.mode === 'url') bg.mode = 'aurora';
            saveBg(); applyBg(); syncSettingsUI();
            setHint('已清除服务端背景图。');
        }).catch(function () { setHint('清除失败。'); });
    }

    /** 打开页面时从服务端同步一次：换设备也能看到同一张背景 */
    function syncAppearanceFromServer() {
        if (typeof Api === 'undefined' || !Api.get) return;
        // 登录页还没有 token。Api.request 遇到 401 会跳回 login.html，
        // 在这里调用会变成无限刷新，所以必须先确认有 token。
        try { if (!sessionStorage.getItem('authToken')) return; } catch (e) { return; }
        Api.get('/api/appearance').then(function (info) {
            if (!info) return;
            bg.url = info.url || '';
            bg.urlStamp = info.savedAt || 0;
            // 服务端有图、且本机从没手动选过背景模式 → 跟随服务端
            if (info.hasImage && !bg.saved) bg.mode = 'url';
            var inp = document.getElementById('lg-opt-url');
            if (inp && !inp.value) inp.value = bg.url;
            if (bg.mode === 'url' && info.hasImage) applyBg();
            syncSettingsUI();
        }).catch(function () { });
    }

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
        bindContentHost();
        watchNav();

        applyBg();
        if (isOn()) enable();
        updateButton();
        syncSettingsUI();
        syncAppearanceFromServer();

        // 尺寸变化：之前按尺寸缓存的贴图全部失效，清掉重来
        var rzTimer = null;
        window.addEventListener('resize', function () {
            syncViewportVars();            // 立刻更新，别等防抖
            clearTimeout(rzTimer);
            rzTimer = setTimeout(function () {
                clearFilterCache();
                surfaces.forEach(function (s) { s.filterId = null; applySurfaceFilter(s); });
                cardSurfaces.forEach(function (s) { s.filterId = null; });
                syncCards();
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
