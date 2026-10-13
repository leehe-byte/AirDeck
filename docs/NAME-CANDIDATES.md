# 项目命名候选

> **已定名：AirDeck**（2026-10）。
> 这份文档保留下来作为选名过程和约束分析的记录 —— 尤其是「`applicationId` 不要动」那一段，换名时容易踩。
> 下面提到的「现状」是定名前的情况。

给这个项目起个定名，然后把代码各处统一。

现状是 **5 个名字混用**（详见文末「现状」），Gradle/包名一套、界面显示一套、仓库产物又一套。

---

## 先看约束：什么能改，什么最好别动

**能随便改（用户可见）：**
- 界面显示名（顶栏、登录页、页面标题）
- 仓库名、Release 里的 APK 文件名
- `settings.gradle.kts` 的 `rootProject.name`
- 文档标题、About 页

**强烈建议别动：**

| 项 | 当前值 | 为什么别动 |
|---|---|---|
| `applicationId` | `com.opengw.manager` | **改了等于换了一个 App**。已装设备无法覆盖升级，必须卸载重装，本机数据（插件、配置、插件目录）全丢；签名/更新链也断 |
| `namespace` | `com.opengw.manager` | 改它要连带移动整个源码目录树，纯 churn，且和 `applicationId` 解耦后容易埋坑 |

**结论：新名字只作为「显示名 / 仓库名 / 产物名」，包名保持 `com.opengw.manager` 不动。**
（除非你打算借这次换名彻底重来一遍安装链 —— 那要提前说。）

---

## 候选一览

| # | 名字 | 读法 | 一句话 | 风险 |
|---|---|---|---|---|
| 1 | **AirDeck** | 艾尔戴克 | U30 **Air** 的控制台（deck） | 低 |
| 2 | **琉璃 / Liuli** | liú lí | 有色玻璃 —— 直指液态玻璃招牌 | 低 |
| 3 | **Prism** | 普rism | 棱镜，折射 | 中：与 Prism.js 同名 |
| 4 | **Conduit** | 康杜伊特 | 导管 / 枢纽 | 低 |
| 5 | **Beacon** | 比肯 | 信标 | 低（但偏通用） |
| 6 | **PocketGate** | 口袋盖特 | 口袋网关 | 低 |
| 7 | **Refract** | 瑞弗拉克特 | 折射（动词） | 低 |
| 8 | **Lucent** | 卢森特 | 透光的 | 低 |
| 9 | **灵枢 / Lingshu** | líng shū | 灵巧的枢纽 | 低，但略生僻 |
| 10 | **明镜 / Mingjing** | míng jìng | 明镜高悬 —— 看清设备一切 | 中：中文常见词 |
| 11 | **Glaze** | 格莱兹 | 釉 / 上釉 | 中：与一个反 AI 绘图工具同名 |
| 12 | **RoamDeck** | 罗姆戴克 | 漫游 + 控制台 | 低 |

---

## 逐个说

### 1. AirDeck ⭐ 我最推荐

中兴 **U30 Air** 是这个项目的主力设备，`AirDeck` 就是「Air 的驾驶台/控制台」。
`Deck` 在软件里已经有成熟语义（Steam Deck、Presentation Deck、Ops Deck），读起来像一个真产品而不是玩具。

- 短（7 字母），好念，中英文都不会念错
- APK：`AirDeck-4.1.0-release.apk`；仓库：`AirDeck`
- 顾虑：主打设备是 Air，但你也支持 F50。如果以后想扩到更多机型，「Air」会有点像绑定单一型号
  → 反过来说，这也正好是「随身 WiFi」这个品类的常见命名法

### 2. 琉璃 / Liuli ⭐ 中文里最漂亮

「琉璃」= 有色玻璃、釉。**直接对上你现在最大的视觉特征**，而且是个有质感的古词，不是生造词。

- 界面标题可以就写「琉璃」，比任何英文名都好看
- 仓库：`liuli` 或 `liuli-gw`；APK：`Liuli-4.1.0-release.apk`
- 顾虑：对不讲中文的人是三个无意义音节；如果以后想在英文社区推，辨识度低
- 另一个顾虑：**名字绑定了视觉风格**。哪天你换掉液态玻璃，名字就有点尴尬

### 3. Prism

棱镜 —— 光穿过就散成光谱，和「折射」是同一件事的两种说法。英文里短、干净、有科技感。

- 仓库 `prism` 大概率被占，得用 `prism-gw` 之类
- **和 Prism.js（语法高亮库）同名**，搜起来会混

### 4. Conduit

