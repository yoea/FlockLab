# FlockLab 开发文档

面向「换一台电脑继续开发」的接手指南：怎么跑起来、代码怎么组织、怎么验证改动、怎么上线，以及踩过的坑。
面向使用者的特性说明见 [`README.md`](./README.md)。

---

## 1. 快速开始

### 1.1 环境

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 18+（本机用 22） | 只用于本地静态服务器和语法检查，**项目本身无构建步骤** |
| Python | 3.x | 起静态服务器用（也可换成任意静态服务器） |
| 浏览器 | 支持 WebGL2 + ES module | Chrome / Edge 皆可；开发时用无头 Chrome + CDP 做自动化验证 |
| 网络 | 首次打开需要 | `three` 与 `lil-gui` 走 CDN（jsDelivr，失败回退 unpkg） |

无 npm 依赖、无打包器、无 `.gitignore` 外的隐藏目录。整个项目就是一组静态文件。

### 1.2 跑起来

```bash
cd flocklab
python -m http.server 8777          # 端口随意
# 打开 http://127.0.0.1:8777/index.html
```

**必须经 HTTP 打开**：页面用 ES module 加载 `js/main.js`，`file://` 会被 CORS 拦住（`Access to script at 'file://...' from origin 'null' has been blocked`）。

### 1.3 语法自检（改完代码先跑这个）

```bash
node --input-type=module --check < js/main.js
node --input-type=module --check < js/audio.js
node --input-type=module --check < js/grass.js
```

`node --check` 只查语法。**运行期错误必须在真实页面里跑一遍**（见 §4），曾经多次出现「`node --check` 通过但页面 `ReferenceError`」。

---

## 2. 架构总览

### 2.1 文件职责

```
flocklab/
├── index.html          页面骨架、图标按钮、「关于」弹窗、CDN 引入、SW 注册
├── sw.js               Service Worker：离线壳缓存 + CDN 依赖缓存
├── manifest.webmanifest PWA 清单（standalone / 图标 / 主题色）
├── css/style.css       全部界面样式（含隐藏动画、右下角按钮 / 控制台定位）
├── js/main.js          仿真主循环 + GLSL + GUI + 调试接口（约 3900 行，核心）
├── js/audio.js         Web Audio 事件音效 + 六层生成式音乐（约 730 行）
├── js/grass.js         草地几何、谐波轮廓、面积校准、着色（约 180 行）
├── js/backdrop.js      背景地貌（草地斑 / 河流 / 村庄剪影）+ 漂移云层（约 250 行）
├── assets/logo.svg     LOGO 与 favicon
├── assets/icon-*.png   PWA 图标（192 / 512 / maskable 512 / 180）
└── README.md / DEVELOPMENT.md
```

`grass.js` 只管「草地长什么样、在哪」；**休憩调度（谁去休息、排队、争夺）全在 `main.js`**。
`backdrop.js` 只管「背景长什么样」；**它需要草地位置来做避让**，所以 `main.js` 在草地重建后调 `backdrop.setGrass(grass)`。

### 2.2 `main.js` 内部结构（按文件从上到下）

| 段落 | 内容 |
| --- | --- |
| 参数常量 | `DEFAULTS`、`MAX_N=10000`、`MAX_P`、滑块范围、存档读写与夹紧 |
| 仿真数组 | 全是预分配 `TypedArray`（`pos/vel/acc/col/siz/...`），**运行期不新建数组** |
| 穿墙 | `wrapThroughWall()`：墙不存在，越界后从关于中心对称的位置出现 |
| 草地 | `grassField = createGrass(...)`；休憩状态数组（`resting/settled/restDue/contending/...`） |
| 音频 | `audio` / `music` 挂载 |
| GPU 箭头 | `arrowGeo` + `arrowMat`（GLSL 画 ">" 形，朝向在顶点着色器里按速度旋转） |
| 加速尾迹 | `MAX_TRAILS=4800` 环形槽位池 + `trailMat`（详见 §3.4） |
| 捕食者渲染 | `predGeo`/`predMat`（锐角三角形 SDF）、警戒圈 `threatRings` |
| `step(dt, time)` | **物理**：网格重建 → 逐鸟邻域扫描/三力/逃逸/休息 → 速度积分 → 穿墙 → 统计 |
| `render()` | **着色**：逐鸟颜色尺寸 → 尾迹发射 → 捕食者位置颜色 → 音乐驱动 → 提交实例 |
| GUI | `lil-gui` 面板绑定，`bindNum`/`bindBool` 自带说明文本与持久化 |
| `window.FlockLab` | 调试接口（见 §4.2） |

### 2.3 每帧数据流

