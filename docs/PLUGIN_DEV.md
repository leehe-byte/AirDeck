# OpenGW 插件开发指南

插件系统为 OpenGW 提供了类 OpenWrt/LuCI 的扩展能力：**外部安装、免重启、热更新**。插件包是一个 `.owpkg` 文件（本质是 zip 压缩包），安装后即可向管理页添加侧边栏菜单、独立页面、状态总览卡片，并调用系统通用能力 API。

最小可用的示例见 `examples/demo-plugin/`。打包与签名使用项目内置脚本 `scripts/build_plugin.sh`（见第 6 节）。

---

## 1. 插件包结构

```
my-plugin.owpkg  (zip)
├── manifest.json    # 必填：插件元数据（id 与 entryJs 为硬性要求）
├── www/             # 前端资源：页面 html、逻辑 js、css、图片
│   ├── page.html
│   └── plugin.js    # 入口脚本（entryJs），调用 PluginRegistry.register()
├── bin/             # 可选：可执行二进制，安装时自动 chmod 755
├── files/           # 可选：需写入系统的文件（由 install.sh 负责落盘）
└── scripts/         # 可选：生命周期脚本
    ├── install.sh   # 安装时执行（root），如部署二进制/配置到系统目录
    ├── remove.sh    # 卸载时执行（root）
    ├── start.sh     # 手动启动（插件管理页「▶ 启动」）
    ├── stop.sh      # 手动停止（「⏹ 停止」）
    └── boot.sh      # 开机自启（APK 后台服务启动时执行，应自行判断是否真正需要自启）
```

## 2. manifest.json

```json
{
  "id": "my-plugin",              // 必填，仅 [A-Za-z0-9_-]
  "name": "我的插件",
  "version": "1.0.0",
  "versionCode": 100,             // 建议：数值版本号，用于程序化比较/升级判断
  "icon": "🧩",
  "description": "一句话描述",
  "requiresRoot": true,           // 是否需要 root 权限
  "menu": { "section": "应用服务", "order": 1 },  // 侧边栏分组（同名自动合并）+ 组内排序
  "page": "page.html",            // 插件独立页面（相对 www/ 的路径）
  "entryJs": "plugin.js",         // 必填：入口脚本，将动态加载并执行
  "cards": [                      // 可选：状态总览卡片
    // refreshMs：轮询间隔(ms)；0 = 仅渲染一次不轮询；overview:false = 不进状态总览
    { "id": "status", "title": "运行状态", "icon": "🛡️", "refreshMs": 5000 }
  ],
  "scripts": {
    "install": "scripts/install.sh",
    "remove": "scripts/remove.sh",
    "start": "scripts/start.sh",
    "stop": "scripts/stop.sh",
    "boot": "scripts/boot.sh"
  }
}
```

## 3. 前端入口（entryJs）

入口脚本通过 `PluginRegistry.register()` 注册自身。注册后核心框架会自动处理侧边栏菜单、页面加载与卡片刷新。

```js
PluginRegistry.register({
    id: 'my-plugin',
    title: '我的插件',
    icon: '🧩',
    menu: { section: '应用服务', order: 1 },
    page: 'page.html',

    // 独立页面初始化（页面 HTML 注入后由框架调用）
    init() {
        // 可访问全局: Api, ApiExtra, startPolling, showAlert, showConfirm, escapeHtml 等
    },

    // 状态总览卡片
    cards: [
        {
            id: 'status', title: '运行状态', icon: '🛡️', refreshMs: 5000,
            render() {
                const el = document.getElementById('plugin-card-body-my-plugin-status');
                if (el) el.textContent = '...';
            }
        }
    ]
});
```

要点：

