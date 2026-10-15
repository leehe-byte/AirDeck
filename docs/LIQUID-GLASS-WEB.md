# 液态玻璃 · Web 实现技术文档

> **这份文档的用途**：让另一个 AI（或人）能从零开始做出真正的液态玻璃，而不是又一层毛玻璃。
> 内容自包含，不依赖任何具体项目。所有结论都来自实测，踩过的坑都标了症状和排查方法。

---

## 0. 先明确：液态玻璃 ≠ 毛玻璃

这是最容易走偏的地方。普通的 glassmorphism 只有模糊：

```css
backdrop-filter: blur(20px);   /* 这只是毛玻璃 */
```

液态玻璃（iOS 26 / visionOS 的语言）多三样东西：

| 要素 | 作用 | 没有它会怎样 |
|---|---|---|
| **折射（lensing）** | 背景像素按玻璃侧壁的曲面发生**位移**，边缘能看到内容被挤压/放大 | 就是毛玻璃，没有"玻璃"的实体感 |
| **镜面高光（specular rim）** | 沿边框内法线方向的一条亮边 | 玻璃和背景贴在一起，没有厚度 |
| **自适应色调（tint）** | 一层很淡的底色，随深浅主题变 | 内容对比度不够，或者太脏 |

**这篇文章 80% 的篇幅在讲第一项**，因为另外两项是纯 CSS，而折射是唯一有平台陷阱的部分。

---

## 1. 两条可行路线（选一条）

### 1.1 先纠正一个流传很广的错误结论

网上（包括本仓库早期的一份笔记）常说：**「`feImage` 不能作为 `feDisplacementMap` 的 `in2`，
`backdrop-filter: url()` 走不通」**。

**这个结论是错的。** 在 Edge / Chromium（headless、`--disable-gpu`）上实测：

| 测试 | 方法 | 结果 |
|---|---|---|
| `filter: url(#f)` 里用 `feImage` 当 `in2` | 把带滤镜 / 不带滤镜的同一张 SVG 各自 `load` 成 `<img>`，等 `onload` 后 `drawImage` 到 canvas，逐像素比对 | **16800 / 40000 像素不同，最大通道差 255** → ✅ 生效 |
| `backdrop-filter: url(#f)` | 黑底白条纹上放两个 `::before`，一个 `url(#f)` 一个 `none`，其中 `f` 用 `feFlood` 喂 `feDisplacementMap` | 带滤镜那块里的条纹**明显平移/挤压** → ✅ 生效 |

> **教训**：判定这类效果有没有生效，**必须读渲染结果像素**，不能靠别的间接迹象。
> 本文档早期版本用「整图截图哈希是否不同」来判断，结果同一个文件渲染两次哈希一致，
> 但只改一个强度常数就得到两个互不对应的哈希 —— 那个方法**测的是噪声，不是效果**。
> 下图两个反例就是这么做出来的差别。

### 1.2 路线 A：`backdrop-filter: url()`（更简单，先试这个）

```css
.glass {
    backdrop-filter: url(#refraction);
}
```

浏览器会把**元素背后的像素**交给滤镜，滤镜位移它们，再画回元素区域内。
你不用复制背景、不用管对齐 —— 这是最省事的做法。

**注意**：

- 滤镜的 `x/y/width/height`（滤镜区域）要留够余量，否则位移后的像素会被裁掉：
  ```html
  <filter id="refraction" x="-30%" y="-30%" width="160%" height="160%">
  ```
- `backdrop-filter` 在**同一元素上和其他 backdrop 效果叠加**时行为较微妙，
  建议一个元素只用一条 `backdrop-filter`。
- `feImage` 的 `href` 指向 data URL 时**解码是异步的**。
  首帧可能还没有位移 —— 如果你看到"刷新一下才有效果"，就是这个问题。
  对策：把贴图内联成 SVG 元素，或在 `feImage` 的 `onload` 之后再显示玻璃。

### 1.3 路线 B：把背景复制进玻璃，用普通 `filter`