```
requestAnimationFrame(render)
  └─ render(now)
       ├─ dt 钳制（防切标签页后一帧跳太远）
       ├─ step(dt, now)                 ← 只算物理，不碰渲染
       │    ├─ 重建空间网格（计数 → 前缀和 → 回填，TypedArray）
       │    ├─ for 每只鸟【第一趟：力】
       │    │    ├─ 局部密度（3×3 格计数）→ localDen
       │    │    ├─ 邻域扫描（轮转取样）→ 对齐/聚合（前 7 只）+ 分离（sepCap 内全部）
       │    │    ├─ 贴身碰撞响应（掐接近速度）
       │    │    ├─ 逃逸/反应延迟/信息级联/爆发
       │    │    ├─ 休息调度（出发/排队/争夺/换位/掠过降落）
       │    │    └─ 合力一阶低通 → acc
       │    ├─ 统计（orderParam、groupRms、density、temperature、pressure）
       │    └─ for 每只鸟【第二趟：积分】
       │         ├─ 速度上限（爆发 > 受惊 > 巡航节奏）
       │         ├─ pos += vel * dt      ← 位移唯一来源
       │         └─ wrapThroughWall()     ← 越界穿墙
       ├─ for 每只鸟：颜色/尺寸 → col/siz（爆发色、新生色、休息苔绿、争斗红）
       ├─ 尾迹发射（鸟按速度超限、捕食者按加速度尖峰）
       ├─ 捕食者位置/颜色/警戒圈热度
       ├─ 音乐驱动（聚集度、捕食者位置）
       └─ 上传实例属性 + renderer.render()
```

**关键**：`step` 只写 `pos/vel/acc` 等物理数组；颜色尺寸在 `render` 里算（读物理数组）。两趟循环作用域不同，跨趟传数据要用模块级数组（见 §6.3）。

---

## 3. 核心设计约定（改代码前务必读）

### 3.1 绝不直接写 `pos`

**位移一律由 `pos += vel * dt` 产生。** 任何「想让个体去某处」的需求都只改**目标点**或**速度/加速度**，由下一帧积分走过去。

> 违反案例：v37 的「位置级软修正」在积分后直接 `pos[k] += ...`，看起来像瞬移，用户立刻看出来了，v39 整块删除。
> 唯一例外是**穿墙**（`wrapThroughWall`），它是瞬移，但语义上就是「从对侧出现」，且速度方向不变。

### 3.2b 邻域：v41 起没有「注意力上限」

对齐 / 聚合 / 分离都取视野内**全部**同伴（原始 Boids）。`sepCap` 不是注意力上限，是**防炸帧的安全阀**（130/110/90 按数量分档），正常密度下大于真实邻居数。网格边长是 `视野/1.4` 而不是 `视野`——3×3 仍能覆盖任意位置的视野圆，但扫描面积从 2.9 倍降到 1.5 倍；这一条直接决定单帧耗时，改回 `视野` 会让 800 只的 `step` 从 10ms 涨到 26ms。

实测代价（800 只密集成团）：`step ≈ 10ms`（v40 的 7 只上限是 2.8ms）。这是「原始涌现」必须付的账，别再靠加注意力上限去压——那会重新带回「方块化 / 聚散极限环」。

### 3.2 防重叠靠「提前推开」，不是「事后补位」

参考 `de3717e`（v30，重叠最少的版本）的做法，当前是三件事的组合：

1. **分离权重纯 `1/d²`、不软化**（`sepSoft = 0`）：贴近时权重陡增，`crowd` 随之趋近 1 → 满力推开。
   > v33 加过 `sepSoft = sep2*0.015`，把贴近时的权重峰值从上百压到 –20，结果「贴身推不动」，是重叠的主因之一。
2. **分离力底数 0.55**（`desiredSpeed * (0.55 + 0.45*crowd) / sl`）：远距离就有力推开，鸟在贴近之前就被挡开。
   > 低底数（0.22 / 0.42）会让鸟一路贴近才补救，来不及。
3. **贴身碰撞响应**：挤进 `COLLIDE_DIST(0.55)` 时除强推外，把「朝对方去」的速度分量直接掐掉（`kill = -closing/dt * 0.85`，**不受 `maxForce` 限制**）——速度 15、相对速度 30 时靠 22 的转向力要 20 多帧才停得住，期间早穿过去了。

另外两件配套：
- **注意力与分离解耦**：对齐/聚合只取前 7 只（固定拓扑邻居），但**分离看 `sepCapFor(n)` 内全部候选**（当前 24/18/14）——只看 7 只会漏掉真正贴身的那只。
- **`MAX_FORCE = 22`**：太小（14）时最小转弯半径约 16 单位，是身位（0.5）的 30 倍，转向来不及。

**验证用 `FlockLab.sepStats`**（每只鸟到最近邻的距离分位数 + 重叠比例），**不要用瞬时最小值** `minNeighborDist`——全场一对瞬时擦身就会把它打到 0.01，看着像没修好。健康值：`p50 > 1.0`、`below05 < 0.1`、`below03 < 0.02`。

**同源问题：编队稳定性（别让群体「聚成一坨 → 炸开 → 再聚」）**。成因是两个**恒定满力**对顶：分离只要「有近邻」就满推、没有就归零，聚合也恒定满推，于是群体在「聚合占优 → 挤成一团」和「分离占优 → 炸开」之间反复横跳。当前的解法（v33/v34）：