- 菜单分组 `menu.section` 与现有分组同名会自动合并（如「应用服务」），否则在侧边栏底部新建；`menu: false` 可完全隐藏。
- 卡片容器 id 约定为 `plugin-card-body-{pluginId}-{cardId}`，`render()` 在 overview 页按 `refreshMs` 轮询调用。
- 卡片刷新控制：`refreshMs` 缺省 5000；设 `0` 表示**只渲染一次、不轮询**（适合静态信息）；设 `overview: false` 则**不进状态总览**。
- 页面内联 `<script>` 会自动执行（框架手动补挂载），但推荐把逻辑都放入口脚本。
- **缓存机制**：入口 JS（entryJs）每个 app 会话只加载一次（`scriptsLoaded` 标记）；**重装/更新插件后 app 会自动重置该标记并重新拉取新版**。为彻底绕开任何缓存，**强烈建议 entryJs 用版本化文件名**，如 `"entryJs": "plugin-1.1.8.js"`（每版本换新文件名）。
- **作用域隔离（重要）**：所有插件的 entryJs 都加载进**同一个全局作用域**。顶层 `const/let/var/function` 会互相污染——两个插件若都声明 `const PLUGIN`，后加载的那个会报 `Identifier 'PLUGIN' has already been declared`。**强烈建议入口脚本整体用 IIFE 包裹**，把所有内部常量/函数封闭在局部作用域，仅通过 `PluginRegistry.register()` 对外注册：

  ```js
  (function () {
      const PLUGIN = 'my-plugin';   // 局部常量，不影响其它插件
      const PORT = 8080;
      const VERSION = '1.0.0';

      PluginRegistry.register({
          id: PLUGIN, title: '我的插件', icon: '🧩',
          page: 'page.html',
          init() { /* ... */ },
          cards: [ /* ... */ ]
      });
  })();
  ```
- **卡片 `render()` 的 `this` 陷阱**：框架在收集卡片时用 `{...c}` **展开**了卡片对象，因此 `render()` 被调用时 `this` 指向卡片副本，**不是插件对象**——在卡片里调用 `this.xxx`（如 `this.exec`）会报 `TypeError: xxx is not a function`。卡片内请直接用全局 `Api`，不要依赖 `this`；插件的 `exec` 等私有方法只可在 `init()`/页面逻辑（经插件对象调用）里用。

  ```js
  cards: [{
      id: 'status', title: '状态', icon: '🛡️', refreshMs: 5000,
      render() {
          const el = document.getElementById('plugin-card-body-my-plugin-status');
          if (!el) return;
          Api.post('/api/plugins/my-plugin/exec', { command: 'pgrep -x myapp' })
              .then(res => { el.textContent = (res && res.output) ? '运行中' : '已停止'; })
              .catch(() => {});
      }
  }]
  ```

## 4. 通用能力 API

插件前端通过以下接口调用系统能力，前缀为 `/api/plugins/{id}/`：

| 接口 | 方法 | 说明 |
|---|---|---|
| `/exec` | POST `{"command":"..."}` | **root** 执行命令，返回 `{result, output}`；cwd 限定插件目录；命令 ≤ 4096 字符、10s 超时 |
| `/config` | GET / POST `{"k":"v"}` | 插件 KV 配置（存于插件目录 config.json） |
| `/file` | GET `?path=` / POST `{"path","content"}` | 读写插件私有目录内的文件（防路径穿越） |
| `/start` `/stop` `/restart` | POST | 执行对应生命周期脚本 |
| `/uninstall` | POST | 执行 remove.sh 并删除插件目录 |

```js
// 例：执行 root 命令
const res = await Api.post('/api/plugins/my-plugin/exec', { command: 'uname -a' });
console.log(res.output);

// 例：读写配置
await Api.post('/api/plugins/my-plugin/config', { note: 'hello' });
const cfg = await Api.get('/api/plugins/my-plugin/config');
```

### 响应格式与局限

- **/exec** 返回 `{result, output}`，`output` 是 **trim 后的 stdout 文本**；若命令输出 JSON，前端用 `JSON.parse(res.output)`。
- **JSON 输出规范**：exec 脚本要输出 JSON 时，**空值必须输出 `null`**（如 `"mem":null`），不能留空（`"mem":,` 是非法 JSON，前端解析直接失败）。
- **/file** 的 `content` 是**原始文本**（UTF-8），适合小配置/文本；**二进制/大文件不适用**——可放 `bin/` 随包部署，或前端 base64 编码后 exec `base64 -d` 落盘。
- **WebSocket/实时能力**：当前通用能力 API **不提供 WebSocket**；实时刷新（终端/串口）可轮询 `/exec` 实现，双向流需插件自起服务并复用已开放的端口。