```css
.glass-refract { filter: url(#refraction); }   /* 注意：不是 backdrop-filter */
```

在玻璃内部再画一份**和页面完全相同的背景**，然后对这份副本用**普通 `filter`** 做位移。

**什么时候选它：**

- 目标环境里 `backdrop-filter` 支持不好（老 WebView、部分国产内核）
- 你要对同一份背景做**多次不同参数的采样**（比如色散要采三次），
  用 `backdrop-filter` 就得叠三层元素，用副本则一层就够
- 背景本身是你自己画的（渐变、canvas 截图），复制成本很低

**代价**：你得自己保证副本和真实背景对齐。两种办法：

1. **每帧重算**（最稳）：`copy.style.backgroundPosition = `${-r.left}px ${-r.top}px``
2. **`background-attachment: fixed`**（省，但有前提，见第 4 节坑 4）

**适用边界**：

- 背景是**渐变色块 / 纯色 / 一张静态图** → 两条路线都好走
- 背景是**视频 / canvas / 频繁变化的 DOM** → 路线 B 复制不了；
  路线 A 可以（浏览器自己抓背后的像素），但性能要先测

---

## 2. 整体架构

一块玻璃由 **5 层** 叠成，全部用**负 z-index**：

```html
<div class="card" style="isolation: isolate">   <!-- 父级必须 isolate -->
    <div class="lg-refract"></div>  <!-- z-index: -5  折射：背景副本 + filter -->
    <div class="lg-frost"></div>    <!-- z-index: -4  磨砂：backdrop-filter: blur -->
    <div class="lg-tint"></div>     <!-- z-index: -3  色调：淡底色 -->
    <div class="lg-spec"></div>     <!-- z-index: -2  镜面高光：SDF 梯度算出的亮边 -->
    <div class="lg-rim"></div>      <!-- z-index: -1  外描边 -->

    <!-- 真实内容，z-index 自然是 auto(0)，压在玻璃之上 -->
    <h3>标题</h3>
    <p>正文……</p>
</div>
```

```css
.card { position: relative; isolation: isolate; }

.lg-refract, .lg-frost, .lg-tint, .lg-spec, .lg-rim {
    position: absolute;
    inset: 0;                  /* refract 要更大，见下 */
    pointer-events: none;      /* 关键：玻璃层不能挡住点击 */
    border-radius: inherit;
}
.lg-refract { inset: -48px; z-index: -5; }   /* 留取样余量，见 3.4 */
.lg-frost   { z-index: -4; }
.lg-tint    { z-index: -3; }
.lg-spec    { z-index: -2; }
.lg-rim     { z-index: -1; }
```

### ⚠️ 为什么必须用负 z-index

这是**排版上最容易翻车的一点**。

如果把玻璃层写成 `position: absolute; z-index: 1`，而内容 `<h3>`/`<p>` 是**静态定位**，
那么定位元素会画在静态元素**之上** —— 结果是：

> **卡片的标题能看见，表格内容全不见。**

因为标题（`<h3>`）在某些布局里会产生层叠上下文，而表格的 `<td>` 不会。
症状是"部分内容正常、部分内容神秘消失"，非常难查。

**负 z-index + 父级 `isolation: isolate` 是唯一稳的做法**：
- 负值让玻璃层沉到所有内容之下
- `isolate` 阻止它们继续沉到卡片外面（比如沉到 `body` 背景后面）

---

## 3. 完整实现

### 3.1 位移贴图怎么生成（这是核心）

贴图是一张 RGBA 图，每个像素编码**该点的位移方向和大小**。

算法（在 canvas 里按玻璃尺寸实时生成）：

