# 液态玻璃 · Android 实现技术文档

> **这份文档的用途**：让另一个 AI（或人）能在 Android 上做出真正的液态玻璃。
> 内容自包含，配套的 Web 版见 [LIQUID-GLASS-WEB.md](LIQUID-GLASS-WEB.md)。
>
> 核心结论先给：**Android 上不需要自己造轮子。**
> 用 [`io.github.kyant0:backdrop`](https://github.com/Kyant0/AndroidLiquidGlass)（Apache-2.0），
> 几行代码就有真折射。想完全可控再自己写 AGSL —— 第 3 节给了完整着色器源码。

---

## 0. 液态玻璃 ≠ 毛玻璃

| 要素 | 作用 | 没有它会怎样 |
|---|---|---|
| **折射（lensing）** | 背景像素按玻璃侧壁的曲面发生位移 | 就是毛玻璃 |
| **镜面高光** | 沿边框内法线方向的亮边 | 玻璃和背景贴在一起，没厚度 |
| **vibrancy** | 提亮 / 提饱和，让内容在玻璃上可读 | 内容发灰 |
| 模糊 | 磨砂 | 背景太抢眼，内容读不出来 |

Android 上的关键分野是：**折射需要 AGSL（`RuntimeShader`），也就是 Android 13 / API 33+。**
低版本只能做模糊 + vibrancy。这是硬限制，不是没调好参数。

---

## 1. 路线选择

| 路线 | 真折射 | 适用 |
|---|---|---|
| **A. Kyant backdrop** | ✅ `lens()` | **默认选它。** 效果好、维护中、几行代码 |
| B. Haze | ❌ 只做模糊 | 需要兼容 API ≤ 30（有实验性 RenderScript 兜底） |
| C. 自己写 AGSL | ✅ | 要完全可控、要接自己的渲染管线 |

A 和 B 都需要 **`compileSdk ≥ 37`** —— 这是它们依赖的 Compose Multiplatform 1.12 的硬性要求，
也是很多大厂 APK（例如酷安 16.6.1）`compileSdkVersion='37'` 的原因。

---

## 2. 路线 A：Kyant backdrop

### 2.1 依赖

```kotlin
dependencies {
    implementation("io.github.kyant0:backdrop:2.0.1")   // 会带上 backdrop-android
    implementation("io.github.kyant0:shapes:1.2.1")     // squircle 连续圆角，可选
}
```

### 2.2 三段式 API

思路是「**录制背景 → 标记来源 → 绘制玻璃**」：

```kotlin
Box(Modifier.fillMaxSize()) {
    // 1) 录制背景：底色 + 被标记子树的内容
    val backdrop = rememberLayerBackdrop {
        drawRect(Color(0xFF06070C))
        drawContent()
    }

    // 2) 标记来源：这个子树会被录进 backdrop
    //    ⚠️ 忘了这一步 = backdrop 是空的 = 玻璃里什么都没有
    LazyVerticalGrid(modifier = Modifier.fillMaxSize().layerBackdrop(backdrop)) { ... }

    // 3) 绘制玻璃：effects 的叠加顺序 = 调用顺序
    Box(
        Modifier.drawBackdrop(
            backdrop = backdrop,
            shape = { RoundedCornerShape(28.dp) },
            effects = {
                vibrancy()                              // 提亮/提饱和
                blur(4f.dp.toPx())                      // 磨砂（⚠️ 收 Float 像素，不是 Dp）
                lens(28f.dp.toPx(), 48f.dp.toPx(),      // (折射带宽度, 折射强度, ...)
                     depthEffect = true,
                     chromaticAberration = false)
            },
            onDrawSurface = { drawRect(Color.White.copy(alpha = 0.06f)) }
        )
    )
}
```

`lens` 的完整签名：

```kotlin
fun BackdropEffectScope.lens(
    refractionHeight: Float,            // 折射带宽度：只有离边框这么近的区域才弯折
    refractionAmount: Float,            // 折射强度：像素被推多远
    depthEffect: Boolean = false,       // 叠加"中心透镜"整体畸变（通透感的来源）
    chromaticAberration: Boolean = false // 色散：7 次采样，很贵
)
```

**参数怎么调：**

| 参数 | 太小 | 太大 |
|---|---|---|
| `refractionHeight` | 只有极细一圈在动，像描边 | 整块玻璃都在扭，像果冻 |
| `refractionAmount` | 看不出挤压 | 边缘内容被扯碎 |
| `depthEffect` | 只有边缘一圈折射，中间死板 | 中心也糊，失去"清晰"的对比 |

参考值：`height 24~32dp`、`amount 40~56dp`、`depthEffect = true`。
**做一个实时滑杆面板**，比对着截图猜快得多。

### 2.3 四个坑

1. **`lens()` 需要 API 33+。**
   低版本 `isRuntimeShaderSupported()` 返回 false，库内部直接跳过 —— 只剩模糊，
   而且**不报错**。要用它做降级判断：

   ```kotlin
   if (isRuntimeShaderSupported()) {
       lens(28f.dp.toPx(), 48f.dp.toPx(), true)
   }
   ```

2. **`blur()` 的 2.0.x 版本收的是 `Float` 像素值，不是 `Dp`。**
   官方文档写 `blur(4f.dp.toPx())`，照抄就对了；写成 `blur(4.dp)` **编译不过**。

3. **`Modifier.offset {}` 用的是像素。**
   初始位置按 dp 写会在不同屏幕上错位，要用 `LocalDensity` 换算：

   ```kotlin
   val density = LocalDensity.current
   var offset by remember(density) {
       mutableStateOf(with(density) { Offset(440.dp.toPx(), 300.dp.toPx()) })
   }
   ```

4. **玻璃叠玻璃必须用 `exportedBackdrop` 打断递归，否则直接 SIGSEGV。**
   （玻璃面板上再放一个玻璃按钮就会触发）

   ```kotlin
   val sheetBackdrop = rememberLayerBackdrop()
   Column(
       Modifier.drawBackdrop(
           backdrop = backdrop,
           exportedBackdrop = sheetBackdrop,   // ⚠️ 关键
           effects = { lens(24f.dp.toPx(), 48f.dp.toPx(), true) }
       )
   ) {
       Box(Modifier.drawBackdrop(backdrop = sheetBackdrop, ...))  // 玻璃按钮
   }
   ```

---

## 3. 路线 C：自己写 AGSL（完整着色器）

如果你要接自己的渲染管线，或者想把效果参数暴露到极致，这是全套源码。
下面这些是从一个实际在用的商业 APK 里提取、并与开源库源码核对一致的。

### 3.1 圆角矩形 SDF 与解析梯度（三个着色器共用）

```glsl
float radiusAt(float2 coord, float4 radii) {
    if (coord.x >= 0.0) {
        if (coord.y <= 0.0) return radii.y;
        else return radii.z;
    } else {
        if (coord.y <= 0.0) return radii.x;
        else return radii.w;
    }
}

float sdRoundedRect(float2 coord, float2 halfSize, float radius) {
    float2 cornerCoord = abs(coord) - (halfSize - float2(radius));
    float outside = length(max(cornerCoord, 0.0)) - radius;
    float inside = min(max(cornerCoord.x, cornerCoord.y), 0.0);
    return outside + inside;
}

// ⚠️ 解析梯度。用数值中心差分会在对角线折点处出 X 形亮线 —— 见 Web 文档第 3.2 节
float2 gradSdRoundedRect(float2 coord, float2 halfSize, float radius) {
    float2 cornerCoord = abs(coord) - (halfSize - float2(radius));
    if (cornerCoord.x >= 0.0 || cornerCoord.y >= 0.0) {
        return sign(coord) * normalize(max(cornerCoord, 0.0));
    } else {
        float gradX = step(cornerCoord.y, cornerCoord.x);   // 硬切换，从不平均
        return sign(coord) * float2(gradX, 1.0 - gradX);
    }
}
```

### 3.2 折射（主力）

```glsl
uniform shader content;          // 背景快照
uniform float2 size;
uniform float2 offset;
uniform float4 cornerRadii;      // 四个角半径（可分别指定）
uniform float refractionHeight;  // 折射带宽度（bezel）
uniform float refractionAmount;  // 折射强度
uniform float depthEffect;       // 是否叠加"中心透镜"（0 或 1）

float circleMap(float x) { return 1.0 - sqrt(1.0 - x * x); }

half4 main(float2 coord) {
    float2 halfSize = size * 0.5;
    float2 centeredCoord = (coord + offset) - halfSize;
    float radius = radiusAt(coord, cornerRadii);

    float sd = sdRoundedRect(centeredCoord, halfSize, radius);
    // 平面区：原样输出，完全不折射。这个 early-return 是性能关键
    if (-sd >= refractionHeight) {
        return content.eval(coord);
    }
    sd = min(sd, 0.0);

    // -sd = 到边框的距离；归一化到 [0,1] 后过侧壁剖面
    float d = circleMap(1.0 - -sd / refractionHeight) * refractionAmount;

    float gradRadius = min(radius * 1.5, min(halfSize.x, halfSize.y));
    float2 grad = normalize(gradSdRoundedRect(centeredCoord, halfSize, gradRadius)
                            + depthEffect * normalize(centeredCoord));

    float2 refractedCoord = coord + d * grad;
    return content.eval(refractedCoord);
}
```

**三个设计要点：**

1. **`circleMap = 1 - √(1-x²)`** 就是侧壁剖面函数（球形穹顶）。
   边缘位移最大，到 `refractionHeight` 处归零。
2. **位移方向直接取 SDF 梯度** —— 任何圆角矩形都自动得到正确的内法线，
   不需要按边分段处理。这是用小 SDF 而不是写死四条边的最大理由。
3. **`depthEffect * normalize(centeredCoord)`** 是额外项：往中心再拉一点，
   模拟厚镜片的整体畸变。**不加就只有边缘一圈折射，中间死板** ——
   这是"通透感"的来源，很多人做不出来就是漏了这一项。

### 3.3 色散（可选，7 次采样）

```glsl
// 强度带 centeredCoord.x * centeredCoord.y 因子：四角最强、边中为零
float dispersionIntensity = chromaticAberration
    * ((centeredCoord.x * centeredCoord.y) / (halfSize.x * halfSize.y));
float2 dispersedCoord = d * grad * dispersionIntensity;

half4 color = half4(0.0);
half4 red    = content.eval(refractedCoord + dispersedCoord);                color.r += red.r / 3.5;    color.a += red.a / 7.0;
half4 orange = content.eval(refractedCoord + dispersedCoord * (2.0 / 3.0));  color.r += orange.r / 3.5; color.g += orange.g / 7.0; color.a += orange.a / 7.0;
half4 yellow = content.eval(refractedCoord + dispersedCoord * (1.0 / 3.0));  color.r += yellow.r / 3.5; color.g += yellow.g / 3.5; color.a += yellow.a / 7.0;
half4 green  = content.eval(refractedCoord);                                 color.g += green.g / 3.5;  color.a += green.a / 7.0;
half4 cyan   = content.eval(refractedCoord - dispersedCoord * (1.0 / 3.0));  color.g += cyan.g / 3.5;   color.b += cyan.b / 3.0;  color.a += cyan.a / 7.0;
half4 blue   = content.eval(refractedCoord - dispersedCoord * (2.0 / 3.0));  color.b += blue.b / 3.0;   color.a += blue.a / 7.0;
half4 purple = content.eval(refractedCoord - dispersedCoord);                color.r += purple.r / 7.0; color.b += purple.b / 3.0;  color.a += purple.a / 7.0;
return color;
```

### 3.4 镜面高光

```glsl
uniform float2 size;
uniform float4 cornerRadii;
layout(color) uniform half4 color;
uniform float angle;     // 光源方向
uniform float falloff;

half4 main(float2 coord) {
    float2 halfSize = size * 0.5;
    float2 centeredCoord = coord - halfSize;
    float radius = radiusAt(coord, cornerRadii);
    float gradRadius = min(radius * 1.5, min(halfSize.x, halfSize.y));
    float2 grad = gradSdRoundedRect(centeredCoord, halfSize, gradRadius);
    float2 normal = float2(cos(angle), sin(angle));
    float d = dot(grad, normal);
    float intensity = pow(abs(d), falloff);
    return color * intensity;
}
```

有个变体多一行 `float t = step(0.0, d);` 并返回 `half4(t,t,t,1.0) * intensity` ——
把高光硬切成"迎光的那半边"，用来做掩码。

### 3.5 怎么把它接起来

```kotlin
val shader = RuntimeShader(REFRACTION_AGSL)
shader.setFloatUniform("size", w, h)
shader.setFloatUniform("cornerRadii", r, r, r, r)
shader.setFloatUniform("refractionHeight", bezelPx)
shader.setFloatUniform("refractionAmount", amountPx)
shader.setFloatUniform("depthEffect", if (depth) 1f else 0f)
shader.setInputShader("content", backgroundSnapshotShader)
// 再用 shader 画到玻璃形状的 canvas 上
```

**`content` 必须是「玻璃背后的像素」** —— 这就是整件事最难的部分：
你要拿到背景快照。Compose 里靠 `graphicsLayer` 录制子树，
传统 View 体系里要靠 `RenderNode` + `PixelCopy`。拿不到快照，折射就无从谈起。

---

## 4. 降级与边界情况

| 情况 | 处理 |
|---|---|
| **API < 33** | `lens()` 不可用，退化成 `blur()` + `vibrancy()`。用 `isRuntimeShaderSupported()` 判断，**不要静默失败** |
| **WebView / SurfaceView / 视频** | 它们的内容**抓不进 graphics layer**，backdrop 采样到的是一片空白或黑。必须单独降级（商业 App 的做法是给这些区域关掉玻璃，改回普通背景） |
| **列表滚动时** | 每帧重算背景快照很贵。`layerBackdrop` 内部有缓存，但要避免每帧改玻璃的形状/尺寸 |
| **远程开关** | 大型 App 会做一个服务端下发的开关（灰度 / 紧急关闭）。自己用可以省，但要留个本地的全局开关 |
| **降低动态效果** | 读 `Settings.Global.ANIMATOR_DURATION_SCALE == 0`，此时应当减少或关闭动画 |

---

## 5. 工具链（三个非显然的坑）

| 组件 | 版本 | 原因 |
|---|---|---|
| Gradle | 9.5.1 | AGP 9 要求 |
| AGP | **9.2.1** | backdrop 2.x 的 AAR 元数据要求 AGP ≥ 9.1.0 |
| compileSdk | **37（minor 2）** | backdrop / Compose 1.12 要求 ≥ 37 |
| Kotlin | 2.4.0 | 依赖库用 kotlin-stdlib 2.3.20+ 编译，编译器 metadata 版本不能更低 |
| Compose BOM | 2026.05.01 | |
| minSdk | 26（折射实际要 33） | |

1. **AGP 9 内置了 Kotlin 支持**，不能再应用 `org.jetbrains.kotlin.android` 插件。
   `org.jetbrains.kotlin.plugin.compose` 仍需保留。

   ```kotlin
   plugins {
       alias(libs.plugins.android.application)
       alias(libs.plugins.kotlin.compose)   // ✅
       // alias(libs.plugins.kotlin.android)  ❌ AGP 9 下会冲突
   }
   ```

2. **只有带 minor 的平台（如 `android-37.2`）时要用带 minor 的 DSL**：

   ```kotlin
   compileSdk { version = release(37) { minorApiLevel = 2 } }
   ```

3. **Gradle wrapper 的缓存目录名是 `base36(MD5(distributionUrl))`。**
   如果本机已经缓存过某个镜像的发行包，把 `gradle-wrapper.properties` 指到
   同一个 URL 就能直接复用缓存、不用重新下载（国内建议指向腾讯云镜像）。

---

## 6. 怎么验证折射真的生效

这一步很关键 —— **"模糊 + 透明"看起来已经很像了，很容易误判成成功。**

判别方法：

1. **背景要放高对比度的内容**（彩色色块 + 大号文字）。
   低对比背景上折射几乎看不出来，容易自我欺骗。
2. **快速拖动玻璃**。真折射时，边缘的内容会**跟着变形**（像透过水杯看字），
   中间保持清晰；只有模糊的话，边缘和中间一样糊。
3. **把 `refractionAmount` 拉到很大**。真折射会看到边缘内容被明显扯开甚至拉丝；
   如果毫无变化，说明 `lens()` 根本没生效 —— 大概率是 API < 33 被跳过了。
4. **看 `depthEffect` 开关的差异**。开之前只有边缘一圈在动，开之后整块玻璃
   的内容都会有轻微的整体位移。没有差异 = 这个参数没接上。

---

## 7. 选型速查

| 场景 | 建议 |
|---|---|
| 要真折射、效果接近 iOS / 主流 App | **Kyant backdrop `lens()`**（API 33+） |
| 要兼容 API ≤ 30 | Haze（只有模糊 + 实验性 RenderScript） |
| 要完全可控、要接自己的管线 | 自己写 AGSL，用第 3 节的源码，配 33 / 31 / 30- 三档降级 |
| 只是想要"玻璃感"，性能优先 | `Modifier.blur()` + 半透明白底，别碰折射 |

---

## 附：怎么从 APK 里提取内嵌着色器（可复现）

想研究别人的实现时，这条路径很快：

```powershell
# 1. 从 APK 里取出 classes.dex
# 2. 按 ASCII 读成字符串（R8 会重命名类名，但不会改写字符串字面量）
$text = [System.Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes("classes.dex"))
# 3. 用着色器的特征串定位
[regex]::Matches($text, 'uniform shader content;[\s\S]{0,3000}?return content\.eval\(refractedCoord\);')
```

AGSL 源码是以字符串常量嵌在 dex 里的，所以能原样捞出来。