### 静态资源

`www/` 目录下的文件通过 `GET /plugins/{id}/www/*` 提供访问。

## 5. 生命周期脚本

- 均在 **root** 下执行，由 `sh <script>` 调用。
- `install.sh` 中可通过 `${0%/*}` 向上定位插件目录：`PLUGIN_DIR=$(dirname $(dirname $0))`。
- `boot.sh` 应在 **父脚本立即退出、逻辑放后台子 shell**，避免阻塞 APK 服务启动：

  ```sh
  #!/system/bin/sh
  {
      # 等系统启动完成后按需启动...
      if [ -f /data/my-plugin/on ]; then
          sh /data/my-plugin/bin/run.sh start
      fi
  } > /dev/null 2>&1 &
  exit 0
  ```

- **携带依赖二进制**：把二进制放入 `bin/`（安装时自动 chmod 755）；`install.sh` 负责把它复制到系统/数据目录（如 `/data/my-plugin/bin/`），运行脚本再引用该路径。

## 6. 打包、签名与安装

推荐使用项目内置脚本 `scripts/build_plugin.sh` 打包（自动压缩为 zip，并可选做 RSA 签名）：

```bash
# 打包 + 签名（私钥默认取 releases/keys/private.pem）
./scripts/build_plugin.sh <插件目录> my-plugin.owpkg releases/keys/private.pem

# 不签名打包（示例/本地测试用）
./scripts/build_plugin.sh <插件目录> my-plugin.owpkg none
```

签名策略（可选签名）：

- **带签名**：脚本会对 `manifest.json` 做 `SHA256withRSA` 签名，将 `signature.sig` 写入包内；安装时用 APK 内嵌公钥校验，**篡改或签名不匹配将拒绝安装**。
- **无签名**：可以正常安装，但插件列表与安装结果会标记「⚠️ 未签名」。
- 私钥需妥善保管（丢失后需重新生成密钥对并替换 APK 内公钥）；公钥编译在 APK 内。

安装方式：

1. 管理页「插件管理」→ 上传 `.owpkg` 文件；
2. 或填写 URL 远程拉取安装（**仅支持公网 http/https，禁止本机/内网地址**）。

安装时会校验扩展名 `.owpkg`、`manifest.json`（必须含 `id`、`entryJs`）与签名，随后执行 `install.sh` 完成部署，并回显 `install.sh` 的输出。

## 7. 注意事项

- **全 API 鉴权**：所有 `/api/*` 均要求登录会话（官方密码登录后下发 token）。框架的 `Api` 与插件入口会自动附加 `X-Auth-Token`，插件内部请求请统一走 `Api`。
- **安全**：`/exec` 是 root 级命令执行，命令长度上限 4096、10s 超时，插件应做好命令参数校验；`/file` 已被限定在插件目录内（防路径穿越）。
- **URL 安装**：仅公网 http/https，禁止本机/内网地址（SSRF 防护）。
- **签名**：发布插件建议签名（见第 6 节）；未签名插件安装时会标记提示。
- **路径**：插件安装于 `filesDir/plugins/<id>/`，安装包内路径请使用正斜杠。
- **免重启**：部署通过 root 直接落盘，不依赖 Magisk 挂载，无需重启。

## 8. 调试

- 浏览器按 **F12** 打开控制台，查看插件 JS 的报错与 `console.log`。
- 确认加载的是最新 JS：看插件页面版本徽标，或控制台 Network 里 entryJs 请求 URL（带 `?_=<时间戳>` 即为新拉取）。
- 插件后端命令的输出通过 `/exec` 返回，可在插件页的 `console` 里打印 `res.output` 排查。
- 若怀疑缓存导致旧代码，重装插件即可（app 会自动重置加载标记）；仍异常则强制停止并重开 app。

## 9. 主题与液态玻璃（插件适配）

**这一节很重要**：app 现在有液态玻璃皮肤，插件如果写死颜色，会在一片玻璃里突兀地出现一块纯色方块，浅色主题下甚至会出现「白字压白底」。

### 9.1 主题挂在 `<html>` 上的属性

