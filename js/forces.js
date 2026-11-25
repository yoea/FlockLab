// FlockLab · 鸟群邻域受力（纯计算：无 DOM、无 THREE、无音频、无随机事件）
//
// 为什么要单独一个文件：
//   这段是整个仿真的热点。2000 只时整帧 31ms、其中 27ms 全花在这里（把邻域扫描
//   配额压到 1，同一场景立刻掉到 2.9ms）；4000 只 56ms / 50ms。网格重建、积分、
//   统计、渲染加起来不到 10%。所以只要把这一段按个体区间切开并行，收益几乎线性。
//   主线程（单核模式）和 Worker（多核模式）**必须共用同一份实现**，否则两份逻辑
//   会随时间漂移，「多核跑出来的群和多核关掉的群行为不一样」是最难查的一类 bug。
//
// 本函数是「只读邻居 + 只写自己的输出」的纯数据并行：
//   - 读：pos / vel / prevFlee / caught / resting / sprintUntil / 空间网格 / 捕食者位置
//   - 写：acc / localDen / neighbors / nearD2A / fleeDir / fleeing / grassTouch / wAng(只读)
//   - 返回：本区间的局部汇总（邻居总数、质心增量、最小间距、碰撞冲量）
// 所有跨个体的全局量都在返回值里交给调用方合并，函数内部不碰任何单例状态。
//
// **不在**这里的（留在 main.js 主线程，它们有全局副作用或依赖全局配额）：
//   - 休息调度（startRest / landHere / endRest：要改草地成员集合、按帧配额放行）
//   - 逃逸爆发触发（要写 stamina / alertMs / sprintUntil 并播声音）
//   - 积分、边界、捕食判定（要写 pos/vel 并即时处理捕获）
//   - 质心累计后的归位、统计量

export const MAX_FORCE = 22;
export const COLLIDE_DIST = 0.55;
export const COLLIDE_DIST2 = COLLIDE_DIST * COLLIDE_DIST;

// 邻域扫描的 9 个格：自己格 → 四邻 → 四角。
const NBR_OFF = [0, 0, 1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];
// 局部密度（颜色）用同一套 9 格，但只读每格的计数、不遍历成员。
const DEN_OFF = NBR_OFF;

const FSM = 0.55;   // 合力一阶低通系数（时间常数约 2 帧）

/**
 * @param {object} S 帧上下文（字段见文件头；worker 侧由消息里的数组重建）
 * @param {number} i0 起始下标（含）——没有 list 时是个体索引，有 list 时是 list 的下标
 * @param {number} i1 结束下标（不含）
 * @param {Int32Array|null} list 可选：要处理的个体索引表（按空间聚类的 cellItems）。
 *   按这张表切分比按 i 区间切分均衡得多——群体是一团，按索引切会让中间那几段
 *   承担几乎全部邻居，最慢的那个 worker 决定整帧时间。
 * @returns {{sumN:number, cx:number, cy:number, minPair2:number, impact:number}}
 */
