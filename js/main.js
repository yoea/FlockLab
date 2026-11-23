
import { FlockAudio, FlockMusic } from './audio.js';
import { createGrass } from './grass.js';

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
const MAX_N = 50000;
const MAX_P = 10;              // AI 捕食者上限（GUI 可调范围）
// 鼠标捕食者单独占一个数组槽位（索引 = 当前 AI 捕食者数量），所以要多留一格。
// GUI 的「捕食者数量」仍以 MAX_P 为上限，两者互不挤占。
const MAX_SLOT = MAX_P + 1;
// 鼠标捕食者的捕食冷却：人控制时移动极快，沿用 AI 那套长冷却会完全吃不到东西。
// 90ms ≈ 每秒最多 11 只：快速划过鸟群会留下一串小爆发，又不至于一下清空全场
// （被吃的个体 1 秒后照常重生，数量会自动补回来）。
const MOUSE_FEED_MS = 90;
// 速度只用于箭头朝向与音效冲击量（位置完全由光标决定，没有速度上限），
// 夹到 60 是为了不让甩鼠标时音效爆表。
const MOUSE_VMAX = 60;
// 每只鸟只跟「最近的 7 只」打交道（拓扑式邻域，Ballerini 2008 测椋鸟约 7 只）：
// 不是看见多少算多少，而是按距离由近到远取满 7 个就停。这既符合真实鸟群的注意分配，
// 也让单帧配对量恒定在 7n（5 万只 = 35 万对），不再随密度平方级上升。
const NEIGHBOR_CAP = 7;
// 分段耗时探针（FlockLab.perf 可读）：定位「哪一段吃掉了这一帧」比猜有用。
const perfParts = { grid: 0, loop: 0, stats: 0, color: 0 };

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
  boundary: BOUND,
  arrowSize: 0.25,
  master: 0.38,
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
  // 音量直接就是增益（0~1.5，1.0 为标准响度），面板上看到的数字就是它：
  // 默认音乐 0.4（能听见但不会压住画面），音效 1.0。
  musicLevel: 0.4,
  fxLevel: 1.0,
  // 草地：场里长出 2~3 片草地，鸟会定期降落歇一会儿
  grassOn: true
};
// 运行时参数：先从 localStorage 恢复上次的调整结果，没有存档才用默认值。
const params = { ...DEFAULTS, enabled: false, paused: false };

// 只持久化「用户可调」的参数；enabled / paused 属于会话状态，不写入存档。
const PERSIST_KEYS = [
  'count', 'separation', 'alignment', 'cohesion', 'perception', 'separationRange',
  'flow', 'maxSpeed', 'minSpeed', 'arrowSize',
  'predatorOn', 'predatorCount', 'fleeWeight', 'fleeRange', 'predict',
  'chaseWeight', 'predSpeed', 'lockTime', 'feedCooldown', 'infoCascade',
  'sprintFactor', 'sprintDuration', 'sprintRecovery',
  'musicLevel', 'fxLevel', 'grassOn'
];
// v6：出厂默认值改为 对齐 1.8 / 视野 7 / 元素 800，音乐音量改回 0~1.5 增益刻度（默认 0.4）；
// 音量刻度与默认值都变了，旧存档不能沿用，否则刷新后仍是旧数值。
const STORE_KEY = 'flocklab.params.v6';
const PARAM_RANGE = {
  count: [10, MAX_N], separation: [0, 4], alignment: [0, 4], cohesion: [0, 4],
  perception: [1, 14], separationRange: [0.2, 6], flow: [0, 4],
  maxSpeed: [2, 18], minSpeed: [0.5, 8], arrowSize: [0.18, 0.9],
  predatorCount: [1, MAX_P], fleeWeight: [0, 6], fleeRange: [3, 24],
  predict: [0, 1.5], chaseWeight: [0, 4], predSpeed: [2, 36],
  lockTime: [0, 5], feedCooldown: [0.3, 60],
  sprintFactor: [1, 2.5], sprintDuration: [0.2, 3], sprintRecovery: [1, 12],
  musicLevel: [0, 1.5], fxLevel: [0, 1.5]
};
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function loadParams() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { saved = null; }
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
function saveParams() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = {};
      for (const key of PERSIST_KEYS) out[key] = params[key];
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch (_) { /* 隐私模式写不进去时静默忽略 */ }
  }, 120);
}

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
const fleeDir = new Float32Array(MAX_N * 3);   // 当前帧逃逸力方向
const prevFlee = new Float32Array(MAX_N * 3);  // 上一帧逃逸力，用于信息级联（传播带一帧延迟）
const fleeing = new Uint8Array(MAX_N);
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

// ---------------------------------------------------------------- 爆发拖尾
// 只有爆发中的个体才画拖尾。不做逐帧历史记录（万只时太贵），
// 而是给每只鸟维护「尾巴点」：尾巴用指数平滑追头部，稳态落后量 ≈ 速度 × τ，
// 所以尾巴长度自然随爆发速度变长，起爆瞬间从零快速拉长。
const trailHead = new Float32Array(MAX_N * 2);  // 头部（= 当前位置）
const trailTail = new Float32Array(MAX_N * 2);  // 尾巴（滞后点）
const trailAmt = new Float32Array(MAX_N);       // 拖尾强度 0~1，用于淡入淡出
const TRAIL_TAU = 0.115;                        // 尾巴跟随时间常数（秒）
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
let restSessions = 0;   // 累计完成的草地休憩次数（状态卡用）
let flyLandings = 0;   // 「掠过草地顺手落下」的次数（调试用）
const overGrass = new Uint8Array(MAX_N);            // 上一帧是否正在草地正上方（用于「掠过」判定）
const REST_SPACING = 1.5;                           // 草地上个体之间要保持的最小距离（≈6 个身位）
// 单次停留上限 60 秒：基础 28~50 秒 + 个体作息相位 0~10 秒。
// 相位让同批落地的鸟不会在同一秒集体起飞（拆分后这两个常量曾漏定义，务必保留）。
const REST_MAX_MIN = 28000, REST_MAX_SPAN = 22000, REST_PHASE_SPAN = 10000;
// 落点微调只用「速度积分走过去」，绝不直接写 pos——那一下就是肉眼可见的瞬移。
// 半径放大到 1.25 仍能保持连续：鸟会花 1~2 秒慢慢走过去，而不是一帧跳过去。
const REST_NUDGE_MIN = 0.45, REST_NUDGE_MAX = 1.25;
// 软错峰：每帧最多放行 2 只鸟「出发去草地」、1 只鸟「站定」。
// 不取消需求也不减少总次数，只把成群的同步动作摊成一条细流。
const REST_START_SOFT_CAP = 2, REST_SETTLE_SOFT_CAP = 1;
// 边界通行判定：靠近墙时先掷一次骰子决定「这次当墙不存在」还是「贴边掉头」。
// 只有掷中的人才真的会穿出去，其余会一直飞到边界旁再拐弯，不提前造软边界。
const wallPass = new Uint8Array(MAX_N);             // 1 = 这次撞墙当作没有墙（会穿出去）
const wallNear = new Uint8Array(MAX_N);             // 是否已进入「靠近墙」的判定区
const wallTurn = new Float32Array(MAX_N);           // 本次贴边往哪一侧沿墙拐（±1，进判定带时抽）
// ---------------------------------------------------------------- 个体差异
// 每只鸟带一点固定的「脾气」：速度系数不同、方向有自己的缓慢随机游走。
// 这是为了破除「整群像弹珠一样整齐移动」的机械感——但都仍是局部量，
// 不改变三条规则，所以群体的涌现结构不受影响，只是多了一层自然抖动。
const spdJit = new Float32Array(MAX_N);   // 个体速度系数 0.86 ~ 1.14
const wAng = new Float32Array(MAX_N);     // 个体游走航向（每帧小幅随机漂移）
const wAmp = new Float32Array(MAX_N);     // 个体游走强度 0.55 ~ 1.65
let WANDER_BASE = 1.6;                    // 游走基础力度（调试接口可改，用于对比手感）
function rollTraits(i) {
  spdJit[i] = 0.86 + Math.random() * 0.28;
  wAng[i] = Math.random() * Math.PI * 2;
  wAmp[i] = 0.55 + Math.random() * 1.1;
  reactJit[i] = 0.78 + Math.random() * 0.54;
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
const predTrailAmt = new Float32Array(MAX_SLOT);    // 拖尾强度 0~1
const predHeat = new Float32Array(MAX_SLOT);        // 饥饿度 0~1：决定警戒圈是暗色（饱食）还是亮色（捕食）
const predTrailTail = new Float32Array(MAX_SLOT * 2);
let PRED_TRAIL_REF = 45;                         // 加速度达到这个值即视为「全力冲刺」（实测中位数 12、峰值 64）
// 捕食者的个体差异：速度系数 + 追击时持续漂移的摆尾角度，让它不是一条死直线。
const predSpdJit = new Float32Array(MAX_SLOT);
const predWobble = new Float32Array(MAX_SLOT);
const predWallTurn = new Float32Array(MAX_SLOT);  // 贴边掉头时往哪一侧沿墙拐（±1）
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

const MAX_FORCE = 14;
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
// 传送门：靠近墙时先按 10% 判定该个体本次是否可穿墙；可穿者当墙不存在，
// 越界后按中心对称从对侧穿出；不可穿者一路飞到墙边再急转掉头，不在内侧另造软边界。
const PORTAL_P = 0.10;
let teleportCount = 0;
const PRED_FORCE = 24;
const PRED_SEP_RANGE2 = 6 * 6;
const PRED_SEP_FORCE = 34;
const COLLIDE_DIST = 0.55;
const COLLIDE_DIST2 = COLLIDE_DIST * COLLIDE_DIST;
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
    stamina[i] = 1; sprintUntil[i] = 0; capNow[i] = params.maxSpeed * 0.78;
    alertMs[i] = 0; trailAmt[i] = 0;
    resting[i] = 0; settled[i] = 0; restPatch[i] = -1;
    restSwapAt[i] = Infinity; restFleeAt[i] = Infinity;
    rollTraits(i);
    // 首次「想休息」的时刻铺到 3~35 秒（含个体相位），避免开局一波同时出发
    restDue[i] = performance.now() + 3000 + Math.random() * 22000 + restPhase[i] * 10000;
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
  stamina[i] = 1; sprintUntil[i] = 0; fleeing[i] = 0; capNow[i] = params.maxSpeed * 0.78;
  alertMs[i] = 0; trailAmt[i] = 0;
  trailTail[i * 2] = pos[k]; trailTail[i * 2 + 1] = pos[k + 1];
  resting[i] = 0; settled[i] = 0; restPatch[i] = -1;
  restSwapAt[i] = Infinity; restFleeAt[i] = Infinity;
  rollTraits(i);   // 重生等于换一只新个体：速度脾气、游走相位和作息相位都重新抽
  restDue[i] = now + 4000 + Math.random() * 20000 + restPhase[i] * 8000;
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
    predTrailTail[p * 2] = predPos[k]; predTrailTail[p * 2 + 1] = predPos[k + 1];
    predSpdJit[p] = 0.9 + Math.random() * 0.2;
    predWobble[p] = Math.random() * Math.PI * 2;
    predWallTurn[p] = Math.random() < 0.5 ? -1 : 1;
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
}
function setCount(v) {
  const next = Math.max(10, Math.min(MAX_N, Math.round(v)));
  if (next > activeCount) initBoids(activeCount, next);
  activeCount = next;
  params.count = next;
  arrowGeo.instanceCount = next;
  document.getElementById('hCount').textContent = next;
}