| 属性 | 取值 | 说明 |
|---|---|---|
| `data-theme` | `light` / `dark` | 深浅色，顶栏 🌓 切换，也可跟随系统 |
| `data-skin` | `glass` / 无 | 液态玻璃皮肤总开关 |
| `data-lg-glass` | `liquid` / `frost` | 玻璃档位：液态折射 / 毛玻璃 |
| `data-lg-blur` | `on` / `off` | 是否允许 `backdrop-filter`。**手机首次运行默认 `off`**（低端 WebView 兜底） |
| `data-lg-bg` | `aurora` / `solid` / `image` / `url` | 背景模式 |
| `data-lg-cardlens` | `on` / `off` | 内容卡片是否也做折射 |

### 9.2 只用 CSS 变量，不要写死颜色

**最容易踩的坑。** 皮肤会在 `[data-skin="glass"]` 作用域内把基础主题变量**重映射**一遍：

```css
[data-skin="glass"] {
    --bg:           rgba(255, 255, 255, .07);
    --card-bg:      rgba(255, 255, 255, .08);
    --inner-bg:     rgba(255, 255, 255, .06);
    --text-main:    var(--lg-text);       /* 白 */
    --text-sub:     var(--lg-text-sub);
    --border-color: rgba(255, 255, 255, .13);
    --item-hover:   rgba(255, 255, 255, .10);
}
```

所以：

- ✅ `background: var(--inner-bg); color: var(--text-main); border: 1px solid var(--border-color);`
- ❌ `background: #f9f9f9; color: #262626;`

写死颜色的话，浅色主题下会得到「白色底 + 皮肤设的白色文字」——**白字压白底，什么都看不见**。
（app 主体里就有两处这种内联写法，是靠重映射变量才救回来的。）

变量定义在 `:root` 上，而内联样式引用的是变量 —— 所以哪怕你**内联**写 `style="background: var(--inner-bg)"`，皮肤开启时也会自动跟着变。

### 9.3 优先复用现成的类

插件页面会自动继承皮肤，尽量用这些类，不要另造一套：

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

### 9.4 有语义色的小按钮

`<button class="badge">` 如果**内联**写了颜色，框架会自动换算成同色系玻璃：

```html
<!-- 拉黑 → 自动变红玻璃 + 浅红字 -->
<button class="badge" style="background:#fff1f0; color:#f5222d; border-color:#ffa39e">拉黑</button>
<!-- 移出 → 自动变绿玻璃 -->
<button class="badge" style="background:#f6ffed; color:#52c41a; border-color:#b7eb8f">移出</button>
<!-- 主操作：字是白的，就用底色当强调色 -->
<button class="badge" style="background: var(--primary); color:#fff">应用更改</button>
```

规则：**强调色取内联的 `color`**（字接近白色时改取 `background`），再生成
`rgba(强调色,.20)` 底 + `rgba(强调色,.50)` 描边 + 提亮 90 的字色。
所以只要语义色写对，开皮肤时它是玻璃，关皮肤时自动还原。

### 9.5 几条硬性约束

- **不要在侧边栏里加 `backdrop-filter`**。侧边栏内嵌一个 SVG 位移滤镜，嵌套的背景采样是 Android WebView 上闪烁的主要来源。
- **不要给自己的元素加 `position: fixed`**：`filter` 会创建包含块，`fixed` 会被解析成相对那个元素。
- **不要用 `!important` 写死颜色**：会盖掉皮肤的变量重映射，症状同 9.2。
- **`render()` 里不要替换整个 `.card` 的 innerHTML**。玻璃层是注入在 `.card` 顶部的，
  整体替换会把它们冲掉，而这层注入不会自动补回（内容轮询每 2 秒更新文本，框架不能监听子树，
  否则会被高频触发）。要重建结构的话，请替换 `.card-body` 内部的节点，不要碰 `.card` 本身。

### 9.6 确实需要判断的时候

```js
const r = document.documentElement;
const glassOn = r.getAttribute('data-skin') === 'glass';
const mode    = r.getAttribute('data-lg-glass');   // liquid | frost
const canBlur = r.getAttribute('data-lg-blur') === 'on';
```

一般用不上 —— 跟着 CSS 变量走就够了。