```
对每个像素 p（相对于玻璃中心）:
  1. sd = sdRoundRect(p, halfSize, radius)          // 圆角矩形有符号距离场
  2. 如果 -sd >= bezel:  位移 = 0，跳出           // 平面区，不折射
  3. t = clamp(-sd / bezel, 0, 1)                   // 0=外边缘, 1=折射带内侧
  4. h = circleMap(t) = 1 - sqrt(1 - t²)            // 侧壁剖面（球形穹顶）
  5. 位移量 = refraction * bezel * h
  6. 方向   = normalize(gradSdRoundRect(p, halfSize, radius)
                        + depthEffect * normalize(p))   // 内法线 + 指向中心
  7. 写入：R = 128 + dir.x * 127
           G = 128 + dir.y * 127
           B = 128
```

**SDF（有符号距离场）**，`coord` 是相对中心的坐标：

```js
function sdRoundRect(p, half, r) {
    const cx = Math.abs(p.x) - (half.x - r);
    const cy = Math.abs(p.y) - (half.y - r);
    const outside = Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) - r;
    const inside  = Math.min(Math.max(cx, cy), 0);
    return outside + inside;
}
```

### ⚠️ 3.2 梯度必须用解析式，不能用数值差分

**这是整份文档里最值钱的一条。**

你可能会想：SDF 有了，梯度用中心差分算就行：

```js
// ❌ 会画出贯穿玻璃的 X 形亮线/暗线
const gx = sd(x + e, y) - sd(x - e, y);
const gy = sd(x, y + e) - sd(x, y - e);
```

**不行。** 圆角矩形 SDF 的内部是 `max(|px|-hw, |py|-hh)`，
这个 `max` 在**对角线**上有折点（"最近边"从水平切换成垂直）。
中心差分跨过折点时会算出两边的**平均**，于是对角线上的法线变成 45°，
代入高光公式 `pow(abs(dot(grad, lightDir)), falloff)`：

- 一条对角线 `|dot|` 掉到 **0** → 暗线
- 另一条变成 **1** → 亮线
- 玻璃上出现一个贯穿的 **X**

正确做法是**解析梯度**，用 `step()` 在两条轴之间**硬切换**，从不平均：

```js
function gradSdRoundRect(p, half, r) {
    const cx = Math.abs(p.x) - (half.x - r);
    const cy = Math.abs(p.y) - (half.y - r);
    if (cx >= 0 || cy >= 0) {
        // 对角区域：法线指向最近的那个角
        const nx = Math.max(cx, 0), ny = Math.max(cy, 0);
        const len = Math.hypot(nx, ny) || 1;
        return { x: Math.sign(p.x) * nx / len, y: Math.sign(p.y) * ny / len };
    }
    // 内部：硬切换，不平均
    const useX = cx >= cy ? 1 : 0;
    return { x: Math.sign(p.x) * useX, y: Math.sign(p.y) * (1 - useX) };
}
```

**实测对比**（350×180，r=28，光向 135°）：

| 方案 | `|dot|` 的取值 | 暗像素（`|dot|<0.10`） |
|---|---|---|
| 数值中心差分 | `0 / 0.707 / 1` 三种 | **120 个** |
| 解析梯度 | 只有 `0.707` 一种 | **0 个** |

> 这条同样适用于 iOS/macOS 的 `Shader`、Android 的 AGSL —— 见配套的 Android 文档，那边用的是同一套数学。

### 3.3 侧壁剖面函数

`circleMap(t) = 1 - sqrt(1 - t²)` 是球形穹顶剖面，也是 Android 端主流库用的那一条。
可以换，效果不同：

| 形状 | 公式 | 特点 |
|---|---|---|
| `circle` | `√(1-(1-t)²)` | 球形穹顶，最常见 |
| `squircle` | `⁴√(1-(1-t)⁴)` | Apple 偏好，过渡柔和，拉成矩形也不生硬 |
| `lip` | smootherstep 混合凸/凹 | 边缘凸起 + 中心浅凹 |
| `concave` | `1 - circle(t)` | 凹面，把光线推出玻璃 |

### 3.4 SVG 滤镜

贴图生成后塞进 `<feImage>`：

