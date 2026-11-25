
import { FlockAudio, FlockMusic } from './audio.js';
import { createGrass } from './grass.js';
import { createBackdrop } from './backdrop.js';
import { computeForces, MAX_FORCE } from './forces.js';
import { VERSION, COMMIT, BUILD_TIME, AUTHOR } from './version.js';

const fail = (msg) => {
  const el = document.getElementById('error');
  el.style.display = 'flex';
  el.textContent = msg;
};

// 多 CDN 回退：业务代码仍只有这一个文件。
async function loadModule(urls) {
  let last;
  for (const url of urls) {
    try { return await import(/* @vite-ignore */ url); }
    catch (e) { last = e; }
  }
  throw last;
}

let THREE, GUI;
try {
  THREE = await loadModule([
    'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js',
    'https://unpkg.com/three@0.160.1/build/three.module.js'
  ]);
  const guiMod = await loadModule([
    'https://cdn.jsdelivr.net/npm/lil-gui@0.19.2/dist/lil-gui.esm.js',
    'https://unpkg.com/lil-gui@0.19.2/dist/lil-gui.esm.js'
  ]);
  GUI = guiMod.GUI || guiMod.default;
} catch (e) {
  fail('依赖加载失败，请检查网络后刷新页面。\n' + (e && e.message ? e.message : e));
  throw e;
}

// 触控屏检测：混合设备（有触摸屏但鼠标为主）也算进去
const isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
if (isTouch) document.body.classList.add('touch');

// 所有玻璃卡片标题可点击折叠；默认全部展开。
for (const head of document.querySelectorAll('.card > .card-head')) {
  head.addEventListener('click', () => {
    const card = head.closest('.card');
    card.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
  });
}

// ---------------------------------------------------------------- 参数
// 活动范围固定 40（世界半高），宽度按显示器比例推出 → 场地正好铺满全屏，不再提供滑块。
const BOUND = 40;
// 相机视口比活动范围大 2%（留少量边距，缩放/平移时不至于一下就贴边）。
// 注意 bounds2D() 会引用它，所以必须声明在 bounds2D 之前（否则 TDZ）。
const VIEW2D_MARGIN = 1.02;
// 多核调度状态。定义在文件顶部：setCount / resetBoids 在模块初始化阶段就会 bump
// epoch（TDZ 安全），而这些函数远在调度器代码之前。
const MC = {
  enabled: false,   // 当前是否在用 Worker
  tried: false,     // 是否尝试过创建（只试一次）
  reason: 'idle',   // idle / on / off / no-worker / spawn / worker-error / timeout
  workers: [],
  job: null,        // 在飞的那一帧
  epoch: 0,         // 数组被重置过就 +1，旧结果直接丢弃
  serial: 0,
  lastWall: 0,      // 上一帧 dispatch→收齐的墙钟时间（ms）
  warm: 0,          // 成功跑完的帧数：前几帧要等 worker 首次加载/JIT 编译 forces.js，
                    // 和后面的稳态耗时不是一个量级，超时判定必须给首帧更宽的预算
  minN: 320,        // 小群体并行反而更慢（消息开销 > 计算）
  timeoutMs: 800
};
const MAX_N = 10000;
const MAX_P = 10;              // AI 捕食者上限（GUI 可调范围）
// 鼠标捕食者单独占一个数组槽位（索引 = 当前 AI 捕食者数量），所以要多留一格。
// GUI 的「捕食者数量」仍以 MAX_P 为上限，两者互不挤占。
const MAX_SLOT = MAX_P + 1;
// 鼠标捕食者的捕食冷却：跟 AI 共用「进食冷却」这个参数，只打到 35%（最低 300ms）。
// 人驾驶时划过鸟群还是有手感，但不再是无冷却连吃——一秒钟最多几只，
// 和 AI 猛禽受同一个限制（被吃的个体 1 秒后照常重生，数量自动补回来）。
function mouseFeedMs() {
  return Math.max(300, params.feedCooldown * 1000 * 0.35);
}
// 速度只用于箭头朝向与音效冲击量（位置完全由光标决定，没有速度上限），
// 夹到 60 是为了不让甩鼠标时音效爆表。
const MOUSE_VMAX = 60;
// 注意力：v41 起不再限制邻居数——对齐 / 聚合 / 分离都取视野半径内的**全部**同伴，
// 即最原始的 Boids 涌现规则（v31~v40 的「只注意最近 7 只」已移除，见 step 里邻域扫描）。
// 分段耗时探针（FlockLab.perf 可读）：定位「哪一段吃掉了这一帧」比猜有用。
const perfParts = { grid: 0, force: 0, loop: 0, stats: 0, color: 0 };

// 出厂默认值：只有点击「重新初始化」才会回到这里。
const DEFAULTS = {
  count: 800,
  separation: 2.3,
  alignment: 1.8,
  cohesion: 1.16,
  perception: 7,
  separationRange: 1.9,
  flow: 2.05,
  maxSpeed: 15,
  minSpeed: 0.5,
  arrowSize: 0.25,
  // 捕食者：标准 Reynolds pursuit + 预测逃逸模型
  predatorOn: true,
  predatorCount: 1,
  fleeWeight: 2.45,     // 逃跑力度
  fleeRange: 9.5,       // 危险感知距离
  predict: 0.6,
  chaseWeight: 1.55,    // 追击力度
  predSpeed: 25,
  lockTime: 1.0,
  feedCooldown: 8.0,
  infoCascade: true,
  // 逃逸爆发：白肌式短时冲刺，体力耗尽后必须恢复，不能连续多次爆发
  sprintFactor: 1.7,
  sprintDuration: 1.0,
  sprintRecovery: 3.0,
  // 音量固定为满刻度（1.5 = 面板刻度的上限），不再提供滑块：
  // 仪表盘只保留顶部/右下角那一个声音开关（静音 / 开声），音量本身不给调。
  // master 0.38 只是总线预留的余量，不在这两个值里体现。
  musicLevel: 1.5,
  fxLevel: 1.5,
  // 草地：场里长出 2~3 片草地，鸟会定期降落歇一会儿
  grassOn: true,
  // 屏幕边缘穿越：开=墙不存在（环面平移，飞出对侧回来）；关=墙变实体（反弹）
  wrapEdges: false,
  // 多核加速：把鸟群邻域受力分给几个 Worker 并行算。
  // 关掉就是原来的单线程路径（也是 worker 建不起来时的自动回退目标）。
  multiCore: true,
  // 视野摇晃：模拟「人扛着摄影机」，相机做缓慢的漂移 / 倾斜 / 拉近拉远。
  // 0 = 完全静止（截图对比、演示时用）。只影响相机与鼠标拾取，不参与任何力学。
  viewShake: 1
};
// 运行时参数：先从 localStorage 恢复上次的调整结果，没有存档才用默认值。
const params = { ...DEFAULTS, enabled: false, paused: false };

// 只持久化「用户可调」的参数；enabled / paused 属于会话状态，不写入存档。
// 音量（musicLevel / fxLevel）已经不给用户调了，固定满刻度，所以不进存档：
// 老存档里的 0.4 也就不会被读回来（否则「默认最大」对老用户不生效）。
const PERSIST_KEYS = [
  'count', 'separation', 'alignment', 'cohesion', 'perception', 'separationRange',
  'flow', 'maxSpeed', 'minSpeed', 'arrowSize',
  'predatorOn', 'predatorCount', 'fleeWeight', 'fleeRange', 'predict',
  'chaseWeight', 'predSpeed', 'lockTime', 'feedCooldown', 'infoCascade',
  'sprintFactor', 'sprintDuration', 'sprintRecovery',
  'grassOn', 'wrapEdges', 'multiCore', 'viewShake'
];
// v7：只多了一个「多核加速」开关，默认值一个都没改，所以升级时把 v6 的存档整份搬过来，
// 不让用户调过的参数回到出厂值。
const STORE_KEY = 'flocklab.params.v7';
const STORE_KEY_PREV = 'flocklab.params.v6';
const PARAM_RANGE = {
  count: [10, MAX_N], separation: [0, 4], alignment: [0, 4], cohesion: [0, 4],
  perception: [1, 14], separationRange: [0.2, 6], flow: [0, 4],
  maxSpeed: [2, 18], minSpeed: [0.5, 8], arrowSize: [0.18, 0.9],
  predatorCount: [1, MAX_P], fleeWeight: [0, 6], fleeRange: [3, 24],
  predict: [0, 1.5], chaseWeight: [0, 4], predSpeed: [2, 36],
  lockTime: [0, 5], feedCooldown: [0.3, 60],
  sprintFactor: [1, 2.5], sprintDuration: [0.2, 3], sprintRecovery: [1, 12],
  viewShake: [0, 2.5]
};
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function loadParams() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { saved = null; }
  if (!saved || typeof saved !== 'object') {
    // v6 → v7 迁移：新增的 multiCore 走默认值，其余原样继承。
    try {
      const old = JSON.parse(localStorage.getItem(STORE_KEY_PREV) || 'null');
      if (old && typeof old === 'object') {
        saved = old;
        // 只搬 PERSIST_KEYS 里的键：老版本可能还存着 musicLevel / boundary 这些
        // 现在已经不读的字段，原样搬会一直在存档里躺着，让人以为它们还生效。
        const clean = {};
        for (const key of PERSIST_KEYS) if (old[key] !== undefined) clean[key] = old[key];
        localStorage.setItem(STORE_KEY, JSON.stringify(clean));
      }
    } catch (_) { /* 读不到就算了 */ }
  }
  if (!saved || typeof saved !== 'object') return;
  for (const key of PERSIST_KEYS) {
    const v = saved[key];
    if (v === undefined || v === null) continue;
    const def = DEFAULTS[key];
    if (typeof v !== typeof def) continue;
    if (typeof v === 'number' && !isFinite(v)) continue;
    let next = typeof v === 'number' ? v : !!v;
    const range = PARAM_RANGE[key];
    if (range) next = clampNum(next, range[0], range[1]);
    if (key === 'count' || key === 'predatorCount') next = Math.round(next);
    params[key] = next;
  }
}
loadParams();

let saveTimer = 0;
function saveParamsNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    const out = {};
    for (const key of PERSIST_KEYS) out[key] = params[key];
    localStorage.setItem(STORE_KEY, JSON.stringify(out));
  } catch (_) { /* 隐私模式写不进去时静默忽略 */ }
}
function saveParams() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveParamsNow, 120);
}
// 拖完滑杆立刻关页面 / 切到后台时，120ms 的防抖窗口会把最后一次改动丢掉。
// 这两个事件一定在页面被挂起前跑到，所以在这里强制落盘。
addEventListener('pagehide', saveParamsNow);
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveParamsNow(); });

// 存档里可能存着一个超过当前 MAX_N 的数量（例如旧版本允许更大的上限）：
// 直接拿来用会让所有定长 TypedArray 越界读写（读到 undefined 变成 NaN），
// 所以在这里就夹一次，不让脏存档把仿真带崩。
let activeCount = Math.max(10, Math.min(MAX_N, Math.round(params.count) || 800));
params.count = activeCount;
let activeP = params.predatorCount;

// 高速缓存：位置/速度数组直接作为 GPU 实例属性，CPU 只更新数值，不再算矩阵。
const pos = new Float32Array(MAX_N * 3);
const vel = new Float32Array(MAX_N * 3);
// 渲染用速度：对物理速度做低通滤波，只影响箭头朝向，不改变 Boids 动力学。
const rVel = new Float32Array(MAX_N * 3);
const acc = new Float32Array(MAX_N * 3);
const col = new Float32Array(MAX_N * 3);
const siz = new Float32Array(MAX_N);
const neighbors = new Uint16Array(MAX_N);
// 局部密度（3×3 格的活跃鸟数，归一化到 0~1）：和「注意力只取 7 只」解耦。
// 用邻居数当色阶时分不清「稀疏」和「采样上限已满」，万只以上会整片卡在同一色。
const localDen = new Float32Array(MAX_N);
const fleeDir = new Float32Array(MAX_N * 3);   // 当前帧逃逸力方向
const prevFlee = new Float32Array(MAX_N * 3);  // 上一帧逃逸力，用于信息级联（传播带一帧延迟）
const fleeing = new Uint8Array(MAX_N);
const grassTouch = new Int8Array(MAX_N).fill(-1);   // 本帧压在哪片草地（-1 = 不在）；并行段写、主线程读
const caught = new Uint8Array(MAX_N);           // 1=已被捕食，等待重新出生
const respawnAt = new Float64Array(MAX_N);      // 重新出生的时间戳（ms），0 表示无需等待
const birthAt = new Float64Array(MAX_N);       // 新生时间戳：-Infinity 表示普通个体
birthAt.fill(-Infinity);
// 逃逸体力：1=满，0=耗尽。爆发结束后按 sprintRecovery 秒恢复，未回满不能再爆发。
const stamina = new Float32Array(MAX_N);
stamina.fill(1);
const sprintUntil = new Float64Array(MAX_N);   // 爆发到期时间（ms）
// 反应延迟：看到捕食者不等于立刻爆发。每只鸟有一个「危险感知计时器」，
// 距离越近需要的累积时间越短（贴身约 45ms，感知圈边缘约 260ms，按距离平方过渡），
// 再乘个体反应系数 0.78~1.32。这样爆发是从捕食者身边向外一圈圈亮起来，
// 而不是整群像开关一样同时闪烁。
const alertMs = new Float32Array(MAX_N);       // 当前已累计的危险感知时间（ms）
const reactJit = new Float32Array(MAX_N);      // 个体反应快慢系数
const REACT_NEAR_MS = 45;
const REACT_FAR_MS = 260;

// ---------------------------------------------------------------- 加速尾迹
// 鸟和捕食者共用一套「独立粒子」尾迹（见下方 MAX_TRAILS 定义）：粒子在生成瞬间
// 冻结世界坐标与航向，之后不随实体移动，转弯时自然连成弧，按寿命淡出缩小。
// 这里存的是每只鸟 / 每个捕食者槽位的「发射节流时刻」与「快起慢落包络」——
// 后者把一次加速摊成约半秒的发射窗口，鸟用速度超限驱动、捕食者用加速度驱动，
// 除了「怎么判定在加速」之外，节流、撒点、着色器、淡出全部走同一条路径。
const trailNextAt = new Float64Array(MAX_N);
const birdTrailP = new Float32Array(MAX_N);   // 鸟的加速包络 0~1（与 predTrailP 对称）
// ---------------------------------------------------------------- 草地休息
// 每只鸟有一张「休息预约」：到点就去最近的空地降落 3~6 秒，再起飞。
// 草地有容量，满了就稍后再试，所以不会一千只同时挤进同一片。
const resting = new Uint8Array(MAX_N);
const restPatch = new Int8Array(MAX_N).fill(-1);   // 停在哪片草地（-1 = 没有）
const restUntil = new Float64Array(MAX_N);         // 起身时间
const restDue = new Float64Array(MAX_N);           // 下次想休息的时间
const restTgt = new Float32Array(MAX_N * 2);       // 落点
const restSince = new Float64Array(MAX_N);         // 真正「停稳」的时间（用于「至少 5 秒」）
// settled：只有「已经到了落点并且几乎不动」才算在休息。
// resting 只是「打算去 / 正在往过飞」，不算休息——否则一脱队就被算成休息了。
const settled = new Uint8Array(MAX_N);
const restApproachUntil = new Float64Array(MAX_N);  // 前往草地的截止时间，飞太久就放弃
const restMoves = new Uint8Array(MAX_N);            // 已在草地上换过几次位置（最多 2 次）
const restTries = new Uint8Array(MAX_N);            // 为了找空位而重新选点的次数
const restAng = new Float32Array(MAX_N);            // 站定时保持的朝向 = 落地瞬间的飞行方向（避免朝向跳变）
const restPhase = new Float32Array(MAX_N);          // 个体作息相位 0~1：把出发 / 离场时间天然错开
const restSwapAt = new Float64Array(MAX_N).fill(Infinity);  // 老住客换位的错峰起步时刻
const restFleeAt = new Float64Array(MAX_N).fill(Infinity);  // 受惊后的错峰起飞时刻
// ---- 休息保障 / 争夺地盘 ----
// 草地容量有限（grass.js 的 gp.cap），排不上队的鸟不能被无限期晾着：
//   等待 REST_WAIT_NUDGE 后 → 有权请走「已经休息满 5 秒」的老住客（优先休得最久的）；
//   等待 REST_WAIT_FORCE 后 → 变红（争斗色），强行驱赶，争夺地盘。
// 这样每只鸟都能在规定时间内休息到，不会出现「老实鸟永远进不去」。
const contending = new Uint8Array(MAX_N);                 // 争地盘中：全身泛红
const restWaitFrom = new Float64Array(MAX_N).fill(Infinity);  // 排队开始时刻（进草地即清）
const restEvictAt = new Float64Array(MAX_N).fill(0);          // 被赶走的保护期，防两只鸟无限互赶
let restSessions = 0;   // 累计完成的草地休憩次数（状态卡用）
let flyLandings = 0;   // 「掠过草地顺手落下」的次数（调试用）
let restEvictCount = 0;   // 累计「请走/赶走」次数（验证争夺机制真的在跑）
const overGrass = new Uint8Array(MAX_N);            // 上一帧是否正在草地正上方（用于「掠过」判定）
const REST_SPACING = 1.5;                           // 草地上个体之间要保持的最小距离（≈6 个身位）
// 单次停留上限 60 秒：基础 28~50 秒 + 个体作息相位 0~10 秒。
// 相位让同批落地的鸟不会在同一秒集体起飞（拆分后这两个常量曾漏定义，务必保留）。
const REST_MAX_MIN = 28000, REST_MAX_SPAN = 22000, REST_PHASE_SPAN = 10000;
const REST_WAIT_NUDGE = 5000;      // 排队多久后可以礼貌请走老住客（对方须已休息满 5 秒）
const REST_WAIT_FORCE = 10000;     // 排队多久后变红强行驱赶（不限对方休息时长）
const REST_MIN_EVICT_DWELL = 5000; // 可被「礼貌请走」的最短已休时长
const REST_EVICT_GUARD = 12000;    // 被赶走后的保护期
const REST_CONTENTION_FADE = 2500; // 抢到位子后争斗色再保留 2.5 秒才褪
// 一直挤不进去就「放弃这一轮」：清掉争斗红、把下次休息往后推一大截。
// 否则鸟会在草地边上永远保持红色、每 1~2 秒回来碰一次壁（用户看到的「红鸟一直在闪」）。
const REST_GIVEUP = 20000;
// 休息节奏必须跟「草地总容量」匹配：每只鸟平均 40 秒占一个位子，
// 容量 237 个位子 / 800 只鸟 → 平均每只每 135 秒才轮得上一次。
// 早先固定写死 20~53 秒，等于需求是容量的 4 倍，排队永远清不空（3000 只时 1300 只在排队）。
// 草地总容量。它要等 createGrass() 之后才知道（initBoids 在更早就跑了），
// 所以用一个可写的模块变量，草地建好后写进来再重铺一次休息时刻（见草地那一节）。
let grassCapTotal = 0;
function restIntervalMs() {
  const ratio = activeCount / Math.max(1, grassCapTotal || 1);
  // 55 秒 × 比值：一次停留均值约 44 秒，乘 55 让整体负载落在容量的八成左右
  // （留一点余量，排队才不会越积越长）。上限 15 分钟：数量上万时也允许「很久才轮到一次」。
  return Math.max(20000, Math.min(900000, 55000 * ratio));
}
// 落点微调只用「速度积分走过去」，绝不直接写 pos——那一下就是肉眼可见的瞬移。
// 半径放大到 1.25 仍能保持连续：鸟会花 1~2 秒慢慢走过去，而不是一帧跳过去。
const REST_NUDGE_MIN = 0.45, REST_NUDGE_MAX = 1.25;
// 软错峰：每帧最多放行 2 只鸟「出发去草地」、1 只鸟「站定」。
// 不取消需求也不减少总次数，只把成群的同步动作摊成一条细流。
const REST_START_SOFT_CAP = 2, REST_SETTLE_SOFT_CAP = 1;
// 边界通行判定：靠近墙时先掷一次骰子决定「这次当墙不存在」还是「贴边掉头」。
// 只有掷中的人才真的会穿出去，其余会一直飞到边界旁再拐弯，不提前造软边界。
// 墙视为不存在：越界一律「穿墙」（见下方 wrapThroughWall），不再有贴边判定带、
// 不再有反射/随机散射、也不再按概率触发传送门。
// ---------------------------------------------------------------- 个体差异
// 每只鸟带一点固定的「脾气」：速度系数不同、方向有自己的缓慢随机游走。
// 这是为了破除「整群像弹珠一样整齐移动」的机械感——但都仍是局部量，
// 不改变三条规则，所以群体的涌现结构不受影响，只是多了一层自然抖动。
const spdJit = new Float32Array(MAX_N);   // 个体速度系数 0.86 ~ 1.14
const wAng = new Float32Array(MAX_N);     // 个体游走航向（每帧小幅随机漂移）
const wAmp = new Float32Array(MAX_N);     // 个体游走强度 0.55 ~ 1.65
// 渲染抖动：**只影响画出来的样子，不参与任何受力**（见 render 里「尺寸」与顶点着色器）。
// 密集群里个体被分离力推到等间距、又几乎同向，屏幕上就叠出一层规整栅格；当栅格周期
// 接近像素周期时出现摩尔纹——用户看到的「干涉网格」。三样固定的个体偏差就能打散它：
// 尺寸（点大小不一）、朝向（箭头不同向）、位置（点不严格落在等距格点上）。
// 都是每只鸟出生时抽一次的常数，所以个体身份稳定，飞起来也不会跳。
const rJit = new Float32Array(MAX_N * 4);  // 尺寸系数 / 朝向偏置 / 位置偏移 x,y
// 开关：0 = 退回旧画法（等大等向、密集处偏大），用于现场 A/B 对比摩尔纹。
// 只有调试用，不进存档——它不改变仿真，只影响画法。
let RENDER_JIT = 1;
let aJitDirty = true;
let WANDER_BASE = 1.6;                    // 游走基础力度（调试接口可改，用于对比手感）
function rollTraits(i) {
  spdJit[i] = 0.86 + Math.random() * 0.28;
  wAng[i] = Math.random() * Math.PI * 2;
  wAmp[i] = 0.55 + Math.random() * 1.1;
  reactJit[i] = 0.78 + Math.random() * 0.54;
  rJit[i * 4] = 0.88 + Math.random() * 0.24;
  rJit[i * 4 + 1] = (Math.random() - 0.5) * 0.52;
  // 位置偏移取 ±0.18：密集处实测间距中位数 0.56，偏 30% 足以让行列错开，
  // 又小到单独看仍觉得「一群在齐飞」。
  const ja = Math.random() * Math.PI * 2, jr = 0.06 + Math.random() * 0.12;
  rJit[i * 4 + 2] = Math.cos(ja) * jr;
  rJit[i * 4 + 3] = Math.sin(ja) * jr;
  aJitDirty = true;
  // 作息相位是「性格」的一部分：出生时抽一次，之后每次重排休息/离场时间都带上它，
  // 于是同一波落地的鸟天然分散在不同的时刻出发与起飞。
  restPhase[i] = Math.random();
}

const capNow = new Float32Array(MAX_N);        // 每只鸟当前生效的速度上限（只用于调试采样）
capNow.fill(params.maxSpeed * 0.78);
let sprintCount = 0, sprintingCount = 0;
let cohesion01 = 0;   // 0=散开 1=紧团
let restingCount = 0;  // 当前在草地上休息的数量（HUD/调试用）
// 上一帧的群体半径（RMS），用于相干度与群体尺度
let groupRms = 12;

// 捕食者独立数组，与 boid 数组完全隔离，不影响元素数量语义。
const predPos = new Float32Array(MAX_SLOT * 3);
const predVel = new Float32Array(MAX_SLOT * 3);
const rPredVel = new Float32Array(MAX_SLOT * 3);   // 捕食者渲染速度，同样做低通
const predCol = new Float32Array(MAX_SLOT * 3);
const predSiz = new Float32Array(MAX_SLOT);
const predFeedAt = new Float64Array(MAX_SLOT);    // 饱腹冷却时间戳
const predTarget = new Int16Array(MAX_SLOT);      // 锁定的目标编号，-1 为未锁定
predTarget.fill(-1);
const predLockUntil = new Float64Array(MAX_SLOT); // 锁定到期时间（ms）
const predPulseAt = new Float64Array(MAX_SLOT);   // 扑击瞬间，用于箭头脉冲
predPulseAt.fill(-Infinity);
// 捕食者当前生效的速度上限（追击 / 冷却巡游切换时直接生效）
const predCap = new Float32Array(MAX_SLOT);
predCap.fill(params.predSpeed);
// 冷却期的巡逻：不再用「随机航向 + 碰墙反弹」，而是选一个场地内部的目标点，
// 朝它滑过去，到点或超时再换——这样吃饱后不会一头扎到墙上反复弹。
const predWp = new Float32Array(MAX_SLOT * 2);      // 巡逻目标点（世界坐标）
const predWpUntil = new Float64Array(MAX_SLOT);     // 目标点过期时间
// 捕食者拖尾：由「加速度」驱动——加速度越大，尾巴越长越亮；
// 几乎不加速（匀速直线）时完全不出拖尾，所以它只在扑击、急转时闪现。
const predAccel = new Float32Array(MAX_SLOT);       // 当帧加速度大小（转向力模长）
const predTrailP = new Float32Array(MAX_SLOT);      // 平滑后的加速度强度 0~1
const predTrailAmt = new Float32Array(MAX_SLOT);    // 拖尾强度 0~1（保留给音乐/调试用）
const predTrailNextAt = new Float64Array(MAX_SLOT);  // 下一颗尾迹粒子的生成时刻
const predSoundAt = new Float64Array(MAX_SLOT);      // 加速音效的按只限流时刻
const predHeat = new Float32Array(MAX_SLOT);        // 饥饿度 0~1：决定警戒圈是暗色（饱食）还是亮色（捕食）
let PRED_TRAIL_REF = 45;                         // 加速度达到这个值即视为「全力冲刺」（实测中位数 12、峰值 64）
// 捕食者的个体差异：速度系数 + 追击时持续漂移的摆尾角度，让它不是一条死直线。
const predSpdJit = new Float32Array(MAX_SLOT);
const predWobble = new Float32Array(MAX_SLOT);
const predPrev = new Float32Array(MAX_SLOT * 3);  // 上一帧位置，用于「扫掠」碰撞检测

// ---------------------------------------------------------------- 鼠标捕食者
// 双击画布：光标变成一只完全由人驾驶的捕食者（无速度上限、沿鼠标轨迹走，
// 箭头朝向 = 光标移动方向）；右键恢复成普通箭头。
// 它不跑 AI，位置每帧直接朝光标对应的世界坐标追，所以「快慢」全看手。
let mouseHunter = false;            // 光标是否正在扮演捕食者
let mouseSlot = -1;                 // 它当前占用的槽位（AI 数量或开关变化时会挪）
const mouseTgt = { x: 0, y: 0 };    // 光标对应的世界坐标
let mouseDirX = 1, mouseDirY = 0;   // 最后一次有效移动方向：静止时用它保持箭头朝向
let lastCX = 0, lastCY = 0;         // 最近一次光标屏幕坐标（双击开场时用来定位）

// 本帧参与物理与渲染的 AI 捕食者数量（鼠标捕食者另加 1，见 predCountNow）。
function predBaseCount() { return params.predatorOn ? activeP : 0; }
// 含鼠标捕食者的总数。鼠标永远排在最后一个槽位（= AI 数量），
// 所以所有 `for (p = 0; p < P; p++)` 的循环天然把它一起算进逃逸、捕食与渲染。
function predCountNow() { return predBaseCount() + (mouseHunter ? 1 : 0); }

// 长程归拢（见 step 里「群体归拢」一段）：超出这个半径才开始拉。
// 9 会让群体长期停在 3~5 坨；14 实测稳定在 1~2 大团（偶发 3~4），分离指标不变。
// 通过 FlockLab.flockKeep 可在线改（调参用，不持久化、不上面板）。
// FLOCK_KEEP_R 是「800 只时的半径」，step 里按 sqrt(n/800) 放大后再用。
let FLOCK_KEEP_R = 18, FLOCK_KEEP_F = 14;
// 捕食者外形：锐角等腰三角形。腰长 = 鸟的 1.4 倍、底 = 0.7 倍，再整体 ×2。
// 「鸟的尺寸」指一只元素的实际整体尺寸（实例四边形边长 = 2 × arrowSize）。
const PRED_SCALE = 2;                              // 整体体积倍率
const birdExtent = () => params.arrowSize * 2;
const predLeg = () => birdExtent() * 1.4 * PRED_SCALE;      // 腰长
const predBase = () => birdExtent() * 0.7 * PRED_SCALE;     // 底边长
// 碰撞体积：按三角形外接范围取一个略宽于外形的圆，再加上鸟自身半径。
// 捕食者单帧位移可能超过这个半径，所以判定会用「上一帧 → 当前帧」的线段做扫掠，避免穿模。
const catchRadius = () => predLeg() * 0.45 + predBase() * 0.35 + params.arrowSize * 0.9;
// 点到线段的距离平方：捕食者单帧可能移动好几个身位，用线段代替点判定才不会「穿过」猎物。
function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}
// ---- 穿墙：墙视为不存在 ----
// 越界后从「对侧同高度」继续出现：右边飞出 → 左边界同 y 处进来，速度方向不变。
// 这等价于把场地当成环面（torus）。
// 曾经的写法是「关于中心点对称」（右边飞出 → 左边进、同时 y 取反），看着更"玄"，
// 但它会把穿过边界的一坨鸟在 y 方向复制成两份镜像：已经穿过去的一半在 -y、还没穿的
// 一半在 +y，两半相距 2y 且互不可见 → 每次有鸟群跨边界，整坨就被撕成两半，
// 再也不合并（实测 25 秒内 800 只累计穿墙 1500 次，群体从 1 坨碎成 6~8 坨）。
// 现在只做平移不做镜像，穿过去的那半只是接着往前飞，位置顺序不变，所以鸟群能完整地
// 「穿过去再聚回来」。鸟、AI 捕食者、鼠标捕食者都走这一套——无概率、无弹性反射、
// 无随机散射、也没有贴边急转（那等于把墙挪进场内）。
let wrapX = 0, wrapY = 0;
function wrapThroughWall(x, y, hx, hy) {
  let hit = false;
  if (x > hx) { x -= 2 * hx; hit = true; } else if (x < -hx) { x += 2 * hx; hit = true; }
  if (y > hy) { y -= 2 * hy; hit = true; } else if (y < -hy) { y += 2 * hy; hit = true; }
  if (!hit) return false;
  // 极端 dt（切标签页回来一帧跳很远）时可能一次越界超过一个场宽，夹回场内防死循环
  if (x > hx) x = hx; else if (x < -hx) x = -hx;
  if (y > hy) y = hy; else if (y < -hy) y = -hy;
  wrapX = x; wrapY = y;
  return true;
}