// ---------------------------------------------------------------- 场景
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070f);

const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
const camera = orthoCam;
// 视图：平移中心 + 缩放
const view2D = { x: 0, y: 0, zoom: 1, tZoom: 1 };
// 相机视野固定：世界半高＝活动范围，短边正好铺满屏幕；留 2% 边距让边界线可见。
const VIEW2D_MARGIN = 1.02;
function view2DFitHalfH() { return BOUND * VIEW2D_MARGIN; }
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, isTouch ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('scene').appendChild(renderer.domElement);

// 正交相机：视口按屏幕宽高比铺满，留少量安全边距；zoom 控制缩放。
let bgMesh = null;   // 背景渐变稍后才创建，先声明避免「用到未定义变量」
function updateOrthoFrustum() {
  const aspect = innerWidth / innerHeight;
  const halfH = view2DFitHalfH() / view2D.zoom;
  const halfW = halfH * aspect;
  orthoCam.left = -halfW; orthoCam.right = halfW;
  orthoCam.top = halfH; orthoCam.bottom = -halfH;
  orthoCam.updateProjectionMatrix();
  // 背景渐变挂在相机上，尺寸跟着视锥走，永远铺满视口
  if (bgMesh) {
    bgMesh.scale.set(halfW * 2.06, halfH * 2.06, 1);
  }
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

// 安全边界矩形（贴合屏幕宽高比）
const rectFrameGeo = new THREE.BufferGeometry();
rectFrameGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(4 * 3), 3));
const rectFrame = new THREE.LineLoop(rectFrameGeo, new THREE.LineBasicMaterial({
  color: 0x3b7fb4, transparent: true, opacity: 0.22, depthWrite: false
}));
rectFrame.frustumCulled = false;
scene.add(rectFrame);
function bounds2D() {
  // 高度固定为 BOUND，宽度按显示器比例展开 → 场地铺满全屏
  return { hx: BOUND * (innerWidth / innerHeight), hy: BOUND };
}
function updateRectFrame() {
  const { hx, hy } = bounds2D();
  const arr = rectFrameGeo.attributes.position.array;
  const pts = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  for (let i = 0; i < 4; i++) { arr[i * 3] = pts[i][0]; arr[i * 3 + 1] = pts[i][1]; arr[i * 3 + 2] = 0; }
  rectFrameGeo.attributes.position.needsUpdate = true;
}
updateRectFrame();