```html
<svg width="0" height="0" style="position:absolute">
  <filter id="lg-f-380x180-r28" x="-50%" y="-50%" width="200%" height="200%"
          filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
    <!-- href 指向上面生成的 dataURL -->
    <feImage id="lg-map-380x180-r28" result="map"
             href="data:image/png;base64,..." />
    <feDisplacementMap in="SourceGraphic" in2="map"
                       scale="1234" xChannelSelector="R" yChannelSelector="G" />
  </filter>
</svg>
```

**三个必须注意的点：**

1. **`in2` 必须是 `result` 名字符串。**
   ```js
   // ❌ 静默失效
   feDisp.setAttribute('in2', feImageElement);
   // 元素会被 stringify 成 "[object SVGFEImageElement]"，不匹配任何 result，滤镜直接不干活
   ```
   正确写法是给 `feImage` 加 `result="map"`，然后 `in2="map"`。

2. **`scale` 的换算。** `feDisplacementMap` 的实际位移是 `scale * (C/255 - 0.5)`。
   贴图里编码的是 `128 + dir*127`，所以：
   ```js
   scale = maxDisplacement * 255 / 127;
   ```

3. **`colorspace` 要设 `sRGB`**，否则插值会在线性空间里做，位移量偏。

### 3.5 CSS：两个静默失效陷阱

```css
.lg-refract {
    filter: var(--fid);   /* ✅ --fid 的值就是 "url(#lg-f-380x180-r28)" */
}
```

> **⚠️ 坑：不要写成 `filter: url(var(--fid))`。**
> CSS 变量替换是**文本替换**，会展开成 `url(url(#id))` → CSS 判定非法 →
> `filter` **静默算成 `none`** → 整块玻璃完全不折射，**且不报任何错**。
>
> 排查：`getComputedStyle(el).filter`，返回 `none` 就是这个问题。

> **⚠️ 坑：别用 `!important` 写死颜色。**
> 液态玻璃通常靠一层变量重映射适配深浅主题，
> `!important` 会盖掉重映射，浅色主题下会得到"白底 + 白字"。

### 3.6 对齐：副本怎么和真实背景对上

背景副本在玻璃内部，坐标为 `inset: -48px`，所以它的 `(0,0)` 不在视口原点。
两种对齐方式：

**方式 A：每帧重算（最稳，推荐）**

```js
const r = el.getBoundingClientRect();
copy.style.backgroundPosition = `${-r.left}px ${-r.top}px`;
```

配合 `requestAnimationFrame` 或滚动/尺寸变化时更新。

**方式 B：`background-attachment: fixed`（不用每帧，但有前提）**

```css
.lg-refract .copy {
    background-attachment: fixed;   /* 锚定视口 */
    background-size: cover;
}
```

**前提（很重要）**：**祖先元素不能有 `transform` 或 `will-change: transform`。**
只要有，`fixed` 就会退化成 `scroll` —— 副本会锚定到自己的盒子上，
结果是**玻璃里显示出壁纸的另一块**，而且拖动/滚动时内容永远不变。

> 这个症状特别有迷惑性：看起来像"背景没对齐"，其实是 `fixed` 静默降级了。
> 典型触发源是 `.card:hover { transform: translateY(-2px) }` 这类悬停动画 ——
> 把悬停反馈改成 `box-shadow` + `border-color` 就好了。

**另外 `position: fixed` 也不能用在玻璃内部**：`filter` 会创建包含块，
`fixed` 会被解析成"相对那个被 filter 的元素"，而不是视口。

**选哪个**：方式 B 更省，但结构稍有变化就可能失效；
如果发现对齐不对，先试方式 A —— 它不依赖任何前提。

### 3.7 色散（可选，很贵）

真实玻璃对不同波长的折射率不同，边缘会出现彩色镶边。做法是让 R/G/B 三个通道
用略有差异的位移量各采样一次：