// 反射撞击：面板上关掉「屏幕边缘穿越」时用的实体墙。
// 只夹回边界并反转越界方向的速度分量（保留 92% 速率），
// 不做切向加速、不瞬移——鸟会真的「撞到墙然后弹开」，而不是贴边急转。
let bounceX = false, bounceY = false;
function bounceOffWall(x, y, hx, hy) {
  bounceX = false; bounceY = false;
  if (x > hx) { x = hx; bounceX = true; } else if (x < -hx) { x = -hx; bounceX = true; }
  if (y > hy) { y = hy; bounceY = true; } else if (y < -hy) { y = -hy; bounceY = true; }
  wrapX = x; wrapY = y;
  return bounceX || bounceY;
}
let teleportCount = 0;   // 累计穿墙次数（状态卡「穿越」计数）
const PRED_FORCE = 24;
const PRED_SEP_RANGE2 = 6 * 6;
const PRED_SEP_FORCE = 34;
const BIRTH_TOTAL_MS = 3200;                    // 新生标记总时长：前 1.8s 亮绿，后 1.4s 渐变
const BIRTH_SOLID_MS = 1800;
const BURST_MS = 820;                           // 捕杀动画时长，三段音效与其对齐
const THERMAL_REF = 5.0;                        // 统计用的参考速度，与声音无关

let density = 0, avgSpeed = 0, avgNeighbors = 0;
// Vicsek 有序参量 φ = |Σ(vᵢ/|vᵢ|)| / N：0=各飞各的，1=整群同向，是「涌现」最直观的量化
let orderParam = 0, groupAlert = false;
// 一帧内同时「出发去休息 / 离开草地」的数量与历史峰值，用来验证错峰是否生效
let waveStart = 0, waveEnd = 0, waveStartMax = 0, waveEndMax = 0;
let restStartThisFrame = 0, restSettleThisFrame = 0;
let currentPace = 0;
// 上一帧鱼群质心：用于群体级躲避，让整群像鱼群一样一起绕开捕食者。
let groupX = 0, groupY = 0, groupZ = 0;
// 群体惊吓波纹：捕食者进入范围时整群一起闪避一次，随后恢复群聚，不会永远逃跑。
let groupThreatAt = -Infinity, groupWasThreat = false;
let temperature = 0, pressure = 0, collisionImpulse = 0;
const fxFlash = { sprint: 0, predate: 0, birth: 0 };   // 音效指示灯状态（由音频模块写入）
let predCatches = 0;

// ---------------------------------------------------------------- 出生动画
// 「不凭空出现」：每只鸟有一个 hatchAt（涌出起点），GPU 用 age 算出「由小到大 + 自转 + 淡入」。
// 与 birthAt（新生标记的亮绿色）是两件事：出生动画每次新个体都有，
// 亮绿只用于「被吃掉之后重生」，否则开局 800 只全部闪绿会变成一片绿光。
const HATCH_MS = 700;            // 涌出时长：从一点微光长成你看到的那只鸟
const hatchAt = new Float64Array(MAX_N);
hatchAt.fill(-Infinity);
const growBuf = new Float32Array(MAX_N);   // 0~1 的涌出进度，直接作为 GPU 实例属性
growBuf.fill(1);

function initBoids(from, to, isBirth = false) {
  const bd = bounds2D();
  for (let i = from; i < to; i++) {
    const k = i * 3;
    pos[k] = (Math.random() * 2 - 1) * bd.hx * 0.8;
    pos[k + 1] = (Math.random() * 2 - 1) * bd.hy * 0.8;
    pos[k + 2] = 0;
    const vs = 3 + Math.random() * 4;
    vel[k] = (Math.random() * 2 - 1) * vs;
    vel[k + 1] = (Math.random() * 2 - 1) * vs;
    vel[k + 2] = 0;
    rVel[k] = vel[k]; rVel[k + 1] = vel[k + 1]; rVel[k + 2] = 0;
    birthAt[i] = isBirth ? performance.now() : -Infinity;
    // 出生动画错峰 0~900ms：开局 / 改数量时不是「啪」地一次全亮出来，而是一层层涌出来
    hatchAt[i] = performance.now() + (isBirth ? 0 : Math.random() * 900);
    stamina[i] = 1; sprintUntil[i] = 0; capNow[i] = params.maxSpeed * 0.78;
    alertMs[i] = 0; trailNextAt[i] = 0; birdTrailP[i] = 0;
    resting[i] = 0; settled[i] = 0; restPatch[i] = -1;
    restSwapAt[i] = Infinity; restFleeAt[i] = Infinity;
    contending[i] = 0; restWaitFrom[i] = Infinity; restEvictAt[i] = 0;
    rollTraits(i);
    // 首次「想休息」的时刻按自适应间隔铺开（含个体相位），避免开局一波同时出发
    const gap0 = restIntervalMs();
    restDue[i] = performance.now() + 3000 + Math.random() * gap0 + restPhase[i] * gap0 * 0.3;
    caught[i] = 0; respawnAt[i] = 0; fleeing[i] = 0;
  }
}

// 被捕食的个体在 1 秒后重新出生：在所有候选点里挑离捕食者最远、
// 同时离边界留有余量的位置，避免「刚出生就被吃」。
function spawnFar(i, now) {
  const k = i * 3;
  const bd = bounds2D();
  let bestX = 0, bestY = 0, bestScore = -Infinity;
  const inset = 0.18;   // 离边界至少留 18%
  for (let c = 0; c < 32; c++) {
    const x = (Math.random() * 2 - 1) * bd.hx * (1 - inset);
    const y = (Math.random() * 2 - 1) * bd.hy * (1 - inset);
    let minD2 = Infinity;
    const pn = predCountNow();   // 含鼠标捕食者：别让新鸟直接出生在光标底下
    for (let p = 0; p < pn; p++) {
      const q = p * 3;
      const dx = x - predPos[q], dy = y - predPos[q + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 < minD2) minD2 = d2;
    }
    if (minD2 === Infinity) minD2 = 0;
    const score = minD2 - Math.hypot(x, y) * 0.05;  // 轻微偏好中心
    if (score > bestScore) { bestScore = score; bestX = x; bestY = y; }
  }
  pos[k] = bestX; pos[k + 1] = bestY; pos[k + 2] = 0;
  const dir = Math.random() * Math.PI * 2;
  const vs = params.maxSpeed * (0.6 + Math.random() * 0.2);
  vel[k] = Math.cos(dir) * vs;
  vel[k + 1] = Math.sin(dir) * vs;
  vel[k + 2] = 0;
  rVel[k] = vel[k]; rVel[k + 1] = vel[k + 1]; rVel[k + 2] = 0;
  birthAt[i] = now;
  hatchAt[i] = now;
  birthWisp(bestX, bestY, now);
  stamina[i] = 1; sprintUntil[i] = 0; fleeing[i] = 0; capNow[i] = params.maxSpeed * 0.78;
  alertMs[i] = 0; trailNextAt[i] = 0;
  resting[i] = 0; settled[i] = 0; restPatch[i] = -1;
  restSwapAt[i] = Infinity; restFleeAt[i] = Infinity;
  contending[i] = 0; restWaitFrom[i] = Infinity; restEvictAt[i] = 0;
  rollTraits(i);   // 重生等于换一只新个体：速度脾气、游走相位和作息相位都重新抽
  const gapR = restIntervalMs();
  restDue[i] = now + 4000 + Math.random() * gapR + restPhase[i] * gapR * 0.3;
}

// 重生时原地散出几道极淡的绿丝，配合 GPU 那边的「由小自转涌出」，
// 视觉上就是「从一点光里长出来」，而不是凭空出现。复用尾迹粒子，不额外开一套池子。
// 只在重生时发（每秒最多几只），所以不会把 4800 个环形槽位挤爆。
const WISP_R = 0.49, WISP_G = 1.0, WISP_B = 0.60;
function birthWisp(x, y, now) {
  const n = 5;
  for (let s = 0; s < n; s++) {
    const a = (s / n) * Math.PI * 2 + Math.random() * 0.7;
    const dx = Math.cos(a), dy = Math.sin(a);
    // 从中心往外 0.2 处起笔，长度 0.42：短、淡、朝四周，像被吹散的一小簇光子
    emitTrail(x + dx * 0.2, y + dy * 0.2, dx, dy, now,
      520, 0.42, params.arrowSize * 0.45,
      WISP_R * 0.55, WISP_G * 0.55, WISP_B * 0.55, 0);
  }
}

function initPredators(from, to) {
  const bd = bounds2D();
  for (let p = from; p < to; p++) {
    const k = p * 3;
    predPos[k] = (Math.random() * 2 - 1) * bd.hx * 0.7;
    predPos[k + 1] = (Math.random() * 2 - 1) * bd.hy * 0.7;
    predPos[k + 2] = 0;
    const vs = params.predSpeed * 0.7;
    predVel[k] = (Math.random() * 2 - 1) * vs;
    predVel[k + 1] = (Math.random() * 2 - 1) * vs;
    predVel[k + 2] = 0;
    rPredVel[k] = predVel[k]; rPredVel[k + 1] = predVel[k + 1]; rPredVel[k + 2] = 0;
    predFeedAt[p] = 0;
    predCap[p] = params.predSpeed;
    predWp[p * 2] = 0; predWp[p * 2 + 1] = 0;
    predWpUntil[p] = 0;
    predTrailAmt[p] = 0; predTrailP[p] = 0; predHeat[p] = 1;
    predSpdJit[p] = 0.9 + Math.random() * 0.2;
    predWobble[p] = Math.random() * Math.PI * 2;
  }
}
initPredators(0, activeP);
initBoids(0, activeCount);
const resetBoids = () => {
  // 重置会把所有鸟重生到随机位置：草地上的占位必须一起清掉，
  // 否则 members 里会残留旧索引，之后新鸟复用这些索引就会出现「两只鸟叠在一起」。
  for (const gp of grass) { gp.members.clear(); gp.count = 0; }
  initBoids(0, activeCount);
  initPredators(0, activeP);
  predCatches = 0;
  sprintCount = 0;
  restSessions = 0;
  waveStartMax = 0; waveEndMax = 0;
  caught.fill(0); respawnAt.fill(0);
  predTarget.fill(-1); predLockUntil.fill(0); predPulseAt.fill(-Infinity);
  clearBursts();
};
// 鼠标捕食者永远占「AI 数量」这个槽位：数量或开关一变就要搬一次。
// 直接在光标处重建（不搬旧位置），同时重置扫掠用的上一帧点——
// 否则会从旧槽位的位置拉出一条长线，沿线吃掉一整排鸟。
function syncMouseSlot() {
  if (!mouseHunter) { mouseSlot = -1; return; }
  const slot = predBaseCount();
  if (mouseSlot === slot) return;
  mouseSlot = slot;
  const q = slot * 3;
  predPos[q] = mouseTgt.x; predPos[q + 1] = mouseTgt.y; predPos[q + 2] = 0;
  predVel[q] = 0; predVel[q + 1] = 0; predVel[q + 2] = 0;
  predPrev[q] = predPos[q]; predPrev[q + 1] = predPos[q + 1]; predPrev[q + 2] = 0;
  predTrailAmt[slot] = 0; predTrailP[slot] = 0; predAccel[slot] = 0;
  predSiz[slot] = predLeg();
}

// 统一的「画几只捕食者 + 显示几个警戒圈」同步点。
// 鼠标捕食者永远排在最后一个槽位（索引 = AI 数量），所以 p < P 就把它一起覆盖了。
function syncPredDraw() {
  syncMouseSlot();
  const P = predCountNow();
  if (predGeo) predGeo.instanceCount = P;
  for (let p = 0; p < MAX_SLOT; p++) threatRings[p].visible = p < P;
  predMesh.visible = P > 0;
}
function setPredCount(v) {
  const next = Math.max(1, Math.min(MAX_P, Math.round(v)));
  if (next > activeP) initPredators(activeP, next);
  activeP = next;
  params.predatorCount = next;
  for (let p = next; p < MAX_P; p++) predTarget[p] = -1;
  // 关键：控制绘制数量的是几何体的 instanceCount，不是 Mesh 的。
  // 之前误写 predMesh.instanceCount 导致减少数量后旧捕食者仍被绘制且不更新（定住）。
  // 现在统一走 syncPredDraw()：数量一变，鼠标捕食者的槽位也跟着挪到队尾。
  syncPredDraw();
  document.getElementById('hPred').textContent = params.predatorOn ? next : '0';
  syncCtrl('predatorCount');
}
// 调试接口（FlockLab.setCount 等）绕过 GUI 直接改 params，lil-gui 不会自己重绘，
// 于是面板上显示的还是旧数字。这里按 key 找到控件刷一次显示。
// guiCtrls 定义在后面，但这两个函数的调用都在面板建好之后，运行时安全。
function syncCtrl(key) {
  for (const [k, c] of guiCtrls) if (k === key) { c.updateDisplay(); return; }
}
function setCount(v) {
  MC.epoch++;
  const next = Math.max(10, Math.min(MAX_N, Math.round(v)));
  if (next > activeCount) initBoids(activeCount, next);
  activeCount = next;
  params.count = next;
  arrowGeo.instanceCount = next;
  document.getElementById('hCount').textContent = next;
  syncCtrl('count');
}

// ---------------------------------------------------------------- 场景
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070f);

const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
const camera = orthoCam;
// 视图：平移中心 + 缩放
const view2D = { x: 0, y: 0, zoom: 1, tZoom: 1 };
// 相机视野固定：世界半高＝活动范围，短边正好铺满屏幕；留 2% 边距让边界线可见。
function view2DFitHalfH() { return BOUND * VIEW2D_MARGIN; }

// ---------------------------------------------------------------- 视野摇晃
// 模拟「有人扛着摄影机」：四条低频通道叠在相机上——横向漂移、纵向漂移、
// 绕视线轴倾斜、视锥轻微缩放。每条通道 = 主频 + 次频（振幅约 6:4），频率取
// 无理比、相位互错，所以叠加后不会在十几秒后回到原点，看不出周期。
//
// 两条约束决定了写法：
//  · 幅度按「视口高度的比例」算，不是固定世界单位——放大到 4× 或缩到 0.5× 时，
//    屏幕上的晃动幅度必须一样（halfH 传的就是当前 zoom 下的视口半高）。
//  · 倾斜必须用 rotateZ 叠在 lookAt **之后**。改 camera.up 会被 lookAt 重算掉。
const SHAKE = { t: 0, x: 0, y: 0, roll: 0, zoom: 1 };
const TAU = Math.PI * 2;
function updateViewShake(dt, halfH) {
  const s = params.viewShake;
  if (!(s > 0)) { SHAKE.x = 0; SHAKE.y = 0; SHAKE.roll = 0; SHAKE.zoom = 1; return; }
  SHAKE.t += dt;                        // 暂停时传 0：相位冻结 → 画面定格
  const t = SHAKE.t;
  // 强度 1.0 时：横向 ±1.6% 视口高（约 13px @810 高）、纵向 ±1.0%（约 8px）、
  // 倾斜 ±0.55°、缩放 ±0.9%。周期 5~23 秒，能感到在动又不影响看鸟。
  // 注意 halfH 是视口**半**高，所以「视口高的 1.6%」要写成 0.032 × halfH。
  SHAKE.x = (Math.sin(TAU * 0.055 * t + 1.3) * 0.62 + Math.sin(TAU * 0.130 * t + 4.1) * 0.38) * halfH * 0.032 * s;
  SHAKE.y = (Math.sin(TAU * 0.071 * t + 3.7) * 0.62 + Math.sin(TAU * 0.190 * t + 0.4) * 0.38) * halfH * 0.020 * s;
  SHAKE.roll = (Math.sin(TAU * 0.043 * t + 5.2) * 0.62 + Math.sin(TAU * 0.110 * t + 2.6) * 0.38) * 0.0096 * s;
  SHAKE.zoom = 1 + (Math.sin(TAU * 0.062 * t + 2.2) * 0.62 + Math.sin(TAU * 0.150 * t + 3.3) * 0.38) * 0.009 * s;
}
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, isTouch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('scene').appendChild(renderer.domElement);

// ---------------------------------------------------------------- GPU 计时
// 状态卡上的 GPU 压力要有真实来源：用 EXT_disjoint_timer_query_webgl2 异步测
// 「渲染这一帧显卡花了多久」。一个 query 对象就够——上一帧结果还没就绪时本帧
// 不发新查询，所以是隔一两帧采一次；读取只在 QUERY_RESULT_AVAILABLE 为真时发生，
// 不会像 gl.finish() 那样把管线卡住。
// 浏览器不给这个扩展（Safari / 部分移动端）时 gpuTimer 为 null，HUD 退回
// 「渲染提交耗时」估算，并在数字前加 ~ 标明是估算值。
const gpuTimer = (() => {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return null;
    const q = gl.createQuery();
    if (!q) return null;
    return { gl, ext, q, busy: false, pending: false, ms: 0, ok: false };
  } catch (_) { return null; }
})();
function gpuQueryBegin() {
  if (!gpuTimer || gpuTimer.busy) return;
  gpuTimer.gl.beginQuery(gpuTimer.ext.TIME_ELAPSED_EXT, gpuTimer.q);
  gpuTimer.busy = true;
}
function gpuQueryEnd() {
  if (!gpuTimer || !gpuTimer.busy) return;
  gpuTimer.gl.endQuery(gpuTimer.ext.TIME_ELAPSED_EXT);
  gpuTimer.pending = true;
}
function gpuQueryPoll() {
  if (!gpuTimer || !gpuTimer.pending) return;
  const { gl, ext, q } = gpuTimer;
  // 显卡中途换过频 / 被别的进程抢过，这批计时不可信，直接丢掉重来
  if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
    gpuTimer.busy = false; gpuTimer.pending = false; return;
  }
  if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
    if (ns > 0) { gpuTimer.ms = ns / 1e6; gpuTimer.ok = true; }
    gpuTimer.busy = false; gpuTimer.pending = false;
  }
}

// 正交相机：视口按屏幕宽高比铺满，留少量安全边距；zoom 控制缩放。
let bgMesh = null;   // 背景渐变稍后才创建，先声明避免「用到未定义变量」
let backdrop = null; // 地貌层同理
// zoomOverride：摇晃时的瞬时缩放。不写回 view2D.zoom，否则滚轮状态会被抖动污染；
// 不传就等于基准 zoom，所以 resize / 重置视图这些调用点的行为完全不变。
function updateOrthoFrustum(zoomOverride) {
  const aspect = innerWidth / innerHeight;
  const z = zoomOverride === undefined ? view2D.zoom : zoomOverride;
  const halfH = view2DFitHalfH() / Math.max(0.05, z);
  const halfW = halfH * aspect;
  orthoCam.left = -halfW; orthoCam.right = halfW;
  orthoCam.top = halfH; orthoCam.bottom = -halfH;
  orthoCam.updateProjectionMatrix();
  // 背景渐变挂在与地貌在相机上，尺寸跟着视锥走，永远铺满视口
  if (bgMesh) {
    // 2.10 而不是 2.06：相机倾斜时画面四角会往内收，21:9 上 0.9° 要约 3.4% 余量。
    bgMesh.scale.set(halfW * 2.10, halfH * 2.10, 1);
  }
  if (backdrop) backdrop.setProjection(halfW, halfH);
}
updateOrthoFrustum();

const cv = renderer.domElement;
const pointers = new Map();
let pinchDist = 0, downTime = 0, moved = 0, lastTap = 0;

function resetView2D() {
  view2D.x = 0; view2D.y = 0; view2D.tZoom = 1; view2D.zoom = 1;
  updateOrthoFrustum();
}

cv.addEventListener('pointerdown', (e) => {
  try { cv.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件无真实指针 */ }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    downTime = performance.now(); moved = 0;
  } else if (pointers.size === 2) {
    const p = [...pointers.values()];
    pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }
});

cv.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  prev.x = e.clientX; prev.y = e.clientY;
  moved += Math.abs(dx) + Math.abs(dy);
  if (pointers.size === 1) {
    // 拖拽平移视图（屏幕像素 → 世界坐标）
    const scale = (2 * view2DFitHalfH() / view2D.zoom) / innerHeight;
    view2D.x -= dx * scale;
    view2D.y += dy * scale;
  } else if (pointers.size === 2) {
    const p = [...pointers.values()];
    const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    if (pinchDist > 0 && d > 0) {
      view2D.tZoom = Math.max(0.5, Math.min(4, view2D.tZoom * d / pinchDist));
    }
    pinchDist = d;
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const wasSingle = pointers.size === 1;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchDist = 0;
  if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
  // 触控双击重置视角；鼠标不参与，避免和拖拽冲突
  if (wasSingle && e.pointerType !== 'mouse' && moved < 12 && performance.now() - downTime < 260) {
    const now = performance.now();
    if (now - lastTap < 340) { resetView2D(); lastTap = 0; }
    else lastTap = now;
  }
}
cv.addEventListener('pointerup', endPointer);
cv.addEventListener('pointercancel', endPointer);
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  view2D.tZoom = Math.max(0.5, Math.min(4, view2D.tZoom * Math.exp(-e.deltaY * 0.0012)));
}, { passive: false });

// 视野边界（贴合屏幕宽高比）：活动范围直接等于屏幕可视范围（zoom=1 时），
// 所以个体一直飞到画面边缘才穿墙。原先这里用 BOUND（比相机小 VIEW2D_MARGIN=1.02），
// 去掉矩形框之后就会看到「离屏幕边界还有一点点距离」。
// 它同时是显示范围（正交相机视口）与穿墙的对称轴，个体运动不受它限制。
function bounds2D() {
  const halfH = view2DFitHalfH();
  return { hx: halfH * (innerWidth / innerHeight), hy: halfH };
}

// ---------------------------------------------------------------- 背景
// 氛围层，不参与任何仿真。三层叠起来（全部挂在相机上 / 世界坐标里，缩放平移都跟着走）：
//   ① 星云底：全屏 quad，两层不同尺度、方向的 fbm 噪声缓慢漂移 → 像有一层极淡的云在动
//   ② 星点：同一张 shader 里用高频格子撒稀疏亮点，各自按相位呼吸
//   ③ 尘埃：世界坐标里的点精灵，缓慢漂移 + 呼吸（原来 uTime 从没被更新，所以一动不动）
// 亮度都压在 0.003~0.02（线性空间），转成 sRGB 后是近黑的深蓝，不抢鸟群。
const bgGeo = new THREE.PlaneGeometry(1, 1);
const bgMat = new THREE.ShaderMaterial({
  uniforms: {
    uHalf: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform vec2 uHalf;
    uniform float uTime;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm(vec2 p) {
      float s = 0.0, a = 0.5;
      for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 5.7; a *= 0.5; }
      return s;
    }

    void main() {
      vec2 p = (vUv - 0.5) * 2.0;              // -1~1
      float t = uTime * 0.02;
      float core = smoothstep(1.15, 0.0, length(p * vec2(1.0, 0.85)));
      float warm = smoothstep(1.2, 0.2, length(p - vec2(0.55, 0.45)));

      // 两层云：冷蓝一层、偏紫一层，速度与尺度都不同，叠出来的斑块不是同一个源头
      vec2 q1 = p * 1.55 + vec2(t * 0.55, -t * 0.38);
      float n1 = fbm(q1 + fbm(q1 * 0.8 + t * 0.25) * 0.9);
      vec2 q2 = p * 2.60 + vec2(-t * 0.42, t * 0.61);
      float n2 = fbm(q2 + t * 0.15);
      // 再压一层极慢的「大块呼吸」，让整片底子亮度以 40 秒级周期轻微起伏
      float breathe = 0.86 + 0.14 * sin(uTime * 0.16);

      vec3 base = mix(vec3(0.0026, 0.0038, 0.0070), vec3(0.0050, 0.0076, 0.0126), core);
      vec3 cool = vec3(0.0026, 0.0068, 0.0140);
      vec3 violet = vec3(0.0092, 0.0034, 0.0128);
      float c1 = pow(smoothstep(0.34, 0.96, n1), 1.7) * 0.95;
      float c2 = pow(smoothstep(0.44, 0.96, n2), 2.1) * 0.62;
      vec3 col = base + (cool * c1 + violet * c2) * breathe
               + vec3(0.0034, 0.0021, 0.0013) * warm * 0.85;

      // 极淡的斜向光带：一层沿对角线缓慢漂移的宽条，纯低频、没有任何高频闪烁
      float band = sin((p.x * 0.75 + p.y * 0.55) * 1.6 - uTime * 0.05);
      band = smoothstep(0.55, 1.0, band) * 0.9 + smoothstep(0.75, 1.0, band) * 0.5;
      col += vec3(0.0016, 0.0026, 0.0052) * band * (0.7 + 0.3 * core);

      col *= 0.66 + 0.34 * core;               // 暗角：四周压暗，主体更突出
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }
  `,
  depthWrite: false,
  depthTest: false
});
bgMesh = new THREE.Mesh(bgGeo, bgMat);
bgMesh.frustumCulled = false;
bgMesh.renderOrder = -10;
camera.add(bgMesh);           // 挂在相机上：平移缩放都跟着，永远铺满视口
bgMesh.position.set(0, 0, -60);
scene.add(camera);
scene.background = null;      // 让这层渐变接管背景

// 尘埃：世界坐标里的一小把点，缓慢上浮 + 横向游走 + 呼吸式明暗，越界自然绕回。
// 漂移放在顶点着色器里算（CPU 不动这些点），中断/后台回来也不会跳。
const DUST_N = 380;
const dustPos = new Float32Array(DUST_N * 3);
const dustSeed = new Float32Array(DUST_N);
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3).setUsage(THREE.DynamicDrawUsage));
dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 1));
const dustMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 }, uHalfH: { value: BOUND }, uPR: { value: 1 },
    uHalf: { value: new THREE.Vector2(BOUND, BOUND) }
  },
  vertexShader: `
    attribute float aSeed;
    uniform float uTime;
    uniform float uPR;
    uniform vec2 uHalf;
    varying float vAlpha;
    void main() {
      vec3 p = position;
      // 上浮 + 缓慢横向摆动：每颗有自己的速度与相位，整体像一层极慢的浮尘
      float sp = 0.18 + fract(aSeed * 5.0) * 0.55;
      p.y = mod(p.y + uTime * sp + uHalf.y, uHalf.y * 2.0) - uHalf.y;
      p.x += sin(uTime * (0.05 + fract(aSeed * 9.0) * 0.06) + aSeed * 6.2831)
             * (0.6 + fract(aSeed * 17.0) * 2.2);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      // 每颗尘埃自己呼吸，周期 6~14 秒，明暗只在 0.35~1 之间
      float ph = aSeed * 6.2831;
      float breathe = 0.62 + 0.38 * sin(uTime * (0.45 + fract(aSeed * 7.0) * 0.5) + ph);
      vAlpha = breathe * (0.35 + 0.65 * fract(aSeed * 13.0));
      gl_PointSize = (1.0 + 1.6 * fract(aSeed * 3.0)) * uPR;
    }
  `,
  fragmentShader: `
    varying float vAlpha;
    void main() {
      vec2 q = gl_PointCoord - 0.5;
      float d = length(q);
      float a = smoothstep(0.5, 0.0, d) * vAlpha * 0.14;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vec3(0.55, 0.78, 1.0) * a, a);
      #include <colorspace_fragment>
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: false
});
const dust = new THREE.Points(dustGeo, dustMat);
dust.frustumCulled = false;
dust.renderOrder = -9;
scene.add(dust);
function seedDust() {
  const bd = bounds2D();
  for (let i = 0; i < DUST_N; i++) {
    dustPos[i * 3] = (Math.random() * 2 - 1) * bd.hx * 1.05;
    dustPos[i * 3 + 1] = (Math.random() * 2 - 1) * bd.hy * 1.05;
    dustPos[i * 3 + 2] = 0;
    dustSeed[i] = Math.random();
  }
  dustGeo.attributes.position.needsUpdate = true;
  dustGeo.attributes.aSeed.needsUpdate = true;
  // 漂移范围也跟着场地走：窗口比例变了，浮尘不会全挤到一边
  dustMat.uniforms.uHalf.value.set(bd.hx, bd.hy);
}
seedDust();

// 地貌层（河流 / 草地 / 村庄剪影 + 漂移的云）：挂在相机上，夹在星云和浮尘之间。
// 整层是加法混合，只加亮不遮挡，所以和星云、浮尘之间没有排序问题。
backdrop = createBackdrop(THREE);
backdrop.mesh.position.set(0, 0, -58);
backdrop.mesh.renderOrder = -9.5;
camera.add(backdrop.mesh);
backdrop.setViewport(innerWidth, innerHeight);
updateOrthoFrustum();      // 地貌层建好之后补一次投影，平面尺寸才对得上视口


// 在草地内取一个点：极坐标均匀采样，再按谐波半径筛一遍，保证落在形状里
// 在草地上找一个「和已停的鸟保持间距」的落点。找不到就放宽一次再退回中心。
function pickRestPoint(gp, skipI) {
  const bd = bounds2D();
  const cl = (v, h) => Math.max(-h + 1.2, Math.min(h - 1.2, v));
  // 草地越挤，允许的间距越小；实在放不下就选「最空」的那个点，而不是统统堆到中心
  const minSep = REST_SPACING * (gp.members.size > gp.cap * 0.75 ? 0.85 : 1);
  const ms2 = minSep * minSep;
  let bx = gp.x, by = gp.y, bestScore = -Infinity;
  for (let t = 0; t < 34; t++) {
    const th = Math.random() * Math.PI * 2;
    const rr = gp.R * Math.sqrt(Math.random()) * 0.94;
    const lim = gp.R * (1 + gp.a1 * Math.sin(3 * th + gp.p1) + gp.a2 * Math.sin(5 * th + gp.p2)) * 0.92;
    const x = gp.x + Math.cos(th) * rr, y = gp.y + Math.sin(th) * rr;
    if (rr > lim || Math.abs(x) > bd.hx - 1.2 || Math.abs(y) > bd.hy - 1.2) continue;
    let nearest = Infinity;
    for (const j of gp.members) {
      if (j === skipI || !settled[j]) continue;
      const dx = x - pos[j * 3], dy = y - pos[j * 3 + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 < nearest) nearest = d2;
    }
    if (nearest >= ms2) return [x, y];
    if (nearest > bestScore) { bestScore = nearest; bx = x; by = y; }
  }
  return [bx, by];
}
// 草地很挤时用这个：采样一批候选点，返回「离最近邻居最远」的那个。
// 比一直 first-fit 强，因为饱和时 80% 的随机点都不合格。
function pickRestPointBest(gp, skipI) {
  const bd = bounds2D();
  let bx = gp.x, by = gp.y, best = -1;
  for (let t = 0; t < 26; t++) {
    const th = Math.random() * Math.PI * 2;
    const rr = gp.R * Math.sqrt(Math.random()) * 0.94;
    const lim = gp.R * (1 + gp.a1 * Math.sin(3 * th + gp.p1) + gp.a2 * Math.sin(5 * th + gp.p2)) * 0.92;
    const x = gp.x + Math.cos(th) * rr, y = gp.y + Math.sin(th) * rr;
    if (rr > lim || Math.abs(x) > bd.hx - 1.2 || Math.abs(y) > bd.hy - 1.2) continue;
    let nearest = Infinity;
    for (const j of gp.members) {
      if (j === skipI || !settled[j]) continue;
      const dx = x - pos[j * 3], dy = y - pos[j * 3 + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 < nearest) nearest = d2;
    }
    if (nearest > best) { best = nearest; bx = x; by = y; }
  }
  return [bx, by];
}