1. **分离力幅值连续化**：`crowd = maxW/(maxW+SEP_SAT)` 随贴近程度连续上升，取代开关。⚠️ 但拥挤度必须用 `maxW`，不能用 `sl`（见 §3.3）。
2. **邻域轮转取样**：`scanTick` 每帧推进，9 个格按 `(鸟序号 + 帧号) & 7` 错位扫描；自己格给 45% 配额（保证贴身分离），其余 8 格轮转。否则「自己格优先、取满 7 只就停」会让 7 个邻居**全部来自同一格**（实测 800 只时 78%），聚合质心被钉在格心、整群被拽进一个个方块里。
3. **合力一阶低通**（`FSM = 0.55`，约 2 帧时间常数）：只盯 7 只邻居时逐帧合力抖动大，直接积分会让群体来回摆。
4. **对齐一致性加权**：`agree = |Σv| / sqrt(n·Σv²)`，散乱时对齐力只有约四成、齐飞时才接近满力（否则把方向噪声放大成满力，群体被随机推力搅成块）。

判断指标：`orderParam` 的标准差（不是均值——v30 时 `0.524±0.176`，sd 极大正是抖动）与 `groupRms` 序列的方向翻转次数。健康值：800 只 `order ≈ 0.24–0.35`、sd < 0.12，16 秒内半径只 2–3 次翻转。

### 3.3 拥挤度用 `maxW`，不要用 `sl`

分离向量加权和的模长 `sl = |Σ dx·w|` 在两只鸟几乎重合时**同样趋于 0**（`dx·w = d/(d²+ε)`，`d` 比 `1/d²` 衰减得快，峰值在 `d=√ε` 处）。用它当拥挤度会让「最该排斥的时刻力反而最小」。

正确做法：`maxW = max(1/(d²+ε))`（最近那只的权重，随贴近**单调上升**），`crowd = maxW/(maxW+SEP_SAT)`。
**凡是「用向量和的模长当拥挤度」都会踩这个坑。**

### 3.4 尾迹是独立粒子，不是附着在模型上的拖尾

`MAX_TRAILS = 4800` 环形槽位池（`InstancedBufferGeometry`），`emitTrail()` 在生成瞬间**冻结世界坐标与航向**，之后不随实体移动 → 转弯自然连成弧。顶点着色器按 `age = (uTime-aBirth)/aLife` 裁剪过期槽并让长度/宽度/透明度收缩淡出，CPU 不逐帧遍历。

- **发射位置在实体尾部**：`emitTrail()` 的 `tailOff` 参数把锚点沿航向反方向退 `len + tailOff`，粒子亮端正好贴在捕食者三角形的底边（`0.3227486 × 腰长`）或鸟的尾角连线中点（`0.42 × 个体尺寸`），整体拖在后方，不会盖住本体。
- **触发条件**：鸟按「瞬时速度超出巡航节奏」、捕食者按「加速度尖峰」，都先过「快起慢落」包络（`birdTrailP`/`predTrailP`）+ 个体节流（`trailNextAt`/`predTrailNextAt`），其余撒点/着色器/淡出完全共用。
- **穿墙/被吃/重生时清发射包络**（粒子留在旧位置是对的——那是历史航迹），避免落点凭空接一段。

### 3.5 穿墙：墙视为不存在（环面平移，**不镜像**）

`wrapThroughWall(x, y, hx, hy)`：越界后从**对侧同高度**继续出现（右边飞出 → 左边界同 y 处进来），速度方向不变，等价于把场地当环面。

⚠️ **不要改回「关于场地中心对称」**（v38/v39 的写法：`x = -hx; y = -y`）。它会让跨边界的一坨鸟变成两份镜像：已穿过去的一半在 `-y`、还没穿的一半在 `+y`，相距 `2y` 且互不可见，于是每次有鸟群跨边界，整坨就被永久撕成两半。实测 25 秒内 800 只累计穿墙 1500 次（平均每只每 13 秒一次），群体从 1 坨碎成 6–8 坨、RMS 半径涨到 42（≈ 铺满全屏）。纯平移下穿过去的那半只是接着往前飞，顺序不乱，鸟群能完整地穿过去再聚回来。

配套：群体质心按**最小映像**累计（`pos - 上一帧 groupX`，超出半场就 ±2hx），`groupRms` 也按最小映像算。否则穿墙那一帧质心会跳到对面，把「群体归拢」的方向整个翻过来。

鸟、AI 捕食者、鼠标捕食者**完全相同**，无概率、无反射、无贴边急转（那些等于把墙挪进场内侧）。

面板上的 `params.wrapEdges`（**默认 false**）可以打开它：关掉时走 `bounceOffWall()`——夹回边界 + 反转越界方向的速度分量（保留 92%），三处调用点（鸟 / AI 捕食者 / 鼠标捕食者）都按 `params.wrapEdges` 分支，鼠标捕食者的**光标目标**在关掉时也要夹进场内（否则它会一直贴着墙追一个场外的点）。`bounds2D()` 只是**显示范围**（正交相机视口），不阻挡运动；活动边界 = 屏幕边界（`view2DFitHalfH()` = `BOUND × VIEW2D_MARGIN`）。

### 3.5b 群体归拢（长程）与密度配色

两条都是 v40 加的，**彼此独立但容易一起踩坑**：