```html
<feDisplacementMap in="SourceGraphic" in2="map" scale="S*1.42"
                   xChannelSelector="R" yChannelSelector="G" result="dR"/>
<feDisplacementMap in="SourceGraphic" in2="map" scale="S"
                   xChannelSelector="R" yChannelSelector="G" result="dG"/>
<feDisplacementMap in="SourceGraphic" in2="map" scale="S/1.42"
                   xChannelSelector="R" yChannelSelector="G" result="dB"/>

<feColorMatrix in="dR" type="matrix"
  values="1 0 0 0 0   0 0 0 0 0   0 0 0 0 0   0 0 0 1 0" result="cR"/>
<feColorMatrix in="dG" type="matrix"
  values="0 0 0 0 0   0 1 0 0 0   0 0 0 0 0   0 0 0 1 0" result="cG"/>
<feColorMatrix in="dB" type="matrix"
  values="0 0 0 0 0   0 0 0 0 0   0 0 1 0 0   0 0 0 1 0" result="cB"/>

<feBlend in="cR" in2="cG" mode="screen" result="rg"/>
<feBlend in="rg" in2="cB" mode="screen"/>
```

`screen` 对互不重叠的通道等价于相加。

---

## 4. 五个必踩的坑（速查）

| # | 症状 | 原因 | 修法 |
|---|---|---|---|
| 1 | 玻璃完全不折射，无报错 | `filter: url(var(--fid))` 展开成 `url(url(#id))` → `none` | 写成 `filter: var(--fid)` |
| 2 | 玻璃上一条贯穿的 X 形亮线/暗线 | SDF 梯度用了数值中心差分，跨过 `max()` 折点 | 改用解析梯度 + `step()` 硬切换 |
| 3 | 标题能看见，表格/正文不见 | 玻璃层用了 `z-index: 0+`，压在静态内容上 | 改负 z-index + 父级 `isolation: isolate` |
| 4 | 玻璃里显示壁纸的另一块 | 祖先有 `transform` → `background-attachment: fixed` 退化成 `scroll` | 去掉祖先的 `transform` / `will-change`，或改用每帧重算 |
| 5 | 位移贴图完全不生效 | `in2` 被设成了 DOM 元素（stringify 后不匹配任何 result） | `feImage` 加 `result="map"`，`in2="map"` |

---

## 5. 性能

折射贴图和滤镜是主要开销，按这几条压：

1. **按尺寸 + 参数缓存滤镜和贴图。**
   key 用 `${w}x${h}x${radius}x${bezel}x${refraction}x${depth}`，
   同尺寸的玻璃片共用一份 `<filter>` 和一张贴图。一个页面几十块玻璃只需要几个滤镜。

2. **动画时只改 `<feDisplacementMap scale>`，不要重建贴图。**
   重建 = 重新跑一遍逐像素 SDF，是最贵的操作。

3. **`getBoundingClientRect()` 要批量读。**
   先读完所有元素再写样式，否则每写一次就触发一次强制重排（layout thrashing）。

4. **玻璃层加 `pointer-events: none`**，否则会挡住下面的点击。

5. **光斑 / 模糊图层要节制。**
   如果背景是"几个大模糊色块"那种极光效果，注意：每个玻璃面如果都复制一整套
   模糊图层，图层数会爆炸。实测 8 个玻璃面 × 4 个 `62vmax` + `blur(6vmax)` 的光斑
   = 32 个大模糊图层，直接把 WebView 打到闪烁、甚至整块不渲染。
   **对策：副本里的光斑不要再套 `filter: blur()`**（外层已经有整体模糊了），
   并把更新频率从每帧降到 1.5 秒一次。

---

## 6. 无障碍

自己实现时记得接上「降低动态效果」—— Apple 的实现是会响应的：

```css
@media (prefers-reduced-motion: reduce) {
    /* 关掉所有动画；折射可以保留，模糊可以保留 */
    * { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
```

---

## 7. 选型速查