// 「挪半步」：只在当前位置周围 0.42~0.78 个单位内找一个离邻居更远的点。
// 存在意义就是不直接写 pos——落点改成这里之后，位移仍由下一帧的速度积分产生，
// 所以肉眼看到的是连续的小步移动，而不是一帧跳到草地另一头。
function nearbyRestPoint(gp, i, px, py) {
  const bd = bounds2D();
  let bx = px, by = py, best = -1;
  for (let t = 0; t < 18; t++) {
    const ang = Math.random() * Math.PI * 2;
    const rad = REST_NUDGE_MIN + Math.random() * (REST_NUDGE_MAX - REST_NUDGE_MIN);
    const x = px + Math.cos(ang) * rad, y = py + Math.sin(ang) * rad;
    if (Math.abs(x) > bd.hx - 1.0 || Math.abs(y) > bd.hy - 1.0) continue;
    let nearest = Infinity;
    for (const j of gp.members) {
      if (j === i || !settled[j]) continue;
      const dx = x - pos[j * 3], dy = y - pos[j * 3 + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 < nearest) nearest = d2;
    }
    if (nearest > best) { best = nearest; bx = x; by = y; }
  }
  return [bx, by];
}

// 从一片草地上请走一位「已经休息够久」的住客，腾出位子给排队的鸟。
// force=false：只请走已休息满 REST_MIN_EVICT_DWELL 的（礼貌，符合「优先赶走
//   已在草地休息满 5 秒的鸟」）；force=true（争地盘）时连刚坐下不久的也请走。
// 挑「休得最久」的那位先让位；被请走的鸟 endRest 会按已休时长重排下次休息，
// 并有 REST_EVICT_GUARD 保护期，避免两只鸟来回互赶。
function evictFromGrass(gp, time, force) {
  let evict = -1, longest = -1;
  for (const j of gp.members) {
    if (!settled[j] || time < restEvictAt[j]) continue;
    const dwell = time - restSince[j];
    if (force) { if (dwell < 1200) continue; }        // 刚落地 1 秒多的别赶，看着太怪
    else if (dwell < REST_MIN_EVICT_DWELL) continue;
    if (dwell > longest) { longest = dwell; evict = j; }
  }
  if (evict < 0) return -1;
  endRest(evict, time, true);
  restEvictAt[evict] = time + REST_EVICT_GUARD;
  restEvictCount++;
  return evict;
}

function startRest(i, time) {
  const k = i * 3;
  let best = -1, bestD2 = Infinity;
  for (let g = 0; g < grass.length; g++) {
    const gp = grass[g];
    if (gp.members.size >= gp.cap) continue;
    const dx = pos[k] - gp.x, dy = pos[k + 1] - gp.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = g; }
  }
  // 都满了：排队等位，先礼后兵（见 evictFromGrass 与 REST_WAIT_* 的说明）。
  // 不再像旧版那样干等 1.8~11 秒重试——那会让老实鸟永远排不上。
  if (best < 0) {
    if (restWaitFrom[i] === Infinity) restWaitFrom[i] = time;
    const waited = time - restWaitFrom[i];
    if (waited > REST_GIVEUP) {
      // 这一轮认输：褪掉争斗红，隔一大段再来（避免永久红鸟 + 每 1~2 秒撞一次门）
      contending[i] = 0;
      restWaitFrom[i] = Infinity;
      const gap0 = restIntervalMs();
      restDue[i] = time + gap0 * (0.5 + Math.random() * 0.8) + restPhase[i] * gap0 * 0.2;
      return;
    }
    if (waited > REST_WAIT_FORCE) contending[i] = 1;   // 变红：争夺地盘
    if (waited >= REST_WAIT_NUDGE) {
      const force = contending[i] === 1;
      for (let g = 0; g < grass.length; g++) {
        if (evictFromGrass(grass[g], time, force) >= 0) { best = g; break; }
      }
    }
    if (best < 0) {
      // 还挤不进去就短间隔再试（抖动避免同批排队的鸟同一秒齐冲）
      restDue[i] = time + 900 + Math.random() * 1600 + restPhase[i] * 800;
      return;
    }
  }
  const gp = grass[best];
  // 软错峰：本帧出发的鸟够多了就顺延 0.25~2 秒，不取消这次休息。
  // 配合个体作息相位，把「一群鸟同时飞去草地」摊成均匀细流。
  if (restStartThisFrame >= REST_START_SOFT_CAP) {
    restDue[i] = time + 250 + Math.random() * 1600 + restPhase[i] * 900;
    return;
  }
  restStartThisFrame++;
  const [tx, ty] = pickRestPoint(gp, i);
  restTgt[i * 2] = tx; restTgt[i * 2 + 1] = ty;
  resting[i] = 1; settled[i] = 0; restPatch[i] = best;
  restMoves[i] = 0; restTries[i] = 0;
  restSwapAt[i] = Infinity; restFleeAt[i] = Infinity;
  restWaitFrom[i] = Infinity;   // 排队结束；争斗色由 restSince 计时自动褪（见 step）
  gp.members.add(i); gp.count = gp.members.size;
  restSince[i] = 0;
  waveStart++;
  // 先给一段赶路时间；真正「开始休息」要等它到点并停稳（见 settled）
  const travel = Math.hypot(tx - pos[k], ty - pos[k + 1]) / Math.max(6, params.maxSpeed * 0.6);
  const approach = travel * 1000 + 15000 + restPhase[i] * 3000;
  restApproachUntil[i] = time + approach;
  restUntil[i] = time + approach;              // 到点后会重设成 28~60 秒
  // 下次出发：按容量的自适应间隔 + 个体相位，绝不与同批鸟同步
  const gap = restIntervalMs();
  restDue[i] = time + gap * (0.75 + Math.random() * 0.5) + restPhase[i] * gap * 0.2;
  // 有新的鸟降落到这片草地：已经休息 5~60 秒的老住客有 10% 概率往旁边挪个位置。
  // 关键改动：只登记一个 0~4 秒内的随机「起身时刻」，不立刻 unsettle、也不改朝向，
  // 于是一批老住客不会在同一帧齐刷刷动起来；到点后也只挪半步（见 nearbyRestPoint）。
  for (const j of gp.members) {
    if (j === i || !settled[j] || restMoves[j] >= 2) continue;
    const dwell = time - restSince[j];
    if (dwell < 5000 || dwell > 60000) continue;
    if (Math.random() >= 0.10) continue;
    if (restSwapAt[j] === Infinity) restSwapAt[j] = time + Math.random() * 4000;
    restMoves[j]++;
  }
}

// 「掠过草地」时顺路落下来：不等到休息时间，10% 概率就地减速停住
function landHere(i, g, time) {
  const gp = grass[g];
  if (gp.members.size >= gp.cap) return false;
  // 掠过落地也走同一份出发配额，避免整群一起掠过草地时同时落下一大片
  if (restStartThisFrame >= REST_START_SOFT_CAP) return false;
  restStartThisFrame++;
  const k = i * 3;
  // 落点优先取当前位置附近（顺势停下），但也要和别人保持间距
  let tx = pos[k], ty = pos[k + 1];
  let ok = true;
  for (const j of gp.members) {
    if (!settled[j]) continue;
    const dx = tx - pos[j * 3], dy = ty - pos[j * 3 + 1];
    if (dx * dx + dy * dy < REST_SPACING * REST_SPACING) { ok = false; break; }
  }
  if (!ok) [tx, ty] = pickRestPointBest(gp, i);
  restTgt[i * 2] = tx; restTgt[i * 2 + 1] = ty;
  resting[i] = 1; settled[i] = 0; restPatch[i] = g;
  restMoves[i] = 0; restTries[i] = 0; restSince[i] = 0;
  restSwapAt[i] = Infinity; restFleeAt[i] = Infinity;
  restWaitFrom[i] = Infinity;
  gp.members.add(i); gp.count = gp.members.size;
  waveStart++;
  restApproachUntil[i] = time + 2500;     // 已经在草地上方，很快就能停稳
  restUntil[i] = time + 2500;
  const gap2 = restIntervalMs();
  restDue[i] = time + gap2 * (0.75 + Math.random() * 0.5) + restPhase[i] * gap2 * 0.2;
  flyLandings++;
  return true;
}
// 结束休息（起飞或被惊到）
// 关掉草地：所有正在休息的立刻起飞（不然它们会定在原地不动），
// 而且**排队 / 争斗态也一并清掉**——否则关了草地还会飘着几只红鸟在
// 「争夺」一块已经不存在的草地（休息逻辑随 grassOn 一起关闭）。
function liftAllResting() {
  const now = performance.now();
  for (let i = 0; i < activeCount; i++) {
    if (resting[i]) endRest(i, now, false);
    contending[i] = 0;
    restWaitFrom[i] = Infinity;
  }
}
function syncGrassVisibility() {
  grassField.setVisible(params.grassOn);
  backdrop.setGrass(params.grassOn ? grass : []);   // 草地关掉时地貌就该露出来
}
function endRest(i, time, scared) {
  if (resting[i]) audio.takeoff();   // 离地
  const wasSettled = settled[i] === 1;
  resting[i] = 0; settled[i] = 0;
  restSwapAt[i] = Infinity; restFleeAt[i] = Infinity;
  contending[i] = 0; restWaitFrom[i] = Infinity;
  const g = restPatch[i];
  if (g >= 0 && grass[g]) { grass[g].members.delete(i); grass[g].count = grass[g].members.size; }
  restPatch[i] = -1;
  waveEnd++;
  // 「必须停留至少 5 秒」：真正停稳过、且被吓走时待够了 5 秒，才算休成；
  // 没停稳（还在赶路）或没待够就被赶走，都当作这次没休成，隔几秒重来。
  // 两种重排都叠加个体作息相位，避免一批同时被惊走的鸟又约好一起回来。
  const dwell = wasSettled ? time - restSince[i] : 0;
  const gap3 = restIntervalMs();
  restDue[i] = (scared && dwell < 5000)
    ? time + 5000 + Math.random() * 9000 + restPhase[i] * 7000
    : time + gap3 * (0.75 + Math.random() * 0.5) + restPhase[i] * gap3 * 0.2;
}

// ---------------------------------------------------------------- 草地
const grassField = createGrass({ THREE, scene, params, bounds2D });
const grass = grassField.patches;
// 重建草地时同步通知背景层：地貌（河 / 村庄 / 草地斑）要绕开草地，不能从草上穿过去。
// 避让判定在着色器里按世界坐标做，所以这里只传一次数据，平移缩放都不用重算。
const buildGrass = () => {
  grassField.build();
  backdrop.setGrass(params.grassOn ? grass : []);
};
backdrop.setGrass(params.grassOn ? grass : []);
// 草地建好 → 拿到真实总容量 → 把开局用临时值铺的休息时刻按真实节奏重铺一遍。
// 不这么做的话，开局那一波会在同一分钟里全冲向草地，队列从第一秒就清不空。
{
  grassCapTotal = 0;
  for (const gp of grass) grassCapTotal += gp.cap;
  const gap = restIntervalMs();
  const t0 = performance.now();
  for (let i = 0; i < activeCount; i++) {
    if (resting[i]) continue;
    restDue[i] = t0 + Math.random() * gap + restPhase[i] * gap * 0.3;
  }
}
const inFieldArea = grassField.inFieldArea;

// ---------------------------------------------------------------- GPU 箭头
// 一个 quad 实例一个箭头；朝向由顶点着色器在视图空间按速度方向旋转，
// 形状用 SDF 在片元着色器里画成 ">" 形，边缘发光。
const arrowGeo = new THREE.InstancedBufferGeometry();
arrowGeo.setAttribute('position', new THREE.Float32BufferAttribute([
  -1, -1, 0,  1, -1, 0,  1, 1, 0,  -1, 1, 0
], 3));
arrowGeo.setAttribute('aLocal', new THREE.Float32BufferAttribute([
  -1, -1,  1, -1,  1, 1,  -1, 1
], 2));
arrowGeo.setIndex([0, 1, 2, 0, 2, 3]);
const aPos = new THREE.InstancedBufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
const aVel = new THREE.InstancedBufferAttribute(rVel, 3).setUsage(THREE.DynamicDrawUsage);
const aCol = new THREE.InstancedBufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
const aSiz = new THREE.InstancedBufferAttribute(siz, 1).setUsage(THREE.DynamicDrawUsage);
// 出生涌出进度 0~1（见上方「出生动画」）：CPU 只写进度，缓动与自转在顶点着色器里算
const aGrow = new THREE.InstancedBufferAttribute(growBuf, 1).setUsage(THREE.DynamicDrawUsage);
// 渲染抖动 vec4（尺寸系数 / 朝向偏置 / 位置偏移 xy），每只鸟固定，见 rollTraits
const aJit = new THREE.InstancedBufferAttribute(rJit, 4).setUsage(THREE.DynamicDrawUsage);
arrowGeo.setAttribute('aPosition', aPos);
arrowGeo.setAttribute('aVelocity', aVel);
arrowGeo.setAttribute('aColor', aCol);
arrowGeo.setAttribute('aSize', aSiz);
arrowGeo.setAttribute('aGrow', aGrow);
arrowGeo.setAttribute('aJit', aJit);
arrowGeo.instanceCount = activeCount;