导管、枢纽。强调「把原厂锁住的东西导出来」—— 和桥接协议破解的内核很贴。

- 英文里偏冷门但认得，不像玩具名
- `conduit` 这个词也被一些项目用过（Mozilla 的一个 Rust 代理就叫 Conduit），但领域不冲突

### 5. Beacon

信标。设备在局域网里就是个信标，管理端是收信标的人。短、好记、发音全世界都会。

- 顾虑：太通用了，`beacon` 相关的开源项目一抓一大把，重名感强
- 适合：如果你不在意搜索唯一性

### 6. PocketGate

口袋网关。最直白地说清「这是什么」。中文可以叫「口袋网关」。

- 稍长（10 字母），APK 名会长一点
- 好处是**不会有人看不懂**，尤其对同款设备的朋友

### 7. Refract

折射。把招牌效果直接当名字。

- 当仓库名很利落，当界面标题略硬
- 和 Prism 一样，绑定了视觉风格

### 8. Lucent

透光的、发亮的。比 Refract 柔和，气质更「精致工具」。

- 有点软，气势不如 AirDeck
- `lucent` 在一些库名里出现过

### 9. 灵枢 / Lingshu

「灵」= 灵巧、灵敏；「枢」= 枢纽、中枢。**功能上极其贴切**（一个灵巧的网关中枢）。
中文极好，但——「灵枢」是《黄帝内经》的篇名，中医语境太重，搜索引擎会被压住。

### 10. 明镜 / Mingjing

「明镜高悬」，一眼看清设备所有状态。做管理后台的寓意非常好。

- 中文常见词，重名多（明镜网、明镜周刊……），搜索辨识度差
- 当界面标题倒是不错

### 11. Glaze

釉。玻璃质感 + 工艺感，英文里很顺口。

- 和芝加哥大学的反 AI 绘图工具 Glaze 同名，那项目有一定知名度

### 12. RoamDeck

漫游 + 控制台。比 AirDeck 更不绑定具体型号，覆盖面更广。

- 稍长（9 字母）
- 如果以后要支持更多随身 WiFi 机型，这个比 AirDeck 稳

---

## 我的建议

**如果你主要面向中文用户、也喜欢现在这套视觉 → 选「琉璃 / Liuli」。**

**如果你希望名字更「像产品」、以后可能给同款设备的朋友用 → 选「AirDeck」。**

**如果你打算长期维护、机型会扩 → 选「RoamDeck」或「Conduit」。**

三个维度简单排一下：

| 维度 | 最好 | 次之 |
|---|---|---|
| 中文观感 | 琉璃 | 灵枢 |
| 通用/可扩展 | RoamDeck、Conduit | AirDeck |
| 好念好记 | AirDeck、Prism | Beacon |
| 和项目特征的关联 | 琉璃、Refract、Prism | AirDeck |

---

## 定名之后要改的地方（33 个文件）

选定后我做一次全量统一，涉及：

| 类别 | 位置 | 数量 |
|---|---|---|
| Gradle | `settings.gradle.kts` 的 `rootProject.name` | 1 |
| 应用显示名 | `res/values/strings.xml` 的 `app_name` | 1 |
| 原生界面 | `activity_main.xml`、`MainActivity.kt` | 2 |
| Web 界面 | `index.html`、`login.html`、`pages/*.html`、`js/*.js`、`docs/glass-preview.html` | ~20 |
| 服务端字符串 | `CoreWebServer.kt`、`CoreBackgroundService.kt`、`PluginManager.kt`、`WakeLockManager.kt` | 4 |
| 文档 | `README.md`、`docs/THEME.md`、`docs/PLUGIN_DEV.md` | 3 |
| CI | `.github/workflows/main.yml`（Release 标题与文件名） | 1 |

**不改：** `applicationId`、`namespace`、`com.opengw.manager` 包路径、已有的 GitHub 仓库地址（改仓库名要在 GitHub 设置里做，本地 remote 也要跟着改 —— 这个我可以一起处理）。

---

## 现状（供参考）

| 名字 | 出现 | 用在哪 |
|---|---|---|
| OpenGW | 17 | `rootProject.name`、`app_name`、`com.opengw.manager`、PluginManager、文档 |
| BridgeLink | 13 | **Web UI 显示名**（顶栏 / 登录页 / 标题）、`activity_main.xml`、CoreWebServer |
| WebManagerLite | 13 | **仓库名**、产物名、若干页面字符串、插件文档 |
| OpenGW Lite Manager | 1 | `about.html` 的 `<h2>` |
| OpenGW-mobile | 1 | README 里的姊妹项目链接 |