| 场景 | 建议 |
|---|---|
| 只要快、要兼容 | `backdrop-filter: blur + saturate`，接受它是毛玻璃不是液态玻璃 |
| 要真折射，目标浏览器支持 `backdrop-filter: url()` | **路线 A**（1.2）：一个属性搞定，不用复制背景 |
| 要真折射，但 `backdrop-filter: url()` 不可用，或要多次采样同一背景 | **路线 B**（1.3）：复制背景 + 普通 `filter: url()` |
| 要真折射，背景是视频 / canvas | 路线 A 可以；路线 B 复制不了。两者性能都要先测 |
| 要真折射，且追求极致性能 / 要色散 + 多光源 | 直接上 WebGL / WebGPU 着色器，数学同 3.1 |

> **实测起点建议**：先按路线 B 做（本文第 8 节的骨架就是 B，已验证可跑），
> 因为它不依赖 `backdrop-filter` 的滤镜区域行为，可控性最好、坑最少。
> 确认效果对了之后，再试路线 A 简化 —— 记得两条路线都要**读像素**验证，
> 别用截图哈希（见 1.1 的教训）。

---

## 8. 最小可运行骨架

```html
<!doctype html>
<html><head><meta charset="utf-8"><style>
/* 背景要用「高对比内容」—— 平滑渐变上看不出折射。
   这里叠了两种锐利的斜条纹，边缘被弯折时一眼能看出来。 */
:root {
    --bg:
        repeating-linear-gradient(45deg,  rgba(255,255,255,.18) 0 6px, transparent 6px 28px),
        repeating-linear-gradient(-45deg, rgba(0,0,0,.20)      0 6px, transparent 6px 28px),
        linear-gradient(135deg, #ff6b6b, #4ecdc4 45%, #556270);
}
body {
    margin: 0; height: 100vh;
    background: var(--bg);
    background-attachment: fixed;
}
.glass {
    position: relative; isolation: isolate;
    overflow: hidden;                 /* 裁掉 refract 超出卡片的部分 */
    width: 320px; height: 180px; margin: 120px auto;
    border-radius: 28px;
    display: grid; place-items: center;   /* 内容居中 */
    color: #fff; font: 600 24px/1 system-ui;
    text-shadow: 0 1px 2px rgba(0,0,0,.4);
}
/* 五层玻璃：全部负 z-index，全部不吃点击 */
.glass > i {
    position: absolute; display: block;
    pointer-events: none;
}
.lg-refract { inset: -48px; z-index: -5;
              filter: var(--fid); }   /* ⚠️ 这一行不能少，--fid 由 JS 设 */
.lg-frost   { inset: 0; z-index: -4;
              /* ⚠️ 模糊别开太大：它在折射层「之上」，会把刚弯折出来的内容又糊平。
                 高对比细条纹背景上，14px 会直接糊成一片纯色，误以为折射没生效。 */
              backdrop-filter: blur(4px) saturate(170%) brightness(1.06); }
.lg-tint    { inset: 0; z-index: -3; background: rgba(255,255,255,.08); }
.lg-spec    { inset: 0; z-index: -2; }   /* 镜面高光，本例从简 */
.lg-rim     { inset: 0; z-index: -1;
              box-shadow: inset 0 0 0 1px rgba(255,255,255,.18); }
/* 背景副本：和 body 用同一份背景，对位靠 background-attachment: fixed */
.lg-copy {
    position: absolute; left: 0; top: 0;
    width: 100vw; height: 100vh;
    background: var(--bg);
    background-attachment: fixed;
}
</style></head>
<body>
<div class="glass">
    <i class="lg-refract"><i class="lg-copy"></i></i>
    <i class="lg-frost"></i><i class="lg-tint"></i>
    <i class="lg-spec"></i><i class="lg-rim"></i>
    液态玻璃
</div>

<script>
/* 1) 生成位移贴图 */
const CARD_W = 320, CARD_H = 180, PAD = 48;
const W = CARD_W + PAD * 2, H = CARD_H + PAD * 2;
const R = 28, BEZEL = 26, REFRACT = 0.85;   // 折射强度：0.4 很含蓄，1.0 左右很夸张
const cv = document.createElement('canvas');
cv.width = W; cv.height = H;
const ctx = cv.getContext('2d');
const img = ctx.createImageData(W, H);
const half = { x: W / 2, y: H / 2 };

const sd = (px, py) => {
    const cx = Math.abs(px) - (half.x - R), cy = Math.abs(py) - (half.y - R);
    return Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) - R
         + Math.min(Math.max(cx, cy), 0);
};
// 解析梯度：绝不能用中心差分（会出 X 形亮线）
const grad = (px, py) => {
    const cx = Math.abs(px) - (half.x - R), cy = Math.abs(py) - (half.y - R);
    if (cx >= 0 || cy >= 0) {
        const nx = Math.max(cx, 0), ny = Math.max(cy, 0);
        const len = Math.hypot(nx, ny) || 1;
        return [Math.sign(px) * nx / len, Math.sign(py) * ny / len];
    }
    const useX = cx >= cy ? 1 : 0;
    return [Math.sign(px) * useX, Math.sign(py) * (1 - useX)];
};

for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const px = x - half.x, py = y - half.y;
    const d = sd(px, py);
    const i = (y * W + x) * 4;
    let dx = 0, dy = 0;
    if (-d < BEZEL) {                       // 只在折射带内
        const t = Math.min(Math.max(-d / BEZEL, 0), 1);
        const h = 1 - Math.sqrt(1 - t * t); // circleMap 剖面
        const [gx, gy] = grad(px, py);
        const m = REFRACT * BEZEL * h;
        dx = gx * m; dy = gy * m;
    }
    img.data[i]     = 128 + dx;             // R = x 方向
    img.data[i + 1] = 128 + dy;             // G = y 方向
    img.data[i + 2] = 128;
    img.data[i + 3] = 255;
}
ctx.putImageData(img, 0, 0);

/* 2) 装进 SVG 滤镜 */
const SVG = 'http://www.w3.org/2000/svg';
const svg = document.createElementNS(SVG, 'svg');
svg.setAttribute('width', 0); svg.setAttribute('height', 0);
svg.style.position = 'absolute';
const f = document.createElementNS(SVG, 'filter');
f.id = 'lg-f';
f.setAttribute('x', '-50%'); f.setAttribute('y', '-50%');
f.setAttribute('width', '200%'); f.setAttribute('height', '200%');
f.setAttribute('color-interpolation-filters', 'sRGB');
const feImg = document.createElementNS(SVG, 'feImage');
feImg.setAttribute('result', 'map');                    // ⚠️ 必须
feImg.setAttribute('href', cv.toDataURL());
const feDisp = document.createElementNS(SVG, 'feDisplacementMap');
feDisp.setAttribute('in', 'SourceGraphic');
feDisp.setAttribute('in2', 'map');                      // ⚠️ 字符串，不是元素
feDisp.setAttribute('xChannelSelector', 'R');
feDisp.setAttribute('yChannelSelector', 'G');
// feDisplacementMap 的实际位移 = scale * (C/255 - 0.5)，而贴图编码是 128 + dir*127，
// 所以 scale = maxDisplacement * 255 / 127。这里的 maxDisplacement 就是 REFRACT * BEZEL。
feDisp.setAttribute('scale', String((REFRACT * BEZEL) * 255 / 127));
f.append(feImg, feDisp); svg.append(f); document.body.append(svg);

/* 3) 应用滤镜。
      注意是给 --fid 赋 "url(#lg-f)"，CSS 里写 filter: var(--fid)；
      千万不要在 CSS 里写 filter: url(var(--fid)) —— 会展开成 url(url(#id)) 而静默失效。 */
document.querySelector('.lg-refract')
        .style.setProperty('--fid', 'url(#lg-f)');
</script>
</body></html>
```

把这段存成 `.html` 双击打开，拖动/滚动页面就能看到边缘的挤压。
**如果边缘毫无变化**，按这个顺序查：

```js
getComputedStyle(document.querySelector('.lg-refract')).filter
// "none"            → --fid 没设上，或者 CSS 里漏了 filter: var(--fid)
// "url(#lg-f)"      → 滤镜挂上了，问题在滤镜内部（查 feImage 的 result / in2）
```