const arrowMat = new THREE.ShaderMaterial({
  // uGrow：出生涌出总开关。鸟 = 1，捕食者 = 0。
  // 捕食者的材质是 arrowMat.clone()，共用这段顶点着色器；它没有 aGrow 属性，
  // 而缺失的顶点属性在 GLSL 里恒为 0 —— 不关掉的话整只猛禽会被缩成 8% 大小（一个点）。
  uniforms: { uMaxSpeed: { value: params.maxSpeed }, uGrow: { value: 1 }, uJit: { value: 1 } },
  vertexShader: `
    attribute vec2 aLocal;
    attribute vec3 aPosition;
    attribute vec3 aVelocity;
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aGrow;
    attribute vec4 aJit;
    uniform float uMaxSpeed;
    uniform float uGrow;
    uniform float uJit;
    varying vec2 vLocal;
    varying vec3 vColor;
    varying float vSpeed;
    varying float vFade;
    varying float vGrow;
    void main() {
      vLocal = aLocal;
      vColor = aColor;
      vSpeed = clamp(length(aVelocity) / uMaxSpeed, 0.0, 1.0);

      // ---- 出生涌出：一点微光 → 由小到大展开 + 起手快速自转 + 淡入 ----
      // aGrow 从 0 走到 1，走完就是普通个体（此时 sK=1、spin=0、vGrow=1，和老行为完全一致）。
      // 前 16% 只留一个极小的点（gr 压在 0），所以看到的顺序是「先亮一点，再展开」，不是「直接放大」。
      float g = mix(1.0, clamp(aGrow, 0.0, 1.0), uGrow);
      float gr = clamp((g - 0.16) / 0.84, 0.0, 1.0);
      float ease = 1.0 - pow(1.0 - gr, 3.0);                // easeOutCubic：先快后慢
      float pop = 1.0 + 0.30 * sin(3.14159 * min(1.0, gr * 1.7)) * (1.0 - ease * 0.6);
      float sK = (0.08 + 0.92 * ease) * pop;                // 尺寸：8% 长到 100%，带一点过冲
      float spin = (1.0 - ease) * (1.0 - ease) * 2.8;       // 刚冒头时转得快，成形后归零
      vGrow = smoothstep(0.0, 0.30, g);

      vec4 mv = modelViewMatrix * vec4(aPosition, 1.0);
      vec3 vv = (modelViewMatrix * vec4(aVelocity, 0.0)).xyz;
      // 个体的固定偏差：尺寸（点大小不一）、朝向（箭头不同向）、位置（不落在等距格点上）。
      // 三者任一单独做都不够——密集群的点阵感来自「等距 + 等大 + 同向」三者叠加。
      // uJit=0 时退回原样（捕食者没有这个属性，缺失属性恒为 0 会把它缩成 0）。
      vec4 jt = mix(vec4(1.0, 0.0, 0.0, 0.0), aJit, uJit);
      float ang = atan(vv.y, vv.x) + spin + jt.y;
      float cs = cos(ang), sn = sin(ang);
      vec2 lp = aLocal * aSize * sK * jt.x;
      mv.xy += vec2(lp.x * cs - lp.y * sn, lp.x * sn + lp.y * cs) + jt.zw;
      vFade = 1.0 - smoothstep(45.0, 145.0, -mv.z);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    varying vec2 vLocal;
    varying vec3 vColor;
    varying float vSpeed;
    varying float vFade;
    varying float vGrow;
    float sdSegment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h);
    }
    void main() {
      vec2 p = vLocal;
      float d = min(
        sdSegment(p, vec2(0.90, 0.0), vec2(-0.42, 0.86)),
        sdSegment(p, vec2(0.90, 0.0), vec2(-0.42, -0.86))
      );
      float core = 1.0 - smoothstep(0.10, 0.17, d);
      float halo = exp(-d * 3.6) * 0.34;
      float a = clamp(core + halo, 0.0, 1.0) * vFade * vGrow;
      if (a < 0.004) discard;
      vec3 c = vColor * (0.85 + 0.70 * vSpeed) * (core + halo * 0.55);
      // 刚涌出的那一瞬整体偏亮，像是「带着光长出来」，成形后回到正常亮度
      c *= 1.0 + 0.55 * (1.0 - vGrow);
      gl_FragColor = vec4(c, a);
      #include <colorspace_fragment>
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide
});
const arrows = new THREE.Mesh(arrowGeo, arrowMat);
arrows.frustumCulled = false;
scene.add(arrows);

// ---------------------------------------------------------------- 加速尾迹（独立粒子）
// 旧做法是「一条从尾巴点拉到头点的四边形」：尾巴点用指数平滑追身体，本质仍绑在实体上，
// 于是转弯是直线/折线，尾巴一收整条就消失。现在改成真正的尾迹粒子：
// 沿实体**实际走过的航迹**每隔一小段撒一个短条，撒下后位置与朝向就冻结在历史点上，
// 所以转弯会自然弯曲、留下一串彼此独立的痕迹；每个粒子有自己的寿命，靠顶点着色器
// 按 age 收缩+淡出，CPU 每帧不需要再遍历它们（只在新粒子生成时写一个槽）。
// 鸟和捕食者走同一套 emitTrail()，只是寿命/尺寸/颜色不同。
const MAX_TRAILS = 4800;      // 环形槽位，写满就覆盖最旧的（视觉上看不出来）
const trailGeo = new THREE.InstancedBufferGeometry();
// 单位短条：aLocal.x 0=尾 1=头，aLocal.y 横向 ±1
trailGeo.setAttribute('position', new THREE.Float32BufferAttribute([
  0, -1, 0,  1, -1, 0,  1, 1, 0,  0, 1, 0
], 3));
trailGeo.setAttribute('aLocal', new THREE.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
trailGeo.setIndex([0, 1, 2, 0, 2, 3]);

const trPos = new Float32Array(MAX_TRAILS * 2);    // 生成位置（世界坐标，之后不再改变）
const trDir = new Float32Array(MAX_TRAILS * 2);    // 生成瞬间的航向（单位向量）
const trCol = new Float32Array(MAX_TRAILS * 3);
const trBirth = new Float32Array(MAX_TRAILS);      // 生成时刻（ms）
const trLife = new Float32Array(MAX_TRAILS);       // 寿命（ms）
const trLen = new Float32Array(MAX_TRAILS);
const trWid = new Float32Array(MAX_TRAILS);
trBirth.fill(-1e9);                                 // 空槽 → age 极大 → 顶点着色器裁掉
const aTrPos = new THREE.InstancedBufferAttribute(trPos, 2).setUsage(THREE.DynamicDrawUsage);
const aTrDir = new THREE.InstancedBufferAttribute(trDir, 2).setUsage(THREE.DynamicDrawUsage);
const aTrCol = new THREE.InstancedBufferAttribute(trCol, 3).setUsage(THREE.DynamicDrawUsage);
const aTrBirth = new THREE.InstancedBufferAttribute(trBirth, 1).setUsage(THREE.DynamicDrawUsage);
const aTrLife = new THREE.InstancedBufferAttribute(trLife, 1).setUsage(THREE.DynamicDrawUsage);
const aTrLen = new THREE.InstancedBufferAttribute(trLen, 1).setUsage(THREE.DynamicDrawUsage);
const aTrWid = new THREE.InstancedBufferAttribute(trWid, 1).setUsage(THREE.DynamicDrawUsage);
trailGeo.setAttribute('aPos', aTrPos);
trailGeo.setAttribute('aDir', aTrDir);
trailGeo.setAttribute('aColor', aTrCol);
trailGeo.setAttribute('aBirth', aTrBirth);
trailGeo.setAttribute('aLife', aTrLife);
trailGeo.setAttribute('aLen', aTrLen);
trailGeo.setAttribute('aWidth', aTrWid);
trailGeo.instanceCount = MAX_TRAILS;

let trailCursor = 0;
let trailDirty = false;
// 寿命/尺寸：鸟的尾迹是「细密颗粒」——短、窄、淡、撒得密（否则断成一截截的虚线）；
// 捕食者更长更亮（它本来就是画面主角）。
const TRAIL_LIFE_BIRD = 340, TRAIL_LEN_BIRD = 0.30;
const TRAIL_LIFE_PRED = 460, TRAIL_LEN_PRED = 1.25;

// tailOff：从实体尾部（而不是质心）发射的回退距离，按实体各自的「尾部中点」算——
//   鸟       尾角连线中点 = 局部 x = -0.42  →  0.42 × 个体尺寸
//   捕食者   等腰三角形底边中点 = 局部 x = -0.3227486 → 0.3227486 × 腰长
// 粒子是「短条」：aPos 是它的尾端，向航向伸展出 len。所以锚点再沿航向反方向退一个
// len，粒子的亮端就正好贴在尾部底边、整体拖在实体后方——不会从头部冒出来把
// 三角形整个盖住（之前就是这样）。
function emitTrail(x, y, vx, vy, now, life, len, wid, r, g, b, tailOff) {
  const sp = Math.sqrt(vx * vx + vy * vy);
  const i = trailCursor;
  trailCursor = (trailCursor + 1) % MAX_TRAILS;
  let dx, dy;
  if (sp > 1e-4) { dx = vx / sp; dy = vy / sp; } else { dx = 1; dy = 0; }
  const back = len + tailOff;
  trPos[i * 2] = x - dx * back; trPos[i * 2 + 1] = y - dy * back;
  trDir[i * 2] = dx; trDir[i * 2 + 1] = dy;
  trBirth[i] = now; trLife[i] = life; trLen[i] = len; trWid[i] = wid;
  trCol[i * 3] = r; trCol[i * 3 + 1] = g; trCol[i * 3 + 2] = b;
  trailDirty = true;
}

const trailMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  vertexShader: `
    attribute vec2 aLocal;
    attribute vec2 aPos;
    attribute vec2 aDir;
    attribute vec3 aColor;
    attribute float aBirth;
    attribute float aLife;
    attribute float aLen;
    attribute float aWidth;
    uniform float uTime;
    varying float vT;        // 0=尾 1=头
    varying float vAcross;   // 横向 -1~1
    varying vec3 vColor;
    varying float vAlpha;
    varying float vFade;
    void main() {
      float age = (uTime - aBirth) / max(1.0, aLife);
      if (age >= 1.0 || age < 0.0) {           // 已过期 / 空槽：挪到裁剪空间外
        vAlpha = 0.0; vT = 0.0; vAcross = 0.0; vColor = aColor; vFade = 0.0;
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
      }
      float k = 1.0 - age;
      float t = aLocal.x;
      vec2 perp = vec2(-aDir.y, aDir.x);
      // 粒子随时间变短、变窄，尾端比头端细——像被气流吹散的烟痕
      float w = aWidth * pow(k, 0.45) * (0.5 + 0.5 * t);
      vec2 p = aPos + aDir * (aLen * pow(k, 0.7) * t) + perp * (aLocal.y * w);
      vT = t; vAcross = aLocal.y; vColor = aColor;
      vAlpha = pow(k, 1.35);                    // 越老越淡（尾巴留得住但很快化开）
      vec4 mv = modelViewMatrix * vec4(p, 0.0, 1.0);
      vFade = 1.0 - smoothstep(45.0, 145.0, -mv.z);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    varying float vT;
    varying float vAcross;
    varying vec3 vColor;
    varying float vAlpha;
    varying float vFade;
    void main() {
      float core = 1.0 - smoothstep(0.25, 1.0, abs(vAcross));
      float glow = exp(-abs(vAcross) * 2.4) * 0.45;
      float a = (core + glow) * vAlpha * (0.18 + 0.82 * vT) * vFade;
      if (a < 0.004) discard;
      // 加法混合下不要把 a 预乘进 rgb：否则实际亮度是 a²，几乎看不见
      gl_FragColor = vec4(vColor * (0.5 + 0.95 * vT), a);
      #include <colorspace_fragment>
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide
});
const trailMesh = new THREE.Mesh(trailGeo, trailMat);
trailMesh.frustumCulled = false;
scene.add(trailMesh);

// ---------------------------------------------------------------- 捕食者渲染
// 同样是箭头，但用「实心宽箭头」+ 暖橙红色 + 亮边，和猎物的细线「>」一眼分开；
// 尺寸只比猎物大几倍，不再使用夸张的大剪影。
const predGeo = new THREE.InstancedBufferGeometry();
predGeo.setAttribute('position', arrowGeo.getAttribute('position'));
predGeo.setAttribute('aLocal', arrowGeo.getAttribute('aLocal'));
predGeo.setIndex([0, 1, 2, 0, 2, 3]);
const pPos = new THREE.InstancedBufferAttribute(predPos, 3).setUsage(THREE.DynamicDrawUsage);
const pVel = new THREE.InstancedBufferAttribute(rPredVel, 3).setUsage(THREE.DynamicDrawUsage);
const pCol = new THREE.InstancedBufferAttribute(predCol, 3).setUsage(THREE.DynamicDrawUsage);
const pSiz = new THREE.InstancedBufferAttribute(predSiz, 1).setUsage(THREE.DynamicDrawUsage);
predGeo.setAttribute('aPosition', pPos);
predGeo.setAttribute('aVelocity', pVel);
predGeo.setAttribute('aColor', pCol);
predGeo.setAttribute('aSize', pSiz);
predGeo.instanceCount = activeP;
const predMat = arrowMat.clone();
predMat.uniforms.uMaxSpeed.value = params.predSpeed;
// 猛禽没有出生动画：关掉 uGrow，顶点着色器就退回原来的「尺寸 × 1、不旋转、不淡入」。
predMat.uniforms.uGrow.value = 0;
// 同样的道理：predGeo 没有 aJit 属性，缺失属性恒为 0 会把猛禽缩成 0 大小，必须关掉。
predMat.uniforms.uJit.value = 0;
// 锐角等腰三角形：腰长 1、底 0.5（即「腰 1.4 : 底 0.7」的比例），方向即运动方向。
// 顶点 (2h/3, 0)、(-h/3, ±0.25)，h = √(1 - 0.25²) → 重心落在原点。
// 实际尺寸由 predSiz = 腰长 控制，所以只改一处就能整体缩放。
predMat.fragmentShader = `
  varying vec2 vLocal;
  varying vec3 vColor;
  varying float vSpeed;
  varying float vFade;
  float sdTri(vec2 p, vec2 a, vec2 b, vec2 c) {
    vec2 e0 = b - a, e1 = c - b, e2 = a - c;
    vec2 v0 = p - a, v1 = p - b, v2 = p - c;
    vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))),
                 vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
  }
  void main() {
    vec2 p = vLocal;
    float d = sdTri(p, vec2(0.6454972, 0.0), vec2(-0.3227486, 0.25), vec2(-0.3227486, -0.25));
    // 形体很小，边缘留足够的软过渡，避免细尖角出现锯齿
    float fill = 1.0 - smoothstep(0.0, 0.055, d);
    float rim = exp(-abs(d) * 16.0) * 0.5;
    float glow = exp(-max(d, 0.0) * 4.8) * 0.36;
    float a = clamp(fill + glow, 0.0, 1.0) * vFade;
    if (a < 0.004) discard;
    // 体色直接由 vColor 决定（冷却期的浅橙黄 / 狩猎的深橙），
    // 这里只做很轻的速度提亮和一个暖色高光——原来的白色高光会把浅橙黄洗成奶白。
    vec3 c = vColor * (0.94 + 0.22 * vSpeed) * (fill * 0.94 + rim + glow * 0.5);
    float tip = 1.0 - smoothstep(0.04, 0.26, length(p - vec2(0.62, 0.0)));
    c = mix(c, vec3(1.0, 0.74, 0.36), tip * 0.3 * fill);
    gl_FragColor = vec4(c, a);
    #include <colorspace_fragment>
  }
`;
predMat.needsUpdate = true;
let predMesh = new THREE.Mesh(predGeo, predMat);
predMesh.frustumCulled = false;
predMesh.visible = params.predatorOn;
scene.add(predMesh);

// 警戒圈：标示该捕食者的逃逸半径 R（大小仍由「危险感知距离」决定）。
// 圈永远可见，只是分成两态：饱食/冷却 = 稳定可见的暗红圈；捕食阶段 = 高饱和亮红圈。
// 这样既不会「吃饱了圈就消失」，又能在远处一眼读出它现在有没有威胁。
const ringGeo = new THREE.PlaneGeometry(2, 2);   // 局部坐标 -1~1，正好对应半径 1
const threatRings = [];
// 多造一个：最后一格留给鼠标捕食者（索引 = AI 数量）。
for (let p = 0; p < MAX_SLOT; p++) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uPhase: { value: Math.random() * 6.283 }, uHeat: { value: 1 } },
    vertexShader: `
      varying vec2 vLocal;
      void main() {
        vLocal = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vLocal;
      uniform float uAlpha;
      uniform float uHeat;   // 0=刚吃饱 1=饿了
      void main() {
        float r = length(vLocal);
        if (r > 1.08) discard;
        float d = (r - 0.965) * 46.0;          // 到环心的归一化距离
        float band = exp(-d * d);              // 主环：很细
        float inner = exp(-pow((r - 0.965) * 10.0, 2.0)) * 0.30;   // 内侧暗红晕
        float outer = exp(-pow((r - 0.965) * 7.5, 2.0)) * 0.16;    // 外侧更淡
        // 两态配色：饱食是暗红（看得见但不刺眼），饿了是高饱和亮红。
        // alpha 下限由 JS 端抬高，所以 heat=0 时同样是一圈完整可见的暗色环。
        vec3 calm = vec3(0.28, 0.075, 0.065);
        vec3 alert = vec3(0.98, 0.13, 0.05);
        vec3 hot = mix(calm, alert, uHeat);
        vec3 col = mix(vec3(0.02, 0.0, 0.0), hot, clamp(band * 1.1 + inner * 0.7, 0.0, 1.0));
        float a = (band * 0.45 + inner * 0.20 + outer * 0.10) * uAlpha;
        if (a < 0.002) discard;
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide
  });
  const ring = new THREE.Mesh(ringGeo, mat);
  ring.visible = false;
  ring.frustumCulled = false;
  ring.renderOrder = -4;
  threatRings.push(ring);
  scene.add(ring);
  predCol[p * 3] = 0.72; predCol[p * 3 + 1] = 0.15; predCol[p * 3 + 2] = 0.03;
  predSiz[p] = predLeg();
}

// ---------------------------------------------------------------- 鼠标即是捕食者
// 双击画布开启：光标变成一只完全由人驾驶的捕食者，位置沿光标轨迹走、
// 箭头朝向即光标移动方向；右键恢复成普通箭头。
// 期间左键拖拽平移、点按钮、滚轮缩放全部照旧——只把画布上的系统光标藏起来，
// UI 面板上仍是正常指针，所以「变成捕食者期间仍然可以操作」。
// 相机现在会随风摇（SHAKE），反投影必须把「瞬时缩放 / 平移 / 倾斜」一起算进去，
// 否则双击开启的鼠标捕食者会比光标偏十几像素，而且光标不动时看起来在漂。
function screenToWorld(cx, cy) {
  const rect = cv.getBoundingClientRect();
  const halfH = view2DFitHalfH() / Math.max(0.05, view2D.zoom * SHAKE.zoom);
  const scale = (2 * halfH) / Math.max(1, rect.height);
  const dx = (cx - (rect.left + rect.width * 0.5)) * scale;
  const dy = -(cy - (rect.top + rect.height * 0.5)) * scale;
  // 相机绕视线轴转过了 roll，屏幕向量要转回世界方向（乘 R(+roll)）
  const cr = Math.cos(SHAKE.roll), sr = Math.sin(SHAKE.roll);
  return {
    x: view2D.x + SHAKE.x + dx * cr - dy * sr,
    y: view2D.y + SHAKE.y + dx * sr + dy * cr,
  };
}

let toastTimer = 0;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function setMouseHunter(on) {
  if (on === mouseHunter) return;
  mouseHunter = on;
  document.body.classList.toggle('mouse-hunter', on);
  const slot = predBaseCount();
  const q = slot * 3;
  mouseSlot = on ? slot : -1;
  if (on) {
    const w = screenToWorld(lastCX, lastCY);
    // 直接从光标处出现：不要从上一次占用的槽位的旧位置飞过来
    predPos[q] = w.x; predPos[q + 1] = w.y; predPos[q + 2] = 0;
    predVel[q] = 0; predVel[q + 1] = 0; predVel[q + 2] = 0;
    rPredVel[q] = mouseDirX; rPredVel[q + 1] = mouseDirY; rPredVel[q + 2] = 0;
    predPrev[q] = w.x; predPrev[q + 1] = w.y; predPrev[q + 2] = 0;
    predFeedAt[slot] = -Infinity;      // 一上线就能捕食
    predPulseAt[slot] = -Infinity;
    predTrailAmt[slot] = 0; predTrailP[slot] = 0; predHeat[slot] = 1;
    predCol[q] = 0.95; predCol[q + 1] = 0.52; predCol[q + 2] = 0.18;
    predSiz[slot] = predLeg();
    mouseTgt.x = w.x; mouseTgt.y = w.y;
    toast('已化身捕食者 · 右键恢复箭头');
  } else {
    // 从画面里撤掉：p >= P 的槽位渲染时会被隐藏，这里顺手把尺寸清零
    predSiz[slot] = 0;
    toast('已恢复常规箭头');
  }
  syncPredDraw();
}

// 双击画布开启。这里自己判定双击，不监听 dblclick——
// 双击状态卡的标题时，第一次点击就把卡片折叠、卡片因此变矮移位，
// 浏览器仍会把第二次点击补成 dblclick，但事件已经落到下面的画布上，
// 于是「双击状态卡」会误开捕食者。所以要求连续两次「干净点击」都落在画布上。
let tapAt = 0, tapX = 0, tapY = 0, tapMoved = 0, tapDownAt = 0, tapOnCanvas = false;
let tapLastX = 0, tapLastY = 0;
addEventListener('pointerdown', (e) => {
  lastCX = e.clientX; lastCY = e.clientY;
  if (e.pointerType === 'touch') return;          // 触屏不参与，避免和双击缩放冲突
  if (e.button === 2) {                            // 右键：随时退出（capture 阶段，面板上也不漏）
    if (mouseHunter) setMouseHunter(false);
    return;
  }
  if (e.button !== 0) return;
  tapDownAt = performance.now(); tapMoved = 0;
  tapX = e.clientX; tapY = e.clientY;
  tapOnCanvas = e.target === cv;
}, true);
addEventListener('pointermove', (e) => {
  if (!tapDownAt) return;
  tapMoved = Math.max(tapMoved, Math.abs(e.clientX - tapX) + Math.abs(e.clientY - tapY));
}, true);
addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !tapDownAt) return;
  const clean = tapMoved < 8 && performance.now() - tapDownAt < 320;   // 拖拽平移不算点击
  const onCanvas = tapOnCanvas;
  tapDownAt = 0;
  if (!clean || !onCanvas) { tapAt = 0; return; }
  const now = performance.now();
  // 两次点击还得落在近处，避免「点一下这里、马上点一下那里」被当成双击
  const near = Math.abs(e.clientX - tapLastX) + Math.abs(e.clientY - tapLastY) < 24;
  if (now - tapAt < 380 && near) {
    tapAt = 0;
    lastCX = e.clientX; lastCY = e.clientY;
    const w = screenToWorld(e.clientX, e.clientY);
    mouseTgt.x = w.x; mouseTgt.y = w.y;
    setMouseHunter(true);
  } else {
    tapAt = now; tapLastX = e.clientX; tapLastY = e.clientY;
  }
}, true);
// 光标移动：只更新目标点。绑在 window 上，所以移出窗口再回来依然跟着走
//（在 UI 面板上方移动时也照样跟随，捕食者不会卡在半路）。
addEventListener('pointermove', (e) => {
  lastCX = e.clientX; lastCY = e.clientY;
  if (!mouseHunter) return;
  const w = screenToWorld(e.clientX, e.clientY);
  mouseTgt.x = w.x; mouseTgt.y = w.y;
}, { passive: true });

// 捕杀特效三段式：0ms 亮核爆闪 → 90ms 内环扩张 + 火花 → 240ms 外环余波。
// 三段分别对应 predate() 的三段音。
const SPARKS = 10;
const burstInnerGeo = new THREE.RingGeometry(0.88, 1.0, 40);
const burstOuterGeo = new THREE.RingGeometry(0.72, 1.0, 48);
const burstCoreGeo = new THREE.CircleGeometry(1, 32);
const killBursts = [];
for (let b = 0; b < 14; b++) {
  const common = {
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false
  };
  const core = new THREE.Mesh(burstCoreGeo, new THREE.MeshBasicMaterial({ ...common, color: 0xffffff, opacity: 0 }));
  const inner = new THREE.Mesh(burstInnerGeo, new THREE.MeshBasicMaterial({ ...common, color: 0xffd6a0, opacity: 0 }));
  const outer = new THREE.Mesh(burstOuterGeo, new THREE.MeshBasicMaterial({ ...common, color: 0xff7a3d, opacity: 0 }));
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(SPARKS * 3), 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
    color: 0xffdcae, size: 3.6, sizeAttenuation: false,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false
  }));
  for (const o of [core, inner, outer, sparks]) {
    o.visible = false; o.frustumCulled = false; scene.add(o);
  }
  killBursts.push({
    core, inner, outer, sparks,
    dirs: new Float32Array(SPARKS * 2),
    active: false, born: 0, x: 0, y: 0
  });
}
function spawnBurst(x, y, z, now) {
  let slot = killBursts.find((b) => !b.active);
  if (!slot) slot = killBursts.reduce((a, b) => (a.born < b.born ? a : b)); // 池满则复用最老
  slot.active = true; slot.born = now; slot.x = x; slot.y = y;
  for (let s = 0; s < SPARKS; s++) {
    const a = Math.random() * Math.PI * 2;
    slot.dirs[s * 2] = Math.cos(a); slot.dirs[s * 2 + 1] = Math.sin(a);
  }
  for (const o of [slot.core, slot.inner, slot.outer, slot.sparks]) o.visible = true;
}
function clearBursts() {
  for (const b of killBursts) {
    b.active = false;
    for (const o of [b.core, b.inner, b.outer, b.sparks]) o.visible = false;
  }
}

const tmpBirth = new THREE.Color(0x7dff9a);

// 颜色查表：邻域饱和度 32 级 × 速度 16 级。原来每只鸟都调一次 THREE.Color.setHSL
// （内部要做 HSL→RGB 换算），5 万只时单这一趟就要 8ms；预先把 512 种组合算好，
// 运行时只剩两次整数索引 + 三次数组读。
const PAL_Q = 32, PAL_S = 16;
const palFly = new Float32Array(PAL_Q * PAL_S * 3);
const palRest = new Float32Array(PAL_Q * 3);
const sprintPal = new Float32Array(PAL_S * 3);   // 爆发色：亮度随包络变化的 16 档洋红
{
  const c = new THREE.Color();
  for (let q = 0; q < PAL_Q; q++) {
    const local = q / (PAL_Q - 1);
    c.setHSL(0.36 + local * 0.04, 0.52, 0.46);
    palRest[q * 3] = c.r; palRest[q * 3 + 1] = c.g; palRest[q * 3 + 2] = c.b;
    for (let s = 0; s < PAL_S; s++) {
      c.setHSL(0.52 + local * 0.40, 0.95, 0.46 + (s / (PAL_S - 1)) * 0.22);
      const o = (q * PAL_S + s) * 3;
      palFly[o] = c.r; palFly[o + 1] = c.g; palFly[o + 2] = c.b;
    }
  }
  // 爆发色与邻域无关（只跟起爆包络走），单独建一张 16 档表
  for (let s2 = 0; s2 < PAL_S; s2++) {
    c.setHSL(0.918, 0.96, 0.45 + 0.07 * (s2 / (PAL_S - 1)));
    sprintPal[s2 * 3] = c.r; sprintPal[s2 * 3 + 1] = c.g; sprintPal[s2 * 3 + 2] = c.b;
  }
}
const tmpTrail = new THREE.Color(0xff9ad4);    // 拖尾：与爆发同一身份色
const tmpTrailPred = new THREE.Color(0xff8a4c); // 捕食者拖尾：橙红，和本体一致

const audio = new FlockAudio(params, fxFlash);
const music = audio.createMusic();
audio.refreshButton();

// 默认开：页面加载就尝试建立音频上下文。浏览器通常会把自动播放挂起（不算错误），
// 这时只要用户第一次操作（点画布、滚轮、按键）就自动恢复——不用再去点声音按钮。
// 这两个按钮自己会处理手势，跳过以免「刚点开启又被 toggle 静音」。
function unlockAudio(e) {
  const t = e && e.target;
  if (t && t.closest && t.closest('#audioBtn')) return;   // 开关自己处理，别抢它的点击
  if (!audio.enabled) { audio.enable().catch(() => {}); return; }
  if (audio.muted) return;                                // 用户主动静音：不动它
  if (!audio.ctx) return;
  // 浏览器要求「用户手势」才能出声：第一次手势前 ctx 一定是 suspended。
  // 只有真的跑起来了才摘监听——早先无论成功与否都摘，导致第一次点击刚好落在
  // 手势无效的时机（例如滚轮/纯 mousemove 前后）就再也唤不醒，表现就是「刷新后一直没声音」。
  if (audio.ctx.state !== 'running') {
    audio.ctx.resume().catch(() => {});
  }
  if (audio.ctx.state === 'running') {
    audio.connectOutput();
    if (audio.music && !audio.music.running) audio.music.start();
    audio.refreshButton();
    for (const ev of ['pointerdown', 'pointerup', 'click', 'keydown', 'touchstart', 'wheel'])
      removeEventListener(ev, unlockAudio);
  }
}
for (const ev of ['pointerdown', 'pointerup', 'click', 'keydown', 'touchstart', 'wheel']) {
  addEventListener(ev, unlockAudio, { passive: true });
}
audio.enable().catch(() => {});
// 顶部按钮 = 真正的声音总开关：静音时主增益归零，不再弹出引导页。
document.getElementById('audioBtn').addEventListener('click', () => {
  audio.toggle().catch((e) => fail('声音切换失败：' + e.message));
});

// ---------------------------------------------------------------- 场景按钮
// 原来的「场景」折叠面板里的三项都是动作而不是参数，这里提成图标按钮，与右下角图标并列。
const pauseBtn = document.getElementById('pauseBtn');
const pauseIcon = pauseBtn.querySelectorAll('.pauseIcon');
const playIcon = pauseBtn.querySelector('.playIcon');
function syncPauseBtn() {
  const on = params.paused;
  pauseBtn.classList.toggle('on', on);
  for (const el of pauseIcon) el.style.display = on ? 'none' : '';
  playIcon.style.display = on ? '' : 'none';
  const label = on ? '继续模拟' : '暂停模拟';
  pauseBtn.title = label;
  pauseBtn.setAttribute('aria-label', label);
}
pauseBtn.addEventListener('click', () => {
  params.paused = !params.paused;
  syncPauseBtn();
  wake();
});
document.getElementById('resetBtn').addEventListener('click', () => {
  applyDefaults();          // 恢复默认参数 + 重新初始化群体
  wake();
});
document.getElementById('viewBtn').addEventListener('click', () => {
  resetView2D();
  wake();
});
syncPauseBtn();

// ---------------------------------------------------------------- 关于
const about = document.getElementById('about');
const brandBtn = document.getElementById('brand');
function openAbout() {
  about.classList.add('open');
  about.setAttribute('aria-hidden', 'false');
}
function closeAbout() {
  about.classList.remove('open');
  about.setAttribute('aria-hidden', 'true');
}
brandBtn.addEventListener('click', openAbout);
about.addEventListener('click', (e) => { if (e.target === about) closeAbout(); });
about.querySelector('.about-close').addEventListener('click', closeAbout);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAbout(); });

// 演示模式：一次点击隐藏控制台、卡片、提示等所有 UI，只留这个图标用于恢复。
const uiBtn = document.getElementById('uiBtn');
function syncUiBtn() {
  const hidden = document.body.classList.contains('ui-hidden');
  uiBtn.classList.toggle('off', hidden);
  const label = hidden ? '显示所有界面' : '隐藏所有界面';
  uiBtn.title = label;
  uiBtn.setAttribute('aria-label', label);
}
uiBtn.addEventListener('click', () => {
  document.body.classList.toggle('ui-hidden');
  syncUiBtn();
  if (document.body.classList.contains('ui-hidden')) scheduleEyeFade();
  else { clearTimeout(eyeTimer); uiBtn.classList.remove('faded'); }
});
syncUiBtn();

// 进入页面：先完整显示所有界面，1 秒后带淡出动画自动收起——
// 等同于自动替用户点一次「隐藏所有界面」按钮，走的是同一套 ui-hidden 逻辑：
// 收起后任意操作只把小眼睛显现出来（3 秒闲置再淡出），点眼睛才展开完整界面。
// 每次打开 / 刷新都会重演。若这 1 秒里用户已手动隐藏，或「关于」弹窗开着，就不抢动作。
function autoHideUi() {
  if (document.body.classList.contains('ui-hidden')) return;
  if (about.classList.contains('open')) { setTimeout(autoHideUi, 800); return; }
  document.body.classList.add('ui-hidden');
  syncUiBtn();
  scheduleEyeFade();
}
setTimeout(autoHideUi, 1000);

// 闲置自动隐藏：光标 3 秒无操作后消失；演示模式里小眼睛也一样淡出。
// 晃动鼠标、按键、触摸或滚轮都会立刻恢复，并重新计时。
const IDLE_MS = 3000;
let idleTimer = 0, eyeTimer = 0;
function scheduleEyeFade() {
  clearTimeout(eyeTimer);
  if (!document.body.classList.contains('ui-hidden')) return;
  eyeTimer = setTimeout(() => uiBtn.classList.add('faded'), IDLE_MS);
}
function wake() {
  document.body.classList.remove('cursor-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('cursor-idle'), IDLE_MS);
  if (document.body.classList.contains('ui-hidden')) {
    uiBtn.classList.remove('faded');
    scheduleEyeFade();
  }
}
// 任意操作只负责「把眼睛叫醒 + 重置光标闲置计时」，不再直接展开完整界面。
// 展开必须点右下角眼睛按钮（常规逻辑）。
addEventListener('mousemove', wake, { passive: true });
addEventListener('mousedown', wake, { passive: true });
addEventListener('keydown', wake, { passive: true });
addEventListener('wheel', wake, { passive: true });
addEventListener('touchstart', wake, { passive: true });
addEventListener('pointerdown', wake, { passive: true });
wake();

// 状态卡「钉住」：钉住后一键隐藏界面时它仍留在屏幕上（CSS 用 :not(.pinned) 排除）。
// 单独存一个 key，不进参数存档，所以与 v6 参数版本无关；刷新后保持上次选择。
const hudEl = document.getElementById('hud');
const pinBtn = document.getElementById('pinBtn');
const PIN_KEY = 'flocklab.hud.pinned';
let hudPinned = false;
try { hudPinned = localStorage.getItem(PIN_KEY) === '1'; } catch (_) { /* 隐私模式 */ }
function syncPin() {
  hudEl.classList.toggle('pinned', hudPinned);
  pinBtn.classList.toggle('on', hudPinned);
  pinBtn.setAttribute('aria-pressed', String(hudPinned));
  const label = hudPinned
    ? '取消钉住（隐藏界面时状态卡一起隐藏）'
    : '钉住状态卡（隐藏所有界面时仍保留）';
  pinBtn.title = label;
  pinBtn.setAttribute('aria-label', label);
}
pinBtn.addEventListener('click', (e) => {
  e.stopPropagation();   // 与 card-head 是兄弟节点，仍显式阻止冒泡更保险
  hudPinned = !hudPinned;
  try { localStorage.setItem(PIN_KEY, hudPinned ? '1' : '0'); } catch (_) {}
  syncPin();
  wake();
});
syncPin();

// ---------------------------------------------------------------- GUI
// 每行滑块的 title 写清“调大之后会怎样”，避免用户靠猜。
const tip = (ctrl, text) => { ctrl.domElement.setAttribute('title', text); return ctrl; };
const gui = new GUI({ title: 'FlockLab 控制台', width: 300 });
// 控件登记表：恢复默认值后用它把面板显示同步回来。
const guiCtrls = [];
function bindNum(folder, key, min, max, step, label, hint, after) {
  const ctrl = folder.add(params, key, min, max, step).name(label);
  ctrl.onChange((v) => { if (after) after(v); saveParams(); });
  tip(ctrl, hint);
  guiCtrls.push([key, ctrl]);
  return ctrl;
}
function bindBool(folder, key, label, hint, after) {
  const ctrl = folder.add(params, key).name(label);
  ctrl.onChange((v) => { if (after) after(v); saveParams(); });
  tip(ctrl, hint);
  guiCtrls.push([key, ctrl]);
  return ctrl;
}

// 分组按「看什么 → 怎么飞 → 谁吃谁 → 画面与性能」排，最常动的放最上面；
// 默认只展开前两组与捕食者，其余收起——一次全展开会把面板拉到屏幕外。
const fFlock = gui.addFolder('鸟群');
bindNum(fFlock, 'count', 10, MAX_N, 10, '元素数量',
  '元素总数（默认 800，范围 10~10000）｜调多：画面更壮观、群体感更强，但帧率会下降（每只鸟都要算物理、每帧上传实例数据，主线程最吃紧）。每只鸟只注意最近的 7 个同伴，所以配对量是固定的 7×数量，不会因为密度翻倍而爆炸；1 万只时单帧仿真约 6~10ms，绘制仍不到 1ms。调少：更容易看清单只的行为。',
  (v) => setCount(v));
bindNum(fFlock, 'separation', 0, 4, 0.01, '分离力度',
  '分离｜调大：鸟会把贴得太近的同伴用力推开，群体更松散、不重叠。调小：彼此贴得很近甚至挤成一团。');
bindNum(fFlock, 'alignment', 0, 4, 0.01, '对齐力度',
  '对齐｜调大：鸟更倾向和周围同伴同向飞，队伍更整齐。调小：各飞各的，方向散乱。');
bindNum(fFlock, 'cohesion', 0, 4, 0.01, '聚合力度',
  '聚合｜调大：鸟更想靠近同伴中心，容易抱团。调小：群体更分散。');
bindNum(fFlock, 'perception', 1, 14, 0.1, '视野范围',
  '视野半径｜调大：每只鸟能看到更远的同伴，队伍更连贯（计算量也更大）。调小：只看身边几只，队形容易断裂。');
bindNum(fFlock, 'separationRange', 0.2, 6, 0.1, '安全距离',
  '安全距离｜两只鸟比这更近时才开始互躲。调大：队伍稀疏、空隙大。调小：能挤得很紧密。它和“分离力度”不同：这里管多近才躲，分离力度管躲得多用力。');
fFlock.open();

const fFly = gui.addFolder('飞行');
bindNum(fFly, 'maxSpeed', 2, 18, 0.1, '巡航速度',
  '巡航速度｜鸟平时最快能飞多快。调大：整体飞得更快、更容易拉开距离，但转弯会变迟钝。逃逸爆发是在这个速度上再乘倍率。',
  (v) => { arrowMat.uniforms.uMaxSpeed.value = v; });
bindNum(fFly, 'minSpeed', 0.5, 8, 0.1, '最低速度',
  '最低速度｜鸟再慢也不会低于这个值，避免悬停不动。一般不用调。');
bindNum(fFly, 'flow', 0, 4, 0.05, '气流扰动',
  '气流扰动｜调大：鸟更容易被随机气流带偏，运动更自然，但队形更松散。调 0：完全按三规则飞行。');
bindBool(fFly, 'wrapEdges', '屏幕边缘穿越',
  '屏幕边缘穿越｜开启：墙不存在，鸟和猛禽飞出画面后从对侧同一高度飞回来（等价环面，群体能完整地穿过去再聚回来）。关闭：墙变成实体，撞到边缘就弹开（速度损失 8%），捕食者也会被弹回来。');
fFly.close();

const fPred = gui.addFolder('捕食者');
bindBool(fPred, 'predatorOn', '开启捕食者',
  '开启捕食者｜打开后出现橙红色锐角三角形，接触即捕获；鸟会逃逸，危险时会短时爆发加速。',
  (v) => {
    // 关掉 AI 捕食者不影响鼠标捕食者：那是玩家自己，开关只管 AI 那几只。
    syncPredDraw();
    document.getElementById('hPred').textContent = v ? activeP : '0';
    if (v) {
      initPredators(0, activeP); predTarget.fill(-1); predLockUntil.fill(0);
      predCatches = 0; sprintCount = 0; stamina.fill(1); sprintUntil.fill(0);
    }
  });
bindNum(fPred, 'predatorCount', 1, MAX_P, 1, '捕食者数量',
  '捕食者数量｜调多：鸟群压力更大、逃生更混乱。调少（推荐 1 只）：更容易看清追击、爆发和捕杀动画。',
  (v) => setPredCount(v));
bindNum(fPred, 'predSpeed', 2, 36, 0.1, '捕食者速度',
  '捕食者速度｜调大：追得更快、更容易抓到鸟（捕获间隔变短）。调小：鸟更容易逃掉。',
  (v) => { predMat.uniforms.uMaxSpeed.value = v; });
bindNum(fPred, 'chaseWeight', 0, 4, 0.05, '追击力度',
  '追击力度｜调大：捕食者拐弯追得更凶、咬得更紧；太大急转会不自然。');
bindNum(fPred, 'lockTime', 0, 5, 0.1, '锁定目标(秒)',
  '锁定目标｜捕食者专注追同一只鸟的秒数。调大：不容易被鸟群晃动骗到，追击更稳定。');
bindNum(fPred, 'predict', 0, 1.5, 0.05, '预判系数',
  '预判系数｜捕食者追的是鸟的「未来位置」而不是当前位置。调大：更难甩掉；太大像未卜先知。');
bindNum(fPred, 'feedCooldown', 0.3, 60, 0.1, '进食冷却(秒)',
  '进食冷却｜捕食者抓到一只鸟后多久才再次捕猎。冷却期间它会减速随机巡游、不再追击，以保存体力。调大：捕获间隔变长。');
fPred.open();

const fFlee = gui.addFolder('逃逸');
bindNum(fFlee, 'fleeRange', 3, 24, 0.5, '危险感知距离',
  '危险感知距离｜鱼群在多远开始察觉捕食者。调大：整群提前绕开，几乎不会被逼近。调小：捕食者贴脸才逃，容易被抓。注意察觉后还要经过反应延迟（贴身约 45ms、圈边缘约 260ms）才会爆发冲刺。');
bindNum(fFlee, 'fleeWeight', 0, 6, 0.05, '逃跑力度',
  '逃跑力度｜调大：个体和整群都逃得更拼命，鱼群会更整齐地绕开捕食者。太大会盖过群聚，队形散掉。');
bindNum(fFlee, 'sprintFactor', 1, 2.5, 0.05, '爆发速度倍率',
  '爆发倍率｜体力满时短时最高速度 = 巡航速度 × 此值。调大：瞬间甩开捕食者，但爆发结束后更容易被追上。');
bindNum(fFlee, 'sprintDuration', 0.2, 3, 0.1, '爆发持续(秒)',
  '爆发持续时间｜一次逃命冲刺能维持几秒。调长：逃得更远、拖尾更长。调短：更像瞬间闪避。结束后速度回到巡航上限。');
bindNum(fFlee, 'sprintRecovery', 1, 12, 0.5, '体力恢复(秒)',
  '体力恢复时间｜爆发后要几秒才能再次爆发。调大：几乎不能连续爆发，鸟更容易被抓。调小：可以频繁逃生。');
bindBool(fFlee, 'infoCascade', '警报传递',
  '警报传递｜开启后受惊的鸟会把逃跑方向告诉邻居，惊吓像波纹一样扩散。关闭则各逃各的。');
fFlee.close();

const fGrass = gui.addFolder('草地');
bindBool(fGrass, 'grassOn', '长草地（定期降落休息）',
  '草地｜开启后场地里会长出 2~3 片草地（总面积约占屏幕 15%，可以压到边界上）。每只鸟每隔二三十秒必须去一次，挑一片最近、没满的降落，只要没有危险就一直待着（最长 28~60 秒，逐只错开）；被惊到会立刻飞走并重新计时，没待够 5 秒的下次很快会再来。草地上的个体会保持间距、各朝各的方向；有新鸟落下时，已经休息 5~60 秒的老住客有 10% 概率往旁边挪（每只最多挪 2 次）。掠过草地的鸟还有 5%~13%（按个体浮动）概率顺势落下来。不休息的鸟会主动绕开草地。关掉后草地隐藏，正在休息的鸟马上起飞。',
  (v) => { syncGrassVisibility(); if (!v) liftAllResting(); });
fGrass.close();

const fView = gui.addFolder('画面与性能');
bindNum(fView, 'arrowSize', 0.18, 0.9, 0.01, '元素大小',
  '元素大小｜一只鸟的整体尺寸。捕食者的腰长与底边按这个值等比推导（腰长 1.4 倍、底 0.7 倍，再整体 ×2），所以它只影响外观，不影响运动规则。');
bindNum(fView, 'viewShake', 0, 2.5, 0.05, '视野摇晃',
  '视野摇晃｜模拟人扛着摄影机：缓慢左右上下漂移 + 轻微倾斜 + 轻微拉近拉远，只影响画面、不动物理。0 = 完全静止（做前后截图对比时用它）｜调大：更像手持机，但看久了可能有点晕。');
bindBool(fView, 'multiCore', '多核加速',
  '多核加速｜把最耗时的邻域受力计算按个体区间切给几个后台线程并行（本机最多 6 个，长年不变的那部分仍在主线程）。关掉立刻回到单核，可以和打开时对比状态卡上的 CPU 占用与 FPS——鸟越多差距越大。检测不到 Worker 或某次计算超时会自动退回单核，不会卡住。',
  (v) => setMultiCore(v));
fView.close();

// 恢复出厂参数：点右下角「重新初始化」才会走到这里，平时刷新都沿用存档。
function applyDefaults() {
  for (const key of PERSIST_KEYS) params[key] = DEFAULTS[key];
  params.paused = false;
  syncPauseBtn();
  setCount(params.count);
  setPredCount(params.predatorCount);
  syncPredDraw();
  document.getElementById('hPred').textContent = params.predatorOn ? activeP : '0';
  arrowMat.uniforms.uMaxSpeed.value = params.maxSpeed;
  predMat.uniforms.uMaxSpeed.value = params.predSpeed;
  // 音量不给用户调：始终写回出厂满刻度（musicLevel / fxLevel = 1.5）
  syncGrassVisibility();
  liftAllResting();
  music.setLevel(params.musicLevel);
  if (audio.fxBus) audio.fxBus.gain.setTargetAtTime(params.fxLevel, audio.ctx.currentTime, 0.08);
  // multiCore 不是「读 params 就生效」的参数：必须真的建 / 拆 worker 池。
  // 少了这一句，重置后面板显示「开」但实际还在单核跑，要刷新才恢复。
  setMultiCore(params.multiCore);
  for (const [, ctrl] of guiCtrls) ctrl.updateDisplay();
  saveParams();
  resetBoids();
}

// ---------------------------------------------------------------- 空间哈希
// 二维计数排序网格：每帧重建，但不分配任何对象。
// 旧版用 Map<字符串键, 数组>，5 万只时每帧要新建上千个桶数组、写 5 万个字符串键，
// 光是 GC 就能吃掉几毫秒。这里用「计数 → 前缀和 → 回填」三趟纯 TypedArray 操作，
// 一次分配、长期复用，格子内容连续，邻居扫描的缓存命中率也更好。
let gridW = 0, gridH = 0, gridX0 = 0, gridY0 = 0;
let cellStart = new Int32Array(0);
let cellEnd = new Int32Array(0);
let cellFill = new Int32Array(0);
const cellItems = new Int32Array(MAX_N);
// 本帧最近一对个体的间距²（只统计 sepRange 内的）：用来验证「鸟不再叠在一起」。
// 期望值 > 0.02（间距 0.14 以上）；若趋近 0 就是分离力在近距离失效了。
let minPairD2 = Infinity;
// 每只鸟「最近那只」的间距²：仅供 sepStats 统计重叠比例（不参与物理）。
const nearD2A = new Float32Array(MAX_N);
// 每只鸟每帧最多扫多少个格内成员（含被距离检查筛掉的）。按数量分档：
// 每帧总成本 ≈ 扫描量 × 鸟数，5 万只时必须收紧。800 只扫 18 个已经覆盖全部近邻。
let dbgSepCap = 0;   // 调试用：覆盖扫描配额（0 = 用默认分档）
// 每帧每只鸟最多扫多少个候选。它**不是**注意力上限，只是防炸帧的安全阀：
// 视野内全部邻居都要算，配额必须远大于真实邻居数（默认 800 只、密集成团时约 250~350）。
// 数量越大格子里的成员越多，所以按数量分档收紧；真被截断时最先丢的是邻格远端的成员。
function sepCapFor(n) {
  return dbgSepCap || (n > 5000 ? 90 : n > 2000 ? 110 : 130);
}
// 密度归一化基准：3×3 格里的活跃个体数。群体归拢后默认 800 只实测
// p50 ≈ 115 只、p95 ≈ 200 只 / 9 格，取 224（= 160 × 1.4）让 p50 落在 0.5、
// p95 落在 0.9，青蓝→紫整条色阶铺得开（用 70/110 时中位以上全部顶格 1.0）。
const LOCAL_DEN_K = 160;

// ---------------------------------------------------------------- 受力上下文
// 主线程单核模式直接引用真实数组；Worker 模式由 worker 用消息里的副本重建同名字段，
// 两边喂给同一个 computeForces，所以行为只有一份实现。
const forceCtx = {
  pos, vel, acc, localDen, neighbors, nearD2A, fleeDir, fleeing, prevFlee,
  caught, resting, wAng, wAmp, sprintUntil, predPos, predVel,
  cellStart, cellEnd, cellItems, grass, grassTouch,
  n: 0, P: 0, dt: 0, time: 0,
  groupX: 0, groupY: 0, groupThreatAt: 0, hx: 0, hy: 0,
  cell: 5, per2: 49, sep2: 3.61, sepSoft: 0, sepSat: 2.1, denK: 224,
  maxSpeed: 15, maxForce: MAX_FORCE, keepR: 18, keepR2: 324, keepF: 14,
  paceSpeed: 11.7, sprintSpeed: 25.5, fleeR: 9.5, fleeR2: 90.25, sepCap: 130,
  flowT: 0, alignment: 1.8, cohesion: 1.16, separation: 2.3, fleeWeight: 2.45,
  predict: 0.6, infoCascade: true, flow: 2.05, grassOn: true, wrapEdges: false,
  wanderBase: 1.6, gridX0: 0, gridY0: 0, gridW: 1, gridH: 1
};
let lastForceResult = null;   // 单核模式复用；多核模式由 worker 结果覆盖
// 每帧的标量参数：单核模式 Object.assign 到 forceCtx，多核模式原样 postMessage 给 worker。
// 只有一份填表逻辑，Worker 侧不重复计算任何参数。
const forceMeta = {
  n: 0, P: 0, dt: 0, time: 0, groupX: 0, groupY: 0, hx: 0, hy: 0, groupThreatAt: 0,
  cell: 5, per2: 49, sep2: 3.61, sepSoft: 0, sepSat: 2.1, denK: 224,
  maxSpeed: 15, maxForce: 22, keepR: 18, keepR2: 324, keepF: 14,
  paceSpeed: 11.7, sprintSpeed: 25.5, fleeR: 9.5, fleeR2: 90.25, sepCap: 130,
  flowT: 0, alignment: 1.8, cohesion: 1.16, separation: 2.3, fleeWeight: 2.45,
  predict: 0.6, infoCascade: true, flow: 2.05, grassOn: true, wrapEdges: false,
  wanderBase: 1.6, gridX0: 0, gridY0: 0, gridW: 1, gridH: 1, grass: []
};

// ---------------------------------------------------------------- 模拟
function frameBegin(dt, time) {
  const n = activeCount;
  minPairD2 = Infinity;                         // 本帧「最近一对」的间距²（验证不重合）
  // 网格边长取感知半径的 1/1.4：3×3 格覆盖 2.14 倍感知半径，仍然「一定覆盖全部邻居」
  // （鸟在自己格的任意角落都够），但扫描量从 2.9 倍感知面积降到 1.5 倍——
  // 去掉 7 只上限后每只鸟要看视野内全部同伴，这个比值直接决定单帧耗时。
  const cell = params.perception / 1.4;
  const per2 = params.perception * params.perception;
  const sep2 = params.separationRange * params.separationRange;
  // 分离权重恢复 de3717e 的纯 1/d²（不做软化）：贴近时权重按 1/d² 陡增，
  // 拥挤度 crowd 随之趋近 1 → 满力推开。v33 加的 ε 软化把峰值从上百压到 ~20，
  // 反而让「贴身时推不动」成了重叠的根源之一。
  const sepSoft = 0;
  // 分离力软饱和尺度：sl 的量纲是 1/距离，除以安全距离让 crowd 对滑杆不敏感。
  const SEP_SAT = 4.0 / params.separationRange;
  // 密度基准随数量线性放大：格数固定时 3×3 计数 ∝ n，固定 70 在 2500 只就全体
  // 顶格 1.0（用户看到的「不变紫色」）。起步 1.4 让默认 800 只的 p95 也留余量。
  // 归拢半径按 sqrt(n) 放大 → 群体密度近似不随数量变，所以基准也按 sqrt(n) 走；
  // 早先按 n 线性放大是给「铺满全屏」的分布调的，现在会把大数量的色阶压成全蓝。
  const denK = LOCAL_DEN_K * 1.4 * Math.sqrt(Math.max(1, n / 800));
  const maxSpeed = params.maxSpeed;
  const maxForce = MAX_FORCE;
  const B = BOUND;
  const bd = bounds2D();                        // 矩形半宽/半高
  const hx = bd.hx, hy = bd.hy;
  const flowT = time * 0.00022;
  // 本帧参与物理的捕食者数量：AI 捕食者（开关打开时）+ 鼠标捕食者（若有）。
  // 鼠标永远排在队尾（索引 = baseP），所以下面所有 `p < P` 的循环都自动把它算进去，
  // 鸟的逃逸、草地的惊飞、捕获判定都不需要另开分支。
  const baseP = params.predatorOn ? activeP : 0;
  const P = baseP + (mouseHunter ? 1 : 0);
  const fleeR = params.fleeRange;
  const fleeR2 = fleeR * fleeR;
  const predSpeed = params.predSpeed;
  const predNorm = Math.pow(predSpeed, 1.2);
  const sprintSpeed = maxSpeed * params.sprintFactor;
  const catchR2 = Math.pow(catchRadius(), 2);
  const sepCap = sepCapFor(n);   // 只跟数量有关，每帧算一次
  // 长程归拢半径按数量开方放大（800 只时就是 FLOCK_KEEP_R），夹在 12~60：
  // 太小在数量大时会把群体压成实心球，太大就等于没有这条力。
  const keepR = Math.min(60, Math.max(12, FLOCK_KEEP_R * Math.sqrt(n / 800)));
  const keepR2 = keepR * keepR;
  // 群体巡航节奏：无威胁时统一收敛到巡航速度的 78%，受惊/爆发才放开到上限。
  const paceSpeed = maxSpeed * 0.78;
  currentPace = paceSpeed;
  sprintingCount = 0;
  waveStart = 0; waveEnd = 0;   // 本帧「出发 / 离场」计数，用于验证错峰
  restStartThisFrame = 0; restSettleThisFrame = 0;

  // 群体惊吓检测：捕食者接近鱼群质心时触发一次波纹，离开后再进入才重新触发。
  if (P > 0) {
    let near = false;
    for (let p = 0; p < P; p++) {
      const q = p * 3;
      if (Math.sqrt((groupX - predPos[q]) * (groupX - predPos[q]) + (groupY - predPos[q + 1]) * (groupY - predPos[q + 1])) < fleeR * 2.5) {
        near = true; break;
      }
    }
    if (near && !groupWasThreat) groupThreatAt = time;
    groupWasThreat = near;
    groupAlert = near;          // 状态卡「群体警戒」徽标
  } else { groupWasThreat = false; groupAlert = false; }

  const tGrid0 = performance.now();
  // ---- 重建网格：计数 → 前缀和 → 回填 ----
  const gx0 = Math.floor((-bd.hx - 6) / cell);
  const gy0 = Math.floor((-bd.hy - 6) / cell);
  const gw = Math.floor((bd.hx + 6) / cell) - gx0 + 1;
  const gh = Math.floor((bd.hy + 6) / cell) - gy0 + 1;
  const gcells = gw * gh;
  if (gw !== gridW || gh !== gridH) {
    gridW = gw; gridH = gh;
    cellStart = new Int32Array(gcells);
    cellEnd = new Int32Array(gcells);
    cellFill = new Int32Array(gcells);
  }
  gridX0 = gx0; gridY0 = gy0;
  cellStart.fill(0);
  for (let i = 0; i < n; i++) {
    // 等待重生的个体、以及在草地上休息的个体都不参与邻域：
    // 休息的鸟速度接近 0，留着会把飞行中的队伍往草地上拽。
    if (caught[i] || resting[i]) continue;
    const k = i * 3;
    const gx = Math.floor(pos[k] / cell) - gridX0;
    const gy = Math.floor(pos[k + 1] / cell) - gridY0;
    if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
    cellStart[gy * gridW + gx]++;
  }
  let accCells = 0;
  for (let c = 0; c < gcells; c++) {
    const cnt = cellStart[c];
    cellEnd[c] = accCells + cnt;
    cellFill[c] = accCells + cnt;      // 回填指针从后往前推
    cellStart[c] = accCells;
    accCells += cnt;
  }
  for (let i = 0; i < n; i++) {
    if (caught[i] || resting[i]) continue;
    const k = i * 3;
    const gx = Math.floor(pos[k] / cell) - gridX0;
    const gy = Math.floor(pos[k + 1] / cell) - gridY0;
    if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) continue;
    const c = gy * gridW + gx;
    cellItems[--cellFill[c]] = i;
  }
  const tGrid1 = performance.now();
  perfParts.grid = tGrid1 - tGrid0;

  // ---- 捕食者：Reynolds 预测拦截 + 相互分离 + 边界约束 ----
  // 只跑 AI 那几只；鼠标捕食者不跑这套，单独在下面由光标驱动。
  if (baseP > 0) {
    for (let p = 0; p < baseP; p++) {
      const q = p * 3;
      const ppx = predPos[q], ppy = predPos[q + 1], ppz = predPos[q + 2];
      predPrev[q] = ppx; predPrev[q + 1] = ppy; predPrev[q + 2] = 0;
      const pvx = predVel[q], pvy = predVel[q + 1], pvz = predVel[q + 2];
      // 进食冷却：吃饱后不再追击，只以四成左右的速度随机巡游保存体力。
      // 速度上限直接生效（不做加速度积分）；再乘个体速度系数，避免几只捕食者同步前进。
      const cooling = time - predFeedAt[p] < params.feedCooldown * 1000;
      predCap[p] = (cooling ? predSpeed * 0.42 : predSpeed) * predSpdJit[p];
      const curSpeed = Math.max(1.5, predCap[p]);
      // 摆尾：航向做连续随机游走，追击时幅度小（不丢目标）、巡游时幅度大（像在闲逛）。
      predWobble[p] += (Math.random() - 0.5) * 9 * dt;
      const wobbleAmp = cooling ? 3.2 : 2.0;
      const chase = params.chaseWeight;

      let ax = 0, ay = 0, az = 0;
      let best = -1, bestD2 = Infinity;

      if (cooling) {
        // 巡逻：朝场地内部的一个目标点滑行。到点、超时或有人在追（这里没有）
        // 就换新点；新点限制在内缩 38% 的区域里，且离当前位置足够远，
        // 所以它不会贴着墙来回弹，也不会原地打转。
        predTarget[p] = -1;
        let wx = predWp[p * 2], wy = predWp[p * 2 + 1];
        let dwx = wx - ppx, dwy = wy - ppy;
        if (Math.sqrt((dwx) * (dwx) + (dwy) * (dwy)) < 5 || time > predWpUntil[p]) {
          let bx = 0, by = 0;
          for (let tries = 0; tries < 10; tries++) {
            bx = (Math.random() * 2 - 1) * hx * 0.62;
            by = (Math.random() * 2 - 1) * hy * 0.62;
            // 饱食时巡逻点也别落在草地上：路径天然从草地边上绕过去，
            // 配合上面的避让推力，看上去就是「有意识地避开」而不是硬撞后弹开。
            let onGrass = false;
            for (let g = 0; g < grass.length; g++) {
              const gp = grass[g];
              const ddx = bx - gp.x, ddy = by - gp.y;
              const rr = gp.R * 1.15;
              if (ddx * ddx + ddy * ddy < rr * rr) { onGrass = true; break; }
            }
            const dd = Math.sqrt((bx - ppx) * (bx - ppx) + (by - ppy) * (by - ppy));
            if (!onGrass && dd > Math.min(16, hy * 0.6)) break;
          }
          predWp[p * 2] = wx = bx; predWp[p * 2 + 1] = wy = by;
          predWpUntil[p] = time + 6000 + Math.random() * 5000;
          dwx = wx - ppx; dwy = wy - ppy;
        }
        const dwl = Math.sqrt((dwx) * (dwx) + (dwy) * (dwy)) || 1;
        let tx = dwx / dwl * curSpeed - pvx;
        let ty = dwy / dwl * curSpeed - pvy;
        const tl = Math.sqrt((tx) * (tx) + (ty) * (ty));
        const capF = PRED_FORCE * 0.55;
        if (tl > capF) { const k = capF / tl; tx *= k; ty *= k; }
        ax += tx; ay += ty;
      } else {
        // 目标锁定：先沿用旧目标，超出视野或锁定过期才重选最近个体。
        // 每帧改追最近者会让鱼群的「迷惑效应」把捕食者拖死，短期记忆可形成稳定直线追击。
        const vision2 = Math.pow(Math.max(fleeR * 3, B * 1.3), 2);
        best = predTarget[p];
        if (best >= 0 && best < n && !caught[best]) {
          const m = best * 3;
          const dx = pos[m] - ppx, dy = pos[m + 1] - ppy;
          bestD2 = dx * dx + dy * dy;
        }
        if (best < 0 || best >= n || caught[best] || bestD2 > vision2 || time > predLockUntil[p]) {
          best = -1; bestD2 = Infinity;
          for (let j = 0; j < n; j++) {
            if (caught[j]) continue;
            const m = j * 3;
            const dx = pos[m] - ppx, dy = pos[m + 1] - ppy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) { bestD2 = d2; best = j; }
          }
        }
        if (best >= 0) {
          predTarget[p] = best;
          predLockUntil[p] = time + params.lockTime * 1000;   // 有效期间持续续期
        } else {
          predTarget[p] = -1;
        }
      }

      if (!cooling && best >= 0) {
        const m = best * 3;
        const d = Math.sqrt(bestD2);
        const ux = vel[m], uy = vel[m + 1], uz = vel[m + 2];
        const u2 = ux * ux + uy * uy + uz * uz;
        const ru = (pos[m] - ppx) * ux + (pos[m + 1] - ppy) * uy + (pos[m + 2] - ppz) * uz;
        // 解 |r + u·t| = v·t：比 τ=d/v 更准确地预判侧向移动目标。
        const a = curSpeed * curSpeed - u2;
        let tau;
        if (a > 1e-6) {
          tau = (ru + Math.sqrt(Math.max(0, ru * ru + a * bestD2))) / a;
        } else {
          tau = d / Math.max(curSpeed, 1e-6);   // 捕食者不够快时退化为直追
        }
        if (!isFinite(tau) || tau < 0) tau = d / Math.max(curSpeed, 1e-6);
        tau = Math.min(1.2, tau);                 // 限制远距离过度预判
        const aimx = pos[m] + ux * tau;
        const aimy = pos[m + 1] + uy * tau;
        const aimz = pos[m + 2] + uz * tau;
        let tx = aimx - ppx, ty = aimy - ppy, tz = aimz - ppz;
        const tl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
        if (tl > 1e-6) {
          tx = tx / tl * curSpeed - pvx;
          ty = ty / tl * curSpeed - pvy;
          tz = tz / tl * curSpeed - pvz;
          const sl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
          if (sl > PRED_FORCE) { const k = PRED_FORCE / sl; tx *= k; ty *= k; tz *= k; }
          ax += tx * chase; ay += ty * chase; az += tz * chase;
        }
      }

      // 捕食者之间反平方分离，避免叠在一起
      for (let r = 0; r < P; r++) {
        if (r === p) continue;
        const s = r * 3;
        const dx = ppx - predPos[s], dy = ppy - predPos[s + 1], dz = ppz - predPos[s + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 1e-6 && d2 < PRED_SEP_RANGE2) {
          const inv = PRED_SEP_FORCE / Math.max(d2, 0.5);
          ax += dx * inv; ay += dy * inv; az += dz * inv;
        }
      }

      // 摆尾力：垂直于当前速度方向施加，让追击轨迹是轻微的蛇形而不是一条直线
      const vlen = Math.sqrt((pvx) * (pvx) + (pvy) * (pvy)) || 1;
      const weave = Math.cos(predWobble[p]) * wobbleAmp;
      ax += (-pvy / vlen) * weave;
      ay += (pvx / vlen) * weave;

      // 墙不存在：不再有贴边掉头（那等于把墙挪到场内侧）。捕食者与鸟走同一套
      // 穿墙规则——越界后从关于中心对称的位置继续出现，见下面的 wrapThroughWall。
      // 饱食（进食冷却中）的捕食者会刻意避让草地：还没碰到草地边缘时就沿
      // 「离开草地」方向施加一个渐强的推力——不是硬性禁止穿行（真撞上也允许
      // 过去），而是像有意识地绕开正在休息的鸟群。追逐时（不 cooling）不避让，
      // 免得把猎物赶到草地上就追不下去了。
      if (cooling) {
        for (let g = 0; g < grass.length; g++) {
          const gp = grass[g];
          const dx = ppx - gp.x, dy = ppy - gp.y;
          const d2 = dx * dx + dy * dy;
          const edge = gp.R * 1.3 + 2.5;        // 提前量：还没贴上就先让开
          const e2 = edge * edge;
          if (d2 < e2 && d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const s = 1 - d / edge;             // 0~1，越贴边越强（已在内部时 s 更大）
            // 幅度按 s² 陡增：离得远几乎不干预（可以大胆靠近草地），
            // 只在快贴上的最后几米才用力拐开——所以是「有意识地避开」而不是远远躲着走。
            const inv = (9 + 44 * s * s) * s / d;
            ax += dx * inv; ay += dy * inv;
          }
        }
      }
      az = 0;

      // 实体墙时的提前避让（与鸟同一套逻辑，力度小一点：猛禽冲得猛，拐太早追不上猎物）
      if (!params.wrapEdges) {
        const m = 8;
        if (ppx > hx - m) { const k = (ppx - (hx - m)) / m; ax -= k * k * 18; }
        else if (ppx < -hx + m) { const k = ((-hx + m) - ppx) / m; ax += k * k * 18; }
        if (ppy > hy - m) { const k = (ppy - (hy - m)) / m; ay -= k * k * 18; }
        else if (ppy < -hy + m) { const k = ((-hy + m) - ppy) / m; ay += k * k * 18; }
      }

      // 记下这一帧施加的加速度模长：拖尾的长度与显隐都由它决定。
      predAccel[p] = Math.sqrt((ax) * (ax) + (ay) * (ay));

      let nvx = pvx + ax * dt, nvy = pvy + ay * dt;
      let sp = Math.sqrt((nvx) * (nvx) + (nvy) * (nvy));
      if (sp > curSpeed) { const k = curSpeed / sp; nvx *= k; nvy *= k; }
      else if (sp < curSpeed * 0.35 && sp > 1e-6) {
        const want = curSpeed * 0.35;
        const k = want / sp; nvx *= k; nvy *= k;
      }
      predVel[q] = nvx; predVel[q + 1] = nvy; predVel[q + 2] = 0;
      predPos[q] = ppx + nvx * dt;
      predPos[q + 1] = ppy + nvy * dt;
      predPos[q + 2] = 0;
      // 边界：与鸟完全相同的规则。开穿越 → 对侧同高度继续飞（速度方向不变）；
      // 关穿越 → 撞到实体墙，越界方向的速度分量反转（保留 92%）。
      if (params.wrapEdges) {
        if (wrapThroughWall(predPos[q], predPos[q + 1], hx, hy)) {
          predPos[q] = wrapX; predPos[q + 1] = wrapY;
          predVel[q] = nvx; predVel[q + 1] = nvy;
          teleportCount++;
          // 尾迹粒子留在旧位置（历史航迹），但发射包络要清零，免得落点凭空接一段
          predTrailP[p] = 0; predTrailNextAt[p] = 0;
        }
      } else if (bounceOffWall(predPos[q], predPos[q + 1], hx, hy)) {
        predPos[q] = wrapX; predPos[q + 1] = wrapY;
        if (bounceX) { nvx = -nvx * 0.92; predVel[q] = nvx; }
        if (bounceY) { nvy = -nvy * 0.92; predVel[q + 1] = nvy; }
      }
    }
  }

  // ---- 鼠标捕食者：位置由光标决定，没有速度上限 ----
  // 这里不做任何「AI 决策」：它朝光标对应的世界坐标做指数追赶（约 45ms 时间常数，
  // 跟手但不会因为一次甩动而瞬移），位置本身的快慢完全取决于手速。
  if (mouseHunter) {
    syncMouseSlot();               // 槽位可能在暂停期间被改过（改数量 / 开关 AI）
    const slot = baseP;
    const q = slot * 3;
    const px = predPos[q], py = predPos[q + 1];
    predPrev[q] = px; predPrev[q + 1] = py; predPrev[q + 2] = 0;
    const follow = 1 - Math.exp(-dt / 0.045);
    // 光标拖到窗口外：开穿越时目标落到对侧（一路飞过去穿墙），关穿越时目标夹在墙内。
    let tgx = mouseTgt.x, tgy = mouseTgt.y;
    if (params.wrapEdges) {
      if (wrapThroughWall(tgx, tgy, hx, hy)) { tgx = wrapX; tgy = wrapY; }
    } else {
      tgx = tgx > hx ? hx : (tgx < -hx ? -hx : tgx);
      tgy = tgy > hy ? hy : (tgy < -hy ? -hy : tgy);
    }
    let nx = px + (tgx - px) * follow;
    let ny = py + (tgy - py) * follow;
    // 边界规则与 AI 捕食者、鸟完全一致
    if (params.wrapEdges) {
      if (wrapThroughWall(nx, ny, hx, hy)) {
        nx = wrapX; ny = wrapY;
        teleportCount++;
        predTrailP[slot] = 0; predTrailNextAt[slot] = 0;
      }
    } else if (bounceOffWall(nx, ny, hx, hy)) {
      nx = wrapX; ny = wrapY;
    }
    // 单帧跨得太远（切标签页回来、缩放/平移后光标位置突变）就不做扫掠：
    // 否则判定会用「上一帧 → 这一帧」这条长线，沿途吃掉一整排鸟。
    if ((nx - px) * (nx - px) + (ny - py) * (ny - py) > 36) {
      predPrev[q] = nx; predPrev[q + 1] = ny;
    }
    let vx = (nx - px) / Math.max(dt, 1e-4);
    let vy = (ny - py) / Math.max(dt, 1e-4);
    let sp = Math.sqrt(vx * vx + vy * vy);
    if (sp > MOUSE_VMAX) { const k = MOUSE_VMAX / sp; vx *= k; vy *= k; sp = MOUSE_VMAX; }
    if (sp > 1.5) { mouseDirX = vx / sp; mouseDirY = vy / sp; }
    else {
      // 停住时保留最后一次移动方向并给一个极小的速度：箭头不会突然转回 0°，
      // 速度还参与音效冲击量，所以不能是 0。
      vx = mouseDirX * 0.7; vy = mouseDirY * 0.7; sp = 0.7;
    }
    predVel[q] = vx; predVel[q + 1] = vy; predVel[q + 2] = 0;
    predPos[q] = nx; predPos[q + 1] = ny; predPos[q + 2] = 0;
    // 拖尾：复用捕食者的「加速度」通道——手划得越快尾巴越长，停住就消失。
    predAccel[slot] += (sp * 0.55 - predAccel[slot]) * (1 - Math.exp(-dt / 0.08));
  } else {
    mouseSlot = -1;
  }

  // 前半段的成果交给后半段（积分 + 统计）与多核调度器。
  return { n, P, baseP, hx, hy, fleeR, fleeR2, maxSpeed, minSpeed: params.minSpeed,
           paceSpeed, sprintSpeed, catchR2, predSpeed, predNorm, tGrid1, accCells };
}

// ---------------------------------------------------------------- 休息（串行）
// 休息中的鸟不参与邻域，只朝落点漂过去、站稳、被惊飞、到点起身。
// 这一段会改草地成员集合与「每帧出发配额」，所以只能在主线程串行跑。
function updateResting(dt, time) {
  const n = activeCount;
  const baseP = params.predatorOn ? activeP : 0;
  const P = baseP + (mouseHunter ? 1 : 0);
  const fleeR = params.fleeRange;
  const paceSpeed = params.maxSpeed * 0.78;
  for (let i = 0; i < n; i++) {
    if (caught[i] || !resting[i]) continue;
    const k = i * 3;
    const px = pos[k], py = pos[k + 1], pz = pos[k + 2];
    const vx = vel[k], vy = vel[k + 1], vz = vel[k + 2];
    acc[k] = 0; acc[k + 1] = 0; acc[k + 2] = 0;
    fleeDir[k] = 0; fleeDir[k + 1] = 0; fleeDir[k + 2] = 0;
    fleeing[i] = 0; neighbors[i] = 0;
    // 争斗色自动褪去：抢到位子坐下 REST_CONTENTION_FADE 后恢复正常体色，
    // 让「刚争夺成功」这件事在画面上留一下，但不整场都是红鸟。
    if (contending[i] && settled[i] && restSince[i] > 0 && time - restSince[i] > REST_CONTENTION_FADE) contending[i] = 0;

    // 老住客换位：到点才起身，落点只在身边半步内，位移交给速度积分（绝不瞬移）。
    if (settled[i] && time >= restSwapAt[i]) {
      restSwapAt[i] = Infinity;
      const gp = grass[restPatch[i]];
      if (gp) {
        const [nx, ny] = nearbyRestPoint(gp, i, px, py);
        restTgt[i * 2] = nx; restTgt[i * 2 + 1] = ny;
        settled[i] = 0; restTries[i] = 0;
        restApproachUntil[i] = Math.max(restApproachUntil[i], time + 4500);
      }
    }
    // 目标点要在换位之后读取，否则换位那一帧会立刻又站回原地
    const tx = restTgt[i * 2], ty = restTgt[i * 2 + 1];
    const dd = Math.sqrt((tx - px) * (tx - px) + (ty - py) * (ty - py));

    // 受惊不再让整片草地同一帧起飞：按「离猛禽多远」给 40~560ms 反应延迟，
    // 近的先跑、远的稍后，和飞行个体的反应延迟是同一套逻辑。
    let scared = false, predD2 = Infinity;
    const safe2 = fleeR * 1.5 * (fleeR * 1.5);
    for (let p = 0; p < P; p++) {
      const q = p * 3;
      const ex = px - predPos[q], ey = py - predPos[q + 1];
      const d2 = ex * ex + ey * ey;
      if (d2 < predD2) predD2 = d2;
      if (d2 < safe2) scared = true;
    }
    if (scared) {
      if (restFleeAt[i] === Infinity) {
        const near = Math.min(1, Math.sqrt(predD2) / (fleeR * 1.5));
        restFleeAt[i] = time + 40 + near * 520;
      }
    } else restFleeAt[i] = Infinity;
    const fleeNow = scared && time >= restFleeAt[i];

    // 到点 + 几乎不动 才算真的在休息；只是从队里飞过来还在路上就不算。
    // 每帧只放行 1 只站定：否则同帧落地的两只鸟互相都还没 settled，
    // 各自的间距检查都会跳过对方，于是贴在一起站定（minSep 掉到 0.6 的元凶）。
    if (!settled[i] && dd < 0.7 && Math.sqrt((vx) * (vx) + (vy) * (vy)) < 2.2
        && restSettleThisFrame < REST_SETTLE_SOFT_CAP) {
      const gp = grass[restPatch[i]];
      let tooClose = false;
      if (gp) {
        const lim = REST_SPACING * 0.95;
        for (const j of gp.members) {
          if (j === i || !settled[j]) continue;
          const ex = px - pos[j * 3], ey = py - pos[j * 3 + 1];
          if (ex * ex + ey * ey < lim * lim) { tooClose = true; break; }
        }
      }
      if (tooClose && gp && restTries[i] < 5) {
        // 只改目标点，让下一帧靠速度积分「走」过去。旧版在这里直接写 pos，
        // 采样点可能落在草地另一头，于是肉眼看到的就是一次瞬移。
        const [nx, ny] = nearbyRestPoint(gp, i, px, py);
        restTgt[i * 2] = nx; restTgt[i * 2 + 1] = ny;
        restTries[i]++;
        restApproachUntil[i] = Math.max(restApproachUntil[i], time + 2600);
      } else {
        settled[i] = 1;
        restSettleThisFrame++;
        // 站定朝向 = 落地瞬间的渲染朝向：箭头不会突然转过去，也不再随机重设朝向。
        restAng[i] = Math.sqrt((rVel[k]) * (rVel[k]) + (rVel[k + 1]) * (rVel[k + 1])) > 1e-4
          ? Math.atan2(rVel[k + 1], rVel[k]) : wAng[i];
        // 停稳瞬间把残余速度清零：否则还会借着惯性滑出 0.5~0.6 个单位
        vel[k] = 0; vel[k + 1] = 0;
        audio.land();          // 落地的那一下
        restSince[i] = time;
        restSessions++;
        // 离场时间带个体相位：28~60 秒，同批落地的鸟不会一起走
        restUntil[i] = time + REST_MAX_MIN + Math.random() * REST_MAX_SPAN
                       + restPhase[i] * REST_PHASE_SPAN;
      }
    }
    // 飞太久还没停稳（草地太挤/一直被挤）就放弃，别一直算作「在路上」
    if (!settled[i] && time > restApproachUntil[i]) {
      endRest(i, time, false);
      continue;
    }
    if (fleeNow || time >= restUntil[i] || !params.grassOn) {
      endRest(i, time, scared);
      // 起飞：朝场内偏中心，再给一个大扇形随机，避免整片鸟朝同一方向齐刷刷飞出
      const ang = Math.atan2(py - groupY, px - groupX) + (Math.random() - 0.5) * 2.4;
      const vs = paceSpeed * (0.8 + Math.random() * 0.3);
      vel[k] = Math.cos(ang) * vs; vel[k + 1] = Math.sin(ang) * vs; vel[k + 2] = 0;
    }
    continue;
  }
}

// ---------------------------------------------------------------- 受力（可并行）
// 爆发触发要写 stamina / alertMs / sprintUntil 并播声音，私人航向也是一次 O(n) 推进，
// 所以放在受力之前由主线程统一做；真正重的那一段（邻域扫描 + 三条规则）在 forces.js。
function prepareForces(F, dt, time) {
  const n = activeCount;
  const P = F.P;
  const fleeR = F.fleeR;
  const fleeR2 = F.fleeR2;

  for (let i = 0; i < n; i++) {
    if (caught[i] || resting[i]) continue;
    // 个体游走：每只鸟带一条缓慢漂移的私人航向（原在算力循环里，现在统一提前推进）。
    wAng[i] += (Math.random() - 0.5) * 6 * dt;
    if (P === 0) { alertMs[i] = 0; continue; }

    let nearest2 = Infinity;
    for (let p = 0; p < P; p++) {
      const q = p * 3;
      const dx = pos[i * 3] - predPos[q], dy = pos[i * 3 + 1] - predPos[q + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 < nearest2) nearest2 = d2;
    }
    // 反应延迟：进入感知圈只是「看到」，还要累积够所需时间才会起爆。
    // 所需时间随距离（平方）从贴身 45ms 增长到圈边缘 260ms，再乘个体系数，
    // 于是爆发会从捕食者身边向外扩散，而不是整群同时亮。
    if (nearest2 < fleeR2) {
      if (stamina[i] >= 1 && time >= sprintUntil[i]) {
        const dNorm = Math.min(1, Math.sqrt(nearest2) / fleeR);
        const need = (REACT_NEAR_MS + (REACT_FAR_MS - REACT_NEAR_MS) * dNorm * dNorm) * reactJit[i];
        alertMs[i] += dt * 1000;
        if (alertMs[i] >= need) {
          alertMs[i] = 0;
          sprintUntil[i] = time + params.sprintDuration * 1000;
          stamina[i] = 0;
          sprintCount++;
          audio.sprint(Math.min(1, Math.sqrt(nearest2) / fleeR));
          // 爆发只提高「速度上限」，提速由转向力在一帧内拉到位，不做额外积分。
        }
      } else {
        alertMs[i] = 0;
      }
    } else {
      alertMs[i] = 0;   // 脱离感知圈就清空，重新进入要重新累积
    }
  }

  const M = forceMeta;
  const per = params.perception;
  const nrm = Math.max(1, n / 800);
  M.n = n; M.P = P; M.dt = dt; M.time = time;
  M.groupX = groupX; M.groupY = groupY; M.hx = F.hx; M.hy = F.hy;
  M.groupThreatAt = groupThreatAt;
  M.cell = per / 1.4;
  M.per2 = per * per;
  M.sep2 = params.separationRange * params.separationRange;
  M.sepSoft = 0;
  M.sepSat = 4.0 / params.separationRange;
  M.denK = LOCAL_DEN_K * 1.4 * Math.sqrt(nrm);
  M.maxSpeed = F.maxSpeed;
  M.maxForce = MAX_FORCE;
  M.keepR = Math.min(60, Math.max(12, FLOCK_KEEP_R * Math.sqrt(nrm)));
  M.keepR2 = M.keepR * M.keepR;
  M.keepF = FLOCK_KEEP_F;
  M.paceSpeed = F.paceSpeed;
  M.sprintSpeed = F.sprintSpeed;
  M.fleeR = fleeR; M.fleeR2 = fleeR2;
  M.sepCap = sepCapFor(n);
  M.flowT = time * 0.00022;
  M.alignment = params.alignment; M.cohesion = params.cohesion;
  M.separation = params.separation; M.fleeWeight = params.fleeWeight;
  M.predict = params.predict; M.infoCascade = params.infoCascade;
  M.flow = params.flow; M.grassOn = params.grassOn; M.wrapEdges = params.wrapEdges;
  M.wanderBase = WANDER_BASE;
  M.gridX0 = gridX0; M.gridY0 = gridY0; M.gridW = gridW; M.gridH = gridH;
  M.grass = grass;
  return M;
}

// ---------------------------------------------------------------- 积分 + 统计（串行）
function frameFinish(F, res, dt, time) {
  const { n, P, baseP, hx, hy, fleeR, fleeR2, maxSpeed, minSpeed, paceSpeed,
          sprintSpeed, catchR2, predNorm } = F;
  let sumNeighbors = res.sumN;
  let deadCount = 0;
  for (let i = 0; i < n; i++) if (caught[i]) deadCount++;
  const aliveN = Math.max(1, n - deadCount);
  let cx = res.cx, cy = res.cy, cz = 0;
  const B = BOUND;
  let impact = res.impact;
  let boundaryImpact = 0;
  minPairD2 = res.minPair2;

  if (aliveN > 0) {
    groupX += cx / aliveN; groupY += cy / aliveN; groupZ = 0;
    // 质心也夹回场内：它外面还有「测距、声像、巡逻点」一堆代码按场地坐标在用它。
    if (groupX > hx) groupX -= 2 * hx; else if (groupX < -hx) groupX += 2 * hx;
    if (groupY > hy) groupY -= 2 * hy; else if (groupY < -hy) groupY += 2 * hy;
  }

  let speedSum = 0, keSum = 0;
  for (let i = 0; i < n; i++) {
    if (caught[i]) continue;
    const k = i * 3;
    if (resting[i]) {
      if (!settled[i]) {
        // 赶路：朝落点直飞，速度随剩余距离收敛（远处接近巡航速度，近处慢慢落）
        const tx = restTgt[i * 2], ty = restTgt[i * 2 + 1];
        const dx = tx - pos[k], dy = ty - pos[k + 1];
        const dd = Math.sqrt((dx) * (dx) + (dy) * (dy)) || 1e-4;
        // 速度随剩余距离连续收敛到 0.35：早先下限是 1.1，鸟到了落点还在以 1.1 往前冲，
        // 一帧就越过靶点、下一帧再掉头回来，于是原地左右抖（渲染朝向跟着 180° 翻）。
        const want = Math.min(paceSpeed, Math.max(0.35, dd * 3.0));
        const wx = dx / dd * want, wy = dy / dd * want;
        const kk = 1 - Math.exp(-dt / 0.10);
        vel[k] += (wx - vel[k]) * kk;
        vel[k + 1] += (wy - vel[k + 1]) * kk;
        vel[k + 2] = 0;
      } else {
        // 停稳：强阻尼把速度收到 0 附近（不适用最低速度与边界反弹）
        const damp = Math.exp(-dt / 0.4);
        vel[k] = (vel[k] + acc[k] * dt) * damp;
        vel[k + 1] = (vel[k + 1] + acc[k + 1] * dt) * damp;
        vel[k + 2] = 0;
      }
      pos[k] += vel[k] * dt; pos[k + 1] += vel[k + 1] * dt;
      const rsp = Math.sqrt((vel[k]) * (vel[k]) + (vel[k + 1]) * (vel[k + 1]));
      speedSum += rsp; keSum += 0.5 * rsp * rsp;
      continue;
    }
    let vx = vel[k] + acc[k] * dt;
    let vy = vel[k + 1] + acc[k + 1] * dt;
    let sp = Math.sqrt((vx) * (vx) + (vy) * (vy));
    const sprinting = time < sprintUntil[i];
    // 速度上限：爆发 > 受惊 > 巡航节奏，直接取目标值（不做加速度积分），
    // 起爆即可提速、威胁解除即刻降到巡航。
    // 每只鸟的巡航/受惊/爆发速度再乘自己的系数，整群不会以同一速度像刚体一样平移。
    const capTarget = (sprinting ? sprintSpeed : (fleeing[i] ? maxSpeed : paceSpeed)) * spdJit[i];
    const cap = Math.max(params.minSpeed, Math.min(sprintSpeed * 1.15, capTarget));
    capNow[i] = cap;   // 仅作为调试采样保留
    if (sp > cap) { const q = cap / sp; vx *= q; vy *= q; sp = cap; }
    else if (sp < params.minSpeed && sp > 1e-6) { const q = params.minSpeed / sp; vx *= q; vy *= q; sp = params.minSpeed; }
    vel[k] = vx; vel[k + 1] = vy; vel[k + 2] = 0;
    speedSum += sp;
    keSum += 0.5 * sp * sp;

    pos[k] += vx * dt; pos[k + 1] += vy * dt;

    // ---- 边界：穿墙（面板可关）或实体墙反弹 ----
    // 开：越界后从对侧同高度继续出现，速度方向不变（刚进场一定朝场内飞），
    //     无概率、无反射、无散射——所有个体规则一致。
    // 关：墙变成实体，只反转越界方向的速度分量（保留 92%），鸟是真的「撞一下弹开」。
    if (params.wrapEdges) {
      if (wrapThroughWall(pos[k], pos[k + 1], hx, hy)) {
        pos[k] = wrapX; pos[k + 1] = wrapY;
        teleportCount++;
        // 穿墙是瞬移：尾迹粒子留在旧位置是对的（历史航迹），但发射包络要清零，
        // 免得落点接着撒出一段凭空出现的尾迹。
        trailNextAt[i] = 0; birdTrailP[i] = 0;
      }
    } else if (bounceOffWall(pos[k], pos[k + 1], hx, hy)) {
      pos[k] = wrapX; pos[k + 1] = wrapY;
      if (bounceX) { vx = -vx * 0.92; vel[k] = vx; }
      if (bounceY) { vy = -vy * 0.92; vel[k + 1] = vy; }
    }
    pos[k + 2] = 0; vel[k + 2] = 0;

    // ---- 落地（原在算力那一遍，现在积分之后：落点要查同片草地的间距、还要占
    // 「本帧出发配额」，只能串行做；晚一帧生效，观感上看不出来）----
    if (params.grassOn && grass.length) {
      const g = grassTouch[i];
      if (g >= 0) {
        // 掠过草地：刚进入草地范围的那一刻，按个体相位给 5%~13% 概率顺势减速落下来。
        // 只在「边沿进入」时掷一次骰子；也不能用 fleeing 判断有没有危险（信息级联会让全群都是 fleeing）。
        if (!overGrass[i] && time >= sprintUntil[i]
            && Math.random() < 0.05 + restPhase[i] * 0.08) {
          let safe = true;
          const safe2 = fleeR * 1.6 * (fleeR * 1.6);
          for (let p = 0; p < P; p++) {
            const q = p * 3;
            const ex = pos[k] - predPos[q], ey = pos[k + 1] - predPos[q + 1];
            if (ex * ex + ey * ey < safe2) { safe = false; break; }
          }
          if (safe) landHere(i, g, time);
        }
        overGrass[i] = 1;
      } else {
        overGrass[i] = 0;
      }
    }
    // 到点了：附近没有捕食者，就去最近的草地歇一会儿。
    if (params.grassOn && !resting[i] && time >= restDue[i] && time >= sprintUntil[i]) {
      let safe2 = fleeR * 2.2 * (fleeR * 2.2), ok = true;
      for (let p = 0; p < P; p++) {
        const q = p * 3;
        const ex = pos[k] - predPos[q], ey = pos[k + 1] - predPos[q + 1];
        if (ex * ex + ey * ey < safe2) { ok = false; break; }
      }
      if (ok) startRest(i, time);
      else restDue[i] = time + 1200 + Math.random() * 3000 + restPhase[i] * 2500;
    }

    // 捕获：捕食者是锐角三角形，有实际碰撞体积，接触即算捕食成功（仍受进食冷却限制）。
    // 用上一帧到当前帧的线段做扫掠判定：高速追击时不会一帧跨过猎物。
    if (P > 0 && !caught[i]) {
      for (let p = 0; p < P; p++) {
        // 鼠标捕食者冷却远短于 AI：人控制时是「划过就吃」，
        // 若沿用 AI 那套几十秒的冷却，整个玩法就完全没手感。
        const cdMs = p === baseP ? mouseFeedMs() : params.feedCooldown * 1000;
        if (time - predFeedAt[p] < cdMs) continue;
        const q = p * 3;
        if (segDist2(pos[k], pos[k + 1], predPrev[q], predPrev[q + 1], predPos[q], predPos[q + 1]) >= catchR2) continue;
        const rvx = vx - predVel[q], rvy = vy - predVel[q + 1];
        const vrel = Math.max(0.5, Math.sqrt((rvx) * (rvx) + (rvy) * (rvy)));
        const J = Math.pow(vrel, 1.2) / predNorm;
        audio.predate(J);
        spawnBurst(pos[k], pos[k + 1], 0, time);
        predFeedAt[p] = time;
        predPulseAt[p] = time;
        predTarget[p] = -1;
        predCatches++;
        caught[i] = 1;
        respawnAt[i] = time + 1000;   // 1 秒后重新出生
        birthAt[i] = -Infinity;
        stamina[i] = 0; sprintUntil[i] = 0;
        // 被吃掉 → 不再产生新尾迹（已有的粒子会按寿命自己淡出）
        trailNextAt[i] = Infinity; birdTrailP[i] = 0;
        if (resting[i]) endRest(i, time, true);   // 从草地上摘掉，别一直占着容量
        break;
      }
    }
  }

  perfParts.loop = performance.now() - F.tGrid1;
  const tStats0 = performance.now();
  // 延迟补位：1 秒后在离捕食者最远、离边界有余量的位置出生
  for (let i = 0; i < n; i++) {
    if (caught[i] && time >= respawnAt[i]) {
      spawnFar(i, time);
      caught[i] = 0; respawnAt[i] = 0;
      audio.birth();
    }
  }
  if (P > 0) prevFlee.set(fleeDir);   // 信息级联使用上一帧逃逸方向

  let spread = 0, restN = 0, dirX = 0, dirY = 0, dirN = 0;
  for (let i = 0; i < n; i++) {
    if (caught[i]) continue;
    const k = i * 3;
    if (settled[i]) restN++;
    else {
      // Vicsek 有序参量：把每只飞行中的鸟的方向单位化后相加，
      // 乱飞时互相抵消（φ→0），整群同向时叠加（φ→1）。
      const sp = Math.sqrt((vel[k]) * (vel[k]) + (vel[k + 1]) * (vel[k + 1]));
      if (sp > 0.05) { dirX += vel[k] / sp; dirY += vel[k + 1] / sp; dirN++; }
    }
    // 参考点必须是用质心（cx 此时还是坐标总和，需要除以 aliveN），
    // 之前直接用总和对减，算出来的半径大了一个数量级，相干度永远是 0。
    // 跨边界的一对个体按最小映像取近路，否则鸟群压着接缝飞时半径会虚高成整个场宽。
    let dx = pos[k] - groupX, dy = pos[k + 1] - groupY;
    if (dx > hx) dx -= 2 * hx; else if (dx < -hx) dx += 2 * hx;
    if (dy > hy) dy -= 2 * hy; else if (dy < -hy) dy += 2 * hy;
    spread += dx * dx + dy * dy;
  }
  orderParam = dirN > 0 ? Math.sqrt((dirX) * (dirX) + (dirY) * (dirY)) / dirN : 0;
  waveStartMax = Math.max(waveStartMax, waveStart);
  waveEndMax = Math.max(waveEndMax, waveEnd);

  // 宏观量：数密度 ρ、动能温度 T、理想气体气压 P = ρT
  restingCount = restN;
  avgNeighbors = sumNeighbors / aliveN;
  // 固定 7 只拓扑邻居后，「平均邻居数」恒为 ~7，不再能代表密度；
  // 改用数量密度（开方只是让 800~5 万的跨度在指标上更平滑）。
  const neighborDensity = Math.min(1, Math.sqrt(n / 20000));
  // 群体半径（RMS）：用于相干度与音乐驱动的聚集度。
  groupRms = Math.max(0.5, Math.sqrt(spread / aliveN));
  // 半径尺度取「整屏对角的一半」左右，让紧团≈1、铺满全屏≈0，指标才有分辨力。
  const coherence = Math.max(0, Math.min(1, 1 - groupRms / (B * 1.15)));
  cohesion01 = coherence;
  density = Math.min(1, neighborDensity * 0.72 + coherence * 0.28);
  avgSpeed = speedSum / aliveN;
  const vRef = THERMAL_REF;
  temperature = Math.min(1, (keSum / aliveN) / (0.5 * vRef * vRef));
  pressure = density * temperature;

  // 碰撞强度只作为统计保留，不再触发音效。
  collisionImpulse = Math.max(impact, boundaryImpact) / Math.pow(maxSpeed, 1.2);
  perfParts.stats = performance.now() - tStats0;
}

// ---------------------------------------------------------------- 单核入口
// 多核模式下 render() 把「前半段 + 受力」与「积分」拆到两帧里做（见 dispatchStep），
// 但两半调用的就是上面这同一组函数——不存在第二份仿真逻辑。
function step(dt, time) {
  const F = frameBegin(dt, time);
  updateResting(dt, time);
  const M = prepareForces(F, dt, time);
  Object.assign(forceCtx, M);
  // 网格数组在窗口/缩放变化时会重新分配（frameBegin 里），forceCtx 存的是旧引用，
  // 必须每帧重新指一次，否则邻域扫描会读到一张空网格（表现为「邻居数恒为 0」）。
  forceCtx.cellStart = cellStart; forceCtx.cellEnd = cellEnd; forceCtx.cellItems = cellItems;
  const t0 = performance.now();
  lastForceResult = computeForces(forceCtx, 0, F.n);
  perfParts.force = performance.now() - t0;
  frameFinish(F, lastForceResult, dt, time);
}


// ---------------------------------------------------------------- 多核调度
// 一帧 dispatch、下一帧收齐再积分。Worker 只算力；积分 / 捕获 / 休息调度 / 统计
// 全部留在主线程——它们要写全局状态，并行会打架。
// 任何一步失败都自动回退单核：Worker 构造失败、脚本加载失败、超过 timeoutMs 没回。
function slotBufs(s) {
  return [s.pos.buffer, s.vel.buffer, s.prevFlee.buffer, s.sprintUntil.buffer,
          s.wAng.buffer, s.wAmp.buffer, s.caught.buffer, s.resting.buffer,
          s.oAcc.buffer, s.oFlee.buffer, s.oDen.buffer, s.oNear.buffer,
          s.oNb.buffer, s.oFl.buffer, s.oTouch.buffer,
          s.gStart.buffer, s.gEnd.buffer, s.gItems.buffer];
}

// Transferable 转移后原来的 TypedArray 视图会 detached（即使 buffer 又还回来，
// 视图也不会自动复活），所以每次收发都要按 buffer 重建视图。
function bindSlot(s, b) {
  s.pos = new Float32Array(b[0]);
  s.vel = new Float32Array(b[1]);
  s.prevFlee = new Float32Array(b[2]);
  s.sprintUntil = new Float64Array(b[3]);
  s.wAng = new Float32Array(b[4]);
  s.wAmp = new Float32Array(b[5]);
  s.caught = new Uint8Array(b[6]);
  s.resting = new Uint8Array(b[7]);
  s.oAcc = new Float32Array(b[8]);
  s.oFlee = new Float32Array(b[9]);
  s.oDen = new Float32Array(b[10]);
  s.oNear = new Float32Array(b[11]);
  s.oNb = new Uint16Array(b[12]);
  s.oFl = new Uint8Array(b[13]);
  s.oTouch = new Int8Array(b[14]);
  s.gStart = new Int32Array(b[15]);
  s.gEnd = new Int32Array(b[16]);
  s.gItems = new Int32Array(b[17]);
}

function makeSlot() {
  const w = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
  const slot = { w };
  bindSlot(slot, [
    new Float32Array(MAX_N * 3).buffer, new Float32Array(MAX_N * 3).buffer,
    new Float32Array(MAX_N * 3).buffer, new Float64Array(MAX_N).buffer,
    new Float32Array(MAX_N).buffer, new Float32Array(MAX_N).buffer,
    new Uint8Array(MAX_N).buffer, new Uint8Array(MAX_N).buffer,
    new Float32Array(MAX_N * 3).buffer, new Float32Array(MAX_N * 3).buffer,
    new Float32Array(MAX_N).buffer, new Float32Array(MAX_N).buffer,
    new Uint16Array(MAX_N).buffer, new Uint8Array(MAX_N).buffer,
    new Int8Array(MAX_N).buffer,
    new Int32Array(4096).buffer, new Int32Array(4096).buffer, new Int32Array(MAX_N).buffer
  ]);
  w.onmessage = (e) => onWorkerDone(slot, e.data);
  w.onerror = () => abortMultiCore('worker-error');
  return slot;
}

function initMultiCore() {
  if (MC.tried) return;
  MC.tried = true;
  if (!params.multiCore) { MC.reason = 'off'; return; }
  if (typeof Worker === 'undefined') { MC.reason = 'no-worker'; return; }
  const cores = navigator.hardwareConcurrency || 4;
  // 留两个核给主线程（渲染、积分、界面）与系统，避免和 worker 抢满。
  const want = Math.max(1, Math.min(6, cores - 2));
  try {
    for (let i = 0; i < want; i++) MC.workers.push(makeSlot());
  } catch (e) {
    MC.workers = [];
    MC.reason = 'spawn';
    return;
  }
  MC.enabled = MC.workers.length > 0;
  MC.reason = MC.enabled ? 'on' : 'empty';
  MC.warm = 0;
}

function abortMultiCore(reason) {
  if (!MC.enabled) return;
  MC.enabled = false;
  MC.reason = reason;
  MC.job = null;
  // 已经决定不用了就把线程池收掉：否则这几个 worker 会一直挂在后台占内存。
  // 用户想再试一次走 setMultiCore(true)，那条路径会重建。
  for (const s of MC.workers) { try { s.w.terminate(); } catch (_) {} }
  MC.workers = [];
  MC.warm = 0;
  toast('多核加速不可用，已切回单核');
}


// 运行时开关：关掉立刻停用并释放 worker；重新打开会重建（已存在的先终止，避免泄漏）。
function setMultiCore(on) {
  params.multiCore = !!on;
  saveParams();
  if (!params.multiCore) {
    for (const s of MC.workers) { try { s.w.terminate(); } catch (_) {} }
    MC.workers = [];
    MC.enabled = false;
    MC.job = null;
    MC.reason = 'off';
    return false;
  }
  // 重新打开：先把旧池（可能还在跑）停掉，否则会越开越多。
  for (const s of MC.workers) { try { s.w.terminate(); } catch (_) {} }
  MC.workers = [];
  MC.job = null;
  MC.tried = false;
  MC.reason = 'idle';
  initMultiCore();
  return MC.enabled;
}

// 主线程 → worker：填好只读副本，把 15 个 buffer 的所有权一起交出去。
function dispatchMulti(F, dt, time) {
  const M = prepareForces(F, dt, time);
  const P3 = Math.max(1, F.P) * 3;
  M.predPos = predPos.slice(0, P3);
  M.predVel = predVel.slice(0, P3);
  // grass 里带 members（Set），不能直接结构化克隆；只挑受力用得到的形状参数。
  M.grass = grass.map((g) => ({ x: g.x, y: g.y, R: g.R, a1: g.a1, p1: g.p1, a2: g.a2, p2: g.p2 }));

  const k = MC.workers.length;
  const n = F.n;
  // 网格由主线程建一次、复制给每个 worker —— 比让 6 个 worker 各自重建省 6 倍的
  // O(n) 三趟计数排序（8000 只时每份约 0.5ms）。尺寸只随窗口/缩放变，扩容很少发生。
  const gcells = gridW * gridH;
  for (let s = 0; s < k; s++) {
    const slot = MC.workers[s];
    if (slot.gStart.length < gcells || slot.gEnd.length < gcells) {
      const cap = Math.max(gcells, slot.gStart.length * 2);
      slot.gStart = new Int32Array(cap); slot.gEnd = new Int32Array(cap);
    }
    slot.gStart.set(cellStart.subarray(0, gcells));
    slot.gEnd.set(cellEnd.subarray(0, gcells));
    slot.gItems.set(cellItems.subarray(0, F.accCells));
  }
  const job = MC.job = {
    F, dt, time, left: k, ready: false, epoch: MC.epoch,
    sumN: 0, cx: 0, cy: 0, minPair2: Infinity, impact: 0,
    t0: performance.now(), ms: 0,
    // 首帧宽限 4 倍：6 个 worker 要各自下载并编译 forces.js，冷启动那一次能到几百毫秒，
    // 按稳态的 800ms 判超时会把一个本来正常的多核在开局就误杀掉。
    budget: MC.warm === 0 ? MC.timeoutMs * 4 : MC.timeoutMs
  };
  // 按「上一帧邻居数」的累计量切连续区间，而不是等分个体数：
  // 群体是一团，等分会让正好覆盖密团的那些 worker 承担几倍的工作量，整帧被最慢的拖住。
  // 也不能按空间表切——那会把 pos 的顺序访问变成随机访问，缓存未命中让总耗时反而涨 4 倍。
  // 用上一帧的 neighbors 做权重（连续变化，误差很小），既均衡又保持顺序遍历。
  const wsum = mcWeights;
  wsum[0] = 0;
  for (let i = 0; i < n; i++) {
    wsum[i + 1] = wsum[i] + ((caught[i] || resting[i]) ? 0 : 1 + neighbors[i]);
  }
  const totalW = wsum[n];
  const cuts = mcCuts;
  cuts[0] = 0;
  let seg = 0;
  if (totalW > 0) {
    for (let i = 1; i < n && seg < k - 1; i++) {
      if (wsum[i] >= totalW * (seg + 1) / k) cuts[++seg] = i;
    }
  }
  while (seg < k) cuts[++seg] = n;
  for (let s = 0; s < k; s++) {
    const slot = MC.workers[s];
    const i0 = cuts[s], i1 = cuts[s + 1];
    slot.pos.set(pos.subarray(0, n * 3));
    slot.vel.set(vel.subarray(0, n * 3));
    slot.prevFlee.set(prevFlee.subarray(0, n * 3));
    slot.sprintUntil.set(sprintUntil.subarray(0, n));
    slot.wAng.set(wAng.subarray(0, n));
    slot.wAmp.set(wAmp.subarray(0, n));
    slot.caught.set(caught.subarray(0, n));
    slot.resting.set(resting.subarray(0, n));
    const bufs = slotBufs(slot);
    slot.w.postMessage({ cmd: 'run', id: ++MC.serial, i0, i1, meta: M, bufs }, bufs);
  }
  return job;
}

function onWorkerDone(slot, m) {
  bindSlot(slot, m.bufs);           // 先把 buffer 收回来，任何情况下都不丢
  const job = MC.job;
  if (!job) return;                 // 已超时 / 已取消
  if (job.epoch !== MC.epoch) { job.left--; return; }   // 数组被重置：只回收，不合并
  const { i0, i1 } = m;
  const a3 = i0 * 3, b3 = i1 * 3;
  acc.set(slot.oAcc.subarray(a3, b3), a3);
  fleeDir.set(slot.oFlee.subarray(a3, b3), a3);
  localDen.set(slot.oDen.subarray(i0, i1), i0);
  nearD2A.set(slot.oNear.subarray(i0, i1), i0);
  neighbors.set(slot.oNb.subarray(i0, i1), i0);
  fleeing.set(slot.oFl.subarray(i0, i1), i0);
  grassTouch.set(slot.oTouch.subarray(i0, i1), i0);
  job.sumN += m.res.sumN;
  job.cx += m.res.cx;
  job.cy += m.res.cy;
  if (m.res.minPair2 < job.minPair2) job.minPair2 = m.res.minPair2;
  if (m.res.impact > job.impact) job.impact = m.res.impact;
  job.ms += m.res.ms;
  if (--job.left === 0) {
    job.ready = true;
    MC.warm++;
    // 真正的并行耗时：dispatch → 最后一个 worker 返回（不含等下一帧 rAF）。
    MC.lastWall = performance.now() - job.t0;
  }
}

function finishMulti() {
  const job = MC.job;
  MC.job = null;
  if (!job) return;
  // force 记「各 worker 实际计算时间之和」，可以和单核的 force 直接对比；
  // 墙钟里还包含消息往返与主线程复制，单独记在 lastWall。
  perfParts.force = +job.ms.toFixed(2);
  frameFinish(job.F, {
    sumN: job.sumN, cx: job.cx, cy: job.cy,
    minPair2: job.minPair2, impact: job.impact
  }, job.dt, job.time);
}

// ---------------------------------------------------------------- 渲染
// 状态卡迷你趋势图：ρ 实线 + 音乐聚集度虚线，每 0.1s 采样一次，保留 9 秒历史。
// 画在 2 倍分辨率的 canvas 上（CSS 缩到 34px 高），高分屏也不糊。
const sparkCanvas = document.getElementById('hSpark');
const sparkCtx = sparkCanvas.getContext('2d');
const sparkRho = [], sparkMusic = [];
const SPARK_N = 90;
function sparkPush(rho, mus) {
  sparkRho.push(rho); sparkMusic.push(mus);
  if (sparkRho.length > SPARK_N) { sparkRho.shift(); sparkMusic.shift(); }
}
function drawSpark() {
  const c = sparkCtx, W = sparkCanvas.width, H = sparkCanvas.height;
  c.clearRect(0, 0, W, H);
  c.strokeStyle = 'rgba(126,170,235,0.10)'; c.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = H * i / 4;
    c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
  }
  const plot = (arr, stroke, fill, width, dash) => {
    if (arr.length < 2) return;
    const stepX = W / (SPARK_N - 1);
    const x0 = W - (arr.length - 1) * stepX;
    const path = () => {
      c.beginPath();
      for (let i = 0; i < arr.length; i++) {
        const x = x0 + i * stepX, y = H - 5 - arr[i] * (H - 12);
        if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
    };
    if (fill) {
      path(); c.lineTo(W, H); c.lineTo(x0, H); c.closePath();
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, fill); g.addColorStop(1, 'rgba(99,230,255,0)');
      c.fillStyle = g; c.fill();
    }
    path();
    c.setLineDash(dash || []);
    c.strokeStyle = stroke; c.lineWidth = width;
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.stroke(); c.setLineDash([]);
  };
  plot(sparkMusic, 'rgba(255,156,203,0.55)', null, 2, [6, 6]);
  plot(sparkRho, '#63e6ff', 'rgba(99,230,255,0.22)', 3);
}
// 事件计数只在数值变化时弹一下，避免每 0.1s 都闪
const statLast = {};
// ---- 近 1 秒事件计数（HUD 用）----
// 传送 / 爆发 / 休憩这三项在 HUD 上只显示「近 1 秒发生了多少次」，不是累计值：
// 累计数只涨不掉，看久了就没信息量（跑到 3000 次之后和 3001 次一样）。
// 实现是 10 个 100ms 的滚动桶：每帧按时间推进桶、把本帧新增的事件数塞进当前桶，
// 显示时把 10 个桶加起来 → 平滑的「每秒速率」，不会出现整秒跳一下的闪烁。
const RATE_BUCKETS = 10, RATE_MS = 100;
const rateBuf = [new Float64Array(RATE_BUCKETS), new Float64Array(RATE_BUCKETS), new Float64Array(RATE_BUCKETS)];
let rateIdx = 0, rateLast = 0;
let prevTeleports = 0, prevSprints = 0, prevRests = 0;
function rateAdvance(now) {
  if (!rateLast) { rateLast = now; return; }
  let dt = now - rateLast;
  if (dt < RATE_MS) return;
  if (dt > RATE_BUCKETS * RATE_MS) {     // 切标签页回来：整段清空，不补算
    for (const b of rateBuf) b.fill(0);
    rateLast = now;
    return;
  }
  while (dt >= RATE_MS) {
    rateIdx = (rateIdx + 1) % RATE_BUCKETS;
    for (const b of rateBuf) b[rateIdx] = 0;
    dt -= RATE_MS;
  }
  rateLast = now - dt;                   // 保留余数，长期不漂
}
function rateAdd(slot, n) { if (n > 0) rateBuf[slot][rateIdx] += n; }
function rateSum(slot) {
  let s = 0;
  for (let i = 0; i < RATE_BUCKETS; i++) s += rateBuf[slot][i];
  return Math.round(s);
}

function setStat(id, v) {
  if (statLast[id] === v) return;
  statLast[id] = v;
  const el = document.getElementById(id);
  el.textContent = v;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

let last = performance.now();
let fps = 60, fpsAcc = 0, fpsFrames = 0, hudTimer = 0;
const perf = { step: 0, prep: 0, draw: 0, cpu: 0, gpu: 0 };

// 压力条以 60fps 的单帧预算为 100%：掉到 30fps 时 CPU 会显示约「实际耗时 / 16.7ms」，
// 不会因为帧间隔本身变长就把数字稀释掉（那样越卡反而越像「不忙」）。
const FRAME_BUDGET = 1000 / 60;
function setMeter(barId, valId, pct, est) {
  const p = Math.max(0, Math.min(999, pct || 0));
  const bar = document.getElementById(barId);
  if (!bar) return;
  bar.style.width = Math.min(100, p).toFixed(1) + '%';
  bar.className = p >= 75 ? 'hot' : p >= 45 ? 'warn' : '';
  document.getElementById(valId).textContent = (est ? '~' : '') + Math.round(p) + '%';
}

// 版本行与关于弹窗里的版本号：只在启动时写一次（构建元数据是常量）。
(function fillVersion() {
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('hVer', VERSION); set('hCommit', COMMIT); set('hBuild', BUILD_TIME); set('hAuthor', AUTHOR);
  set('aVer', VERSION);
  const line = document.getElementById('hVerLine');
  if (line) line.title = `FlockLab ${VERSION}｜commit ${COMMIT}｜构建 ${BUILD_TIME}｜作者 ${AUTHOR}`;
})();

const mcWeights = new Float64Array(MAX_N + 1);   // 负载切分用的权重前缀和
const mcCuts = new Int32Array(64);                // 切分点（worker 数上限 62）
let simAcc = 0;        // 等待 worker 期间累积的 dt
let mcBootAt = 0;      // 首屏稳定后再建 worker

function render(now) {
  requestAnimationFrame(render);
  // 页面加载 1.8 秒后才建 Worker：一开始那几帧全部留给着色器编译和首屏。
  if (!MC.tried) {
    if (!mcBootAt) mcBootAt = now + 1800;
    else if (now >= mcBootAt) initMultiCore();
  }
  const pT0 = performance.now();
  const rawDt = (now - last) / 1000;
  last = now;
  const dt = Math.min(rawDt, 0.035);
  fpsAcc += rawDt; fpsFrames++;
  if (fpsAcc > 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }

  // ---- 仿真推进 ----
  // 多核：一帧 dispatch、下一帧收齐再积分。dt 用累积的真实时间，
  // 排队等 worker 的那一两帧不会让仿真变慢（上限 60ms，防止切标签页回来一次跳太远）。
  if (!params.paused) {
    if (MC.enabled) {
      if (MC.job && MC.job.ready) finishMulti();
      if (MC.job && !MC.job.ready && performance.now() - MC.job.t0 > MC.job.budget) {
        abortMultiCore('timeout');
      }
      if (!MC.enabled) { step(dt, now); simAcc = 0; }          // 本帧刚回退：立刻补一步
      else if (!MC.job) {
        if (activeCount < MC.minN) {
          step(dt, now);                                        // 小群体并行不划算
        } else {
          simAcc = Math.min(0.06, simAcc + dt);
          const F = frameBegin(simAcc, now);
          updateResting(simAcc, now);
          dispatchMulti(F, simAcc, now);
          simAcc = 0;
        }
      }
    } else {
      step(dt, now);
      simAcc = 0;
    }
  }
  const pT1 = performance.now();

  // 音乐跟着群体状态走：聚集度决定和声厚度与节奏密度，
  // 正在爆发的比例决定和声是否被「压」下去一点（最多一个半音）。
  // 尺度说明：实测群体 RMS 半径在 28（极端抱团）~ 48（铺满全屏）之间，
  // 就以这个区间当满量程，中间才有分辨力；用 HUD 上那个相干度会挤在 0 附近。
  if (music.running) {
    // 0.18 的下限让「最散」时也有极稀疏的心跳，不会变成一片死寂的嗡鸣
    const cMusic = 0.18 + 0.82 * Math.max(0, Math.min(1, (BOUND * 1.2 - groupRms) / (BOUND * 0.55)));
    const tension = Math.min(1, sprintingCount / Math.max(24, activeCount * 0.04));
    music.update(cMusic, tension, dt);
    // 捕食者盘旋声的输入：位置归一化到声像、饥饿度、离群体的距离。
    // 鼠标捕食者优先当声源——你自己在哪儿，那层盘旋声就从哪儿（声像左右）飘过来。
    const musicPN = predCountNow();
    if (musicPN > 0) {
      const mSlot = mouseHunter ? musicPN - 1 : 0;
      const ms = mSlot * 3;
      const bd = bounds2D();
      const dx = predPos[ms] - groupX, dy = predPos[ms + 1] - groupY;
      music.setPredator(true, predPos[ms] / Math.max(1, bd.hx), predHeat[mSlot], Math.sqrt(dx * dx + dy * dy));
    } else {
      music.setPredator(false, 0, 0, 100);
    }
  }

  view2D.zoom += (view2D.tZoom - view2D.zoom) * 0.12;
  // 手持摇晃：暂停时 dt 传 0 —— 相位冻结、画面定格，但把强度调到 0 仍会立刻回正。
  updateViewShake(params.paused ? 0 : dt, view2DFitHalfH() / Math.max(0.05, view2D.zoom));
  updateOrthoFrustum(view2D.zoom * SHAKE.zoom);
  const camX = view2D.x + SHAKE.x, camY = view2D.y + SHAKE.y;
  camera.position.set(camX, camY, 40);
  camera.up.set(0, 1, 0);
  camera.lookAt(camX, camY, 0);
  if (SHAKE.roll) camera.rotateZ(SHAKE.roll);   // 必须在 lookAt 之后，否则朝向被重算掉

  // CPU 只写颜色/尺寸；箭头的朝向与形状全部交给 GPU 着色器。
  const tCol0 = performance.now();
  const n = activeCount;
  const SMOOTH = 0.18;   // 30 FPS 下时间常数约 0.15s，抖动明显降低且方向仍跟手
  const arrowBase = params.arrowSize;
  arrowMat.uniforms.uJit.value = RENDER_JIT;
  const invMaxSpeed = 1 / Math.max(0.001, params.maxSpeed);
  const sprintSpanMs = Math.max(160, params.sprintDuration * 1000);
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    // 渲染朝向的低通滤波顺手在这里做：原来另有一趟 3n 的循环，白跑一遍内存。
    // 物理仿真仍用原始 vel，行为不变。
    rVel[k] += (vel[k] - rVel[k]) * SMOOTH;
    rVel[k + 1] += (vel[k + 1] - rVel[k + 1]) * SMOOTH;
    if (caught[i]) { siz[i] = 0; continue; }   // 等待重生的 1 秒完全隐藏
    // 出生涌出进度（0~1）：算好进度丢给 GPU，缓动/自转/淡入全在顶点着色器里做。
    // 已经成形的个体 hatchAt 是 -Infinity，这里一步比较就出去，几乎不花钱。
    const hg = (now - hatchAt[i]) / HATCH_MS;
    growBuf[i] = hg >= 1 ? 1 : (hg > 0 ? hg : 0);
    // 色阶用局部密度（3×3 格里的活跃个体数），**不是** neighbors[i]。
    // neighbors[i] 是「注意力邻居数」，v31 把它固定成最多 7 只，所以它最多只能到
    // 7/24 = 0.29 → 色相永远停在青蓝端，用户看到的「再怎么聚也不变紫」就是这条：
    // 密度色阶被注意力上限锁死了。localDen 独立于注意力（见 step），才铺得开。
    const local = localDen[i];
    const vx = vel[k], vy = vel[k + 1];
    const speedRatio = Math.min(1, Math.sqrt(vx * vx + vy * vy) * invMaxSpeed);
    const q = (local * (PAL_Q - 1) + 0.5) | 0;
    let cr, cg, cb;
    // 落在草地上的鸟换一身「苔绿」：和飞行中的青蓝—紫渐变色系一眼分开，
    // 又不至于像新生个体的亮绿那样抢眼。
    if (settled[i]) {
      const o = q * 3;
      cr = palRest[o]; cg = palRest[o + 1]; cb = palRest[o + 2];
    } else {
      const o = (q * PAL_S + ((speedRatio * (PAL_S - 1) + 0.5) | 0)) * 3;
      cr = palFly[o]; cg = palFly[o + 1]; cb = palFly[o + 2];
    }
    // 争地盘的鸟全身泛红（见 startRest 的 REST_WAIT_FORCE）：一眼看出谁在抢位置。
    if (contending[i]) {
      const w = 0.78;
      cr = cr * (1 - w) + 0.95 * w;
      cg = cg * (1 - w) + 0.18 * w;
      cb = cb * (1 - w) + 0.14 * w;
    }
    // 尺寸不再随密度变化。原来是 `arrowBase + local * 0.10`——密集处反而放大，
    // 而实例四边形全宽是 2×size，10000 只时实测间距中位数只有 0.56，一放大就
    // 超过间距，相邻图元互相叠住、连成整片规则栅格（摩尔纹的放大器）。
    // 个体之间的大小差异改由顶点着色器按 aJit.x 做（±12%），既有疏密感又不会锁相。
    let size = RENDER_JIT ? arrowBase : arrowBase + local * 0.10;
    // 新生个体：亮绿色 + 轻微脉冲，1.8s 后开始渐变为普通色，3.2s 后完全一致。
    const age = now - birthAt[i];
    if (age >= 0 && age < BIRTH_TOTAL_MS) {
      const fade = Math.max(0, Math.min(1,
        (age - BIRTH_SOLID_MS) / (BIRTH_TOTAL_MS - BIRTH_SOLID_MS)));
      const pulse = 0.5 + 0.5 * Math.cos(Math.min(age, 700) * 0.014);
      const glow = 0.85 + 0.3 * pulse;
      col[k] = cr * fade + tmpBirth.r * (1 - fade) * glow;
      col[k + 1] = cg * fade + tmpBirth.g * (1 - fade) * glow;
      col[k + 2] = cb * fade + tmpBirth.b * (1 - fade) * glow;
      size *= 1 + (1 - fade) * (0.28 + 0.12 * pulse);
    } else {
      col[k] = cr; col[k + 1] = cg; col[k + 2] = cb;
    }
    // 停在草地上时保持「落地那一刻的飞行朝向」：速度归零后 atan(0,0)=0，
    // 若不给朝向整片鸟会齐刷刷指向右边。用落地瞬间记录的角度，方向连续、
    // 不会再随机重设朝向，所以站定那一帧不会出现箭头突然转过去的跳变。
    if (settled[i]) {
      rVel[k] = Math.cos(restAng[i]); rVel[k + 1] = Math.sin(restAng[i]); rVel[k + 2] = 0;
    }
    // 爆发中：不换成另一种颜色（原来抹成黄色，和冷色调的群体完全打架），
    // 而是在自身色相上「烧」向粉白——色相推到紫红端、亮度抬高、边缘更亮，
    // 亮度用一次起爆的衰减包络（而非固定频率频闪），30FPS 下也不会像坏灯管。
    if (now < sprintUntil[i] && age >= BIRTH_TOTAL_MS) {
      const t = Math.min(1, Math.max(0, (now - (sprintUntil[i] - sprintSpanMs)) / sprintSpanMs));
      const surge = 0.45 + 0.55 * Math.exp(-t * 3.4);      // 起爆瞬间最强，随后回落
      // 色相全程保持（爆发=洋红发光），只有亮度与尺寸在起爆瞬间冲高再回落，
      // 这样整段爆发期的身份色是一致的，不会一半时间又退回青蓝。
      const so = (((surge - 0.45) * 18.18) | 0) * 3;   // 0.45~1.0 → 0~15
      const w = 0.82;
      col[k] = col[k] * (1 - w) + sprintPal[so] * w;
      col[k + 1] = col[k + 1] * (1 - w) + sprintPal[so + 1] * w;
      col[k + 2] = col[k + 2] * (1 - w) + sprintPal[so + 2] * w;
      size *= 1.22 + 0.24 * surge;
    }
    siz[i] = size;
  }
  perfParts.color = performance.now() - tCol0;
  aPos.needsUpdate = true;
  aVel.needsUpdate = true;
  aCol.needsUpdate = true;
  aSiz.needsUpdate = true;
  aGrow.needsUpdate = true;
  // 抖动只在抽签（出生/重生）后变过，不必每帧重传 160KB
  if (aJitDirty) { aJit.needsUpdate = true; aJitDirty = false; }

  // ---- 加速尾迹：沿实际航迹撒独立粒子（见文件上方「加速尾迹」的说明）----
  // 鸟与捕食者共用 emitTrail，只有「怎么判定在加速」不同：
  //   鸟     → 瞬时速度超出巡航节奏的量（受惊提速 / 爆发冲刺都算），爆发期直接拉满；
  //   捕食者 → 加速度尖峰。
  // 两边都先过一道「快起慢落」包络把尖峰摊成约半秒窗口，再按个体节流撒点；
  // 撒下之后位置/朝向就冻结，不会再跟着实体走，所以转弯会自然弯曲成弧。
  tmpTrail.setHSL(0.928, 0.9, 0.62);
  // 鸟的尾迹整体压暗（加法混合下乘亮度 ≈ 降透明度）：颗粒又细又淡才像尾迹，
  // 保持原来的饱和度只会变成一根根扎眼的亮线段（用户看到的「画虚线」）。
  const BIRD_DIM = 0.62;
  const bR = tmpTrail.r * BIRD_DIM, bG = tmpTrail.g * BIRD_DIM, bB = tmpTrail.b * BIRD_DIM;
  const pR = tmpTrailPred.r, pG = tmpTrailPred.g, pB = tmpTrailPred.b;
  const birdTrailW = params.arrowSize * 0.24;
  const cruiseRef = currentPace;   // step 里算好的本帧巡航速度
  const birdRise = 1 - Math.exp(-dt / 0.035);
  const birdFall = 1 - Math.exp(-dt / 0.34);
  for (let i = 0; i < n; i++) {
    if (caught[i]) continue;
    const k = i * 3;
    const sp = Math.sqrt(vel[k] * vel[k] + vel[k + 1] * vel[k + 1]);
    // 巡航附近不撒；只有明显提速（受惊 / 爆发）才进入发射窗口
    const over = (sp - cruiseRef * 1.08) / (cruiseRef * 0.60);
    let target = over > 0 ? Math.min(1, over) : 0;
    if (now < sprintUntil[i]) target = 1;
    birdTrailP[i] += (target - birdTrailP[i]) * (target > birdTrailP[i] ? birdRise : birdFall);
    if (birdTrailP[i] <= 0.13) continue;
    if (now < trailNextAt[i]) continue;
    // 密度换颗粒感：13~24ms 一颗（原来是 22~40ms），配合更短更窄的单颗，
    // 尾迹才会连成细密的烟粒，而不是断断续续的粗虚线。
    trailNextAt[i] = now + 13 + Math.random() * 11;
    emitTrail(pos[k], pos[k + 1], vel[k], vel[k + 1], now,
      TRAIL_LIFE_BIRD, TRAIL_LEN_BIRD, birdTrailW, bR, bG, bB,
      0.42 * siz[i]);   // 从尾角连线中点出发，不是质心
  }

  // 捕食者：加速度驱动。加速度是尖峰式的（扑击起步只有两三帧），
  // 所以先用「快起慢落」包络把它摊成约半秒的窗口，再从窗口里匀速撒粒子。
  const trailPN = predCountNow();   // 含鼠标捕食者：手划得快时它也会留下尾迹
  if (trailPN > 0) {
    const predW = predLeg() * 0.34;
    for (let p = 0; p < trailPN; p++) {
      const target = Math.min(1, predAccel[p] / PRED_TRAIL_REF);
      const kEnv = target > predTrailP[p] ? (1 - Math.exp(-dt / 0.03)) : (1 - Math.exp(-dt / 0.40));
      const prevEnv = predTrailP[p];
      predTrailP[p] += (target - predTrailP[p]) * kEnv;
      // 加速音效：包络「由低冲高」越过 0.30 时响一次（边沿触发，不是每帧；0.30 ≈ 加速度 13.5，
      // 也就是扑击起步与急转都会响，匀速巡航不会），
      // 每只捕食者 400ms 内最多一次，避免扑击时连成一片。
      if (predTrailP[p] > 0.30 && prevEnv <= 0.30 && now >= predSoundAt[p]) {
        predSoundAt[p] = now + 400;
        audio.predDash(predTrailP[p]);
      }
      if (predTrailP[p] <= 0.18) continue;      // 匀速直线与普通续航转向不出尾迹
      if (now < predTrailNextAt[p]) continue;
      predTrailNextAt[p] = now + 14 + Math.random() * 10;
      const q = p * 3;
      emitTrail(predPos[q], predPos[q + 1], predVel[q], predVel[q + 1], now,
        TRAIL_LIFE_PRED, TRAIL_LEN_PRED, predW, pR, pG, pB,
        0.3227486 * predSiz[p]);   // 从等腰三角形的底边（尾巴）出发，不压住三角形
    }
  }

  trailMat.uniforms.uTime.value = now;      // 顶点着色器用绝对时间算 age
  // 背景与浮尘的动画时钟（秒）：星云漂移、星点闪烁、浮尘上浮都靠它
  const bgT = now * 0.001;
  bgMat.uniforms.uTime.value = bgT;
  dustMat.uniforms.uTime.value = bgT;
  // 视差层要跟相机的**实际**位置（含摇晃偏移），否则摇晃时背景像贴在屏幕上不动。
  backdrop.update(bgT, view2D.x + SHAKE.x, view2D.y + SHAKE.y);
  trailGeo.instanceCount = MAX_TRAILS;      // 恒定：过期粒子在顶点着色器里被裁掉
  if (trailDirty) {
    aTrPos.needsUpdate = true; aTrDir.needsUpdate = true; aTrCol.needsUpdate = true;
    aTrBirth.needsUpdate = true; aTrLife.needsUpdate = true;
    aTrLen.needsUpdate = true; aTrWid.needsUpdate = true;
    trailDirty = false;
  }

  // 捕食者：GPU 属性更新 + 威胁圈跟随相机
  // PN 含鼠标捕食者（它永远排在最后一个槽位），所以这一趟天然把它一起画出来。
  const PN = predCountNow();
  predMesh.visible = PN > 0;
  if (PN > 0) {
    for (let i = 0; i < PN * 3; i++) rPredVel[i] += (predVel[i] - rPredVel[i]) * SMOOTH;
    pPos.needsUpdate = true;
    pVel.needsUpdate = true;
    pCol.needsUpdate = true;
    pSiz.needsUpdate = true;
    const cdNormal = params.feedCooldown * 1000;
    for (let p = 0; p < MAX_SLOT; p++) {
      const ring = threatRings[p];
      if (p >= PN) {
        ring.visible = false;
        // 缩小到 0 再隐藏：数量调小后旧实例会立刻消失，不会定在画面上
        predSiz[p] = 0;
        continue;
      }
      // 鼠标捕食者：冷却、体色都按玩家驾驶的那套处理（更亮的金橙，一眼分得清）
      const isMouse = mouseHunter && p === PN - 1;
      const cdMs = isMouse ? mouseFeedMs() : cdNormal;
      const k = p * 3;
      ring.position.set(predPos[k], predPos[k + 1], predPos[k + 2]);
      ring.quaternion.copy(camera.quaternion);
      ring.scale.setScalar(params.fleeRange);   // 半径仍由「危险感知距离」控制
      ring.visible = true;
      // 圈永远显示：饱食是稳定可见的暗色圈，饿了抬亮成高饱和的亮色圈。
      // 呼吸只做轻微起伏（±12%），避免冷却期忽隐忽现被误当成「圈消失了」。
      const ph = ring.material.uniforms.uPhase.value;
      const breathe = 0.5 + 0.5 * Math.sin(now * 0.0014 + ph);
      const hungry = (now - predFeedAt[p]) >= cdMs ? 1 : 0;
      predHeat[p] += (hungry - predHeat[p]) * (1 - Math.exp(-dt / 0.6));
      const heat = predHeat[p];
      ring.material.uniforms.uHeat.value = heat;
      ring.material.uniforms.uAlpha.value = (0.38 + 0.46 * heat) * (0.88 + 0.12 * breathe);

      // ---- 体色：冷却期=浅橙黄，狩猎=深橙，冷却最后 1 秒渐变回深橙 ----
      // k=1 表示「刚吃饱」的浅橙黄，k=0 表示「随时能扑」的深橙。
      let kk = 0;
      const since = now - predFeedAt[p];
      if (since >= 0 && since < cdMs) {
        const fadeIn = Math.min(1, since / 320);                       // 捕食成功 → 0.32s 渐变到浅色
        const fadeOut = Math.min(1, Math.max(0, (cdMs - since) / 1000)); // 最后 1 秒渐变回深色
        kk = Math.min(fadeIn, fadeOut);
      }
      // 着色器内部还有约 1.4 倍的亮度合成（fill+rim+glow），所以这里要给低一些，
      // 否则两个通道一起削顶，浅橙黄会糊成奶白。
      if (isMouse) {
        predCol[k] = 0.95;
        predCol[k + 1] = 0.50 + 0.26 * kk;
        predCol[k + 2] = 0.16 + 0.18 * kk;
      } else {
        predCol[k] = 0.72;
        predCol[k + 1] = 0.15 + 0.28 * kk;   // 0.15（深橙）→ 0.43（浅橙黄）
        predCol[k + 2] = 0.03 + 0.13 * kk;   // 0.03 → 0.16
      }

      // 扑击瞬间箭头放大脉冲，与冲击波同步；玩家驾驶的那只再略大一圈，
      // 和 AI 猛禽混在一起时也能一眼找到自己。
      const pulse = Math.max(0, 1 - (now - predPulseAt[p]) / 280);
      predSiz[p] = predLeg() * (isMouse ? 1.12 : 1) * (1 + 0.32 * pulse);
    }
  } else {
    for (const ring of threatRings) ring.visible = false;
  }

  // 捕杀三段动画，节拍与 predate() 的三段音一致
  for (const b of killBursts) {
    if (!b.active) continue;
    const age = now - b.born;
    if (age >= BURST_MS) {
      b.active = false;
      for (const o of [b.core, b.inner, b.outer, b.sparks]) o.visible = false;
      continue;
    }
    // 第一段 0ms：亮核闪灭（撞击音）
    const cu = Math.min(1, age / 160);
    b.core.position.set(b.x, b.y, 0.3);
    b.core.quaternion.copy(camera.quaternion);
    b.core.scale.setScalar(0.25 + 1.35 * cu);
    b.core.material.opacity = Math.pow(1 - Math.min(1, age / 260), 2);

    // 第二段 90ms：内环扩张（撕裂音）
    const ia = age - 90;
    if (ia > 0) {
      const iu = Math.min(1, ia / 420);
      b.inner.position.set(b.x, b.y, 0.2);
      b.inner.quaternion.copy(camera.quaternion);
      b.inner.scale.setScalar(0.35 + 2.6 * (1 - Math.pow(1 - iu, 3)));
      b.inner.material.opacity = 0.85 * (1 - iu);
    } else b.inner.material.opacity = 0;

    // 第三段 240ms：外环余波（低沉尾音）
    const u = age / BURST_MS;
    const ease = 1 - Math.pow(1 - u, 3);
    b.outer.position.set(b.x, b.y, 0.1);
    b.outer.quaternion.copy(camera.quaternion);
    b.outer.scale.setScalar(0.5 + 5.0 * ease);
    b.outer.material.opacity = 0.75 * Math.pow(1 - u, 1.4);

    // 火花：随内环一起飞散
    const sa = age - 90;
    if (sa > 0 && sa < 560) {
      const su = sa / 560, se = 1 - Math.pow(1 - su, 2);
      const arr = b.sparks.geometry.attributes.position.array;
      for (let s = 0; s < SPARKS; s++) {
        const r = 0.4 + 5.2 * se;
        arr[s * 3] = b.x + b.dirs[s * 2] * r;
        arr[s * 3 + 1] = b.y + b.dirs[s * 2 + 1] * r;
        arr[s * 3 + 2] = 0.25;
      }
      b.sparks.geometry.attributes.position.needsUpdate = true;
      b.sparks.material.opacity = 0.9 * (1 - su);
      b.sparks.visible = true;
    } else b.sparks.visible = false;
  }

  const pT2 = performance.now();
  // GPU 计时：先收上一次的（就绪才读），再给这一帧包一层。
  gpuQueryPoll();
  gpuQueryBegin();
  renderer.render(scene, camera);
  gpuQueryEnd();
  const pT3 = performance.now();

  fxFlash.sprint = Math.max(0, fxFlash.sprint - dt * 2.6);
  fxFlash.birth = Math.max(0, fxFlash.birth - dt * 2.6);
  fxFlash.predate = Math.max(0, fxFlash.predate - dt * 3);
  hudTimer += dt;
  if (hudTimer > 0.1) {
    hudTimer = 0;
    const $ = (id) => document.getElementById(id);
    const fxOn = audio.enabled && !audio.muted;

    // 主导状态徽标：一眼看出「现在整群在干什么」，比九个静态数字有看点
    let st = '自由巡航', cls = 'st-cruise';
    let sub = 'Φ ' + orderParam.toFixed(2) + ' · 三条局部规则正在自组织';
    if (sprintingCount > Math.max(6, activeCount * 0.02)) {
      st = '逃逸涟漪'; cls = 'st-flee';
      sub = sprintingCount + ' 只冲刺中 · 涟漪从猛禽身边扩散';
    } else if (groupAlert) {
      st = '群体警戒'; cls = 'st-alert'; sub = '猛禽进入群体感知范围';
    } else if (restingCount > activeCount * 0.10) {
      st = '草地休憩'; cls = 'st-rest'; sub = restingCount + ' 只在草上停稳';
    } else if (cohesion01 > 0.42) {
      st = '紧密成团'; cls = 'st-flock'; sub = '对齐与聚合压过了分离';
    } else if (orderParam > 0.62) {
      st = '同向齐飞'; cls = 'st-align'; sub = '局部对齐在整群上放大';
    }
    $('hState').textContent = st;
    $('hState').className = 'state-badge ' + cls;
    $('hStateSub').textContent = sub;

    // ρ 与音乐聚集度的 9 秒曲线
    sparkPush(density, fxOn && music.running ? music.smooth : 0);
    drawSpark();
    $('hDensity').textContent = density.toFixed(2);
    $('hTemp').textContent = temperature.toFixed(2);
    $('hPress').textContent = pressure.toFixed(2);
    $('hOrderBar').style.width = (orderParam * 100).toFixed(0) + '%';
    $('hOrder').textContent = orderParam.toFixed(2);
    $('hSpeed').textContent = avgSpeed.toFixed(1);
    $('hRadius').textContent = groupRms.toFixed(1);
    $('hNeigh').textContent = avgNeighbors.toFixed(1);
    $('hSprint').textContent = sprintingCount;
    // 三个速率：把累计量的增量塞进当前 100ms 桶
    rateAdvance(now);
    rateAdd(0, teleportCount - prevTeleports);
    rateAdd(1, sprintCount - prevSprints);
    rateAdd(2, restSessions - prevRests);
    prevTeleports = teleportCount; prevSprints = sprintCount; prevRests = restSessions;
    setStat('hCatch', predCatches);
    setStat('hPort', rateSum(0));
    setStat('hBurst', rateSum(1));
    setStat('hRest', rateSum(2));
    $('hPort').title = '近 1 秒穿墙 ' + rateSum(0) + ' 次（累计 ' + teleportCount + '）';
    $('hBurst').title = '近 1 秒爆发 ' + rateSum(1) + ' 次（累计 ' + sprintCount + '）';
    $('hRest').title = '近 1 秒落地 ' + rateSum(2) + ' 次（累计 ' + restSessions + '）· 当前 ' + restingCount + ' 只在草上';
    $('hFps').textContent = Math.round(fps) + ' FPS';
    $('hSprintFx').className = 'dot' + (fxOn && fxFlash.sprint > 0.35 ? ' sprint' : '');
    $('hPredFx').className = 'dot' + (fxOn && fxFlash.predate > 0.35 ? ' pred' : '');
    $('hBirthFx').className = 'dot' + (fxOn && fxFlash.birth > 0.35 ? ' birth' : '');

    // 运行模式：以「这一帧到底有没有真的在用 Worker」为准，而不是只看开关——
    // 个体数低于并行阈值、或已经超时回退时，开关是开的但实际在跑单核。
    const mcLive = MC.enabled && MC.workers.length > 0 && activeCount >= MC.minN;
    const modeEl = $('hMode');
    const modeText = mcLive ? '多核 ×' + MC.workers.length : '单核';
    if (modeEl.textContent !== modeText) modeEl.textContent = modeText;
    modeEl.className = 'pc-mode' + (mcLive ? ' mc' : '');
    modeEl.title = mcLive
      ? `多核：${MC.workers.length} 个后台线程并行算邻域受力｜各线程合计 ${perfParts.force.toFixed(1)}ms，真实并行墙钟 ${MC.lastWall.toFixed(1)}ms`
      : (MC.enabled
        ? `单核：当前 ${activeCount} 只，低于并行阈值 ${MC.minN} 只`
        : '单核：多核加速已关闭，或当前环境不支持 Worker');
    // CPU = 主线程整帧耗时 / 60fps 预算；GPU = 显卡渲染耗时 / 同一预算。
    // 没有 GPU 计时扩展时用「渲染提交耗时」兜底，数字前加 ~ 标明是估算。
    setMeter('hCpuBar', 'hCpu', perf.cpu / FRAME_BUDGET * 100, false);
    setMeter('hGpuBar', 'hGpu', perf.gpu / FRAME_BUDGET * 100, !(gpuTimer && gpuTimer.ok));
  }
  // 帧内分段耗时（EMA 平滑）：step=Boids 仿真、prep=着色/平滑与实例数据上传、draw=渲染提交。
  // 两个 performance.now() 每段的开销在微秒级，不影响帧率；FlockLab.perf 可读。
  const w = 0.05;
  perf.step += ((pT1 - pT0) - perf.step) * w;
  perf.prep += ((pT2 - pT1) - perf.prep) * w;
  perf.draw += ((pT3 - pT2) - perf.draw) * w;
  // 状态卡上的两根条：CPU 取主线程整帧耗时，GPU 取计时查询（没有扩展时用提交耗时兜底）。
  // GPU 采样本来就是隔帧的，收敛放慢一点免得数字乱跳。
  perf.cpu += ((pT3 - pT0) - perf.cpu) * w;
  perf.gpu += ((gpuTimer ? gpuTimer.ms : (pT3 - pT2)) - perf.gpu) * (gpuTimer ? 0.14 : w);
}

addEventListener('resize', () => {
  updateOrthoFrustum();
  renderer.setSize(innerWidth, innerHeight);
  bgMat.uniforms.uHalf.value.set(innerWidth, innerHeight);
  backdrop.setViewport(innerWidth, innerHeight);   // 窗口变了就重画地貌纹理
  dustMat.uniforms.uPR.value = Math.min(2, devicePixelRatio || 1);
  const bdDust = bounds2D();
  dustMat.uniforms.uHalf.value.set(bdDust.hx, bdDust.hy);
  // 场地宽度随屏幕比例变化：草地若被挤到场地外，就重新长一次
  const bd = bounds2D();
  const out = grass.some((g) => Math.abs(g.x) + g.R * 1.2 > bd.hx || Math.abs(g.y) + g.R * 1.2 > bd.hy);
  if (out) { liftAllResting(); buildGrass(); }
});

// 存档恢复后同步 HUD 上的初始数量
document.getElementById('hCount').textContent = activeCount;
document.getElementById('hPred').textContent = params.predatorOn ? activeP : '0';
requestAnimationFrame(render);

window.FlockLab = {
  params, defaults: DEFAULTS, resetBoids, resetAll: applyDefaults, setCount, setPredCount, spawnBurst,
  saveParams,
  backdrop,   // 背景地貌层（调试时可改 uniforms.uGain 看形状）
  // 穿墙概率恒为 1：墙不存在，越界一律从关于中心对称的位置出现（v38 起无概率、无反射）
  get portalChance() { return 1; },
  get teleports() { return teleportCount; },
  get predShape() {
    return { leg: +predLeg().toFixed(3), base: +predBase().toFixed(3), birdExtent: +birdExtent().toFixed(3), scale: PRED_SCALE };
  },
  // 反应延迟：near/far 为贴身与感知圈边缘所需毫秒数，jitter 是个体系数范围
  get reaction() {
    return { nearMs: REACT_NEAR_MS, farMs: REACT_FAR_MS, jitter: [0.78, 1.32], pending: Array.from(alertMs.slice(0, activeCount)).filter((v) => v > 0).length };
  },
  get sprintingPositions() {
    const t = performance.now(), out = [];
    for (let i = 0; i < activeCount; i++) {
      if (sprintUntil[i] > t && !caught[i]) out.push({ x: +pos[i * 3].toFixed(2), y: +pos[i * 3 + 1].toFixed(2) });
    }
    return out;
  },
  get maxAbsZ() {
    let m = 0;
    for (let i = 0; i < activeCount; i++) m = Math.max(m, Math.abs(pos[i * 3 + 2]));
    return +m.toFixed(4);
  },
  get xyExtent() {
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (let i = 0; i < activeCount; i++) {
      const k = i * 3;
      mnx = Math.min(mnx, pos[k]); mxx = Math.max(mxx, pos[k]);
      mny = Math.min(mny, pos[k + 1]); mxy = Math.max(mxy, pos[k + 1]);
    }
    return { x: [+mnx.toFixed(1), +mxx.toFixed(1)], y: [+mny.toFixed(1), +mxy.toFixed(1)] };
  },
  get view() { return { x: view2D.x, y: view2D.y, zoom: view2D.zoom }; },
  // 当前摇晃的瞬时量（世界单位 / 弧度 / 缩放系数），验证幅度用。
  get viewShakeNow() { return { x: SHAKE.x, y: SHAKE.y, roll: SHAKE.roll, zoom: SHAKE.zoom, t: SHAKE.t }; },
  // 屏幕（clientX/Y）→ 世界坐标。已经含摇晃的平移/倾斜/缩放，验证鼠标对准用。
  screenToWorld: (cx, cy) => screenToWorld(cx, cy),
  // 世界 → 屏幕。走引擎自己的投影矩阵，不依赖上面那套手写公式，
  // 所以可以拿来交叉校验 screenToWorld 的符号与量级（摇晃一改就要重验）。
  projectToScreen: (x, y) => {
    const v = new THREE.Vector3(x, y, 0).project(camera);
    const rect = cv.getBoundingClientRect();
    return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height };
  },
  // 渲染抖动开关（只影响画法，不影响仿真）：0 = 旧的等大等向画法，用于对比密集处的栅格感。
  get renderJitter() { return RENDER_JIT; },
  set renderJitter(v) { RENDER_JIT = v ? 1 : 0; return RENDER_JIT; },
  get displayRect() {
    const { hx, hy } = bounds2D();
    return { hx: +hx.toFixed(2), hy: +hy.toFixed(2) };
  },
  get orthoHalfH() { return +((orthoCam.top - orthoCam.bottom) / 2).toFixed(2); },
  get count() { return activeCount; },
  get gridDebug() {
    const last = cellEnd.length ? cellEnd[cellEnd.length - 1] : -1;
    return {
      w: gridW, h: gridH, x0: gridX0, y0: gridY0, cells: cellStart.length,
      filled: last, item0: cellItems[0],
      fc: { w: forceCtx.gridW, h: forceCtx.gridH, x0: forceCtx.gridX0, cell: forceCtx.cell,
            cs: forceCtx.cellStart.length, items: forceCtx.cellItems.length,
            per2: forceCtx.per2, sepCap: forceCtx.sepCap, n: forceCtx.n, same: forceCtx.cellStart === cellStart }
    };
  },
  get multiCore() {
    return {
      enabled: MC.enabled, workers: MC.workers.length, reason: MC.reason,
      // live：这一帧实际走的是不是 Worker 路径（个体数低于阈值时开关开着也是单核）
      live: MC.enabled && MC.workers.length > 0 && activeCount >= MC.minN,
      minN: MC.minN, count: activeCount,
      cores: navigator.hardwareConcurrency || 0,
      lastWall: +MC.lastWall.toFixed(2), budget: MC.timeoutMs
    };
  },
  setMultiCore(on) { return setMultiCore(on); },
  get version() { return { version: VERSION, commit: COMMIT, buildTime: BUILD_TIME, author: AUTHOR }; },
  get paused() { return !!params.paused; },
  get sepCap() { return sepCapFor(activeCount); },
  set sepCap(v) { dbgSepCap = Math.max(0, Math.round(v)); return sepCapFor(activeCount); },
  // 局部密度（颜色色阶）的分位数：验证色相是否铺满青蓝→紫，而不是卡在一处。
  get localDenStats() {
    const v = [];
    for (let i = 0; i < activeCount; i++) if (!caught[i] && !resting[i]) v.push(localDen[i]);
    if (!v.length) return null;
    v.sort((a, b) => a - b);
    const q = (f) => +v[Math.min(v.length - 1, (v.length * f) | 0)].toFixed(3);
    return { n: v.length, p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
  },
  get velocities() { return Array.from(vel.slice(0, activeCount * 3)); },
  get renderVelocities() { return Array.from(rVel.slice(0, activeCount * 3)); },
  get predatorCount() { return params.predatorOn ? activeP : 0; },
  // ---- 鼠标捕食者（玩家驾驶的那只，独立于 AI 捕食者计数）----
  get mouseHunter() { return mouseHunter; },
  setMouseHunter(on) { setMouseHunter(!!on); return mouseHunter; },
  // 与 GUI 走同一条路径（改数量 / 开关后同步绘制数量与鼠标槽位），供自动化验证
  setPredatorCount(n) { setPredCount(n); return activeP; },
  // 同上：开关草地走 GUI 回调的同一条路径（关掉时同步起飞 + 清掉排队/争斗态）
  setGrassOn(on) {
    params.grassOn = !!on;
    syncGrassVisibility();
    if (!on) liftAllResting();
    return params.grassOn;
  },
  setPredatorOn(on) {
    params.predatorOn = !!on;
    if (on) { initPredators(0, activeP); predTarget.fill(-1); predLockUntil.fill(0); }
    syncPredDraw();
    return params.predatorOn;
  },
  toWorld: (cx, cy) => screenToWorld(cx, cy),
  get mousePredator() {
    const slot = predBaseCount();
    const q = slot * 3;
    return {
      active: mouseHunter, slot,
      x: +predPos[q].toFixed(2), y: +predPos[q + 1].toFixed(2),
      vx: +predVel[q].toFixed(2), vy: +predVel[q + 1].toFixed(2),
      speed: +Math.hypot(predVel[q], predVel[q + 1]).toFixed(2),
      dirDeg: +(Math.atan2(mouseDirY, mouseDirX) * 180 / Math.PI).toFixed(1),
      target: { x: +mouseTgt.x.toFixed(2), y: +mouseTgt.y.toFixed(2) },
      size: +predSiz[slot].toFixed(3),
      drawCount: predGeo.instanceCount,
      cursor: getComputedStyle(cv).cursor,
    };
  },
  get predatorPositions() {
    return Array.from({ length: params.predatorOn ? activeP : 0 }, (_, p) => ({
      x: +predPos[p * 3].toFixed(2), y: +predPos[p * 3 + 1].toFixed(2), z: +predPos[p * 3 + 2].toFixed(2)
    }));
  },
  get catches() { return predCatches; },
  get newbornCount() {
    const now = performance.now();
    let c = 0;
    for (let i = 0; i < activeCount; i++) if (now - birthAt[i] < BIRTH_TOTAL_MS) c++;
    return c;
  },
  get activeBursts() { return killBursts.filter((b) => b.active).length; },
  get sprintCount() { return sprintCount; },
  get sprintingCount() { return sprintingCount; },
  get trailCount() { return trailGeo.instanceCount; },
  get restingCount() { return restingCount; },
  get orderParam() { return +orderParam.toFixed(3); },
  get groupAlert() { return groupAlert; },
  get restSessions() { return restSessions; },
  // 本帧最近一对个体的间距：验证「鸟不会叠在一起」。身体半宽约 arrowSize(0.25)，
  // 低于 0.1 基本就是穿模了。修好分离力后实测稳定在 0.15~0.4。
  get minNeighborDist() {
    return minPairD2 === Infinity ? null : +Math.sqrt(minPairD2).toFixed(3);
  },
  // 每只鸟到最近邻的距离分布：判断「视觉上是不是叠在一起」。
  // 箭头宽约 0.5，所以 below05（<0.5 的比例）就是「看起来重叠」的鸟占比；
  // below03 是明显穿模。期望 p50 > 0.7、below05 < 0.2。
  get sepStats() {
    const v = [];
    for (let i = 0; i < activeCount; i++) {
      if (caught[i]) continue;
      const d2 = nearD2A[i];
      if (d2 > 1e-10) v.push(Math.sqrt(d2));
    }
    if (!v.length) return null;
    v.sort((a, b) => a - b);
    const q = (f) => +v[Math.min(v.length - 1, (v.length * f) | 0)].toFixed(3);
    const frac = (lim) => +(v.filter((x) => x < lim).length / v.length).toFixed(3);
    return { n: v.length, p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), below03: frac(0.3), below05: frac(0.5) };
  },
  // 草地容量与休息排队：验证「每只鸟都能在规定时间内休息到」。
  // waiting = 正在排队等位的鸟（restWaitFrom 已记但还没抢到位）；
  // contendingN = 已经变红在争夺地盘的鸟；evicted = 累计被请走的次数。
  get grassStats() {
    const patches = grass.map((p) => ({
      x: +p.x.toFixed(1), y: +p.y.toFixed(1), R: +p.R.toFixed(1),
      cap: p.cap, count: p.count, settled: [...p.members].filter((j) => settled[j]).length
    }));
    const t = performance.now();
    let waiting = 0, contendingN = 0, waitMax = 0;
    for (let i = 0; i < activeCount; i++) {
      if (caught[i]) continue;
      if (!resting[i] && restWaitFrom[i] !== Infinity) {
        waiting++;
        if (t - restWaitFrom[i] > waitMax) waitMax = t - restWaitFrom[i];
      }
      if (contending[i]) contendingN++;
    }
    return { patches, waiting, contending: contendingN, resting: restingCount, evicted: restEvictCount, waitMaxMs: Math.round(waitMax) };
  },
  get hudPinned() { return hudEl.classList.contains('pinned'); },
  // 作息相位分布：验证出发 / 离场时间确实被逐只打散
  get restPhaseStats() {
    let lo = 1, hi = 0, sum = 0;
    for (let i = 0; i < activeCount; i++) {
      const v = restPhase[i]; lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v;
    }
    return { min: +lo.toFixed(3), max: +hi.toFixed(3), mean: +(sum / activeCount).toFixed(3) };
  },
  // 未来 10 秒内任意 0.5s 窗口里，最多有多少只鸟的「出发去休息 / 离开草地」挤在一起。
  // 错峰生效后这个数应该是个位数，而不是几十上百。
  get grassBunch() {
    const now = performance.now();
    let startMax = 0, endMax = 0;
    for (let s = 0; s < 20; s++) {
      const t0 = now + s * 500, t1 = t0 + 500;
      let a = 0, b = 0;
      for (let i = 0; i < activeCount; i++) {
        if (caught[i]) continue;
        if (!resting[i] && restDue[i] >= t0 && restDue[i] < t1) a++;
        if (settled[i] && restUntil[i] >= t0 && restUntil[i] < t1) b++;
      }
      startMax = Math.max(startMax, a); endMax = Math.max(endMax, b);
    }
    return { startMax, endMax, frameStartMax: waveStartMax, frameEndMax: waveEndMax };
  },
  // 休息质量诊断：最小间距、换过位置的个体数、最长停留
  get flyLandings() { return flyLandings; },
  get restStats() {
    const now = performance.now();
    let minSep = Infinity, moved = 0, maxDwell = 0, settledN = 0;
    for (const gp of grass) {
      const members = [];
      for (const i of gp.members) if (settled[i]) members.push(i);
      settledN += members.length;
      for (const i of members) {
        const dwell = now - restSince[i];
        if (dwell > maxDwell) maxDwell = dwell;
        if (restMoves[i] > 0) moved++;
      }
      for (let a = 0; a < members.length && a < 200; a++) {
        for (let b = a + 1; b < members.length && b < 200; b++) {
          const i = members[a], j = members[b];
          const dx = pos[i * 3] - pos[j * 3], dy = pos[i * 3 + 1] - pos[j * 3 + 1];
          const d = Math.hypot(dx, dy);
          if (d < minSep) minSep = d;
        }
      }
    }
    return { settled: settledN, minSep: +minSep.toFixed(2), moved, maxDwellSec: +(maxDwell / 1000).toFixed(1) };
  },
  get grassRest() {
    let traveling = 0, still = 0;
    for (let i = 0; i < activeCount; i++) {
      if (caught[i]) continue;
      if (settled[i]) still++;
      else if (resting[i]) traveling++;
    }
    return { traveling, settled: still };
  },
  get grassInfo() {
    return grass.map((g) => ({ x: +g.x.toFixed(1), y: +g.y.toFixed(1), R: +g.R.toFixed(1), area: Math.round(g.area), cap: g.cap, count: g.members.size }));
  },
  // 正在「飞越草地」的个体数（不含休息中的）：用来验证绕行是否生效
  get flyingOverGrass() {
    let n = 0;
    for (let i = 0; i < activeCount; i++) {
      if (resting[i] || caught[i]) continue;
      const x = pos[i * 3], y = pos[i * 3 + 1];
      for (const gp of grass) {
        const dx = x - gp.x, dy = y - gp.y;
        const th = Math.atan2(dy, dx);
        const rr = gp.R * (1 + gp.a1 * Math.sin(3 * th + gp.p1) + gp.a2 * Math.sin(5 * th + gp.p2));
        if (Math.hypot(dx, dy) < rr * 0.96) { n++; break; }
      }
    }
    return n;
  },
  // 草地「落在场地内」的总面积占屏幕的比例（目标 0.15，实测口径）
  get grassRatio() {
    if (!grass.length) return 0;
    const bd = bounds2D();
    const sum = grass.reduce((a, g) => a + inFieldArea(g, g.R, bd, 900), 0);
    return +(sum / (2 * bd.hx * 2 * bd.hy)).toFixed(3);
  },
  // 尾迹粒子的「历史长度」：沿航迹最老那颗到最新那颗的距离。
  // 转弯时它应该明显大于首尾直线距离（说明粒子是沿弧线铺开的，不是一条直线）。
  get trailStats() {
    const now = performance.now();
    let live = 0, oldest = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < MAX_TRAILS; i++) {
      const age = (now - trBirth[i]) / Math.max(1, trLife[i]);
      if (age < 0 || age >= 1) continue;
      live++;
      if (age > oldest) oldest = age;
      const x = trPos[i * 2], y = trPos[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return {
      live, oldestAge: +oldest.toFixed(2),
      spanX: live ? +(maxX - minX).toFixed(2) : 0,
      spanY: live ? +(maxY - minY).toFixed(2) : 0,
      capacity: MAX_TRAILS
    };
  },
  // 体色与冷却状态：g 分量 0.30=深橙（随时能扑），0.78=浅橙黄（刚吃饱）
  get predatorColors() {
    return Array.from({ length: params.predatorOn ? activeP : 0 }, (_, p) => ({
      g: +predCol[p * 3 + 1].toFixed(2), b: +predCol[p * 3 + 2].toFixed(2),
      cooling: (performance.now() - predFeedAt[p]) < params.feedCooldown * 1000
    }));
  },
  // 警戒圈状态：heat 0=饱食（暗色圈）1=捕食阶段（亮色圈）；
  // alpha 始终 > 0、visible 始终为 true —— 圈不会因为吃饱就被藏起来。
  get ringState() {
    return Array.from({ length: params.predatorOn ? activeP : 0 }, (_, p) => ({
      heat: +predHeat[p].toFixed(2),
      alpha: +threatRings[p].material.uniforms.uAlpha.value.toFixed(3),
      visible: threatRings[p].visible
    }));
  },
  get predatorTrail() {
    return Array.from({ length: params.predatorOn ? activeP : 0 }, (_, p) => ({
      accel: +predAccel[p].toFixed(1), power: +predTrailP[p].toFixed(2), amt: +predTrailAmt[p].toFixed(2)
    }));
  },
  // 最近生成的几颗粒子：用来验证「每颗粒子位置固定、朝向是生成瞬间的航向」
  get trailSample() {
    const now = performance.now();
    const out = [];
    for (let k = 0; k < Math.min(4, MAX_TRAILS); k++) {
      const i = (trailCursor - 1 - k + MAX_TRAILS * 2) % MAX_TRAILS;
      const age = (now - trBirth[i]) / Math.max(1, trLife[i]);
      out.push({
        pos: [+trPos[i * 2].toFixed(2), +trPos[i * 2 + 1].toFixed(2)],
        dir: [+trDir[i * 2].toFixed(2), +trDir[i * 2 + 1].toFixed(2)],
        age: +age.toFixed(2),
        len: +trLen[i].toFixed(2), wid: +trWid[i].toFixed(3)
      });
    }
    return out;
  },
  get recoveringCount() {
    let c = 0;
    for (let i = 0; i < activeCount; i++) if (stamina[i] < 1) c++;
    return c;
  },
  get avgStamina() {
    let s = 0;
    for (let i = 0; i < activeCount; i++) s += stamina[i];
    return +(s / activeCount).toFixed(3);
  },
  get sprintWindowMs() {
    let m = 0;
    const now = performance.now();
    for (let i = 0; i < activeCount; i++) m = Math.max(m, sprintUntil[i] - now);
    return Math.round(m);
  },
  get sprintDeadlines() { return Array.from(sprintUntil.slice(0, activeCount)); },
  get predatorTargets() {
    return Array.from({ length: params.predatorOn ? activeP : 0 }, (_, p) => predTarget[p]);
  },
  get predatorDrawCount() { return predGeo.instanceCount; },
  get muted() { return audio.muted; },
  music,
  get perf() {
    return {
      step: +perf.step.toFixed(2), prep: +perf.prep.toFixed(2), draw: +perf.draw.toFixed(2),
      cpu: +perf.cpu.toFixed(2), gpu: +perf.gpu.toFixed(2),
      // 压力条用的百分比：以 60fps 帧预算为 100%
      cpuPct: Math.round(perf.cpu / FRAME_BUDGET * 100), gpuPct: Math.round(perf.gpu / FRAME_BUDGET * 100),
      gpuMeasured: !!(gpuTimer && gpuTimer.ok),
      total: +(perf.step + perf.prep + perf.draw).toFixed(2),
      grid: +perfParts.grid.toFixed(2), force: +perfParts.force.toFixed(2), loop: +perfParts.loop.toFixed(2),
      stats: +perfParts.stats.toFixed(2), color: +perfParts.color.toFixed(2),
      fps: +fps.toFixed(1), count: activeCount
    };
  },
  get musicState() {
    return {
      running: music.running, c: +music.smooth.toFixed(3), tension: +music.tension.toFixed(3),
      gain: music.nodes ? +music.nodes.bus.gain.value.toFixed(4) : 0,
      bassLayer: music.nodes ? {
        gate: +music.nodes.bassGate.gain.value.toFixed(3),
        gain: +music.nodes.bassGain.gain.value.toFixed(5)
      } : null,
      orbitLayer: music.nodes ? {
        gain: +music.nodes.orbitGain.gain.value.toFixed(5),
        pan: music.nodes.orbitPan ? +music.nodes.orbitPan.pan.value.toFixed(3) : null
      } : null,
      ...music.counts
    };
  },
  get audioState() { return audio.ctx ? audio.ctx.state : null; },
  get masterGain() { return audio.master ? +audio.master.gain.value.toFixed(4) : null; },
  get audioOutputConnected() { return audio.outputConnected; },
  get soundEvents() { return { ...audio.total }; },
  // 休息 / 争斗状态的逐只快照：排查「草地上的红鸟左右乱闪」这类问题用。
  // resting=在去草地的路上或已停稳；settled=真的停稳了；c=争斗红；dd=到落点距离
  restDebug() {
    const now = performance.now();
    const out = [];
    for (let i = 0; i < activeCount; i++) {
      if (!resting[i] && !contending[i]) continue;
      const k = i * 3;
      const tx = restTgt[i * 2], ty = restTgt[i * 2 + 1];
      out.push({
        i, patch: restPatch[i],
        x: +pos[k].toFixed(2), y: +pos[k + 1].toFixed(2),
        vx: +vel[k].toFixed(2), vy: +vel[k + 1].toFixed(2),
        r: resting[i], s: settled[i], c: contending[i], tries: restTries[i],
        dd: +Math.sqrt((tx - pos[k]) * (tx - pos[k]) + (ty - pos[k + 1]) * (ty - pos[k + 1])).toFixed(2),
        since: restSince[i] > 0 ? Math.round(now - restSince[i]) : 0,
      });
    }
    return out;
  },
  // 近 1 秒的传送 / 爆发 / 休憩次数（HUD 上显示的就是这三个）
  get rates() { return { teleport: rateSum(0), sprint: rateSum(1), rest: rateSum(2) }; },
  // 出生动画：还在「涌出」过程中的个体数（0 表示全部成形）
  get hatchPending() { let c = 0; for (let i = 0; i < activeCount; i++) if (growBuf[i] < 1) c++; return c; },
  // 调试 / 验证用：立刻让 n 只鸟原地重生（等价于被吃掉 1 秒后的补位），用来看出生动画
  respawn(n = 1) {
    const t = performance.now();
    for (let i = 0, k = 0; i < activeCount && k < n; i++) {
      if (caught[i]) continue;
      spawnFar(i, t); k++;
    }
    return n;
  },
  get uiHidden() { return document.body.classList.contains('ui-hidden'); },
  get cursorHidden() { return document.body.classList.contains('cursor-idle'); },
  get eyeFaded() { return uiBtn.classList.contains('faded'); },
  get fleeingCount() { let c = 0; for (let i = 0; i < activeCount; i++) c += fleeing[i]; return c; },
  get groupCenter() { return { x: +groupX.toFixed(2), y: +groupY.toFixed(2), z: +groupZ.toFixed(2) }; },
  get avgPredDist() {
    if (!params.predatorOn) return 0;
    let sum = 0;
    for (let i = 0; i < activeCount; i++) {
      let best = Infinity;
      for (let p = 0; p < activeP; p++) {
        const k = i * 3, q = p * 3;
        const dx = pos[k] - predPos[q], dy = pos[k + 1] - predPos[q + 1], dz = pos[k + 2] - predPos[q + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) best = d2;
      }
      sum += Math.sqrt(best);
    }
    return sum / activeCount;
  },
  get density() { return density; },
  get cohesion() { return +cohesion01.toFixed(3); },
  get wanderBase() { return WANDER_BASE; },
  set wanderBase(v) { WANDER_BASE = Math.max(0, Math.min(4, +v || 0)); },
  get groupRms() { return +groupRms.toFixed(2); },
  get temperature() { return temperature; },
  get pressure() { return pressure; },
  get impulse() { return collisionImpulse; },
  get avgNeighbors() { return avgNeighbors; },
  get avgSpeed() { return +avgSpeed.toFixed(3); },
  get paceSpeed() { return +currentPace.toFixed(3); },
  get deadCount() { let c = 0; for (let i = 0; i < activeCount; i++) c += caught[i]; return c; },
  get respawnDelays() {
    const now = performance.now();
    return Array.from({ length: activeCount }, (_, i) => caught[i] ? Math.max(0, Math.round(respawnAt[i] - now)) : 0);
  },
  get catchRadius() { return +catchRadius().toFixed(2); },
  get predatorSpeeds() {
    return Array.from({ length: params.predatorOn ? activeP : 0 },
      (_, p) => +Math.hypot(predVel[p * 3], predVel[p * 3 + 1]).toFixed(2));
  },
  get predatorCaps() {
    return Array.from({ length: params.predatorOn ? activeP : 0 }, (_, p) => +predCap[p].toFixed(2));
  },
  get predatorCooling() {
    const now = performance.now();
    const cd = params.feedCooldown * 1000;
    return Array.from({ length: params.predatorOn ? activeP : 0 },
      (_, p) => Math.max(0, Math.round(cd - (now - predFeedAt[p]))));
  },
  get capSample() { return Array.from(capNow.slice(0, 8)).map((v) => +v.toFixed(2)); },
  get bound() { return BOUND; },
  // 长程归拢的两个常数（调参用）：半径内不受力，半径外按超出比例拉回群体质心。
  get flockKeep() { return { r: FLOCK_KEEP_R, f: FLOCK_KEEP_F }; },
  setFlockKeep(r, f) {
    FLOCK_KEEP_R = Math.max(1, +r); FLOCK_KEEP_F = Math.max(0, +f);
    return { r: FLOCK_KEEP_R, f: FLOCK_KEEP_F };
  },
  get positions() {
    return Array.from({ length: activeCount }, (_, i) => ({
      x: +pos[i * 3].toFixed(2), y: +pos[i * 3 + 1].toFixed(2),
      born: birthAt[i] === -Infinity ? 0 : Math.round(birthAt[i]),
      dead: !!caught[i]
    }));
  },
  get sprintSoundDuration() { return audio.lastSprintDur; }
};
  