1. **长程归拢**（`FLOCK_KEEP_R = 18` / `FLOCK_KEEP_F = 14`，见 step 里「群体归拢」一段）：只对离质心超过 18 单位的个体施力，力度随超出量线性增长、上限 1.6 倍系数 × 14。它解决的是「局部规则留不住大群」这个结构性问题——感知半径只有 7 个单位，两坨鸟的间距一超过视野就永久互不可见，强分离又把群体压成一个个结晶小团，整屏散着 5–9 坨。**别试图靠调 `cohesion` 解决**：实测 `cohesion=3.2` 反而碎成 17 坨（聚合越强，结晶越小越硬），`separation` 调小也一样（分离越弱，小坨越紧越容易成形）。
2. **密度配色**：颜色色阶必须用 `localDen`（3×3 格计数），**不能用 `neighbors[i]`**。`neighbors` 是注意力邻居数、v31 起上限 7，`neighbors/24` 最多 0.29，色相只能到 `0.52 + 0.29×0.4 ≈ 0.64`（蓝绿）——这就是「再怎么聚集也不变紫」的根因，而 `localDen` 当时算了却没人用（死代码）。归一化基准 `LOCAL_DEN_K = 110`（`denK = 110 × 1.4 × max(1, n/800)`），默认 800 只实测 p50 ≈ 0.5、p95 ≈ 0.95。

调这两个数用 `FlockLab.setFlockKeep(r, f)`，判定用 `FlockLab.positions` 做单链接聚类（阈值 6–12）+ `localDenStats` 分位，别凭肉眼。

### 3.6 休息逻辑随 `grassOn` 一起开/关

关掉草地时 `liftAllResting()` 必须同时清掉 **`contending`（争斗红）与 `restWaitFrom`（排队计时）**，只清 `resting` 会让红鸟留在场上「争夺」一块不存在的草地。新开关请走 `FlockLab.setGrassOn(on)`（与 GUI 回调同路径）。

### 3.6b 响应式布局（手机 / 平板）

只改 CSS，`css/style.css` 末尾三段媒体查询：`≤900px`（平板）、`≤620px`（竖屏手机）、`(max-width:400px) or (max-height:430px)`（超小屏）。

- **`body.touch` 的选择器特异性更高**（0,2,1），媒体查询里想覆盖 `body.touch .lil-gui.root` 的 `max-height` 必须写 `!important`——这个坑踩过一次（面板在手机上仍然是 66vh，把按钮行盖住）。
- 控制台在手机上改成 `left/right: 6px; width: auto`，并把 `--background-color` 提到 0.97：它是覆盖在状态卡上的抽屉，半透明会让两卡的字叠在一起。
- 世界尺寸（`view2DFitHalfH`）**没有**跟着屏幕比例变：鸟的元素尺寸是世界单位，改视口高度等于改鸟的像素大小。竖屏手机上场地就是一条竖条，这是有意的取舍。
- 状态卡在 ≤400px 宽时隐藏迷你曲线和四宫格（`.spark-wrap` / `.hud-grid`），否则一张卡吃掉 28% 屏高。

### 3.8 出生动画：`aGrow` 只属于鸟，`uGrow` 是总开关

每只鸟有一个「涌出」进度 `aGrow`（实例属性，0→1），顶点着色器做三件事：前 16% 只留一个极小的点 → 由 8% 尺寸展开到 100%（带过冲）→ 起手自转到成形归零，同时淡入。**走完 g=1 时 `sK=1 / spin=0 / vGrow=1`，与没有这段代码完全一致**，所以老的观感不受影响。

**`predMat` 是 `arrowMat.clone()`，共用同一个顶点着色器**。捕食者几何体没有 `aGrow`，而**缺失的顶点属性在 GLSL 里恒为 0**——不管一下，整只猛禽会被 `sK` 缩到 8%（一个点）。所以顶点着色器里是 `float g = mix(1.0, aGrow, uGrow);`，`predMat.uniforms.uGrow.value = 0`。

它和「新生亮绿」（`birthAt` + `BIRTH_TOTAL_MS`，只在被吃掉后重生时用）是两件事：
- `hatchAt`（ms）→ 涌出动画；`initBoids` 里随机错峰 0–900ms，重生时 = now。
- `birthAt`（ms）→ 新生亮绿；开局为 `-Infinity`，否则 800 只一起闪绿。

### 3.9 背景地貌层：canvas 纹理 + 加法混合 + 世界坐标避让

`backdrop.js` 把静态地貌（草地斑 / 河流 / 村庄）用 canvas 2D 一次性画成纹理，云另画一张**可无缝平铺**的小图（每团在 3×3 个偏移位置各画一遍），着色器里只做两次纹理采样 + 漂移。三条约定：

- **亮度靠增益，不靠 canvas 颜色**：canvas 里按 0.05–0.3 的 alpha 画（8 位通道才分得清），着色器乘 `uGain` 回到 0.002–0.01 线性亮度。改亮度只动 `GAIN` 一个数，不要逐层调 alpha。
- **加法混合 = 没有排序问题**：整层 `AdditiveBlending` + `depthWrite/depthTest: false`，和星云、浮尘谁先谁后都一样。
- **避让草地必须用世界坐标**：纹理会随窗口重画、还会带 22% 视差，按屏幕坐标擦纹理的话一平移就对不上。现在是在片元着色器里把像素反算成世界点（`wp = (vUv-0.5)*2*uHalf + uView`），再和 `setGrass()` 传进来的 `(x,y,R,a1,p1,a2,p2)` 比，轮廓用和草地完全相同的极坐标谐波 → 河 / 村庄 / 草地斑都会绕开草地，平移缩放零成本。
- **不要在背景里叠「山坡」横带**：那几条脊线在静态画面里读起来像划痕（v42 已删）。