// ---------------------------------------------------------------- 背景点缀
// 纯粹是氛围：一层挂在相机上的极淡径向渐变 + 会缓慢漂移的尘埃点。
// 都压得很暗（亮度 0.01~0.06 量级），并且不参与任何仿真，不影响主体观感。
const bgGeo = new THREE.PlaneGeometry(1, 1);
const bgMat = new THREE.ShaderMaterial({
  uniforms: { uHalf: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform vec2 uHalf;
    void main() {
      vec2 p = (vUv - 0.5) * 2.0;              // -1~1
      float d = length(p * vec2(1.0, 0.85));
      // 中心微微亮一点的冷调，向外压暗，再叠一点极轻的右上暖光
      float core = smoothstep(1.15, 0.0, d);
      float warm = smoothstep(1.2, 0.2, length(p - vec2(0.55, 0.45)));
      // 注意：这里是线性空间，经过 colorspace_fragment 转 sRGB 后会被提亮，
      // 所以数值必须压到 0.003 量级，最终观感才是近黑的深蓝。
      vec3 col = mix(vec3(0.0030, 0.0042, 0.0072), vec3(0.0055, 0.0082, 0.0130), core);
      col += vec3(0.0035, 0.0022, 0.0014) * warm * 0.9;
      // 暗角：边缘再压一层，避免画面四周发灰
      col *= 0.72 + 0.28 * core;
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

// 尘埃：世界坐标里的一小把点，缓慢漂移 + 呼吸式明暗，撞到边界就绕回
const DUST_N = 260;
const dustPos = new Float32Array(DUST_N * 3);
const dustSeed = new Float32Array(DUST_N);
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3).setUsage(THREE.DynamicDrawUsage));
dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 1));
const dustMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uHalfH: { value: BOUND }, uPR: { value: 1 } },
  vertexShader: `
    attribute float aSeed;
    uniform float uTime;
    uniform float uPR;
    varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
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
}
seedDust();


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
  // 都满了：重试时间必须带随机抖动，否则所有被挡住的鸟会在同一秒再冲一次
  if (best < 0) {
    restDue[i] = time + 1800 + Math.random() * 4200 + restPhase[i] * 5000;
    return;
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
  gp.members.add(i); gp.count = gp.members.size;
  restSince[i] = 0;
  waveStart++;
  // 先给一段赶路时间；真正「开始休息」要等它到点并停稳（见 settled）
  const travel = Math.hypot(tx - pos[k], ty - pos[k + 1]) / Math.max(6, params.maxSpeed * 0.6);
  const approach = travel * 1000 + 15000 + restPhase[i] * 3000;
  restApproachUntil[i] = time + approach;
  restUntil[i] = time + approach;              // 到点后会重设成 28~60 秒
  // 下次出发：20~53 秒 + 个体相位，绝不与同批鸟同步
  restDue[i] = time + 20000 + Math.random() * 24000 + restPhase[i] * 9000;
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
  gp.members.add(i); gp.count = gp.members.size;
  waveStart++;
  restApproachUntil[i] = time + 2500;     // 已经在草地上方，很快就能停稳
  restUntil[i] = time + 2500;
  restDue[i] = time + 20000 + Math.random() * 24000 + restPhase[i] * 9000;
  flyLandings++;
  return true;
}
// 结束休息（起飞或被惊到）
// 关掉草地：所有正在休息的立刻起飞（不然它们会定在原地不动）
function liftAllResting() {
  const now = performance.now();
  for (let i = 0; i < activeCount; i++) if (resting[i]) endRest(i, now, false);
}
function syncGrassVisibility() {
  grassField.setVisible(params.grassOn);
}
function endRest(i, time, scared) {
  if (resting[i]) audio.takeoff();   // 离地
  const wasSettled = settled[i] === 1;
  resting[i] = 0; settled[i] = 0;
  restSwapAt[i] = Infinity; restFleeAt[i] = Infinity;
  const g = restPatch[i];
  if (g >= 0 && grass[g]) { grass[g].members.delete(i); grass[g].count = grass[g].members.size; }
  restPatch[i] = -1;
  waveEnd++;
  // 「必须停留至少 5 秒」：真正停稳过、且被吓走时待够了 5 秒，才算休成；
  // 没停稳（还在赶路）或没待够就被赶走，都当作这次没休成，隔几秒重来。
  // 两种重排都叠加个体作息相位，避免一批同时被惊走的鸟又约好一起回来。
  const dwell = wasSettled ? time - restSince[i] : 0;
  restDue[i] = (scared && dwell < 5000)
    ? time + 5000 + Math.random() * 9000 + restPhase[i] * 7000
    : time + 20000 + Math.random() * 24000 + restPhase[i] * 9000;
}

// ---------------------------------------------------------------- 草地
const grassField = createGrass({ THREE, scene, params, bounds2D });
const grass = grassField.patches;
const buildGrass = grassField.build;
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
arrowGeo.setAttribute('aPosition', aPos);
arrowGeo.setAttribute('aVelocity', aVel);
arrowGeo.setAttribute('aColor', aCol);
arrowGeo.setAttribute('aSize', aSiz);
arrowGeo.instanceCount = activeCount;

const arrowMat = new THREE.ShaderMaterial({
  uniforms: { uMaxSpeed: { value: params.maxSpeed } },
  vertexShader: `
    attribute vec2 aLocal;
    attribute vec3 aPosition;
    attribute vec3 aVelocity;
    attribute vec3 aColor;
    attribute float aSize;
    uniform float uMaxSpeed;
    varying vec2 vLocal;
    varying vec3 vColor;
    varying float vSpeed;
    varying float vFade;
    void main() {
      vLocal = aLocal;
      vColor = aColor;
      vSpeed = clamp(length(aVelocity) / uMaxSpeed, 0.0, 1.0);
      vec4 mv = modelViewMatrix * vec4(aPosition, 1.0);
      vec3 vv = (modelViewMatrix * vec4(aVelocity, 0.0)).xyz;
      float ang = atan(vv.y, vv.x);
      float cs = cos(ang), sn = sin(ang);
      vec2 lp = aLocal * aSize;
      mv.xy += vec2(lp.x * cs - lp.y * sn, lp.x * sn + lp.y * cs);
      vFade = 1.0 - smoothstep(45.0, 145.0, -mv.z);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    varying vec2 vLocal;
    varying vec3 vColor;
    varying float vSpeed;
    varying float vFade;
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
      float a = clamp(core + halo, 0.0, 1.0) * vFade;
      if (a < 0.004) discard;
      vec3 c = vColor * (0.85 + 0.70 * vSpeed) * (core + halo * 0.55);
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

// ---------------------------------------------------------------- 爆发拖尾
// 每条拖尾 = 一个实例四边形，从尾巴点拉到头点，沿长度收窄 + 加色发光。
// 只有爆发中的个体才写入实例（其余攒成 instanceCount = 0），所以常态零开销；
// 极端情况下并发爆发会超过上限，多出的直接丢弃（画面看不出来，也保护帧率）。
const MAX_TRAILS = 600;
const trailGeo = new THREE.InstancedBufferGeometry();
trailGeo.setAttribute('position', new THREE.Float32BufferAttribute([
  -1, -1, 0,  1, -1, 0,  1, 1, 0,  -1, 1, 0
], 3));
trailGeo.setAttribute('aLocal', new THREE.Float32BufferAttribute([
  -1, -1,  1, -1,  1, 1,  -1, 1
], 2));
trailGeo.setIndex([0, 1, 2, 0, 2, 3]);
const trHead = new Float32Array(MAX_TRAILS * 3);
const trTail = new Float32Array(MAX_TRAILS * 3);
const trCol = new Float32Array(MAX_TRAILS * 3);
const trWid = new Float32Array(MAX_TRAILS);
const trAlp = new Float32Array(MAX_TRAILS);
const aTrHead = new THREE.InstancedBufferAttribute(trHead, 3).setUsage(THREE.DynamicDrawUsage);
const aTrTail = new THREE.InstancedBufferAttribute(trTail, 3).setUsage(THREE.DynamicDrawUsage);
const aTrCol = new THREE.InstancedBufferAttribute(trCol, 3).setUsage(THREE.DynamicDrawUsage);
const aTrWid = new THREE.InstancedBufferAttribute(trWid, 1).setUsage(THREE.DynamicDrawUsage);
const aTrAlp = new THREE.InstancedBufferAttribute(trAlp, 1).setUsage(THREE.DynamicDrawUsage);
trailGeo.setAttribute('aHead', aTrHead);
trailGeo.setAttribute('aTail', aTrTail);
trailGeo.setAttribute('aColor', aTrCol);
trailGeo.setAttribute('aWidth', aTrWid);
trailGeo.setAttribute('aAlpha', aTrAlp);
trailGeo.instanceCount = 0;
const trailMat = new THREE.ShaderMaterial({
  vertexShader: `
    attribute vec2 aLocal;
    attribute vec3 aHead;
    attribute vec3 aTail;
    attribute vec3 aColor;
    attribute float aWidth;
    attribute float aAlpha;
    varying float vT;        // 0=尾 1=头
    varying float vAcross;   // 横向 -1~1
    varying vec3 vColor;
    varying float vAlpha;
    varying float vFade;
    void main() {
      vec2 dv = aHead.xy - aTail.xy;
      float len = length(dv);
      vec2 dir = len > 1e-4 ? dv / len : vec2(1.0, 0.0);
      vec2 perp = vec2(-dir.y, dir.x);
      float t = 0.5 + 0.5 * aLocal.x;
      // 宽度沿长度收窄：尾部细、靠近头部略鼓，看起来像被拉出的速度线
      float w = aWidth * (0.26 + 0.74 * pow(t, 0.7));
      vec2 p = aTail.xy + dir * (len * t) + perp * (aLocal.y * w);
      vT = t; vAcross = aLocal.y; vColor = aColor; vAlpha = aAlpha;
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
      float a = (core + glow) * vAlpha * (0.25 + 0.75 * vT) * vFade;
      if (a < 0.004) discard;
      // 加法混合下不要再把 a 预乘进 rgb：否则实际亮度是 a²，几乎看不见
      gl_FragColor = vec4(vColor * (0.45 + 1.05 * vT), a);
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
function screenToWorld(cx, cy) {
  const rect = cv.getBoundingClientRect();
  const scale = (2 * view2DFitHalfH() / view2D.zoom) / Math.max(1, rect.height);
  return {
    x: view2D.x + (cx - (rect.left + rect.width * 0.5)) * scale,
    y: view2D.y - (cy - (rect.top + rect.height * 0.5)) * scale,
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
  if (t && t.closest && t.closest('#audioBtn')) return;
  if (audio.enabled) {
    if (audio.ctx && audio.ctx.state !== 'running' && !audio.muted) audio.ctx.resume().catch(() => {});
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) removeEventListener(ev, unlockAudio);
    return;
  }
  audio.enable().catch(() => {});
}
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
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

const fRules = gui.addFolder('鸟群规则');
bindNum(fRules, 'separation', 0, 4, 0.01, '分离力度',
  '分离｜调大：鸟会把贴得太近的同伴用力推开，群体更松散、不重叠。调小：彼此贴得很近甚至挤成一团。');
bindNum(fRules, 'alignment', 0, 4, 0.01, '对齐力度',
  '对齐｜调大：鸟更倾向和周围同伴同向飞，队伍更整齐。调小：各飞各的，方向散乱。');
bindNum(fRules, 'cohesion', 0, 4, 0.01, '聚合力度',
  '聚合｜调大：鸟更想靠近同伴中心，容易抱团。调小：群体更分散。');
bindNum(fRules, 'perception', 1, 14, 0.1, '视野范围',
  '视野半径｜调大：每只鸟能看到更远的同伴，队伍更连贯（计算量也更大）。调小：只看身边几只，队形容易断裂。');
bindNum(fRules, 'separationRange', 0.2, 6, 0.1, '安全距离',
  '安全距离｜两只鸟比这更近时才开始互躲。调大：队伍稀疏、空隙大。调小：能挤得很紧密。它和“分离力度”不同：这里管多近才躲，分离力度管躲得多用力。');
fRules.open();

const fMotion = gui.addFolder('飞行与视野');
bindNum(fMotion, 'count', 10, MAX_N, 10, '元素数量',
  '元素总数（默认 800，范围 10~50000）｜调多：画面更壮观、群体感更强，但帧率会下降（每只鸟都要算物理、每帧上传实例数据，主线程最吃紧）。每只鸟只注意最近的 7 个同伴，所以配对量是固定的 7×数量，不会因为密度翻倍而爆炸；5 万只时单帧仿真约 20~30ms，绘制仍不到 1ms。调少：更容易看清单只的行为。',
  (v) => setCount(v));
bindNum(fMotion, 'maxSpeed', 2, 18, 0.1, '巡航速度',
  '巡航速度｜鸟平时最快能飞多快。调大：整体飞得更快、更容易拉开距离，但转弯会变迟钝。逃逸爆发是在这个速度上再乘倍率。',
  (v) => { arrowMat.uniforms.uMaxSpeed.value = v; });
bindNum(fMotion, 'flow', 0, 4, 0.05, '气流扰动',
  '气流扰动｜调大：鸟更容易被随机气流带偏，运动更自然，但队形更松散。调 0：完全按三规则飞行。');
bindNum(fMotion, 'arrowSize', 0.18, 0.9, 0.01, '元素大小',
  '元素大小｜一只鸟的整体尺寸。捕食者的腰长与底边按这个值等比推导（腰长 1.4 倍、底 0.7 倍，再整体 ×2），所以它只影响外观，不影响运动规则。');
fMotion.open();

const fPred = gui.addFolder('捕食与逃逸');
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
bindNum(fPred, 'fleeRange', 3, 24, 0.5, '危险感知距离',
  '危险感知距离｜鱼群在多远开始察觉捕食者。调大：整群提前绕开，几乎不会被逼近。调小：捕食者贴脸才逃，容易被抓。注意察觉后还要经过反应延迟（贴身约 45ms、圈边缘约 260ms）才会爆发冲刺。');
bindNum(fPred, 'fleeWeight', 0, 6, 0.05, '逃跑力度',
  '逃跑力度｜调大：个体和整群都逃得更拼命，鱼群会更整齐地绕开捕食者。太大会盖过群聚，队形散掉。');
bindNum(fPred, 'sprintFactor', 1, 2.5, 0.05, '爆发速度倍率',
  '爆发倍率｜体力满时短时最高速度 = 巡航速度 × 此值。调大：瞬间甩开捕食者，但爆发结束后更容易被追上。');
bindNum(fPred, 'sprintDuration', 0.2, 3, 0.1, '爆发持续(秒)',
  '爆发持续时间｜一次逃命冲刺能维持几秒。调长：逃得更远、拖尾更长。调短：更像瞬间闪避。结束后速度回到巡航上限。');
bindNum(fPred, 'sprintRecovery', 1, 12, 0.5, '体力恢复(秒)',
  '体力恢复时间｜爆发后要几秒才能再次爆发。调大：几乎不能连续爆发，鸟更容易被抓。调小：可以频繁逃生。');
bindBool(fPred, 'infoCascade', '警报传递',
  '警报传递｜开启后受惊的鸟会把逃跑方向告诉邻居，惊吓像波纹一样扩散。关闭则各逃各的。');
fPred.open();

const fAdv = gui.addFolder('高级参数（很少用）');
bindNum(fAdv, 'minSpeed', 0.5, 8, 0.1, '最低速度',
  '最低速度｜鸟再慢也不会低于这个值，避免悬停不动。一般不用调。');
bindNum(fAdv, 'predict', 0, 1.5, 0.05, '预判系数',
  '预判系数｜鸟逃跑时会朝捕食者未来位置躲。调大：躲得更提前；太大像未卜先知。');
bindNum(fAdv, 'lockTime', 0, 5, 0.1, '锁定目标(秒)',
  '锁定目标｜捕食者专注追同一只鸟的秒数。调大：不容易被鸟群晃动骗到，追击更稳定。');
bindNum(fAdv, 'feedCooldown', 0.3, 60, 0.1, '进食冷却(秒)',
  '进食冷却｜捕食者抓到一只鸟后多久才再次捕猎。冷却期间它会减速随机巡游、不再追击，以保存体力。调大：捕获间隔变长。');
fAdv.close();

const fGrass = gui.addFolder('草地');
bindBool(fGrass, 'grassOn', '长草地（定期降落休息）',
  '草地｜开启后场地里会长出 2~3 片草地（总面积约占屏幕 15%，可以压到边界上）。每只鸟每隔二三十秒必须去一次，挑一片最近、没满的降落，只要没有危险就一直待着（最长 28~60 秒，逐只错开）；被惊到会立刻飞走并重新计时，没待够 5 秒的下次很快会再来。草地上的个体会保持间距、各朝各的方向；有新鸟落下时，已经休息 5~60 秒的老住客有 10% 概率往旁边挪（每只最多挪 2 次）。掠过草地的鸟还有 5%~13%（按个体浮动）概率顺势落下来。不休息的鸟会主动绕开草地。关掉后草地隐藏，正在休息的鸟马上起飞。',
  (v) => { syncGrassVisibility(); if (!v) liftAllResting(); });
fGrass.open();

const fSound = gui.addFolder('声音');
bindNum(fSound, 'musicLevel', 0, 1.5, 0.01, '音乐音量',
  '音乐音量｜0~1.5 的增益刻度，四层生成式音景总音量，默认 0.4（1.0 为标准响度）。嫌低频嗡嗡就往下调，0 完全关掉音乐（提示音仍保留）。',
  (v) => music.setLevel(v));
bindNum(fSound, 'fxLevel', 0, 1.5, 0.01, '音效音量',
  '音效音量｜0~1.5 的增益刻度，事件提示音音量，默认 1.0 为标准响度，与音乐互不影响。',
  (v) => { if (audio.fxBus) audio.fxBus.gain.setTargetAtTime(v, audio.ctx.currentTime, 0.08); });
fSound.close();

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
  // 音量也回到默认：音乐电平 + 音效总线
  syncGrassVisibility();
  liftAllResting();
  music.setLevel(params.musicLevel);
  if (audio.fxBus) audio.fxBus.gain.setTargetAtTime(params.fxLevel, audio.ctx.currentTime, 0.08);
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
// 邻域扫描顺序：先自己所在格，再上下左右，最后四个斜角。
// 二维场地里 z 恒为 0，原来 3×3×3=27 次查表有 24 次必然落空；这里只查 9 个格，
// 且按由近到远，配合「只取最近 7 只」时先拿到的就是近邻。
const NBR_OFF = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];

// ---------------------------------------------------------------- 模拟
function step(dt, time) {
  const n = activeCount;
  const cell = params.perception;
  const per2 = cell * cell;
  const sep2 = params.separationRange * params.separationRange;
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
  // 拓扑式邻域：每只鸟只取最近的 7 只（见 NEIGHBOR_CAP），单帧配对量 = 7n。
  const neighborCap = NEIGHBOR_CAP;
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
            const dd = Math.sqrt((bx - ppx) * (bx - ppx) + (by - ppy) * (by - ppy));
            if (dd > Math.min(16, hy * 0.6)) break;
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

      // 贴边掉头：和鸟群一致，只在最后 3.2 个单位介入，不再提前 9 个单位往回压
      // （那样等于在真边界内侧又造了一条软边界）。捕食者默认 25 的速度很快，
      // 所以法向修正更强，保证 5~6 帧内把朝外分量折回来并转成沿墙切向。
      const wm = 3.2;
      const pspeed = vlen;
      const psgn = predWallTurn[p] || 1;
      const pband = (d) => Math.min(1, Math.max(0, d) / wm);
      if (ppx > hx - wm && pvx > 0) {
        const s = pband(ppx - (hx - wm));
        ax -= pvx * (4 + 9 * s) * s + 8 * s;
        ay += psgn * pspeed * (2 + 5 * s) * s;
      }
      if (ppx < -hx + wm && pvx < 0) {
        const s = pband(-hx + wm - ppx);
        ax += (-pvx) * (4 + 9 * s) * s + 8 * s;
        ay += psgn * pspeed * (2 + 5 * s) * s;
      }
      if (ppy > hy - wm && pvy > 0) {
        const s = pband(ppy - (hy - wm));
        ay -= pvy * (4 + 9 * s) * s + 8 * s;
        ax += psgn * pspeed * (2 + 5 * s) * s;
      }
      if (ppy < -hy + wm && pvy < 0) {
        const s = pband(-hy + wm - ppy);
        ay += (-pvy) * (4 + 9 * s) * s + 8 * s;
        ax += psgn * pspeed * (2 + 5 * s) * s;
      }
      az = 0;

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
      // 矩形硬边界：逐轴夹紧后弹性反射，再叠加一个随机偏转角——
      // 真实撞击不是镜面反射，同一条路线上不会来回弹成弹珠。
      let bounced = false;
      if (predPos[q] > hx) { predPos[q] = hx; nvx = -Math.abs(nvx) * 0.9; bounced = true; }
      else if (predPos[q] < -hx) { predPos[q] = -hx; nvx = Math.abs(nvx) * 0.9; bounced = true; }
      if (predPos[q + 1] > hy) { predPos[q + 1] = hy; nvy = -Math.abs(nvy) * 0.9; bounced = true; }
      else if (predPos[q + 1] < -hy) { predPos[q + 1] = -hy; nvy = Math.abs(nvy) * 0.9; bounced = true; }
      if (bounced) {
        const sc = (Math.random() - 0.5) * 0.7;          // ±20°
        const cs = Math.cos(sc), sn = Math.sin(sc);
        const bx = nvx * cs - nvy * sn;
        const by = nvx * sn + nvy * cs;
        nvx = bx; nvy = by;
        predVel[q] = nvx; predVel[q + 1] = nvy;
        // 万一还是撞到墙：冷却期直接换一个场内巡逻点，别沿着墙根来回蹭
        if (cooling) { predWpUntil[p] = 0; }
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
    let nx = px + (mouseTgt.x - px) * follow;
    let ny = py + (mouseTgt.y - py) * follow;
    // 夹在场地内：光标跑到窗口边缘外时，捕食者贴着边界走，不会飞出画面。
    if (nx > hx) nx = hx; else if (nx < -hx) nx = -hx;
    if (ny > hy) ny = hy; else if (ny < -hy) ny = -hy;
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

  let sumNeighbors = 0;
  let deadCount = 0;
  for (let i = 0; i < n; i++) if (caught[i]) deadCount++;
  const aliveN = Math.max(1, n - deadCount);
  let cx = 0, cy = 0, cz = 0;
  let impact = 0;
  let boundaryImpact = 0;

  for (let i = 0; i < n; i++) {
    if (caught[i]) continue;   // 死亡等待期不参与运动与统计
    const k = i * 3;
    const px = pos[k], py = pos[k + 1], pz = pos[k + 2];
    let vx = vel[k], vy = vel[k + 1], vz = vel[k + 2];

    // 在草地上休息：不跑三条规则，只是朝落点漂过去、站稳、偶尔挪半步。
    // 附近有捕食者按距离错峰起飞，到点也会自己走——草地是「歇脚点」而不是避难所。
    if (resting[i]) {
      acc[k] = 0; acc[k + 1] = 0; acc[k + 2] = 0;
      fleeDir[k] = 0; fleeDir[k + 1] = 0; fleeDir[k + 2] = 0;
      fleeing[i] = 0; neighbors[i] = 0;

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
      if (!settled[i] && dd < 0.55 && Math.sqrt((vx) * (vx) + (vy) * (vy)) < 1.6
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

    // 安全时按群体节奏控速；受惊时恢复满速；爆发时直接用爆发速度作为
    // 转向目标速度——否则「追赶」只会把速度上限抬高，方向却仍按巡航速度算，容易冲过头。
    const isDashing = time < sprintUntil[i];
    const calm = !fleeing[i] && !isDashing;
    const desiredSpeed = isDashing ? sprintSpeed : (calm ? paceSpeed : maxSpeed);
    let count = 0;
    let sx = 0, sy = 0, sz = 0;
    let ax = 0, ay = 0, az = 0;
    let dxs = 0, dys = 0, dzs = 0;
    let cfx = 0, cfy = 0, cfz = 0, cascadeCount = 0;   // 信息级联：邻居上一帧的逃逸方向

    const ix = Math.floor(px / cell) - gridX0, iy = Math.floor(py / cell) - gridY0;
    nbrScan:
    for (let oi = 0; oi < 18; oi += 2) {
      const cx = ix + NBR_OFF[oi], cy = iy + NBR_OFF[oi + 1];
      if (cx < 0 || cy < 0 || cx >= gridW || cy >= gridH) continue;
      const c = cy * gridW + cx;
      const bEnd = cellEnd[c];
      for (let b = cellStart[c]; b < bEnd; b++) {
        if (count >= neighborCap) break nbrScan;
        const j = cellItems[b];
        if (j === i || caught[j]) continue;
        const m = j * 3;
        const dx = px - pos[m], dy = py - pos[m + 1], dz = pz - pos[m + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > per2 || d2 < 1e-8) continue;

        count++;
        sx += pos[m]; sy += pos[m + 1]; sz += pos[m + 2];
        ax += vel[m]; ay += vel[m + 1]; az += vel[m + 2];
        if (P > 0 && params.infoCascade && fleeing[j]) {
          cfx += prevFlee[m]; cfy += prevFlee[m + 1]; cfz += prevFlee[m + 2];
          cascadeCount++;
        }
        if (d2 < sep2) {
          const inv = 1 / d2;
          dxs += dx * inv; dys += dy * inv; dzs += dz * inv;
        }
        if (d2 < COLLIDE_DIST2) {
          const dist = Math.sqrt(d2);
          const nx = dx / dist, ny = dy / dist, nz = dz / dist;
          const rvx = vx - vel[m], rvy = vy - vel[m + 1], rvz = vz - vel[m + 2];
          const closing = -(rvx * nx + rvy * ny + rvz * nz); // 相向接近才计冲量
          if (closing > 0) impact = Math.max(impact, Math.pow(closing, 1.2));
        }
      }
    }
    neighbors[i] = count;
    sumNeighbors += count;
    cx += px; cy += py; cz += pz;

    let fx = 0, fy = 0, fz = 0;
    if (count > 0) {
      let len = Math.sqrt((ax) * (ax) + (ay) * (ay) + (az) * (az));
      if (len > 1e-6) {
        const s = desiredSpeed / len;
        let tx = ax * s - vx, ty = ay * s - vy, tz = az * s - vz;
        const tl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
        if (tl > maxForce) { const q = maxForce / tl; tx *= q; ty *= q; tz *= q; }
        fx += tx * params.alignment; fy += ty * params.alignment; fz += tz * params.alignment;
      }
      let tx = sx / count - px, ty = sy / count - py, tz = sz / count - pz;
      len = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
      if (len > 1e-6) {
        const s = desiredSpeed / len;
        tx = tx * s - vx; ty = ty * s - vy; tz = tz * s - vz;
        const tl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
        if (tl > maxForce) { const q = maxForce / tl; tx *= q; ty *= q; tz *= q; }
        fx += tx * params.cohesion; fy += ty * params.cohesion; fz += tz * params.cohesion;
      }
    }
    const sl = Math.sqrt((dxs) * (dxs) + (dys) * (dys) + (dzs) * (dzs));
    if (sl > 1e-6) {
      const s = desiredSpeed / sl;
      let tx = dxs * s - vx, ty = dys * s - vy, tz = dzs * s - vz;
      const tl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
      if (tl > maxForce) { const q = maxForce / tl; tx *= q; ty *= q; tz *= q; }
      fx += tx * params.separation; fy += ty * params.separation; fz += tz * params.separation;
    }

    // ---- 猎物逃逸：预测威胁点 + 距离平方衰减 + 信息级联 ----
    // 白肌式短时爆发：体力满 + 进入危险范围才触发，持续固定时长后体力清零；
    // 必须等 sprintRecovery 秒完全恢复才能再次爆发，所以不能连续冲刺。
    let sprinting = time < sprintUntil[i];
    if (P > 0) {
      let nearest2 = Infinity, nearestP = -1;
      for (let p = 0; p < P; p++) {
        const q = p * 3;
        const dx = px - predPos[q], dy = py - predPos[q + 1], dz = pz - predPos[q + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearest2) { nearest2 = d2; nearestP = p; }
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
      sprinting = time < sprintUntil[i];

      let efx = 0, efy = 0, efz = 0;
      for (let p = 0; p < P; p++) {
        const q = p * 3;
        const dx = px - predPos[q], dy = py - predPos[q + 1], dz = pz - predPos[q + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= fleeR2 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const tau = (d / maxSpeed) * params.predict;
        // 威胁点取捕食者未来位置；方向为从威胁点指向自己
        let ex = px - (predPos[q] + predVel[q] * tau);
        let ey = py - (predPos[q + 1] + predVel[q + 1] * tau);
        let ez = pz - (predPos[q + 2] + predVel[q + 2] * tau);
        const el = Math.sqrt((ex) * (ex) + (ey) * (ey) + (ez) * (ez));
        if (el < 1e-6) continue;
        const escapeSpeed = sprinting ? sprintSpeed : maxSpeed;
        let tx = ex / el * escapeSpeed - vx;
        let ty = ey / el * escapeSpeed - vy;
        let tz = ez / el * escapeSpeed - vz;
        const tl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
        const fCap = sprinting ? maxForce * 2 : maxForce;
        if (tl > fCap) { const s = fCap / tl; tx *= s; ty *= s; tz *= s; }
        const w = 1 - d / fleeR;                 // 到半径边缘恰好为 0，避免力突变
        const mag = params.fleeWeight * w * w * (sprinting ? 1.25 : 1);
        efx += tx * mag; efy += ty * mag; efz += tz * mag;
      }
      // 群体级躲避：捕食者进入范围时整群沿远离它的方向一起偏航一次（约 1.2 秒波纹），
      // 随后停止群体推力，让鱼群重新聚合——像真实鱼群遇鲨后散开再合拢，而不是永远四散。
      const ripple = Math.max(0, 1 - (time - groupThreatAt) / 1200);
      if (ripple > 0) {
        for (let p = 0; p < P; p++) {
          const q = p * 3;
          const gdx = groupX - predPos[q], gdy = groupY - predPos[q + 1];
          const gl = Math.sqrt((gdx) * (gdx) + (gdy) * (gdy));
          if (gl < 1e-6) continue;
          const dx = px - predPos[q], dy = py - predPos[q + 1];
          const d = Math.sqrt((dx) * (dx) + (dy) * (dy));
          if (d > fleeR * 2.5) continue;
          const w = Math.max(0, 1 - d / (fleeR * 2.5));
          const strength = params.fleeWeight * w * ripple * 1.6;
          efx += gdx / gl * strength;
          efy += gdy / gl * strength;
          efz = 0;
        }
      }
      // 信息级联：邻居上一帧的逃逸方向传播过来，形成波状逃逸
      if (params.infoCascade && cascadeCount > 0) {
        const s = 0.80 / cascadeCount;
        efx += cfx * s; efy += cfy * s; efz += cfz * s;
      }
      const mag = Math.sqrt((efx) * (efx) + (efy) * (efy) + (efz) * (efz));
      if (mag > 1e-6) {
        fleeDir[k] = efx / mag; fleeDir[k + 1] = efy / mag; fleeDir[k + 2] = efz / mag;
        fleeing[i] = 1;
        fx += efx; fy += efy; fz += efz;
      } else {
        fleeDir[k] = 0; fleeDir[k + 1] = 0; fleeDir[k + 2] = 0;
        fleeing[i] = 0;
      }
    } else {
      fleeDir[k] = 0; fleeDir[k + 1] = 0; fleeDir[k + 2] = 0;
      fleeing[i] = 0;
    }

    // 爆发只有一种动机：被逼近时的逃命。归队/合群不消耗体力、不爆发，
    // 掉队的鸟靠常规转向力慢慢追上大部队。

    sprinting = time < sprintUntil[i];
    if (sprinting) sprintingCount++;
    else if (stamina[i] < 1) stamina[i] = Math.min(1, stamina[i] + dt / params.sprintRecovery);

    // 边界：先判定这次要不要穿墙。
    //   进入 8 个单位的「判定带」时只掷一次骰子：10% 这次当作没有墙（越界后
    //   从中心对称点穿出）；离开 10 个单位才重置，避免贴边徘徊时反复掷。
    const wallM = Math.min(px > 0 ? hx - px : px + hx, py > 0 ? hy - py : py + hy);
    if (!wallNear[i]) {
      if (wallM < 8) {
        wallNear[i] = 1;
        wallPass[i] = Math.random() < PORTAL_P ? 1 : 0;
        wallTurn[i] = Math.random() < 0.5 ? -1 : 1;   // 这次贴边往哪一侧拐，避免整群同向
      }
    } else if (wallM > 10) {
      wallNear[i] = 0; wallPass[i] = 0;
    }
    if (!wallPass[i]) {
      // 贴边掉头：只在最后 2.6 个单位介入，鸟可以一路冲到边界旁。
      // 关键是「转」而不是「刹」——把朝外的速度分量折回来，同时转成沿墙的切向，
      // 速率交给后面的限速器保持，所以看到的是一次急转弯，而不是离墙一大截就停住。
      // 旧版提前 9 个单位用二次曲线猛推，等于在真边界内侧又造了一条软边界。
      const m = 2.6;
      const turn = Math.max(4, Math.sqrt((vx) * (vx) + (vy) * (vy)));   // 用速率做转向幅度，转向过程中不衰减
      const sgn = wallTurn[i] || 1;
      const band = (d) => Math.min(1, Math.max(0, d) / m);
      if (px > hx - m && vx > 0) {
        const s = band(px - (hx - m));
        fx -= vx * (3 + 7 * s) * s + (2 + 6 * s) * s;   // 折回法向 + 一点持续内向推力
        fy += sgn * turn * (3 + 6 * s) * s;              // 转成沿墙切向
      }
      if (px < -hx + m && vx < 0) {
        const s = band((-hx + m) - px);
        fx += (-vx) * (3 + 7 * s) * s + (2 + 6 * s) * s;
        fy += sgn * turn * (3 + 6 * s) * s;
      }
      if (py > hy - m && vy > 0) {
        const s = band(py - (hy - m));
        fy -= vy * (3 + 7 * s) * s + (2 + 6 * s) * s;
        fx += sgn * turn * (3 + 6 * s) * s;
      }
      if (py < -hy + m && vy < 0) {
        const s = band((-hy + m) - py);
        fy += (-vy) * (3 + 7 * s) * s + (2 + 6 * s) * s;
        fx += sgn * turn * (3 + 6 * s) * s;
      }
    }
    // 绕开草地：不休息的鸟会主动沿着草地边缘滑过去，而不是直接从草地上方穿过去。
    // 做法是「法向推开 + 沿当前运动方向的切向」——只推法向的话看起来像撞到墙弹开。
    let insideG = -1;   // 当前正压在哪片草地上（-1 = 不在任何草地上）
    if (params.grassOn && grass.length) {
      for (let g = 0; g < grass.length; g++) {
        const gp = grass[g];
        const gdx = px - gp.x, gdy = py - gp.y;
        const gd2 = gdx * gdx + gdy * gdy;
        const reach = gp.R * 1.3 + 7;
        if (gd2 > reach * reach) continue;
        const gd = Math.sqrt(gd2) || 1e-4;
        const th = Math.atan2(gdy, gdx);
        const rr = gp.R * (1 + gp.a1 * Math.sin(3 * th + gp.p1) + gp.a2 * Math.sin(5 * th + gp.p2));
        const nx = gdx / gd, ny = gdy / gd;
        if (gd < rr) {
          insideG = g;
          // 已经压在草地上（比如刚起飞）：先往外推，力度随深入程度加大
          const k = Math.min(1, (rr - gd) / Math.max(1, rr * 0.5));
          fx += nx * (10 + 14 * k); fy += ny * (10 + 14 * k);
        } else {
          const w = 1 - (gd - rr) / 7;          // 0~1，越靠近边缘越强
          if (w <= 0) continue;
          const tx2 = -ny, ty2 = nx;
          const sgn = (vx * tx2 + vy * ty2) >= 0 ? 1 : -1;   // 往自己正在走的那一侧绕
          fx += (nx * 9 + tx2 * sgn * 7) * w;
          fy += (ny * 9 + ty2 * sgn * 7) * w;
        }
      }
      // 掠过草地：刚进入草地范围的那一刻，10% 概率顺势减速落下来。
      // 只在「边沿进入」时掷一次骰子，不会每帧都掷。
      if (insideG >= 0) {
        // 同样不能用 fleeing 判断有没有危险（信息级联会让全群都是 fleeing），
        // 直接看最近的捕食者有多远。
        // 概率也按个体作息相位浮动（5%~13%）：整群一起掠过草地时不会同时落下一大片
        if (!overGrass[i] && time >= sprintUntil[i]
            && Math.random() < 0.05 + restPhase[i] * 0.08) {
          let safe = true;
          const safe2 = fleeR * 1.6 * (fleeR * 1.6);
          for (let p = 0; p < P; p++) {
            const q = p * 3;
            const ex = px - predPos[q], ey = py - predPos[q + 1];
            if (ex * ex + ey * ey < safe2) { safe = false; break; }
          }
          if (safe) landHere(i, insideG, time);
        }
        overGrass[i] = 1;
      } else {
        overGrass[i] = 0;
      }
    }
    fx += Math.sin(py * 0.11 + flowT) * params.flow;
    fy += Math.cos(px * 0.09 - flowT * 0.8) * params.flow * 0.7;
    // 个体游走：每只鸟带一条缓慢漂移的私人航向。邻居越多，群体把它「稳住」的力度越大，
    // 所以队形仍由三条规则决定，只是落单的个体会自己晃——这正是弹珠感消失的来源。
    wAng[i] += (Math.random() - 0.5) * 6 * dt;
    const wanderMag = WANDER_BASE * wAmp[i] / (1 + count * 0.06);
    fx += Math.cos(wAng[i]) * wanderMag;
    fy += Math.sin(wAng[i]) * wanderMag;
    // 到点了：附近没有捕食者，就去最近的草地歇一会儿。
    // 注意不能用 fleeing[i] 判断「有没有危险」——信息级联会把整个群体都
    // 标记成 fleeing（实测 1000 只里 997 只），那样谁也别想落地。
    if (params.grassOn && !resting[i] && time >= restDue[i] && time >= sprintUntil[i]) {
      let safe2 = fleeR * 2.2 * (fleeR * 2.2), ok = true;
      for (let p = 0; p < P; p++) {
        const q = p * 3;
        const ex = px - predPos[q], ey = py - predPos[q + 1];
        if (ex * ex + ey * ey < safe2) { ok = false; break; }
      }
      // 附近有猛禽时重试也要错峰，否则猛禽一走开，整批鸟会在同一秒一起出发
      if (ok) startRest(i, time);
      else restDue[i] = time + 1200 + Math.random() * 3000 + restPhase[i] * 2500;
    }

    acc[k] = fx; acc[k + 1] = fy; acc[k + 2] = 0;
  }
  if (aliveN > 0) { groupX = cx / aliveN; groupY = cy / aliveN; groupZ = 0; }

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
        const want = Math.min(paceSpeed, Math.max(1.1, dd * 2.2));
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

    // 边界兜底：上面贴边转向没拉住的少数个体才走这里，弹性反射 + 随机散射；
    // 进入判定带时掷中的 10% 则变成「传送门」——
    // 从对侧穿出，且出入点关于场地中心对称（左边偏下飞出 → 右边偏上飞进）。
    // 速度方向保持不变，所以刚进场的个体一定是朝场内飞的。
    const outX = pos[k] > hx ? 1 : (pos[k] < -hx ? -1 : 0);
    const outY = pos[k + 1] > hy ? 1 : (pos[k + 1] < -hy ? -1 : 0);
    if (outX || outY) {
      if (wallPass[i]) {
        if (outX) { pos[k] = -outX * hx; pos[k + 1] = -pos[k + 1]; }
        if (outY) { pos[k + 1] = -outY * hy; pos[k] = -pos[k]; }
        // 斜角同时越界时镜像后可能仍在外侧，夹回场内
        if (pos[k] > hx) pos[k] = hx; else if (pos[k] < -hx) pos[k] = -hx;
        if (pos[k + 1] > hy) pos[k + 1] = hy; else if (pos[k + 1] < -hy) pos[k + 1] = -hy;
        teleportCount++;
        wallPass[i] = 0; wallNear[i] = 0;
        // 传送是瞬移：拖尾必须当场清掉，否则会从旧位置拉出一条横穿全屏的线。
        // 把尾巴重置到落点，下次爆发时从零重新拉开。
        trailAmt[i] = 0;
        trailTail[i * 2] = pos[k];
        trailTail[i * 2 + 1] = pos[k + 1];
      } else {
        if (outX) {
          pos[k] = outX * hx;
          vx = -outX * Math.abs(vx) * 0.92;
          boundaryImpact = Math.max(boundaryImpact, Math.pow(2 * Math.abs(vx), 1.2));
        }
        if (outY) {
          pos[k + 1] = outY * hy;
          vy = -outY * Math.abs(vy) * 0.92;
          boundaryImpact = Math.max(boundaryImpact, Math.pow(2 * Math.abs(vy), 1.2));
        }
        // 反弹再加随机散射：偏转 ±23°、速度乘 0.82~1.08。
        // 这样撞墙既不会沿原路精确返回，整群也不会排着队同步弹开。
        const scat = (Math.random() - 0.5) * 0.8;
        const cs = Math.cos(scat), sn = Math.sin(scat);
        const bx = vx * cs - vy * sn;
        const by = vx * sn + vy * cs;
        const sb = 0.82 + Math.random() * 0.26;
        vx = bx * sb; vy = by * sb;
        // 散射后若仍在往墙外飞，把法向分量纠正回场内
        if (outX && vx * outX > 0) vx = -vx;
        if (outY && vy * outY > 0) vy = -vy;
        vel[k] = vx; vel[k + 1] = vy;
      }
    }
    pos[k + 2] = 0; vel[k + 2] = 0;

    // 捕获：捕食者是锐角三角形，有实际碰撞体积，接触即算捕食成功（仍受进食冷却限制）。
    // 用上一帧到当前帧的线段做扫掠判定：高速追击时不会一帧跨过猎物。
    if (P > 0 && !caught[i]) {
      for (let p = 0; p < P; p++) {
        // 鼠标捕食者冷却远短于 AI：人控制时是「划过就吃」，
        // 若沿用 AI 那套几十秒的冷却，整个玩法就完全没手感。
        const cdMs = p === baseP ? MOUSE_FEED_MS : params.feedCooldown * 1000;
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
        // 被吃掉 → 拖尾立即消失。否则「死亡点 → 1 秒后的重生点」之间会留一条长线。
        trailAmt[i] = 0;
        if (resting[i]) endRest(i, time, true);   // 从草地上摘掉，别一直占着容量
        break;
      }
    }
  }

  perfParts.loop = performance.now() - tGrid1;
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
    const dx = pos[k] - groupX, dy = pos[k + 1] - groupY;
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
const perf = { step: 0, prep: 0, draw: 0 };

function render(now) {
  requestAnimationFrame(render);
  const pT0 = performance.now();
  const rawDt = (now - last) / 1000;
  last = now;
  const dt = Math.min(rawDt, 0.035);
  fpsAcc += rawDt; fpsFrames++;
  if (fpsAcc > 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }

  if (!params.paused) step(dt, now);
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
  updateOrthoFrustum();
  camera.position.set(view2D.x, view2D.y, 40);
  camera.up.set(0, 1, 0);
  camera.lookAt(view2D.x, view2D.y, 0);

  // CPU 只写颜色/尺寸；箭头的朝向与形状全部交给 GPU 着色器。
  const tCol0 = performance.now();
  const n = activeCount;
  const SMOOTH = 0.18;   // 30 FPS 下时间常数约 0.15s，抖动明显降低且方向仍跟手
  const arrowBase = params.arrowSize;
  const invMaxSpeed = 1 / Math.max(0.001, params.maxSpeed);
  const sprintSpanMs = Math.max(160, params.sprintDuration * 1000);
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    // 渲染朝向的低通滤波顺手在这里做：原来另有一趟 3n 的循环，白跑一遍内存。
    // 物理仿真仍用原始 vel，行为不变。
    rVel[k] += (vel[k] - rVel[k]) * SMOOTH;
    rVel[k + 1] += (vel[k + 1] - rVel[k + 1]) * SMOOTH;
    if (caught[i]) { siz[i] = 0; continue; }   // 等待重生的 1 秒完全隐藏
    // 沿用原来的密度刻度：7 只拓扑邻居对应 0.29，整体偏青蓝，
    // 稀疏到看不见同伴时更蓝，不会因为改了邻域规则就整群烧成洋红。
    const local = Math.min(1, neighbors[i] / 24);
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
    let size = arrowBase + local * 0.10;
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

  // ---- 爆发拖尾 ----
  // 尾巴用指数平滑追头部：稳态落后量 ≈ 速度 × TRAIL_TAU，所以爆发越快拖尾越长；
  // 起爆时尾巴贴住身体、从零开始拉开，结束后自然淡出（不再瞬移）。
  tmpTrail.setHSL(0.928, 0.9, 0.62);
  const tailK = 1 - Math.exp(-dt / TRAIL_TAU);
  const fadeDown = Math.exp(-dt / 0.08);
  const riseUp = Math.min(1, dt * 14);
  const arrowW = params.arrowSize;
  let tc = 0;
  for (let i = 0; i < n; i++) {
    const k = i * 3;
    const dashing = !caught[i] && now < sprintUntil[i];
    if (dashing) {
      if (trailAmt[i] < 0.06) {                 // 刚起爆：尾巴贴住身体，避免拖出一条长线
        trailTail[i * 2] = pos[k];
        trailTail[i * 2 + 1] = pos[k + 1];
      }
      trailAmt[i] = Math.min(1, trailAmt[i] + riseUp);
      const tx = trailTail[i * 2], ty = trailTail[i * 2 + 1];
      trailTail[i * 2] = tx + (pos[k] - tx) * tailK;
      trailTail[i * 2 + 1] = ty + (pos[k + 1] - ty) * tailK;
    } else if (trailAmt[i] > 0.002) {
      trailAmt[i] *= fadeDown;
      // 收尾时尾巴也往回缩：否则鸟继续飞、尾巴钉在原地，会拖出一条越拉越长的残留线
      const bx = trailTail[i * 2], by = trailTail[i * 2 + 1];
      const kk = 1 - Math.exp(-dt / 0.12);
      trailTail[i * 2] = bx + (pos[k] - bx) * kk;
      trailTail[i * 2 + 1] = by + (pos[k + 1] - by) * kk;
    } else {
      trailAmt[i] = 0;
      continue;
    }
    if (trailAmt[i] <= 0.02 || tc >= MAX_TRAILS) continue;
    const o = tc * 3;
    trHead[o] = pos[k]; trHead[o + 1] = pos[k + 1]; trHead[o + 2] = 0;
    trTail[o] = trailTail[i * 2]; trTail[o + 1] = trailTail[i * 2 + 1]; trTail[o + 2] = 0;
    trCol[o] = tmpTrail.r; trCol[o + 1] = tmpTrail.g; trCol[o + 2] = tmpTrail.b;
    // 常态会有十几到上百只同时爆发，拖尾不能抢戏：细一点、淡一点，
    // 只做「速度感」的暗示，不画成一条实线。
    trWid[tc] = arrowW * 0.72;
    trAlp[tc] = trailAmt[i] * 0.62;
    tc++;
  }

  // ---- 捕食者拖尾：由加速度驱动 ----
  // 加速度越大 → 尾巴越长、越亮；几乎匀速时完全不出现。
  // 这样它只在扑击起步、急转、从巡游切回追击这几下「闪现」，平时是干净的。
  const trailPN = predCountNow();   // 含鼠标捕食者：手划得快时它也会留下尾迹
  if (trailPN > 0) {
    for (let p = 0; p < trailPN && tc < MAX_TRAILS; p++) {
      // 加速度是尖峰式的（扑击起步只有两三帧），所以这里用「快起慢落」包络：
      // 冲上去 30ms 就到，落下来要 0.4s——一次冲刺能留下约半秒可见的尾巴，
      // 否则尾迹还没亮就灭了，看起来就像没生效。
      const target = Math.min(1, predAccel[p] / PRED_TRAIL_REF);
      const kEnv = target > predTrailP[p] ? (1 - Math.exp(-dt / 0.03)) : (1 - Math.exp(-dt / 0.40));
      predTrailP[p] += (target - predTrailP[p]) * kEnv;
      const power = predTrailP[p];
      const on = power > 0.18;   // 约等于加速度 > 8：匀速直线与普通续航转向不出拖尾
      const want = on ? Math.min(1, (power - 0.18) / 0.5) : 0;
      const wasOff = predTrailAmt[p] < 0.02;   // 上一帧还没拖尾 → 本次从身体重新拉起
      predTrailAmt[p] += (want - predTrailAmt[p]) * (1 - Math.exp(-dt / (want > predTrailAmt[p] ? 0.05 : 0.30)));
      if (predTrailAmt[p] <= 0.02) { predTrailAmt[p] = 0; continue; }
      const hx2 = predPos[p * 3], hy2 = predPos[p * 3 + 1];
      if (wasOff) {   // 尾巴贴住身体，否则会用上一次拖尾的旧尾巴点，瞬间拉出一条长线
        predTrailTail[p * 2] = hx2; predTrailTail[p * 2 + 1] = hy2;
      }
      // 尾巴的长度也随加速度变化：加速越猛，跟随时间常数越大 → 尾巴越长
      const tk = 1 - Math.exp(-dt / (0.02 + 0.22 * power));
      predTrailTail[p * 2] += (hx2 - predTrailTail[p * 2]) * tk;
      predTrailTail[p * 2 + 1] += (hy2 - predTrailTail[p * 2 + 1]) * tk;
      const o = tc * 3;
      trHead[o] = hx2; trHead[o + 1] = hy2; trHead[o + 2] = 0;
      trTail[o] = predTrailTail[p * 2]; trTail[o + 1] = predTrailTail[p * 2 + 1]; trTail[o + 2] = 0;
      trCol[o] = tmpTrailPred.r; trCol[o + 1] = tmpTrailPred.g; trCol[o + 2] = tmpTrailPred.b;
      trWid[tc] = predLeg() * 0.5;
      trAlp[tc] = predTrailAmt[p] * 0.9;
      tc++;
    }
  }
  trailGeo.instanceCount = tc;
  if (tc > 0) {
    aTrHead.needsUpdate = true; aTrTail.needsUpdate = true;
    aTrCol.needsUpdate = true; aTrWid.needsUpdate = true; aTrAlp.needsUpdate = true;
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
      const cdMs = isMouse ? MOUSE_FEED_MS : cdNormal;
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
  renderer.render(scene, camera);
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
    setStat('hCatch', predCatches);
    setStat('hPort', teleportCount);
    setStat('hBurst', sprintCount);
    setStat('hRest', restSessions);
    $('hRest').title = '累计 ' + restSessions + ' 次 · 当前 ' + restingCount + ' 只在草上';
    $('hFps').textContent = Math.round(fps) + ' FPS';
    $('hSprintFx').className = 'dot' + (fxOn && fxFlash.sprint > 0.35 ? ' sprint' : '');
    $('hPredFx').className = 'dot' + (fxOn && fxFlash.predate > 0.35 ? ' pred' : '');
    $('hBirthFx').className = 'dot' + (fxOn && fxFlash.birth > 0.35 ? ' birth' : '');
  }
  // 帧内分段耗时（EMA 平滑）：step=Boids 仿真、prep=着色/平滑与实例数据上传、draw=渲染提交。
  // 两个 performance.now() 每段的开销在微秒级，不影响帧率；FlockLab.perf 可读。
  const w = 0.05;
  perf.step += ((pT1 - pT0) - perf.step) * w;
  perf.prep += ((pT2 - pT1) - perf.prep) * w;
  perf.draw += ((pT3 - pT2) - perf.draw) * w;
}

addEventListener('resize', () => {
  updateOrthoFrustum();
  updateRectFrame();
  renderer.setSize(innerWidth, innerHeight);
  bgMat.uniforms.uHalf.value.set(innerWidth, innerHeight);
  // 场地宽度随屏幕比例变化：草地若被挤到场地外，就重新长一次
  const bd = bounds2D();
  const out = grass.some((g) => Math.abs(g.x) + g.R * 1.2 > bd.hx || Math.abs(g.y) + g.R * 1.2 > bd.hy);
  if (out) { liftAllResting(); buildGrass(); }
});

updateRectFrame();
// 存档恢复后同步 HUD 上的初始数量
document.getElementById('hCount').textContent = activeCount;
document.getElementById('hPred').textContent = params.predatorOn ? activeP : '0';
requestAnimationFrame(render);

window.FlockLab = {
  params, defaults: DEFAULTS, resetBoids, resetAll: applyDefaults, setCount, setPredCount, spawnBurst,
  saveParams,
  get portalChance() { return PORTAL_P; },
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
  get displayRect() {
    const a = rectFrameGeo.attributes.position.array;
    return { hx: +a[3].toFixed(2), hy: +a[7].toFixed(2) };
  },
  get orthoHalfH() { return +((orthoCam.top - orthoCam.bottom) / 2).toFixed(2); },
  get count() { return activeCount; },
  get paused() { return !!params.paused; },
  get velocities() { return Array.from(vel.slice(0, activeCount * 3)); },
  get renderVelocities() { return Array.from(rVel.slice(0, activeCount * 3)); },
  get predatorCount() { return params.predatorOn ? activeP : 0; },
  // ---- 鼠标捕食者（玩家驾驶的那只，独立于 AI 捕食者计数）----
  get mouseHunter() { return mouseHunter; },
  setMouseHunter(on) { setMouseHunter(!!on); return mouseHunter; },
  // 与 GUI 走同一条路径（改数量 / 开关后同步绘制数量与鼠标槽位），供自动化验证
  setPredatorCount(n) { setPredCount(n); return activeP; },
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
  get maxTrailSpan() {
    let m = 0;
    for (let i = 0; i < trailGeo.instanceCount; i++) {
      const dx = trHead[i * 3] - trTail[i * 3], dy = trHead[i * 3 + 1] - trTail[i * 3 + 1];
      m = Math.max(m, Math.hypot(dx, dy));
    }
    return +m.toFixed(2);
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
  get trailSample() {
    const out = [];
    for (let i = 0; i < Math.min(3, trailGeo.instanceCount); i++) {
      out.push({
        head: [+trHead[i * 3].toFixed(2), +trHead[i * 3 + 1].toFixed(2)],
        tail: [+trTail[i * 3].toFixed(2), +trTail[i * 3 + 1].toFixed(2)],
        w: +trWid[i].toFixed(3), a: +trAlp[i].toFixed(3)
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
      total: +(perf.step + perf.prep + perf.draw).toFixed(2),
      grid: +perfParts.grid.toFixed(2), loop: +perfParts.loop.toFixed(2),
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
  get positions() {
    return Array.from({ length: activeCount }, (_, i) => ({
      x: +pos[i * 3].toFixed(2), y: +pos[i * 3 + 1].toFixed(2),
      born: birthAt[i] === -Infinity ? 0 : Math.round(birthAt[i]),
      dead: !!caught[i]
    }));
  },
  get sprintSoundDuration() { return audio.lastSprintDur; }
};
  