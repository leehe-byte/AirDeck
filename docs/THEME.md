# AirDeck 主题与液态玻璃

这份文档讲**怎么让自己的页面 / 插件在 AirDeck 的皮肤下正常显示**。

适用对象：写插件的人、改前端样式的人、以及任何往页面里塞 HTML 的人。

一句话原则：**只用 CSS 变量和现成的类，不要写死颜色、不要另造一套。**

- 插件开发的其他内容见 [PLUGIN_DEV.md](PLUGIN_DEV.md)
- **液态玻璃本身的实现原理**（想自己做一个、或者想改折射参数）：
  [LIQUID-GLASS-WEB.md](LIQUID-GLASS-WEB.md)（Web）·
  [LIQUID-GLASS-ANDROID.md](LIQUID-GLASS-ANDROID.md)（Android）
- 本项目皮肤的功能说明与已知限制见 [README 的「液态玻璃皮肤」一节](../README.md#-液态玻璃皮肤)

---

## 1. 主题挂在 `<html>` 上的属性

| 属性 | 取值 | 说明 |
|---|---|---|
| `data-theme` | `light` / `dark` | 深浅色，顶栏 🌓 切换，也可跟随系统 |
| `data-skin` | `glass` / 无 | 液态玻璃皮肤总开关 |
| `data-lg-glass` | `liquid` / `frost` | 玻璃档位：液态折射 / 毛玻璃 |
| `data-lg-blur` | `on` / `off` | 是否允许 `backdrop-filter`。**手机首次运行默认 `off`**（低端 WebView 兜底） |
| `data-lg-bg` | `aurora` / `solid` / `image` / `url` | 背景模式 |
| `data-lg-cardlens` | `on` / `off` | 内容卡片是否也做折射 |

这些属性**你不需要自己设置**，框架会维护。需要判断的时候读一下就行（见第 6 节）。

---

## 2. 只用 CSS 变量，不要写死颜色

**这是最容易踩的坑，也是唯一一个会让页面直接变不可用的坑。**

皮肤会在 `[data-skin="glass"]` 作用域内把基础主题变量**重映射**一遍：

```css
[data-skin="glass"] {
    --bg:           rgba(255, 255, 255, .07);
    --card-bg:      rgba(255, 255, 255, .08);
    --inner-bg:     rgba(255, 255, 255, .06);
    --code-bg:      rgba(0, 0, 0, .35);
    --text-main:    var(--lg-text);       /* 白 */
    --text-sub:     var(--lg-text-sub);
    --border-color: rgba(255, 255, 255, .13);
    --item-hover:   rgba(255, 255, 255, .10);
}
```

所以：

```css
/* ✅ 跟着皮肤走 */
background: var(--inner-bg);
color: var(--text-main);
border: 1px solid var(--border-color);

/* ❌ 皮肤开启后会出问题 */
background: #f9f9f9;
color: #262626;
```

写死颜色的话，浅色主题下会得到「白色底 + 皮肤设的白色文字」——
**白字压白底，什么都看不见**。app 主体里就有两处这种内联写法，是靠重映射变量才救回来的。

**内联样式也一样安全**：变量定义在 `:root` 上，内联样式引用的是变量。
所以 `style="background: var(--inner-bg)"` 在皮肤开启时也会自动跟着变。

### 皮肤自己提供的变量

除了上面那些重映射过的，皮肤还有一组 `--lg-*`：

| 变量 | 用途 |
|---|---|
| `--lg-text` / `--lg-text-sub` | 玻璃上的主 / 次文字色 |
| `--lg-tint` / `--lg-tint-strong` | 玻璃底色 |
| `--lg-radius` | 玻璃圆角 |
| `--lg-blur` | 毛玻璃模糊半径（桌面 18px / 手机 12px） |

---

## 3. 优先复用现成的类

页面会自动继承皮肤，尽量用这些类，不要另造一套：

| 类名 | 用途 |
|---|---|
| `.card` / `.card-header` / `.card-body` | 卡片。**玻璃层由框架自动注入到 `.card` 顶部** |
| `.info-table` | 键值表格 |
| `.badge` | 右上角小徽标（`<span>`） |
| `.btn-primary` / `.btn-secondary` / `.btn-danger` | 操作按钮，已玻璃化 |
| `.modern-input` | 输入框 |
| `.ios-switch` + `<label class="ios-slider">` | 开关（无色透明玻璃） |
| `.segmented-control` + `.seg-item` | 分段控件 |
| `.picker-trigger` | 下拉触发框 |

---

## 4. 有语义色的小按钮

`<button class="badge">` 如果**内联**写了颜色，框架会自动把它换算成同色系玻璃：

```html
<!-- 拉黑 → 自动变红玻璃 + 浅红字 -->
<button class="badge" style="background:#fff1f0; color:#f5222d; border-color:#ffa39e">拉黑</button>

<!-- 移出 → 自动变绿玻璃 -->
<button class="badge" style="background:#f6ffed; color:#52c41a; border-color:#b7eb8f">移出</button>

<!-- 主操作：字是白的，就用底色当强调色 -->
<button class="badge" style="background: var(--primary); color:#fff">应用更改</button>
```

规则：**强调色取内联的 `color`**（字接近白色时改取 `background`），再生成
`rgba(强调色, .20)` 的底 + `rgba(强调色, .50)` 的描边 + 提亮 90 的字色。

所以只要语义色写对，开皮肤时它是玻璃，关皮肤时自动还原成你写的样子。

> 设备列表是 `innerHTML` 动态生成的，框架挂在 `#content` 的 MutationObserver 上一起重扫，
> 所以后插入的按钮也会被处理。

---

## 5. 几条硬性约束

这几条不是风格建议，是踩过坑的结论。

- **不要在侧边栏里加 `backdrop-filter`。**
  侧边栏内嵌一个 SVG 位移滤镜，嵌套的背景采样是 Android WebView 上闪烁的主要来源。

- **不要给自己要显示玻璃的元素（或它的祖先）加 `transform` / `will-change: transform`。**
  照片背景的玻璃副本靠 `background-attachment: fixed` 锚定视口，
  而**祖先只要有 transform，`fixed` 就会退化成 `scroll`** ——
  副本会锚定到自己的盒子，直接显示出壁纸的另一块。
  （`.card:hover` 原来有个上浮 transform，就是这个症状。）

- **不要用 `!important` 写死颜色**：会盖掉皮肤的变量重映射，症状同第 2 节。

- **`render()` 里不要替换整个 `.card` 的 innerHTML。**
  玻璃层是注入在 `.card` 顶部的，整体替换会把它们冲掉，而这层注入不会自动补回
  （内容每 2 秒轮询更新文本，框架不能监听子树，否则会被高频触发）。
  要重建结构的话，请替换 `.card-body` 内部的节点，不要碰 `.card` 本身。

- **不要给自己要显示玻璃的元素加 `position: fixed`。**
  `filter` 会创建包含块，`fixed` 会被解析成相对那个元素。

---

## 6. 确实需要判断的时候

```js
const r = document.documentElement;
const glassOn = r.getAttribute('data-skin') === 'glass';
const mode    = r.getAttribute('data-lg-glass');   // liquid | frost
const canBlur = r.getAttribute('data-lg-blur') === 'on';
```

一般用不上 —— 跟着 CSS 变量走就够了。

---

## 7. 应用版本号

页面里**不要硬编码版本号**。发版只改 `app/build.gradle.kts` 的 `versionName`，
其余地方都从服务端读：

```js
Api.get('/api/app').then(res => {
    // res = { versionName: "4.0.0", versionCode: 38 }
    console.log(res.versionName);
});
```

`pages/about.html` 就是这么做的，可以照抄。