### 3.10 PWA：缓存策略与部署

- `sw.js` 的缓存名带版本号（`flocklab-v1`），**改了缓存内容必须改 `VER`**，否则旧缓存会一直命中。`install` 里 `skipWaiting`、`activate` 里清旧缓存 + `clients.claim()`。
- 策略：同源静态资源 **stale-while-revalidate**（最多落后一个版本，第二次打开就是新的）；CDN（URL 带版本号、内容不可变）**缓存优先**；导航 **网络优先**，断了退回缓存里的 `index.html`。CDN 两条 module URL 也必须缓存，否则离线时 `import` 直接失败、整页白屏。
- 调试：`?nosw=1` 跳过注册（但已在控制的页面仍受旧 SW 影响，必要时 `navigator.serviceWorker.getRegistrations()` 清掉）。
- **部署必须带 `sw.js` / `manifest.webmanifest` / `assets/icon-*.png`**，少一个就装不成应用。

### 3.11 其他约定

- **热路径不新建对象/数组**：`step`/`render` 里禁止 `new`、数组字面量、`Math.hypot`（用 `Math.sqrt`）、闭包。跨趟传数据用模块级 `TypedArray`。
- **随机化要带个体相位**：任何「定时/重试/错峰」都要叠 `restPhase[i]`（0–1），否则一批个体会在同一秒同步动作。
- **软错峰**：每帧放行少量个体（出发 2 只 / 站定 1 只），超出的顺延而不是取消需求。
- **颜色走调色表**：`palFly`/`palRest`/`sprintPal` 预计算 32×16，运行期不调 `THREE.Color.setHSL`。
- **存档**：`localStorage['flocklab.params.v6']`；出厂默认值变更时**必须提升版本号**，否则老用户永远拿不到新默认值。

---

## 4. 调试与验证

### 4.1 无头 Chrome + CDP（本项目的主要验证手段）

```bash
# 起无头 Chrome（Windows 路径示例）
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$TEMP/flprobe/chrome-profile" \
  --no-first-run --no-default-browser-check about:blank
```

自动化脚本的关键点（踩过的坑）：

- **导航必须带缓存戳**：`Page.navigate({url: 'http://127.0.0.1:8777/index.html?t=' + Date.now()})`。
  `Page.reload({ignoreCache:true})` **不可靠**，会加载旧模块。
- **CDP 断言要点**：`Runtime.enable` + `Log.enable`，把 `Runtime.exceptionThrown` 和 `Log.entryAdded(level=error)` 都收进 `errs[]`，跑完打 `ERRORS`。
- **同时开多个跑 WebGL 的 target 会打满 CPU**（SwiftShader 软渲染），后续 `evaluate` 超时。先 `/json/close/<id>` 关掉多余 target。
- **`Page.captureScreenshot` 在 SwiftShader 下很慢**：先输出核心检查结果再截图。
- **读统计要等一帧**：像 `setGrassOn(false)` 后立刻读 `grassStats.resting`，读到的是 step 更新前的旧值。写 `await sleep(900)` 再读。
- 验证脚本参考模式：创建 target → 等 `typeof window.FlockLab === 'object'` → `document.body.classList.add('ui-hidden')` → 调试接口读写 → 采样 → 截图 → 关 target。

### 4.2 调试接口（`window.FlockLab`）

**仿真控制**：`params` / `defaults` / `saveParams` / `resetAll` / `setCount(n)` / `setPredCount(n)` / `setPredatorOn(on)` / `setMouseHunter(on)` / `setGrassOn(on)` / `resetBoids` / `spawnBurst`

> `setPredatorCount` / `setPredatorOn` / `setGrassOn` **与 GUI 走同一条回调路径**（同步绘制、状态清理），自动化验证要用它们而不是直接改 `params`。

**视角与坐标**：`view` / `displayRect`（活动边界半宽高）/ `orthoHalfH` / `toWorld(cx, cy)`（屏幕像素 → 世界坐标）/ `xyExtent` / `bound`

**群体状态**：`count` / `paused` / `orderParam`（Vicsek 有序度 Φ）/ `groupRms` / `cohesion` / `density` / `avgSpeed` / `temperature` / `pressure` / `groupAlert` / `fleeingCount` / `sprintingCount` / `sprintCount` / `sprintingPositions` / `maxAbsZ` / `newbornCount`

**间距与密度分布（判断「有没有叠在一起」）**：
- `sepStats` → `{n, p05, p25, p50, p75, p95, below03, below05}`：每只鸟到最近邻的距离分位数，`below05` = 视觉重叠占比
- `minNeighborDist`：瞬时最近一对间距（**仅供参考，会被一对擦身打到 0.01**）
- `localDenStats` → `{p05...p95}`：局部密度分位，用于判断颜色色阶是否铺开（别全体顶格 1.0）

**草地与休息**：`restDebug()`（逐只快照：`r` 在休息、`s` 已停稳、`c` 争斗红、`dd` 到落点距离、`tries` 重试次数）/ `grassInfo` / `grassRatio`（应恒为 **0.15**）/ `grassBunch`（`frameStartMax`/`frameEndMax` 是真正同帧出发/离场峰值）/ `restingCount` / `restSessions` / `restPhaseStats` / `grassStats` → `{patches[{x,y,R,cap,count,settled}], waiting, contending, resting, evicted, waitMaxMs}`