export function computeForces(S, i0, i1, list) {
  const pos = S.pos, vel = S.vel, acc = S.acc;
  const localDen = S.localDen, neighbors = S.neighbors, nearD2A = S.nearD2A;
  const fleeDir = S.fleeDir, fleeingArr = S.fleeing, prevFlee = S.prevFlee;
  const caught = S.caught, resting = S.resting;
  const wAng = S.wAng, wAmp = S.wAmp, sprintUntil = S.sprintUntil;
  const predPos = S.predPos, predVel = S.predVel;
  const cellStart = S.cellStart, cellEnd = S.cellEnd, cellItems = S.cellItems;
  const grass = S.grass, grassTouch = S.grassTouch;

  const P = S.P, dt = S.dt, time = S.time;
  const cell = S.cell, per2 = S.per2, sep2 = S.sep2, sepSoft = S.sepSoft;
  const SEP_SAT = S.sepSat, denK = S.denK, maxSpeed = S.maxSpeed, maxForce = S.maxForce;
  const keepR = S.keepR, keepR2 = S.keepR2, keepF = S.keepF;
  const paceSpeed = S.paceSpeed, sprintSpeed = S.sprintSpeed;
  const fleeR = S.fleeR, fleeR2 = S.fleeR2;
  const sepCap = S.sepCap, flowT = S.flowT;
  const alignment = S.alignment, cohesion = S.cohesion, separation = S.separation;
  const fleeWeight = S.fleeWeight, predict = S.predict, infoCascade = S.infoCascade;
  const flow = S.flow, grassOn = S.grassOn, wanderBase = S.wanderBase;
  const gridX0 = S.gridX0, gridY0 = S.gridY0, gridW = S.gridW, gridH = S.gridH;
  const groupX = S.groupX, groupY = S.groupY, hx = S.hx, hy = S.hy;

  let sumN = 0;              // 本区间邻居总数（HUD 的「平均邻居数」）
  let cxAcc = 0, cyAcc = 0;  // 质心增量的最小映像和
  let minPair2 = Infinity;   // 本区间最近一对的间距²（验证不重叠）
  let impact = 0;            // 本区间最大碰撞冲量

  for (let b = i0; b < i1; b++) {
    const i = list ? list[b] : b;
    // 等待重生、正在草地休息的个体不参与邻域：
    // 休息的鸟速度接近 0，留着会把飞行中的队伍往草地上拽。
    if (caught[i] || resting[i]) continue;

    const k = i * 3;
    const px = pos[k], py = pos[k + 1], pz = pos[k + 2];
    const vx = vel[k], vy = vel[k + 1], vz = vel[k + 2];

    // 安全时按群体节奏控速；受惊时恢复满速；爆发时直接用爆发速度作为
    // 转向目标速度——否则「追赶」只会把速度上限抬高，方向却仍按巡航速度算，容易冲过头。
    const isDashing = time < sprintUntil[i];
    const calm = !fleeingArr[i] && !isDashing;
    const desiredSpeed = isDashing ? sprintSpeed : (calm ? paceSpeed : maxSpeed);

    let count = 0;
    let sx = 0, sy = 0, sz = 0;                          // 聚合：邻居坐标和
    let ax = 0, ay = 0, az = 0;                          // 对齐：邻居速度和
    let dxs = 0, dys = 0, dzs = 0;                       // 分离：加权方向
    let maxW = 0;                                        // 最近那只的排斥权重（拥挤度用）
    let nearDx = 0, nearDy = 0, nearD2 = Infinity;       // 最近那只的方向与间距²（贴身硬核用）
    let nearVx = 0, nearVy = 0;                          // 最近那只的速度（抵消接近分量用）
    let cfx = 0, cfy = 0, cfz = 0, cascadeCount = 0;     // 信息级联：邻居上一帧的逃逸方向
    let asp2 = 0;                                        // 注意力邻里速度平方和（一致性加权用，免 sqrt）

    const ix = Math.floor(px / cell) - gridX0, iy = Math.floor(py / cell) - gridY0;
    // 局部密度：3×3 格的总活跃鸟数（只读计数，不遍历成员，开销可以忽略）。
    // 颜色色阶必须独立于注意力上限，否则整群永远同一色。
    let nearby = 0;
    for (let oi = 0; oi < 18; oi += 2) {
      const ccx = ix + DEN_OFF[oi], ccy = iy + DEN_OFF[oi + 1];
      if (ccx < 0 || ccy < 0 || ccx >= gridW || ccy >= gridH) continue;
      const c = ccy * gridW + ccx;
      nearby += cellEnd[c] - cellStart[c];
    }
    localDen[i] = nearby > denK ? 1 : nearby / denK;

    // ---- 邻域扫描（原始 Reynolds 式：视野内全部同伴）----
    // 只保留一个「每帧最多扫多少个候选」的安全阀（sepCap，按数量分档）：
    // 它**不是**注意力上限，只是防炸帧，默认 800 只时远大于真实邻居数。
    let cand = 0;
    scanCells:
    for (let pass = 0; pass < 9; pass++) {
      const ccx = ix + NBR_OFF[pass * 2], ccy = iy + NBR_OFF[pass * 2 + 1];
      if (ccx < 0 || ccy < 0 || ccx >= gridW || ccy >= gridH) continue;
      const c = ccy * gridW + ccx;
      const b1 = cellEnd[c];
      for (let b = cellStart[c]; b < b1; b++) {
        if (cand >= sepCap) break scanCells;
        cand++;
        const j = cellItems[b];
        if (j === i || caught[j]) continue;
        const m = j * 3;
        const dx = px - pos[m], dy = py - pos[m + 1], dz = pz - pos[m + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > per2 || d2 < 1e-8) continue;

        // 对齐与聚合：视野内每一只都算
        count++;
        sx += pos[m]; sy += pos[m + 1]; sz += pos[m + 2];
        ax += vel[m]; ay += vel[m + 1]; az += vel[m + 2];
        asp2 += vel[m] * vel[m] + vel[m + 1] * vel[m + 1] + vel[m + 2] * vel[m + 2];
        if (P > 0 && infoCascade && fleeingArr[j]) {
          cfx += prevFlee[m]; cfy += prevFlee[m + 1]; cfz += prevFlee[m + 2];
          cascadeCount++;
        }
        if (d2 < sep2) {
          // 纯 1/d²：贴近时权重陡增，一次擦身就能把整块炸开（sepSoft 现为 0）。
          const w = 1 / (d2 + sepSoft);
          if (w > maxW) maxW = w;
          dxs += dx * w; dys += dy * w; dzs += dz * w;
          if (d2 < nearD2) { nearD2 = d2; nearDx = dx; nearDy = dy; nearVx = vel[m]; nearVy = vel[m + 1]; }
          if (d2 < minPair2) minPair2 = d2;
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
    sumN += count;

    // 质心累计用「相对上一帧质心的最小映像位移」：鸟穿墙的那一瞬间位置会跳到对侧，
    // 直接累加坐标会让质心跟着跳、把「群体归拢」的方向整个翻过来。
    let cdx = px - groupX, cdy = py - groupY;
    if (cdx > hx) cdx -= 2 * hx; else if (cdx < -hx) cdx += 2 * hx;
    if (cdy > hy) cdy -= 2 * hy; else if (cdy < -hy) cdy += 2 * hy;
    cxAcc += cdx; cyAcc += cdy;

    let fx = 0, fy = 0, fz = 0;

    // ---- 一致性（对齐）----
    if (count > 0) {
      let len = Math.sqrt((ax) * (ax) + (ay) * (ay) + (az) * (az));
      if (len > 1e-6) {
        // 一致性 = |Σv| / sqrt(n·Σv²)（0=各飞各的，1=完全齐飞；等价于 |Σv|/Σ|v| 但省掉逐只开方）。
        // 按一致性加权后，散乱时力只有约四成，齐飞时才接近满力。
        const agree = asp2 > 1e-6 ? len / Math.sqrt(count * asp2) : 0;
        const s = desiredSpeed * (0.72 + 0.28 * agree) / len;
        let tx = ax * s - vx, ty = ay * s - vy, tz = az * s - vz;
        const tl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
        if (tl > maxForce) { const q = maxForce / tl; tx *= q; ty *= q; tz *= q; }
        fx += tx * alignment; fy += ty * alignment; fz += tz * alignment;
      }
      // ---- 聚合（内聚）----
      let tx = sx / count - px, ty = sy / count - py, tz = sz / count - pz;
      len = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
      if (len > 1e-6) {
        const s = desiredSpeed / len;
        tx = tx * s - vx; ty = ty * s - vy; tz = tz * s - vz;
        const tl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
        if (tl > maxForce) { const q = maxForce / tl; tx *= q; ty *= q; tz *= q; }
        fx += tx * cohesion; fy += ty * cohesion; fz += tz * cohesion;
      }
    }

    // ---- 群体归拢（长程）----
    // 局部规则只看视野内的同伴：两坨鸟间距一旦超过视野就永久互不相见，强分离会把
    // 群体压成许多「结晶小团」。这里补一条只对「离质心太远」的个体生效的弱长程吸引。
    let rgx = groupX - px, rgy = groupY - py;
    if (rgx > hx) rgx -= 2 * hx; else if (rgx < -hx) rgx += 2 * hx;
    if (rgy > hy) rgy -= 2 * hy; else if (rgy < -hy) rgy += 2 * hy;
    const rg2 = rgx * rgx + rgy * rgy;
    if (rg2 > keepR2) {
      const rg = Math.sqrt(rg2);
      const w = Math.min(1.6, (rg - keepR) / keepR);
      fx += rgx / rg * keepF * w;
      fy += rgy / rg * keepF * w;
    }

    // ---- 分离 ----
    // 拥挤度必须由「最近那只挤得多近」（maxW = max 1/(d²+ε)）决定，不能用加权和
    // 的模长 sl：sl 在 d→0 时同样趋于 0，于是「最该排斥的时刻力反而最小」。
    let sl = Math.sqrt((dxs) * (dxs) + (dys) * (dys) + (dzs) * (dzs));
    if (maxW > 1e-6) {
      const crowd = maxW / (maxW + SEP_SAT);          // 刚进安全圈 0.1、贴身 0.9
      if (sl < 1e-6) {
        // 完全重合时 dxs 也退化成 0，方向只能随机——但力必须还在，否则叠住分不开
        const a = Math.random() * 6.2831853;
        dxs = Math.cos(a); dys = Math.sin(a); dzs = 0; sl = 1;
      }
      const s = desiredSpeed * (0.55 + 0.45 * crowd) / sl;
      let tx = dxs * s - vx * crowd, ty = dys * s - vy * crowd, tz = dzs * s - vz * crowd;
      const tl = Math.sqrt((tx) * (tx) + (ty) * (ty) + (tz) * (tz));
      if (tl > maxForce) { const q = maxForce / tl; tx *= q; ty *= q; tz *= q; }
      fx += tx * separation; fy += ty * separation; fz += tz * separation;
    }

    // 贴身硬核：已经挤进「一个身位」时，光靠转向根本来不及（速度 15、帧间隔 20~30ms
    // 时一帧就位移 0.3~0.45）。所以同时做两件事：① 沿「远离最近那只」的方向强推；
    // ② 把「朝对方去」的速度分量直接掐掉。两者都按 k²/k 加权，只在极近处发力。
    if (nearD2 < COLLIDE_DIST2) {
      const d = Math.sqrt(nearD2);
      const k = (COLLIDE_DIST - d) / COLLIDE_DIST;      // 0~1，越贴身越陡
      const nx = nearDx / d, ny = nearDy / d;           // 由邻居指向自己
      let hfx = nx * maxForce * 1.2 * k * k;
      let hfy = ny * maxForce * 1.2 * k * k;
      const closing = (vx - nearVx) * nx + (vy - nearVy) * ny;   // <0 = 正在靠近
      if (closing < 0) {
        // 碰撞响应，不是普通转向：一帧内抵消 85% 的接近速度，且**不受 maxForce
        // 限制**——速度 15、相对速度 30 时，靠 22 的转向力要 20 多帧才停得住。
        const kill = Math.min(-closing / Math.max(dt, 0.008) * 0.85, 900) * k;
        hfx += nx * kill; hfy += ny * kill;
      }
      const hl = Math.sqrt(hfx * hfx + hfy * hfy);
      const hcap = 900;
      if (hl > hcap) { const q = hcap / hl; hfx *= q; hfy *= q; }
      fx += hfx; fy += hfy;
    }
    nearD2A[i] = nearD2 === Infinity ? 0 : nearD2;   // sepStats 统计用

    // ---- 猎物逃逸：预测威胁点 + 距离平方衰减 + 信息级联 ----
    // 白肌式短时爆发：体力满 + 进入危险范围才触发（触发在主线程，这里只读 sprintUntil）。
    if (P > 0) {
      const sprinting = time < sprintUntil[i];
      let efx = 0, efy = 0, efz = 0;
      for (let p = 0; p < P; p++) {
        const q = p * 3;
        const dx = px - predPos[q], dy = py - predPos[q + 1], dz = pz - predPos[q + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= fleeR2 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const tau = (d / maxSpeed) * predict;
        // 威胁点取捕食者未来位置；方向为从威胁点指向自己
        const ex = px - (predPos[q] + predVel[q] * tau);
        const ey = py - (predPos[q + 1] + predVel[q + 1] * tau);
        const ez = pz - (predPos[q + 2] + predVel[q + 2] * tau);
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
        const mag = fleeWeight * w * w * (sprinting ? 1.25 : 1);
        efx += tx * mag; efy += ty * mag; efz += tz * mag;
      }
      // 群体级躲避：捕食者进入范围时整群沿远离它的方向一起偏航一次（约 1.2 秒波纹），
      // 随后停止群体推力，让鱼群重新聚合——像真实鱼群遇鲨后散开再合拢。
      const ripple = Math.max(0, 1 - (time - S.groupThreatAt) / 1200);
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
          const strength = fleeWeight * w * ripple * 1.6;
          efx += gdx / gl * strength;
          efy += gdy / gl * strength;
          efz = 0;
        }
      }
      // 信息级联：邻居上一帧的逃逸方向传播过来，形成波状逃逸
      if (infoCascade && cascadeCount > 0) {
        const s = 0.80 / cascadeCount;
        efx += cfx * s; efy += cfy * s; efz += cfz * s;
      }
      const mag = Math.sqrt((efx) * (efx) + (efy) * (efy) + (efz) * (efz));
      if (mag > 1e-6) {
        fleeDir[k] = efx / mag; fleeDir[k + 1] = efy / mag; fleeDir[k + 2] = efz / mag;
        fleeingArr[i] = 1;
        fx += efx; fy += efy; fz += efz;
      } else {
        fleeDir[k] = 0; fleeDir[k + 1] = 0; fleeDir[k + 2] = 0;
        fleeingArr[i] = 0;
      }
    } else {
      fleeDir[k] = 0; fleeDir[k + 1] = 0; fleeDir[k + 2] = 0;
      fleeingArr[i] = 0;
    }

    // ---- 绕开草地 ----
    // 不休息的鸟会主动沿着草地边缘滑过去，而不是直接从草地上方穿过去。
    // 做法是「法向推开 + 沿当前运动方向的切向」——只推法向的话看起来像撞到墙弹开。
    let insideG = -1;   // 当前正压在哪片草地上（-1 = 不在任何草地上）
    if (grassOn && grass.length) {
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
          const kk = Math.min(1, (rr - gd) / Math.max(1, rr * 0.5));
          fx += nx * (10 + 14 * kk); fy += ny * (10 + 14 * kk);
        } else {
          const w = 1 - (gd - rr) / 7;          // 0~1，越靠近边缘越强
          if (w <= 0) continue;
          const tx2 = -ny, ty2 = nx;
          // 往自己正在走的那一侧绕。用「切向速度 / 速率」的连续值而不是 ±1：
          // 鸟在边缘几乎停住时切向速度≈0，若还按符号硬选边，力会每帧左右翻，看着就是抖。
          const tv = vx * tx2 + vy * ty2;
          const sgn = tv / (Math.sqrt((vx) * (vx) + (vy) * (vy)) + 0.8);
          fx += (nx * 9 + tx2 * sgn * 7) * w;
          fy += (ny * 9 + ty2 * sgn * 7) * w;
        }
      }
      // 掠过草地：把「正压在哪片草上」交给主线程，由它决定要不要顺势落下来
      // （落地点要跟同片草地上的其它鸟查间距、还要占「本帧出发配额」，只能串行做）。
      if (grassTouch) grassTouch[i] = insideG;
    }

    // ---- 实体墙的提前避让 ----
    // 只在撞上那一刻反弹的话，鸟会贴着墙一路蹭、或者满屏往一个角堆——提前一个身位
    // 带就开始往外拐：边缘 8 个单位内给一个指向场内的推力，越贴越强。
    if (!S.wrapEdges) {
      const m = 8;
      if (px > hx - m) { const kk = (px - (hx - m)) / m; fx -= kk * kk * 26; }
      else if (px < -hx + m) { const kk = ((-hx + m) - px) / m; fx += kk * kk * 26; }
      if (py > hy - m) { const kk = (py - (hy - m)) / m; fy -= kk * kk * 26; }
      else if (py < -hy + m) { const kk = ((-hy + m) - py) / m; fy += kk * kk * 26; }
    }

    // ---- 流场 + 个体游走 ----
    fx += Math.sin(py * 0.11 + flowT) * flow;
    fy += Math.cos(px * 0.09 - flowT * 0.8) * flow * 0.7;
    // 每只鸟带一条缓慢漂移的私人航向。邻居越多，群体把它「稳住」的力度越大，
    // 所以队形仍由三条规则决定，只是落单的个体会自己晃。
    // wAng 由主线程每帧统一推进（这里只读），所以向量化/并行都不会让航向停住。
    const wanderMag = wanderBase * wAmp[i] / (1 + count * 0.06);
    fx += Math.cos(wAng[i]) * wanderMag;
    fy += Math.sin(wAng[i]) * wanderMag;

    // 合力一阶低通：逐帧的注意力合力抖动很大，直接积分会让群体在
    // 「被聚合力收紧 → 分离力炸开 → 再收紧」之间来回摆。
    acc[k] += (fx - acc[k]) * FSM;
    acc[k + 1] += (fy - acc[k + 1]) * FSM;
    acc[k + 2] = 0;
  }

  return { sumN, cx: cxAcc, cy: cyAcc, minPair2, impact };
}
