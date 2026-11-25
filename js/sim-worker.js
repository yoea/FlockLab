// FlockLab · 仿真 Worker
//
// 只做一件事：对 [i0, i1) 这段个体算邻域受力，把结果写进自己的输出缓冲。
// 具体规则在 forces.js —— 和主线程单核模式**同一份实现**，这里不重复任何物理逻辑。
//
// 数据交换用 Transferable 双程（去程由主线程填好副本，回程把同一批 ArrayBuffer
// 原样还给主线程），所以整趟是零拷贝的；唯一成本是主线程每帧往每个 worker 复制
// 一份只读输入（pos / vel / 上一帧逃逸方向 / 几个个体状态）。
//
// 为什么不用 SharedArrayBuffer：它要求页面处于 crossOriginIsolated（COOP + COEP），
// 那会牵动 nginx 头、CDN 脚本的 CORS 属性、以及 Service Worker 回放缓存的响应头，
// 在已经上线的静态站 + PWA 离线场景里风险远大于收益。Transferable 方案在普通
// same-origin 页面就能跑，离线也一致。
//
// 网格在这里自己重建：主线程的网格尺寸会随缩放/窗口变化，跨线程传三个数组还要
// 处理 resize 握手；而重建一次 8000 只只要 ~0.5ms，相对并行的收益可以忽略。

import { computeForces } from './forces.js';

const MAXN = 10000;

// 每个 worker 自己维护的计数排序网格（尺寸随场地变化时重分配）。
const gItems = new Int32Array(MAXN);
let gW = 0, gH = 0, gX0 = 0, gY0 = 0;
let cStart = new Int32Array(0), cEnd = new Int32Array(0), cFill = new Int32Array(0);

const S = {
  pos: null, vel: null, acc: null, localDen: null, neighbors: null, nearD2A: null,
  fleeDir: null, fleeing: null, prevFlee: null, caught: null, resting: null,
  wAng: null, wAmp: null, sprintUntil: null,
  predPos: null, predVel: null, grassTouch: new Int8Array(MAXN),
  cellStart: cStart, cellEnd: cEnd, cellItems: gItems, grass: []
};

function rebuildGrid(n) {
  const cell = S.cell;
  const gx0 = Math.floor((-S.hx - 6) / cell);
  const gy0 = Math.floor((-S.hy - 6) / cell);
  const gw = Math.floor((S.hx + 6) / cell) - gx0 + 1;
  const gh = Math.floor((S.hy + 6) / cell) - gy0 + 1;
  const gcells = gw * gh;
  if (gw !== gW || gh !== gH) {
    gW = gw; gH = gh;
    cStart = new Int32Array(gcells);
    cEnd = new Int32Array(gcells);
    cFill = new Int32Array(gcells);
    S.cellStart = cStart;
    S.cellEnd = cEnd;
  }
  gX0 = gx0; gY0 = gy0;
  cStart.fill(0);

  const pos = S.pos, caught = S.caught, resting = S.resting;
  for (let i = 0; i < n; i++) {
    // 等待重生的个体、以及在草地上休息的个体都不参与邻域（与主线程一致）。
    if (caught[i] || resting[i]) continue;
    const k = i * 3;
    const gx = Math.floor(pos[k] / cell) - gX0;
    const gy = Math.floor(pos[k + 1] / cell) - gY0;
    if (gx < 0 || gy < 0 || gx >= gW || gy >= gH) continue;
    cStart[gy * gW + gx]++;
  }
  let acc = 0;
  for (let c = 0; c < gcells; c++) {
    const cnt = cStart[c];
    cEnd[c] = acc + cnt;
    cFill[c] = acc + cnt;
    cStart[c] = acc;
    acc += cnt;
  }
  for (let i = 0; i < n; i++) {
    if (caught[i] || resting[i]) continue;
    const k = i * 3;
    const gx = Math.floor(pos[k] / cell) - gX0;
    const gy = Math.floor(pos[k + 1] / cell) - gY0;
    if (gx < 0 || gy < 0 || gx >= gW || gy >= gH) continue;
    gItems[--cFill[gy * gW + gx]] = i;
  }
  S.gridX0 = gX0; S.gridY0 = gY0; S.gridW = gW; S.gridH = gH;
}

self.onmessage = (e) => {
  const m = e.data;
  if (!m || m.cmd !== 'run') return;
  const b = m.bufs;

  // 转移回来的是新的 ArrayBuffer 包装，原来的 TypedArray 视图已经 detached，
  // 所以每次都按索引重新建视图（14 个小对象/次，成本可以忽略）。
  S.pos = new Float32Array(b[0]);
  S.vel = new Float32Array(b[1]);
  S.prevFlee = new Float32Array(b[2]);
  S.sprintUntil = new Float64Array(b[3]);
  S.wAng = new Float32Array(b[4]);
  S.wAmp = new Float32Array(b[5]);
  S.caught = new Uint8Array(b[6]);
  S.resting = new Uint8Array(b[7]);
  S.acc = new Float32Array(b[8]);
  S.fleeDir = new Float32Array(b[9]);
  S.localDen = new Float32Array(b[10]);
  S.nearD2A = new Float32Array(b[11]);
  S.neighbors = new Uint16Array(b[12]);
  S.fleeing = new Uint8Array(b[13]);
  S.grassTouch = new Int8Array(b[14]);
  S.cellStart = new Int32Array(b[15]);
  S.cellEnd = new Int32Array(b[16]);
  S.cellItems = new Int32Array(b[17]);

  const meta = m.meta;
  Object.assign(S, meta);      // 标量 + grass / predPos / predVel（小数组，克隆成本可忽略）

  const t0 = performance.now();
  // 网格由主线程建好并复制过来（gridW/H/X0/Y0 在 meta 里），这里不再重建。
  const res = computeForces(S, m.i0, m.i1);
  res.gridMs = performance.now() - t0;
  res.ms = res.gridMs;

  // 同一批 buffer 原样还回去（零拷贝），主线程下一帧继续用。
  self.postMessage({ id: m.id, i0: m.i0, i1: m.i1, res, bufs: b }, b);
};