**捕食者**：`predatorCount` / `predatorPositions` / `predatorSpeeds` / `predatorCaps` / `predatorCooling` / `predatorTargets` / `catches` / `deadCount` / `respawnDelays` / `catchRadius` / `predShape` / `reaction` / `ringState` / `mouseHunter` / `mousePredator` / `mouseDrawCount`

**尾迹**：`trailCount` / `trailStats` → `{live, oldestAge, spanX, spanY, capacity}` / `trailSample`（最近 4 颗的 `pos/dir/age/len/wid`，可验证位置冻结与航向各异）

**边界与穿墙**：`portalChance`（恒为 **1**）/ `teleports`（累计穿墙次数）/ `displayRect`

**性能**：`perf` → `{step, prep, draw, total, fps, count, grid, loop, stats, color}`（毫秒，指数平滑）

**邻域扫描配额**：`sepCap`（get/set，只是安全阀；v41 起没有注意力上限）

**群体归拢**：`flockKeep`（`{r, f}`）/ `setFlockKeep(r, f)`——长程归拢的半径与力度，调参用、不持久化

**音频**：`muted` / `musicState` / `soundEvents` / `music.setLevel(0–1.5)` / `music.running`

**出生动画 / 背景**：`hatchPending`（还在涌出中的个体数，加载后应逐渐归 0）/ `respawn(n)`（立刻让 n 只原地重生，验证涌出动画）/ `backdrop`（背景层本体：`uniforms.uGain` 拉高可看清地貌形状，`uniforms.uGN=0` 可 A/B 对比草地避让）

**UI**：`uiHidden` / `eyeFaded` / `hudPinned`

**个体差异**：`teleportCount`（同 `teleports`）/ `overGrass` 相关在内部

### 4.3 改完怎么验证（按改动类型）

| 改了什么 | 至少验证 |
| --- | --- |
| 三力 / 邻域 | `sepStats`（重叠）、`orderParam`（编队）、`localDenStats`（色阶）各采样 10+ 次 |
| 边界 / 穿墙 | `teleports` 增长、`xyExtent` 落在 `displayRect` 内、截图看有无卡边/边框 |
| 尾迹 | `trailStats`（live 会涨、oldestAge 会过期）、`trailSample`（dir 各异）、放大截图看起点 |
| 草地 / 休息 | `grassStats` 前后对比（关草地后 `contending/resting/waiting` 全 0） |
| 捕食者 | `predatorPositions` 轨迹、`catches`、冷却常量 |
| 数量上限 | `setCount(30000)` 应被夹到 `MAX_N` |
| 任何改动 | **`ERRORS` 必须为空** + 截图目视 |

---

## 5. 部署

站点目录部署，无容器常驻、无构建。**拆分后必须上传整个目录**（只传 `index.html` 会缺 CSS/JS/SVG）。

```bash
# 1) 语法自检
node --input-type=module --check < js/main.js

# 2) 打包（含 README，便于线上对照）
tar -czf /tmp/flocklab.tgz index.html css js assets README.md DEVELOPMENT.md

# 3) 上传 + 一次性容器解包并修正属主
#    1Panel 站点目录属主是 33:33（容器内无 www-data 用户名，用数字 UID/GID）
scp /tmp/flocklab.tgz <host>:/tmp/
ssh <host> 'docker run --rm \
  -v /opt/1panel/www/sites/show.ewing.top/index/flocklab:/target \
  -v /tmp:/src postgres:18.6-alpine \
  sh -c "tar -xzf /src/flocklab.tgz -C /target && chown -R 33:33 /target"'

# 4) 验「服务出来的字节」，不要只看文件拷过去
sha256sum js/main.js README.md
ssh <host> 'cd /opt/1panel/www/sites/show.ewing.top/index/flocklab && sha256sum js/main.js README.md'
curl -s -o /dev/null -m 15 --noproxy '*' -w "HTTP %{http_code} ip=%{remote_ip}\n" https://show.ewing.top/flocklab/
curl -s -o /dev/null -m 15 --noproxy '*' -w "HTTP %{http_code}\n" https://show.ewing.top/flocklab/js/main.js
```

**`git push` 不会自动更新站点**——Gitea 仓库与站点目录是两回事，必须走上面的 scp + docker。

`<host>` 是部署主机（见 SSH 配置）。站点目录属主不可写时不要试图 `sudo`（密码不落盘），用 docker 组的一次性容器挂载写入。

---

## 6. 常见坑（历史踩坑清单）

### 6.1 语法通过 ≠ 运行正常

`node --check` 只查语法。**每次批量改完必须在真实页面跑 `ERRORS`**。
典型：v26 拆分时 `REST_MAX_MIN`/`REST_MAX_SPAN` 只留在 `grass.js`，`main.js` 未定义 → 鸟停稳那一刻 `ReferenceError` 中断 `step`（rAF 已排队所以 FPS 照常、画面冻结但不易察觉）。

### 6.2 TDZ：常量声明顺序

被**初始化期**调用的函数引用的常量，必须声明在该函数之前。
典型：`bounds2D()` 改引 `VIEW2D_MARGIN` 后，`initPredators()`（模块顶层）就崩 `Cannot access 'VIEW2D_MARGIN' before initialization`。已把 `VIEW2D_MARGIN` 挪到 `BOUND` 旁。

### 6.3 两趟循环的作用域

`step()` 里有两趟逐鸟循环（**第一趟算力、第二趟积分**），作用域不同。第一趟的局部变量（如 `nearD2`）在第二趟**不可见**，会 `ReferenceError`。
跨趟传数据用模块级 `TypedArray`（按 `i` 索引），不要用局部变量硬撑。

### 6.4 分批替换的工具链坑

用脚本批量替换 `main.js` 后，**必须**：
1. `node --input-type=module --check < js/main.js`
2. 真实页面跑 `ERRORS`
因为 `git apply --3way` 解冲突会丢声明、替换脚本会覆盖定义（历史上丢过 `localDen`、`sepSoft`、`REST_MAX_*` 的定义）。

**git 状态操作要小心**：`git stash` + `git checkout <sha> -- js/main.js` + `stash pop` 冲突后，工作区改动可能丢。改重要逻辑前先 `cp js/main.js /tmp/backup.js`。

### 6.5 测试缓存

`Page.reload({ignoreCache:true})` 仍可能加载旧模块。用 `Page.navigate` + `?t=Date.now()`。
另：浏览器会缓存 CDN 的 three.js，排查「改了没生效」先排除缓存。

### 6.6 Windows / Git Bash 环境

- **每条 Bash 命令前先加 coreutils PATH**（`export PATH=/usr/bin:/bin:$PATH`），否则 `ls`/`rm` 报错。
- **git 分支名不要带斜杠**（`fix-xxx` 而非 `fix/xxx`），斜杠分支会静默创建失败。
- **用 Python 写 shell 脚本必须 `newline='\n'`**；远程执行前 `tr -d '\r'`——CRLF 会让远程 bash 报诡异错。
- **装 Python 包用 `python -m pip install`**（裸 `pip` 可能进错环境）。
- **测外网可达性的 curl 加 `--noproxy '*'`** 并看 `remote_ip`——本机代理会伪造结果。
- **中文 .bat 标签会跳转错位**，尽量避开。

### 6.7 性能测试的陷阱

- 同一份代码在不同机器/不同负载下 `step` 耗时可差 8 倍（SwiftShader 软渲染、后台 target 抢 CPU）。**别在压测数字上钻牛角尖**——用户已经明确否决过「按 5 万只一直测下去」。
- 5 万只曾测出 `step 347ms`（v32 基线 42ms），关捕食者/草地、`sepCap=1` 都无改善，最终是环境噪声。
- 判断瓶颈用 `FlockLab.perf` 的 `grid/loop/stats/color` 分段，别猜。

### 6.8 验证指标选错会瞎调参

用 `minNeighborDist`（瞬时最小）判断「有没有重叠」会反复误判——一对瞬时擦身就把它打到 0.01。**用 `sepStats` 的分布**。
同理「颜色不变紫」要同时看两处：`localDenStats` 的分位（是否全体顶格 1.0 或全体趴底），以及**渲染到底读的是不是 `localDen`**（v40 之前读的是被 7 只上限钉死的 `neighbors`，分位再漂亮也不会变紫）。
判断「群体散成几坨」也不要用 `groupRms` 或状态卡的「群半径」——单个数字分不清「1 坨大群」和「5 坨小群」。用 `FlockLab.positions` 做单链接聚类数连通块（阈值 6–12，只数 ≥20 只的块）。

### 6.9 `mat.clone()` 会连顶点着色器一起克隆（→「捕食者变成一个点」）

`predMat = arrowMat.clone()` 是为了共用「按速度旋转 + 距离淡出」，只覆写片元着色器。
v42 给 `arrowMat` 的顶点着色器加了出生涌出后，捕食者**自动继承了这段**，而它的几何体
没有 `aGrow` 属性 —— **缺失的顶点属性恒为 0**，于是 `sK = 0.08`，整只猛禽缩成一个点。
教训不是「别 clone」，而是：**改共享材质时，先数一遍谁 clone 了它**。
修法是加一个 `uGrow` 开关（鸟 1 / 捕食者 0），让共享的顶点着色器对不需要它的对象退化成原样。

形如 `aGrow` 这种「新加的实例属性」还要额外确认三件事：① 几何体上 `setAttribute` 了；
② 每帧改了之后 `needsUpdate = true`（漏了会一直显示第一帧的值）；③ 新建/复用的实例
（`setCount` 增加、`initBoids`）有没有写初值 —— `growBuf` 初始 fill(1)，否则老个体会突然隐身。

---

## 7. 参数与存档

- 滑块范围见 `js/main.js` 顶部 `RANGES`；数量上限是 `MAX_N = 10000`。
- 存档键 `flocklab.params.v6`；**出厂默认值变更时提升版本号**，让老用户拿到新默认值。
- 静音偏好单独存 `localStorage['flocklab.audio.muted.v2']`（v2：v40 那个 key 存过实验状态，会让老用户「刷新后一直静音」）；状态卡图钉存 `flocklab.hud.pinned`。
- **音量（`musicLevel` / `fxLevel`）不再持久化、不上面板**：固定满刻度 1.5（v40 起）。它们从 `PERSIST_KEYS` 里移除了，所以老存档里的 0.4 不会被读回来；`FlockLab.music.setLevel()` 仍可临时改（调试用）。
- 脏存档（超过当前 `MAX_N` 的数量）在读取时夹紧，不必迁移。

---

## 8. 版本历史（要点）

| 版本 | 要点 |
| --- | --- |
| v26 | 项目拆分为多文件；右下角控制台布局；振翅音效重做；警戒圈两态 |
| v27 | 默认参数调整（对齐 1.8 / 视野 7 / 巡航 15 / 捕食者 25）；状态卡重做+图钉；修复草地瞬移与同帧站定竞态 |
| v28 | 进入自动收起界面；默认值与存档 v6；边界贴边急转掉头；传送概率 10% |
| v29 | 进入显示 1 秒后动画收起、点眼睛展开（移除独立沉浸机制） |
| v30 | 音乐低音层+盘旋层；静音硬闸门；数量上限 3000→10000；`FlockLab.perf` 分段探针 |
| v31 | 上限 10000→50000；**邻域改固定 7 只拓扑邻居**；二维计数排序网格；颜色查表；`perf` 加 grid/loop/stats/color |
| v32 | 鼠标捕食者玩法（双击化身、右键退出、独立槽位、90ms 冷却） |
| v33 | （工作分支）邻域扫描轮转取样、分离力连续化、密度色阶自适应 |
| v34 | 修「聚成一坨→炸开→再聚」；**尾迹改独立粒子**（删拖尾点）；鼠标捕食者纳入进食冷却 |
| v35 | 尾迹从实体尾部发射（不再盖住三角形）；鸟尾迹改细密颗粒 |
| v36 | 草地容量排队（5s 请走老住客 / 10s 变红强赶 + 12s 保护期）；饱食捕食者避让草地 |
| v37 | 修「鸟会重合」（v34 分离力的 `sl→0` 回归）；引入 `sepStats` |
| v38 | **墙视为不存在**：统一穿墙（无概率/无反射/无贴边急转）；只删矩形边框；上限收回 1 万 |
| v39 | 删位置软修正（瞬移）改回运动方式防重叠（重叠减半）；关草地清争斗态；活动边界铺满屏幕 |
| v41a | 修「草地上的红鸟左右闪」：① 休息间隔改为按「鸟数 / 草地总容量」自适应（原来固定 20–53 秒，800 只时需求是容量的 4 倍，队列从第一秒就清不空）；② 排队 20 秒进不去就认输褪红、隔一大段再来（不再永久红鸟）；③ 到点速度随距离收敛到 0.35（原来下限 1.1，会冲过落点再掉头，渲染朝向跟着 180° 翻）；④ 绕草地的切向力改连续值，停住时不再每帧翻向 |
| v41 | 去掉注意力上限（恢复视野内全邻域）+ `sepCap` 安全阀 + 网格 `视野/1.4`；边缘穿越默认关闭 + 实体墙提前避让；捕食者加速音重做；HUD 传送/爆发/休憩改近 1 秒速率；背景改斜向光带（去闪烁星点）；声音默认开 |
| v40 | 捕食者加速音效 `predDash`（边沿触发 + 400ms/只限流）、草地落地/起飞改轻快双音；动态背景（fbm 星云 + 星点 + 浮尘，`bgMat.uTime` / `dustMat.uTime` 原来没更新）；`wrapEdges` 开关（关=实体墙反弹）；修「不变紫」：色阶改用 `localDen`（原读 `neighbors/24`，被 7 只注意力上限钉死在 0.29）+ 重定 `LOCAL_DEN_K`；修「散成一坨坨」：穿墙不再镜像、质心/半径改最小映像、加弱长程群体归拢；音量滑块移除、固定满刻度 |
| v42 | **PWA**：`manifest.webmanifest` + `sw.js`（壳 SWR / CDN 缓存优先 / 导航网络优先）+ 五张图标（**不自建安装按钮、不拦 `beforeinstallprompt`**，交给浏览器地址栏提示）；**出生涌出动画**：`aGrow` 实例属性（`mix(1, aGrow, uGrow)`，微光→展开过冲→自转→淡入）+ `hatchAt` 错峰 + 重生绿丝 `birthWisp`；**背景地貌层** `js/backdrop.js`（canvas 纹理 + `GAIN` 换算 + 加法混合 + 22% 视差 + 世界坐标避让草地 + 可平铺云层）；删「山坡」横带；新增 `FlockLab.backdrop` / `hatchPending` / `respawn(n)` 调试口；修「捕食者变成一个点」（`predMat` 克隆 arrowMat 却没有 `aGrow`） |

> 完整改动细节见 git 提交信息（`git log --oneline`）与各版本的 README 段落历史。

---

## 9. 想继续做什么

README 的「更多有趣机制与可行性」表里筛过 12 条候选（知情个体、Lévy 飞行、视锥盲区、curl noise、quorum 决策等），都标了依据、可行性与落地代价。挑一条加进去前，先确认**不破坏 §3 的约定**（尤其「绝不直接写 pos」和「防重叠靠提前推开」）。
