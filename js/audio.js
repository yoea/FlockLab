// ---------------------------------------------------------------- 声音
// 事件音共九类（含 v1.4.21 补的三个罕见事件）；另有六层生成式音乐。
// v1.4.23 去掉了「整群振翅」的密度纹理层：那层嘶声会盖住音乐的拍子与事件的方位。
// 没有碰撞与琶音；静音时断开输出并挂起 AudioContext。
// 总线预留余量：音效总线（fxBus）与音乐 bus 都汇进 master 再进 destination。
// 这个值原来是 params.master，v1.4.7 把音量定死成「面板满刻度」后从 DEFAULTS 删掉了它，
// 但这里还在读 → undefined → 写 AudioParam 抛 TypeError → 每帧打断 render → 画面定格。
// 所以改成常量，不再依赖参数表（音频参数以后怎么删都不会再打断主循环）。
const MASTER_GAIN = 0.38;

// ---------------------------------------------------------------- 空间（v1.4.21）
// 相机是正交俯视、lookAt 正下方，唯一的旋转是 ±0.55° 的 SHAKE.roll（可忽略）。
// 所以「世界坐标 → 声像」是一条直线：pan = (x − camX) / 视野半宽。
// 不需要 PannerNode，也不需要把相机矩阵搬进音频线程。
const PAN_SPREAD = 0.92;     // 最大声像偏移：留一点余量，不把声音推到单边贴耳
const PAN_FAR = 1.6;         // 距离归一化的上限（视野半宽的倍数）
const BUCKETS = 4;           // 限流分桶数：左 / 中左 / 中右 / 右
// 共享混响：两条串联的短延迟 + 阻尼反馈 ≈ 0.6s 的房间。事件音原来是纯干声，
// 只有音乐层带空间感，两者听着像不在同一个场地里。不引入卷积（不必载 IR）。
const REV_WET = 0.20;
const REV_D1 = 0.037, REV_D2 = 0.053, REV_FB = 0.40, REV_LP = 2600;
// v1.4.23：整群振翅的「密度纹理层」（一条随速度/密度变化的循环噪声）整个去掉。
// 它本来是「逐鸟振翅 5000+ 次/秒」的替代品，但那层嘶声在安静段落里更像噪声地毯，
// 压住音乐、也压住事件的方位感；而少了它，鸟的动作仍然看得见、事件音仍然听得见。
// 与其反复调电平，不如不要这一层。

export class FlockAudio {
  // flash：与外部共享的「音效指示灯」状态（HUD 上的三个小圆点）
  constructor(params, flash) {
    this.p = params;
    this.flash = flash || { sprint: 0, predate: 0, birth: 0 };
    this.ctx = null;
    this.enabled = false;
    this.muted = false;
    this.outputConnected = false;
    this.suspendedByVisibility = false;
    // 静音是「用户意图」，必须跨刷新记住。否则刷新时 enable() 会擅自开声，
    // 看起来就像「明明静音了还有声音」。
    this.mutedPref = false;
    // v2：v1.4.0 之前这个 key 存过实验用的静音状态，会让人「刷新后一直是静音」。
    // 换 key 等于一次性重置为「默认开声」，之后用户的静音选择照常记住。
    try { this.mutedPref = localStorage.getItem('flocklab.audio.muted.v2') === '1'; } catch (e) {}
    this.lastSprintDur = 0;
    // 视口快照（由 main.js 每帧喂三个标量）：声像与距离都从它算，音频模块不碰相机。
    this.view = { x: 0, y: 0, halfW: 60 };
    // 统一限流表：key → {last, win, n}。按声像分桶，见 _allow()。
    this.lim = Object.create(null);
    this.ctr = {};           // 限流诊断计数（try / gap / cap / pass / b0..b3）
    this.lastPan = 0;
    this.total = { sprint: 0, predate: 0, birth: 0, land: 0, takeoff: 0, dash: 0, lock: 0, dive: 0, alarm: 0 };
    this.music = null;   // 由构造函数末尾创建（音乐与音效共用同一套音频上下文）
    // 切到后台 / 页面被隐藏：主动断开并挂起。浏览器标签页静音由浏览器负责，
    // 但 AudioContext 自己仍在 running、音乐调度器仍每 25ms 排音符——一旦静音
    // 被解除或静音的是别的标签，声音就会继续漏出来。这里从源头掐掉。
    document.addEventListener('visibilitychange', () => this.handleVisibility());
    addEventListener('pagehide', () => {
      if (this.ctx) this.ctx.suspend().catch(() => {});
    });
  }

  // 唯一的音频出口。所有层（事件音 fxBus、音乐 bus）最终都汇到 master → destination，
  // 所以只要这一个开关断开，任何声音都不可能绕过到达扬声器。
  connectOutput() {
    if (!this.master || !this.ctx) return;
    // 这一段在每帧的仿真路径上被调用（canPlay → connectOutput），
    // 任何异常都会打断整帧、让画面定格，所以这里必须自己吞掉：
    // 音频出问题最多是没声音，绝不能让鸟群停下来。
    try {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.value = MASTER_GAIN;
      this.master.disconnect();
      this.master.connect(this.ctx.destination);
      this.outputConnected = true;
    } catch (_) {
      this.outputConnected = false;
    }
  }
  disconnectOutput() {
    if (!this.master || !this.ctx) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.value = 0;
    this.master.disconnect();
    this.outputConnected = false;
  }

  // 所有发声路径的统一闸门：除了「用户没静音」，还要求上下文真的在跑、
  // 出口真的连着、页面真的可见。任何一环不满足都不排新节点。
  // 顺带做一次自愈：从后台回来若出口还没接上，且用户并未静音，就接回来。
  canPlay() {
    if (!this.enabled || this.muted || !this.ctx || document.hidden || this.suspendedByVisibility) return false;
    if (this.ctx.state !== 'running') return false;
    if (!this.outputConnected) this.connectOutput();
    return true;
  }

  // ---- 空间：世界坐标 → 声像 / 距离 ----------------------------------
  // main.js 在相机更新之后每帧调一次。用「屏幕」而不是「场地」当标尺：
  // 缩放时视野半宽变小，远处的鸟声自然会更偏向画面两侧，和看到的一致。
  setView(x, y, halfW) {
    const v = this.view;
    v.x = x; v.y = y;
    v.halfW = (halfW > 1) ? halfW : 60;
  }

  // 声像：正交俯视 + 极小 roll ⇒ 只跟世界 X 有关，一条直线映射。
  panAt(x) {
    if (x === undefined) return 0;
    const v = this.view;
    const p = (x - v.x) / v.halfW;
    return Math.max(-1, Math.min(1, p)) * PAN_SPREAD;
  }

  // 距离（归一化到视野半宽）：只用来做很轻的衰减与闷化。
  distAt(x, y) {
    if (x === undefined) return 0;
    const v = this.view;
    const dx = x - v.x, dy = y - v.y;
    return Math.min(PAN_FAR, Math.sqrt(dx * dx + dy * dy) / v.halfW);
  }

  // 每个事件音共用的出口链：低通（按距离闷化）→ 增益（按距离衰减）
  // → StereoPanner（按位置）→ fxBus（+ 混响送出）。
  // 返回链路的「入口」，事件音的各个成分全部接到它上面。
  _chain(pan, dist) {
    const ctx = this.ctx;
    const d = Math.max(0, Math.min(PAN_FAR, dist || 0));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    // 18k → 6.1k → 3.3k：远处的声音更闷，这是人耳判断距离的主要线索之一。
    lp.frequency.value = 18000 * Math.pow(0.34, d);
    lp.Q.value = 0.5;
    const g = ctx.createGain();
    // 衰减刻意温和（最多 −45%）：整片场地的鸟声本来就该是一层雾，
    // 衰减太狠会变成一颗颗孤立的点，反而更假。
    g.gain.value = 1 - 0.45 * Math.min(1, d);
    lp.connect(g);
    let out = g;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan || 0));
      g.connect(p); out = p;
    }
    out.connect(this.fxBus);
    if (this.revSend) out.connect(this.revSend);   // 共享空间感（纯干声听着像贴脸）
    return lp;
  }

  // 统一限流：gapMs 是最小间隔，perSec 是每秒上限。
  // 返回 true 表示「放行」，调用方负责计数。
  // `try` / `gap` / `cap` / `pass` 只做诊断：调音时要能分出「本来就没事件」和「全被闸门丢了」。
  _allow(key, gapMs, perSec) {
    const now = performance.now();
    let st = this.lim[key];
    if (!st) st = this.lim[key] = { last: 0, win: 0, n: 0 };
    this.ctr.try = (this.ctr.try || 0) + 1;
    // 窗口必须**先**滚动，再判间隔。
    // 反过来写是个真 bug：事件持续密集（间隔永远小于 gapMs）时，
    // 每次调用都停在 gap 那一行 return，永远走不到重置；计数器打满一次就永久锁死，
    // 实测把冲刺发声从 8/s 压到 4.4/s，且表面看「闸门明明还有余量」。
    if (now > st.win) { st.win = now + 1000; st.n = 0; }
    if (now - st.last < gapMs) { this.ctr.gap = (this.ctr.gap || 0) + 1; return false; }
    if (st.n >= perSec) { this.ctr.cap = (this.ctr.cap || 0) + 1; return false; }
    st.last = now; st.n++;
    this.ctr.pass = (this.ctr.pass || 0) + 1;
    return true;
  }

  // 限流**只有一道全局闸门**（每个事件类型各一道），与 v1.4.20 语义一致。
  // 曾经试过「按声像分 4 桶各自限流」，实测没有收益：800 只鸟是集中一团，
  // 声源几乎全落在 1~2 个桶里（b2 命中 758、b0 只有 2），分桶既不改善空间分布，
  // 还让总量变得不可预测（sprint 从 547 掉到 213 次/分）。分桶在这里没有意义——
  // 声像该跟着位置走，总量该由一道闸门管。
  _allowPanned(kind, pan, gapMs, perSec) {
    const b = Math.max(0, Math.min(BUCKETS - 1,
      Math.floor((Math.max(-1, Math.min(1, pan)) + 1) * (BUCKETS / 2))));
    this.ctr['b' + b] = (this.ctr['b' + b] || 0) + 1;   // 只做诊断：看声源摊在几个桶
    return this._allow(kind, gapMs, perSec);
  }

  // 诊断快照：try / gap / cap / pass 累计 + b0..b3 各声像桶的命中数。
  // 「声音太少」时先看这里，能立刻分出是「没事件」还是「全被闸门丢了」。
  get limits() { return { ...this.ctr }; }

  handleVisibility() {
    if (!this.ctx) return;
    if (document.hidden) {
      this.suspendedByVisibility = true;
      this.disconnectOutput();
      this.ctx.suspend().catch(() => {});
      if (this.music) this.music.pauseScheduler();
    } else {
      this.suspendedByVisibility = false;
      if (this.enabled && !this.muted && !this.mutedPref) {
        this.ctx.resume().catch(() => {});
        this.connectOutput();
        if (this.music) this.music.resumeScheduler();
      }
    }
  }

  async enable() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('当前浏览器不支持 Web Audio API');
      const ctx = this.ctx = new AC();

      this.master = ctx.createGain();
      this.master.gain.value = MASTER_GAIN;
      this.master.connect(ctx.destination);
      this.outputConnected = true;
    }

    // 建图拆成两段：上一次若在某个节点上抛错，下次 enable() 还能把缺的补齐，
    // 不会留下「ctx 有了、fxBus 没有」的半成品状态（那会让每个事件音都抛错）。
    if (!this.fxBus) {
      const ctx = this.ctx;
      // 音效总线：所有事件音先进这里，再进 master。
      // 这样「音效音量」只影响提示音，不会把音乐一起推大。
      this.fxBus = ctx.createGain();
      // 面板刻度直接就是增益：1.0 对应单位响度
      this.fxBus.gain.value = this.p.fxLevel;
      this.fxBus.connect(this.master);

      // 噪声缓冲：逃逸气流、咬合、捕食者喷射共用。
      // 长度给到 1.35s —— 火箭喷射那层要连续响 0.4~0.5s，0.25s 的原料会在半途
      // 直接哑掉（BufferSource 播完就静音）；顺便把尾部 60ms 做成交叉淡化，
      // 这样任何一层想 loop 都不会在接缝处「嗒」一下。
      const len = Math.floor(ctx.sampleRate * 1.35);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const fade = Math.floor(ctx.sampleRate * 0.06);
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        data[i] = data[i] * k + data[len - fade + i] * (1 - k);
      }

      // 空间感挂在 fxBus 之后，一起受「音效音量」与总开关控制
      this.buildReverb();
    }
    // 先把「允许发声 / 静音」的状态定下来，再尝试 resume。
    // 关键：resume() 在没有用户手势时会被浏览器拒绝（抛出 NotAllowedError）。
    // 旧代码先 await resume()，一旦被拒就整段中断，静音偏好没来得及应用——
    // master 仍连着 destination、增益还是满的，等用户随便点一下触发 resume，
    // 声音就直接漏出来了，看起来就是「明明静音了还有声音」。
    this.enabled = true;
    this.p.enabled = true;
    if (this.mutedPref) {
      this.setMuted(true);                       // 先断开出口并挂起，再 resume
      try { await this.ctx.resume(); } catch (e) {}
      this.ctx.suspend().catch(() => {});        // resume 成功也要立刻压回去
    } else {
      this.muted = false;
      this.connectOutput();
      try { await this.ctx.resume(); } catch (e) {}
      if (this.music) this.music.start();        // 音乐跟着声音一起开
      this.refreshButton();
    }
  }

  // 共享混响：两条串联短延迟 + 阻尼反馈（≈0.6s 的房间）。
  // 事件音原来全是干声，只有音乐层带空间感，两者听着不像在同一个场地。
  // 不用卷积混响——那需要载一份 IR，而这里要的只是「有墙」的感觉。
  buildReverb() {
    const ctx = this.ctx;
    const send = ctx.createGain(); send.gain.value = 1;
    const pre = ctx.createDelay(0.2); pre.delayTime.value = 0.012;
    const d1 = ctx.createDelay(0.5); d1.delayTime.value = REV_D1;
    const d2 = ctx.createDelay(0.5); d2.delayTime.value = REV_D2;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass'; damp.frequency.value = REV_LP; damp.Q.value = 0.6;
    const fb = ctx.createGain(); fb.gain.value = REV_FB;
    const wet = ctx.createGain(); wet.gain.value = REV_WET;
    send.connect(pre); pre.connect(d1); d1.connect(d2);
    d2.connect(damp); damp.connect(fb); fb.connect(d1);
    damp.connect(wet); wet.connect(this.fxBus);
    this.revSend = send;
  }

  // v1.4.23：buildTexture() / setDensity() 已删除，见文件顶部关于「密度纹理层」的说明。

  refreshButton() {
    const btn = document.getElementById('audioBtn');
    const live = this.enabled && !this.muted;
    btn.classList.toggle('live', live);
    const label = !this.enabled ? '开启声音与音乐'
      : (this.muted ? '声音与音乐已关闭，点击开启' : '声音与音乐已开启，点击静音');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  // 彻底静音：主增益归零 + 断开到 destination 的唯一出口 + 挂起整个 AudioContext。
  // 只把增益降到 0 不够——已排队的节点与后台调度器仍会漏声，所以三件事一起做。
  setMuted(m) {
    this.muted = m;
    this.mutedPref = m;
    try { localStorage.setItem('flocklab.audio.muted.v2', m ? '1' : '0'); } catch (e) {}
    if (m) {
      this.disconnectOutput();
      if (this.ctx) this.ctx.suspend().catch(() => {});
    } else if (this.ctx) {
      this.ctx.resume().catch(() => {});
      this.connectOutput();
    }
    if (this.music) this.music.mute(m);   // 事件音与音乐共用这一个开关
    this.refreshButton();
  }

  toggle() {
    if (!this.enabled) return this.enable();
    this.setMuted(!this.muted);
    return Promise.resolve();
  }

  // 1) 加速逃逸：一串「扑翅」颗粒 + 一记明亮的上扬哨音。
  //    旧版是 1.3~3.2kHz 窄带噪声 + 低频三角波上滑气口，低频混在一起发闷，
  //    听起来是一团「噗噗」的气流而不是振翅。现在改成：
  //      · 3 记极短（14~22ms）的高频「扑棱」脉冲，间隔 22ms，像翅膀连拍
  //      · 一记 sine 哨音从 ~1.5kHz 快速上滑到 ~3kHz（55ms），给提速一个方向
  //      · 整组串 700Hz 高通，把所有低频浑浊切掉；声像每次随机
  //      · 严格限流：间隔 55ms、每秒最多 12 组，密集爆发时是成串的清脆振翅
  sprint(intensity = 0, x, y) {
    if (!this.canPlay() || !this.p.predatorOn) return;
    // 声像不再每次随机：起爆的鸟在哪儿，声音就从哪儿。原来随机 ±0.6 只是
    // 「听着宽」，方向是假的；整群同时冲刺时还会左右乱跳。
    const pan = this.panAt(x);
    if (!this._allowPanned('spr', pan, 55, 12)) return;
    this.total.sprint++;
    this.lastPan = pan;
    this.flash.sprint = 1;

    const ctx = this.ctx, t = ctx.currentTime;
    const amp = 0.35 + 0.65 * Math.max(0, Math.min(1, intensity));
    const dur = 0.075 + Math.min(0.09, this.p.sprintDuration * 0.09);
    this.lastSprintDur = +dur.toFixed(3);

    // 公共出口：高通把 700Hz 以下全部切掉，避免任何低频「发闷」的成分漏出去
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 700; hp.Q.value = 0.7;
    hp.connect(this._chain(pan, this.distAt(x, y)));

    // ① 扑翅：3 记短促高频噪声脉冲，中心频率逐记略升，形成连拍的颗粒感
    for (let b = 0; b < 3; b++) {
      const bt = t + b * 0.022;
      const bd = 0.014 + Math.random() * 0.008;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.6 + Math.random() * 1.2;
      const f0 = 2600 + Math.random() * 1500 + b * 300;
      bp.frequency.setValueAtTime(f0, bt);
      bp.frequency.exponentialRampToValueAtTime(f0 * 1.12, bt + bd);
      const g = ctx.createGain();
      const peak = (0.022 + 0.016 * amp) * (1 - b * 0.18);
      g.gain.setValueAtTime(0.0001, bt);
      g.gain.exponentialRampToValueAtTime(peak, bt + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, bt + bd);
      src.connect(bp); bp.connect(g); g.connect(hp);
      src.start(bt, Math.random() * 0.08, bd + 0.012);
    }

    // ② 提速哨音：sine 快速上滑，短、亮、无谐波浑浊，给一串扑翅「蹿出去」的方向
    const o = ctx.createOscillator();
    o.type = 'sine';
    const of0 = 1450 + Math.random() * 320;
    o.frequency.setValueAtTime(of0, t);
    o.frequency.exponentialRampToValueAtTime(of0 * 2.0, t + 0.055);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.008 + 0.010 * amp, t + 0.006);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    o.connect(g2); g2.connect(hp);
    o.start(t); o.stop(t + 0.09);
  }

  // 2) 被吃掉：三段音与捕杀动画同步——
  //    0ms 亮核闪光=低频撞击；90ms 内环扩张=撕裂噪声；240ms 外环与火花=低沉余波。
  predate(J, x, y) {
    if (!this.canPlay() || !this.p.predatorOn) return;
    const pan = this.panAt(x), dist = this.distAt(x, y);
    if (!this._allowPanned('eat', pan, 120, 5)) return;
    this.total.predate++;
    this.lastPan = pan;
    this.flash.predate = 1;

    const ctx = this.ctx, t = ctx.currentTime;
    const amp = Math.max(0, Math.min(1, J));
    const f = 95 + 150 * Math.sqrt(amp);
    // 三段共用一条出口链：一次捕食是「一个身体被撞碎」，三段分别定位会散开
    const out = this._chain(pan, dist);

    // 第一段：撞击（对应亮核爆闪）
    const o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.setValueAtTime(f, t);
    o1.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.10);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(0.065 + 0.055 * amp, t + 0.006);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o1.connect(g1); g1.connect(out);
    o1.start(t); o1.stop(t + 0.13);

    // 第二段：撕裂（对应内环扩张与火花飞散）
    const t2 = t + 0.09;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.0;
    bp.frequency.setValueAtTime(1500, t2);
    bp.frequency.exponentialRampToValueAtTime(520, t2 + 0.17);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t2);
    g2.gain.exponentialRampToValueAtTime(0.055 + 0.045 * amp, t2 + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.19);
    src.connect(bp); bp.connect(g2); g2.connect(out);
    src.start(t2); src.stop(t2 + 0.2);

    // 第三段：余波（对应外环扩散到最大）
    const t3 = t + 0.24;
    const o3 = ctx.createOscillator();
    o3.type = 'sine';
    o3.frequency.setValueAtTime(f * 0.85, t3);
    o3.frequency.exponentialRampToValueAtTime(f * 0.42, t3 + 0.34);
    const g3 = ctx.createGain();
    g3.gain.setValueAtTime(0.0001, t3);
    g3.gain.exponentialRampToValueAtTime(0.04 + 0.035 * amp, t3 + 0.03);
    g3.gain.exponentialRampToValueAtTime(0.0001, t3 + 0.38);
    o3.connect(g3); g3.connect(out);
    o3.start(t3); o3.stop(t3 + 0.4);
  }

  // 4) 降落：一声很轻的低频「嗒」+ 一下收翅的气流声 + 一点点亮的小尾音。
  //    用窄带噪声做收翅气流，保证每只鸟的声音是独立颗粒，多了也不会糊。
  //    尾音（triangle 1.3kHz 下滑 40ms）就是「轻快」的来源：像鸟爪在草叶上点了一下。
  land(x, y) {
    if (!this.canPlay()) return;
    const pan = this.panAt(x), dist = this.distAt(x, y);
    if (!this._allowPanned('land', pan, 95, 5)) return;
    this.total.land++;
    this.lastPan = pan;

    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._chain(pan, dist);
    const f = 150 + Math.random() * 60;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.5, t + 0.085);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.026, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.12);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(900, t);
    bp.frequency.exponentialRampToValueAtTime(320, t + 0.11);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.010, t + 0.012);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    src.connect(bp); bp.connect(g2); g2.connect(out);
    src.start(t, Math.random() * 0.1, 0.15);

    // 尾音：一个短促下滑的小亮音，落在五声音阶上（A/C/D/E/G），
    // 让「落地」听起来是轻快的一声「嗒—」，而不是闷响。
    const PENTA = [880, 1046.5, 1174.7, 1318.5, 1568.0];
    const pf = PENTA[(Math.random() * PENTA.length) | 0];
    const o3 = ctx.createOscillator();
    o3.type = 'triangle';
    o3.frequency.setValueAtTime(pf, t + 0.01);
    o3.frequency.exponentialRampToValueAtTime(pf * 0.72, t + 0.075);
    const g3 = ctx.createGain();
    g3.gain.setValueAtTime(0.0001, t + 0.01);
    g3.gain.exponentialRampToValueAtTime(0.011, t + 0.018);
    g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.085);
    o3.connect(g3); g3.connect(out);
    o3.start(t + 0.01); o3.stop(t + 0.1);
  }

  // 5) 起飞：一下轻快的扑翅 + 两声上行小音（五声音阶），比降落更亮、更有「起势」。
  takeoff(x, y) {
    if (!this.canPlay()) return;
    const pan = this.panAt(x), dist = this.distAt(x, y);
    if (!this._allowPanned('take', pan, 95, 5)) return;
    this.total.takeoff++;
    this.lastPan = pan;

    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._chain(pan, dist);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 2.2;
    const f0 = 420 + Math.random() * 220;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f0 * 3.4, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.017, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    src.connect(bp); bp.connect(g); g.connect(out);
    src.start(t, Math.random() * 0.08, 0.21);

    // 两声上行小音：550~780Hz 起，第二声升一个音级（大二度~纯四度），
    // 间隔 55~90ms。这是「轻快」的主体，像鸟从草里窜起来时抖了一下翅膀。
    const base = 560 + Math.random() * 220;
    const step = [1.125, 1.2, 1.25, 1.335][(Math.random() * 4) | 0];
    for (let k = 0; k < 2; k++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f1 = base * (k ? step : 1);
      const tt = t + k * (0.055 + Math.random() * 0.035);
      o.frequency.setValueAtTime(f1, tt);
      o.frequency.exponentialRampToValueAtTime(f1 * 1.22, tt + 0.05);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, tt);
      g2.gain.exponentialRampToValueAtTime(0.015 - k * 0.003, tt + 0.008);
      g2.gain.exponentialRampToValueAtTime(0.0001, tt + 0.075);
      o.connect(g2); g2.connect(out);
      o.start(tt); o.stop(tt + 0.09);
    }
  }

  // 6) 捕食者加速：刻意做成完全不同、而且一听就知道「猛禽冲过来了」的音色。
  //    鸟的加速是高频、细碎的振翅颗粒；这一条走「锐鸣 + 气流 + 低频落地感」，
  //    三个成分同时出现，所以哪怕音乐垫底也切得出来：
  //      ① 锐鸣：两只微失谐锯齿（±9 音分）从 1.5kHz 快速滑到 0.6kHz，过带通提亮 → 像猛禽叫
  //      ② 气流：噪声带通 900→240Hz → 收翅切开空气的「唰」
  //      ③ 落地感：95→52Hz 正弦短促下坠 → 冲刺的「推背感」
  //    只在加速度包络由低冲高时触发一次（main.js 做边沿检测 + 每只 400ms 限流）。
  predDash(amp, x, y) {
    if (!this.canPlay()) return;
    const pan = this.panAt(x), dist = this.distAt(x, y);
    if (!this._allowPanned('dash', pan, 220, 3)) return;
    this.total.dash++;
    this.lastPan = pan;

    const ctx = this.ctx, t = ctx.currentTime;
    const a = Math.max(0.25, Math.min(1, amp));
    const out = this._chain(pan, dist);

    // ① 锐鸣（主体：音高与时长都随机，避免每次一模一样）
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.6;
    const f0 = (1380 + Math.random() * 260) * (0.9 + a * 0.2);
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f0 * 0.42, t + 0.17);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(0.050 + 0.030 * a, t + 0.014);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.20);
    bp.connect(g1); g1.connect(out);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = det;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.42, t + 0.17);
      o.connect(bp);
      o.start(t); o.stop(t + 0.22);
    }

    // ② 气流
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 160; hp.Q.value = 0.6;
    const nb = ctx.createBiquadFilter();
    nb.type = 'bandpass'; nb.Q.value = 0.8;
    nb.frequency.setValueAtTime(900 + Math.random() * 160, t);
    nb.frequency.exponentialRampToValueAtTime(240, t + 0.24);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.034 + 0.020 * a, t + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(nb); nb.connect(hp); hp.connect(g2); g2.connect(out);
    src.start(t, Math.random() * 0.06, 0.3);

    // ③ 低频落地感
    const lo = ctx.createOscillator();
    lo.type = 'sine';
    lo.frequency.setValueAtTime(96, t);
    lo.frequency.exponentialRampToValueAtTime(52, t + 0.16);
    const g3 = ctx.createGain();
    g3.gain.setValueAtTime(0.0001, t);
    g3.gain.exponentialRampToValueAtTime(0.040 + 0.022 * a, t + 0.012);
    g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    lo.connect(g3); g3.connect(out);
    lo.start(t); lo.stop(t + 0.2);

    // ④ 火箭喷射（v1.4.22 新增）：一束「点着了往前推」的燃烧嘶啦 + 托底的推力轰鸣。
    //    必须和②的气流区分开，否则两段噪声糊成一片「呼呼」：
    //      · 气流是「切开空气」的短唰——0.28s，中心 900→240 **往下**掉，越冲越闷；
    //      · 喷射是「持续燃烧」——0.37~0.46s，中心 480→1400 **往上**走（喷流越喷越急），
    //        末尾再收一点，尾巴比气流长一倍；
    //      · 叠一个 17~27Hz 的三角波抖动（±16%）＝ 火焰不稳的粗糙感，
    //        这是「推进器」和「风」在听感上最大的区别；纯平滑噪声只会像吹风机。
    const jt = t + 0.012;
    const jd = 0.34 + 0.10 * a;                 // 有效持续 0.375~0.44s
    const jsrc = ctx.createBufferSource();
    jsrc.buffer = this.noise;
    const jbp = ctx.createBiquadFilter();
    jbp.type = 'bandpass'; jbp.Q.value = 0.9;
    const jf = 480 + Math.random() * 140;
    jbp.frequency.setValueAtTime(jf, jt);
    jbp.frequency.exponentialRampToValueAtTime(jf * 2.9, jt + jd * 0.62);
    jbp.frequency.exponentialRampToValueAtTime(jf * 1.7, jt + jd);
    const jtrem = ctx.createGain(); jtrem.gain.value = 0.84;
    const jlfo = ctx.createOscillator();
    jlfo.type = 'triangle'; jlfo.frequency.value = 17 + Math.random() * 10;
    const jlfoG = ctx.createGain(); jlfoG.gain.value = 0.16;
    jlfo.connect(jlfoG); jlfoG.connect(jtrem.gain);
    const jg = ctx.createGain();
    const jPeak = 0.020 + 0.013 * a;
    jg.gain.setValueAtTime(0.0001, jt);
    jg.gain.exponentialRampToValueAtTime(jPeak, jt + 0.045);
    jg.gain.setValueAtTime(jPeak, jt + jd * 0.45);
    jg.gain.exponentialRampToValueAtTime(0.0001, jt + jd);
    jsrc.connect(jbp); jbp.connect(jtrem); jtrem.connect(jg); jg.connect(out);
    jsrc.start(jt, Math.random() * 0.12, jd + 0.02);
    jlfo.start(jt); jlfo.stop(jt + jd + 0.02);

    // 推力层：比③更低更长（58→34Hz）。③ 是「落地」的一记顿感，这一层是
    // 整个喷射期间持续托着的轰鸣——两者差半个八度，叠起来才是「有东西在后面推」。
    const jo = ctx.createOscillator();
    jo.type = 'triangle';
    jo.frequency.setValueAtTime(58, jt);
    jo.frequency.exponentialRampToValueAtTime(34, jt + 0.30);
    const jlp = ctx.createBiquadFilter();
    jlp.type = 'lowpass'; jlp.frequency.value = 190; jlp.Q.value = 0.6;
    const jog = ctx.createGain();
    jog.gain.setValueAtTime(0.0001, jt);
    jog.gain.exponentialRampToValueAtTime(0.018 + 0.012 * a, jt + 0.035);
    jog.gain.exponentialRampToValueAtTime(0.0001, jt + 0.40);
    jo.connect(jlp); jlp.connect(jog); jog.connect(out);
    jo.start(jt); jo.stop(jt + 0.42);
  }

  // 3) 新生：两声短促上行的清亮提示音，捕获后被吃的声音之后响起。
  birth(x, y) {
    if (!this.canPlay()) return;
    const pan = this.panAt(x), dist = this.distAt(x, y);
    if (!this._allowPanned('birth', pan, 90, 5)) return;
    this.total.birth++;
    this.lastPan = pan;
    this.flash.birth = 1;

    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._chain(pan, dist);
    for (const [delay, f1, f2] of [[0, 740, 1100], [0.085, 990, 1480]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f1, t + delay);
      o.frequency.exponentialRampToValueAtTime(f2, t + delay + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(0.075, t + delay + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.09);
      o.connect(g); g.connect(out);
      o.start(t + delay); o.stop(t + delay + 0.1);
    }
  }

  // ---- P1：三个以前完全没有声音的罕见事件 ------------------------------
  // 它们每分钟只有 5~7 次（锁定 / 俯冲 / 群体警戒），低频、可辨识，
  // 而且正对着玩家的注意力 —— 这才是「加音效」该加的地方，
  // 而不是去给每秒几千次的振翅各发一个音。

  // 7) 锁定目标：一记高频「叮」+ 一下极短的擦声。
  //    刻意做成干净的单音：sprint 是成串的高频扑棱，predDash 是下滑锐鸣，
  //    这里必须是第三种质地，否则三个一起响就分不出来了。
  lockOn(x, y) {
    if (!this.canPlay() || !this.p.predatorOn) return;
    const pan = this.panAt(x), dist = this.distAt(x, y);
    if (!this._allowPanned('lock', pan, 400, 3)) return;
    this.total.lock++;
    this.lastPan = pan;

    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._chain(pan, dist);
    // 一声短「叮」：音高在 1.6~2.4kHz 之间抖，避免每次都是同一个音
    const f = 1650 + Math.random() * 700;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.18, t + 0.045);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.020, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + 0.09);
    // 擦声：10ms 的高频噪声，给「注意力一下收束」一个颗粒
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 3.2; bp.frequency.value = 3600;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.014, t + 0.004);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
    src.connect(bp); bp.connect(g2); g2.connect(out);
    src.start(t, Math.random() * 0.1, 0.03);
  }

  // 8) 俯冲开始：一路下坠的「唰」+ 一记低频落感。
  //    和 predDash 的区别是方向——那条是「由低冲高」（起步）的下滑锐鸣，
  //    这条整体是往下掉的，听感就是「从高处砸下来」。
  dive(x, y) {
    if (!this.canPlay() || !this.p.predatorOn) return;
    const pan = this.panAt(x), dist = this.distAt(x, y);
    if (!this._allowPanned('dive', pan, 300, 3)) return;
    this.total.dive++;
    this.lastPan = pan;

    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._chain(pan, dist);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(2400 + Math.random() * 500, t);
    bp.frequency.exponentialRampToValueAtTime(280, t + 0.30);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.030, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    src.connect(bp); bp.connect(g); g.connect(out);
    src.start(t, Math.random() * 0.08, 0.36);
    // 落感：70→38Hz 的短下坠，比 predDash 那记更低更长一点
    const lo = ctx.createOscillator();
    lo.type = 'sine';
    lo.frequency.setValueAtTime(74, t + 0.05);
    lo.frequency.exponentialRampToValueAtTime(38, t + 0.30);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t + 0.05);
    g2.gain.exponentialRampToValueAtTime(0.034, t + 0.10);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    lo.connect(g2); g2.connect(out);
    lo.start(t + 0.05); lo.stop(t + 0.34);
  }

  // 9) 群体警戒：整群被惊动。不做「点」，做成一片涌动的沙沙声 + 低频隆起，
  //    声像居中（它是全场事件，不该从某个方向来）。
  alarm() {
    if (!this.canPlay() || !this.p.predatorOn) return;
    if (!this._allow('alarm', 900, 2)) return;
    this.total.alarm++;
    this.lastPan = 0;

    const ctx = this.ctx, t = ctx.currentTime;
    const out = this._chain(0, 0.45);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(1050, t + 0.26);
    bp.frequency.exponentialRampToValueAtTime(520, t + 0.62);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.028, t + 0.13);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.70);
    src.connect(bp); bp.connect(g); g.connect(out);
    src.start(t, 0, 0.72);
    const lo = ctx.createOscillator();
    lo.type = 'sine';
    lo.frequency.setValueAtTime(58, t);
    lo.frequency.exponentialRampToValueAtTime(44, t + 0.5);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.026, t + 0.10);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    lo.connect(g2); g2.connect(out);
    lo.start(t); lo.stop(t + 0.58);
  }

  // 构造完再建音乐：FlockMusic 定义在本文件后面，运行到这里时已经就绪
  createMusic() {
    this.music = new FlockMusic(this, this.p);
    return this.music;
  }
}
// ---------------------------------------------------------------- 音乐
// 六层生成式音景，全部由「聚集度」C 驱动（0 = 铺满全屏，1 = 紧密成团）：
//   ① drone   低频嗡鸣：基音 + 五度，低通截止随 C 慢慢打开（v1.4.22 起压到 −6dB 当底色）
//   ② pad     和声：开放五度 → 小三和弦 → 加九度音簇，每两小节换一次
//   ③ 鼓点    kick + 反拍闭镲，拍点固定、力度随 C（v1.4.23 由原来的「随机低频短击」改造）
//   ③b 贝斯   跟 kick 走的短拨音（A1 / 五度），v1.4.23 新增，压得很轻
//   ④ shimmer 高频泛音点：只有抱团到一定程度才零星出现
//   ⑤ bass    常驻低音长音：0.043Hz 呼吸 + 浮现门，二十来秒浮一次（有节奏贝斯后压得更低）
//   ⑥ orbit   捕食者盘旋声：随饥饿度与远近变化，声像极慢左右游走
// 全部程序化合成，没有采样文件；音高固定锁在五声音阶里，所以怎么随机都不会跑调。
// 调度用 25ms lookahead 提前排未来一小段，和鸟的数量完全无关（一万只也不多花 CPU）。
const PENTA = [0, 3, 5, 7, 10];        // A 小调五声音阶（相对根音的半音数）
const MUSIC_ROOT = 110;                // A2
const pentaFreq = (deg, oct = 0) => {
  const i = ((deg % PENTA.length) + PENTA.length) % PENTA.length;
  const o = Math.floor(deg / PENTA.length) + oct;
  return MUSIC_ROOT * Math.pow(2, (PENTA[i] + 12 * o) / 12);
};
// 三档和声（五声音阶的度数索引：0=A 1=C 2=D 3=E 4=G，5 起为高八度）
const CHORDS = [[0, 3], [0, 2, 3], [0, 2, 3, 4, 5]];

export class FlockMusic {
  constructor(audio, params) {
    this.a = audio;
    this.p = params;
    this.nodes = null;
    this.running = false;
    this.bpm = 72;
    // 面板「音乐音量」就是增益本身（0~1.5，默认 0.4）
    this.level = Math.max(0, Math.min(1.5, this.p.musicLevel));
    this.smooth = 0;         // 平滑后的聚集度
    this.applied = -1;       // 上次写入音频参数时的聚集度
    this.tension = 0;        // 受惊程度 → 和声整体下沉半音以内
    this.nextTime = 0;
    this.step = 0;
    this.timer = 0;
    // 模拟（画面）是否被暂停：暂停时音乐要停，但「静音」是用户意图、两件事不能混。
    // 这个标志同时管住 start / mute / resumeScheduler，避免暂停期间被它们偷偷复活。
    this.simPaused = false;
    this.counts = { chord: 0, kick: 0, hat: 0, bassNote: 0, shimmer: 0, bass: 0 };
    // 捕食者状态（由 main.js 每帧喂标量，音频参数的平滑与写入只在 25ms 调度器里做）
    this.pred = { active: false, x: 0, heat: 0, dist: 100 };
  }

  // 建图：四层都汇到 bus，bus 再进 audio.master——于是右下角那个声音开关
  // 一动，事件音和音乐一起静音，不需要第二个开关。
  build() {
    const ctx = this.a.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.a.master);

    // 极轻的空间感：短反馈延迟，只给 pad 与 shimmer 送一点
    const send = ctx.createGain(); send.gain.value = 0.45;
    const delay = ctx.createDelay(1.2); delay.delayTime.value = 0.36;
    const fb = ctx.createGain(); fb.gain.value = 0.28;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass'; damp.frequency.value = 2400;
    const wet = ctx.createGain(); wet.gain.value = 0.3;
    send.connect(delay); delay.connect(damp);
    damp.connect(fb); fb.connect(delay);
    damp.connect(wet); wet.connect(bus);

    // ① drone：原来以 55Hz 为基音，在大多数扬声器上就是一段持续的低频嗡鸣，
    //    听感像"机器没关"。改为以 110Hz（A2）为基音、只叠五度，直链高通切掉 55Hz 以下的隆隆声，
    //    再挂一个 0.07Hz 的极慢音量摆动，让它是「呼吸」而不是「嗡嗡」。
    const droneGain = ctx.createGain(); droneGain.gain.value = 0;
    const droneLp = ctx.createBiquadFilter();
    droneLp.type = 'lowpass'; droneLp.frequency.value = 220; droneLp.Q.value = 0.7;
    const droneHp = ctx.createBiquadFilter();
    droneHp.type = 'highpass'; droneHp.frequency.value = 95; droneHp.Q.value = 0.6;
    const droneTrem = ctx.createGain(); droneTrem.gain.value = 0.72;
    droneHp.connect(droneLp); droneLp.connect(droneTrem);
    droneTrem.connect(droneGain); droneGain.connect(bus);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.26;
    lfo.connect(lfoGain); lfoGain.connect(droneTrem.gain); lfo.start();
    for (const [f, g, det] of [[110, 0.5, -6], [164.81, 0.22, 7]]) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f; o.detune.value = det;
      const gg = ctx.createGain(); gg.gain.value = g;
      o.connect(gg); gg.connect(droneHp); o.start();
    }

    // ② pad：和弦音簇，长包络互相交叠
    const padGain = ctx.createGain(); padGain.gain.value = 0;
    const padLp = ctx.createBiquadFilter();
    padLp.type = 'lowpass'; padLp.frequency.value = 900; padLp.Q.value = 0.6;
    padLp.connect(padGain); padGain.connect(bus);

    // ③ 鼓点（v1.4.23 由原来的「低频短击」改造）：kick 与反拍闭镲共用这条总线。
    //    改之前是「按聚集度随机撒低频短击」，拍点不稳定，听感像心跳而不是鼓；
    //    现在固定每小节第 1 拍落 kick、第 3 拍一记弱 kick，反拍镲才随聚集度加入。
    const pulseGain = ctx.createGain(); pulseGain.gain.value = 0;
    pulseGain.connect(bus);

    // ③b 贝斯拨音（v1.4.23）：跟着 kick 走的短低音，独立增益以便与下面的
    //     「⑤ 常驻低音长音」分开调——两者都在低频，挂在同一条总线上就没法分别压。
    const bassPluckGain = ctx.createGain(); bassPluckGain.gain.value = 0;
    bassPluckGain.connect(bus);

    // ④ shimmer：高音泛音点
    const shimmerGain = ctx.createGain(); shimmerGain.gain.value = 0;
    shimmerGain.connect(bus);

    // ⑤ bass：若隐若现的低音。常驻 A1(55Hz) 正弦 + 极轻的五度，先过低通把谐波磨圆，
    //    再由「0.043Hz 呼吸」和「浮现门」两级控制音量。电平只有主层的 1/3 左右，
    //    绝大多数时候几乎听不到，平均每二十来秒慢慢浮上来十秒左右又沉下去。
    const bassHp = ctx.createBiquadFilter();
    bassHp.type = 'highpass'; bassHp.frequency.value = 38; bassHp.Q.value = 0.6;
    const bassLp = ctx.createBiquadFilter();
    bassLp.type = 'lowpass'; bassLp.frequency.value = 130; bassLp.Q.value = 0.5;
    const bassBreath = ctx.createGain(); bassBreath.gain.value = 0.6;
    const bassGate = ctx.createGain(); bassGate.gain.value = 0.0001;
    const bassGain = ctx.createGain(); bassGain.gain.value = 0;
    bassHp.connect(bassLp); bassLp.connect(bassBreath);
    bassBreath.connect(bassGate); bassGate.connect(bassGain); bassGain.connect(bus);
    const bassLfo = ctx.createOscillator();
    bassLfo.type = 'sine'; bassLfo.frequency.value = 0.043;
    const bassLfoGain = ctx.createGain(); bassLfoGain.gain.value = 0.32;
    bassLfo.connect(bassLfoGain); bassLfoGain.connect(bassBreath.gain); bassLfo.start();
    for (const [f, g, det] of [[55, 0.9, -4], [82.41, 0.16, 5]]) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f; o.detune.value = det;
      const gg = ctx.createGain(); gg.gain.value = g;
      o.connect(gg); gg.connect(bassHp); o.start();
    }

    // ⑥ orbit：捕食者盘旋声。两个微失谐低频正弦 + 一丝窄带气流，过低通后由
    //    StereoPanner 极慢地左右游走（盘旋感）。音量随「饥饿度」和「离群体的远近」
    //    变化：进入捕食阶段且逼近时最容易细听出来，饱食巡游时几乎融进背景。
    const orbitLp = ctx.createBiquadFilter();
    orbitLp.type = 'lowpass'; orbitLp.frequency.value = 220; orbitLp.Q.value = 0.7;
    const orbitGain = ctx.createGain(); orbitGain.gain.value = 0;
    const orbitPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    orbitLp.connect(orbitGain);
    if (orbitPan) { orbitGain.connect(orbitPan); orbitPan.connect(bus); }
    else orbitGain.connect(bus);
    for (const [f, g, det] of [[82.41, 0.8, -6], [123.47, 0.22, 7]]) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f; o.detune.value = det;
      const gg = ctx.createGain(); gg.gain.value = g;
      o.connect(gg); gg.connect(orbitLp); o.start();
    }
    const air = ctx.createBufferSource();
    air.buffer = this.a.noise; air.loop = true;
    const airBp = ctx.createBiquadFilter();
    airBp.type = 'bandpass'; airBp.frequency.value = 380; airBp.Q.value = 2.4;
    const airGain = ctx.createGain(); airGain.gain.value = 0.0014;
    air.connect(airBp); airBp.connect(airGain); airGain.connect(orbitGain);
    air.start();

    this.nodes = { bus, send, droneGain, droneLp, padGain, padLp, pulseGain, bassPluckGain,
                   shimmerGain, bassGain, bassGate, orbitGain, orbitLp, orbitPan };
  }

  start() {
    if (!this.a.enabled || !this.a.ctx || this.running) return;
    if (!this.nodes) this.build();
    const ctx = this.a.ctx;
    this.running = true;
    this.step = 0;
    this.chordIdx = 0;
    this.smooth = 0; this.applied = -1;
    this.nextTime = ctx.currentTime + 0.12;
    this.nodes.bus.gain.cancelScheduledValues(ctx.currentTime);
    // 画面处于暂停时不要出声，否则「暂停着却自己响起来」
    this.nodes.bus.gain.setTargetAtTime(this.simPaused ? 0 : this.level, ctx.currentTime, 0.9);
    this.resumeScheduler();
  }

  stop() {
    this.running = false;
    this.pauseScheduler();
    if (this.nodes) this.nodes.bus.gain.setTargetAtTime(0, this.a.ctx.currentTime, 0.12);
  }

  // 模拟暂停：音乐一起停。这和「静音」不是一回事——静音是用户意图、要跨刷新记住，
  // 暂停只是画面冻结，恢复后应该接着往下走。
  // 做法：总线渐隐到 0 + 停掉 25ms 调度器（不排新音符），振荡器留在原地不动。
  pauseForSim() {
    this.simPaused = true;
    this.pauseScheduler();
    if (!this.nodes || !this.a.ctx) return;
    const ctx = this.a.ctx;
    this.nodes.bus.gain.cancelScheduledValues(ctx.currentTime);
    this.nodes.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  }

  // 继续：从当前时刻接着走。nextTime 必须重设，否则会把暂停那几十秒里「欠下」的
  // 音符一次性补排出来（听感上是突然一大串和弦砸下来）。
  resumeFromSim() {
    this.simPaused = false;
    if (!this.running || !this.nodes || !this.a.ctx) return;
    const ctx = this.a.ctx;
    this.nextTime = ctx.currentTime + 0.06;
    // 用户静音 / 页面在后台时保持无声，只把状态修好；等 mute(false) 或切回来时自然会响
    if (this.a.muted || this.a.suspendedByVisibility || document.hidden) return;
    this.nodes.bus.gain.setTargetAtTime(this.level, ctx.currentTime, 0.3);
    this.resumeScheduler();
  }

  // 静音 / 切后台时连 25ms 的调度器一起停，避免后台空转继续排音符
  pauseScheduler() { if (this.timer) { clearInterval(this.timer); this.timer = 0; } }
  resumeScheduler() {
    if (this.simPaused || !this.running || this.timer) return;
    this.timer = setInterval(() => this.tick(), 25);
  }

  // 与声音总开关联动：静音时整个音乐总线归零，恢复时把调度指针拉回当前时刻，
  // 否则会把静音期间「欠下」的音符一次性补排出来。
  // 画面暂停期间解除静音只记状态，不出声（等继续播放时由 resumeFromSim 接回来）。
  mute(m) {
    if (!this.nodes || !this.a.ctx) return;
    const ctx = this.a.ctx;
    this.nodes.bus.gain.setTargetAtTime((m || this.simPaused) ? 0 : this.level, ctx.currentTime, 0.12);
    if (m) this.pauseScheduler();
    else {
      this.nextTime = ctx.currentTime + 0.08; this.step = 0;
      this.resumeScheduler();
    }
  }

  // main.js 每帧只传 4 个标量，不碰任何 AudioParam；真正的平滑写在 25ms 调度器里。
  setPredator(active, x, heat, dist) {
    const p = this.pred;
    p.active = active; p.x = x; p.heat = heat; p.dist = dist;
  }

  applyPredator() {
    const n = this.nodes, ctx = this.a.ctx;
    if (!n || !this.running) return;
    const t = ctx.currentTime, p = this.pred;
    const prox = 1 - Math.min(1, Math.max(0, p.dist / 40));
    // 电平刻意压得极低：最响也只有主层的 1/3，饱食远巡时几乎为零
    const target = p.active
      ? 0.0009 + 0.0032 * (0.35 + 0.65 * p.heat) * (0.35 + 0.65 * prox)
      : 0;
    n.orbitGain.gain.setTargetAtTime(target, t, 1.1);
    n.orbitLp.frequency.setTargetAtTime(170 + 210 * p.heat, t, 1.2);
    if (n.orbitPan) {
      // 位置决定大致方位，再叠一个 0.31rad/s 的极慢环绕 = 盘旋
      const pan = Math.max(-0.8, Math.min(0.8, p.x * 0.45 + Math.sin(t * 0.31) * 0.24));
      n.orbitPan.pan.setTargetAtTime(pan, t, 0.9);
    }
  }

  // 让低音「浮上来一会儿」：3~5s 渐入、保持 5~13s、再 3~6s 沉下去。
  // 两次之间隔得远，所以不会变成持续的低频嗡鸣。
  bassFlicker(t) {
    const g = this.nodes.bassGate.gain;
    const rise = 3.0 + Math.random() * 2.5;
    const hold = 5 + Math.random() * 8;
    const fall = 3.5 + Math.random() * 3;
    const peak = 0.7 + Math.random() * 0.3;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.linearRampToValueAtTime(peak, t + rise);
    g.setValueAtTime(peak, t + rise + hold);
    g.linearRampToValueAtTime(0.0001, t + rise + hold + fall);
    this.counts.bass++;
  }

  // 音乐整体音量（调试接口可实时调：FlockLab.music.setLevel(0~1.5)，与面板同一刻度）
  setLevel(v) {
    this.level = Math.max(0, Math.min(1.5, v));
    if (this.nodes && this.a.ctx && this.running) {
      this.nodes.bus.gain.setTargetAtTime(this.a.muted ? 0 : this.level, this.a.ctx.currentTime, 0.2);
    }
  }

  // 每帧调一次：把聚集度做一阶低通（约 0.45s），再以 10Hz 左右的频率写进音频参数。
  // 绝不逐帧直连音高/音量，否则听起来是抖动而不是呼吸。
  update(C, tension, dt) {
    if (!this.nodes) return;
    this.smooth += (C - this.smooth) * (1 - Math.exp(-dt / 0.45));
    this.tension += (tension - this.tension) * (1 - Math.exp(-dt / 1.4));
    if (Math.abs(this.smooth - this.applied) < 0.004) return;
    this.applied = this.smooth;
    const c = this.smooth, n = this.nodes, ctx = this.a.ctx, t = ctx.currentTime;
    // drone 再压一档（−6dB）：110Hz 那层是最容易被听成「电器没关」的持续嗡声，
    // 它只需要垫在底下，不该在没有事件的时候抢注意力。
    n.droneGain.gain.setTargetAtTime(0.0023 + 0.0053 * c, t, 0.35);
    n.droneLp.frequency.setTargetAtTime(220 + 700 * c * c, t, 0.45);
    n.padGain.gain.setTargetAtTime(0.004 + 0.012 * c, t, 0.5);
    n.padLp.frequency.setTargetAtTime(760 + 2400 * c, t, 0.5);
    // 鼓点与贝斯都很轻：kick 峰值约 0.022、镲约 0.006，都低于和声层的总和，
    // 作用是把拍子垫出来，不是当主角。聚集度只在这个范围内微调，不会突然变响。
    n.pulseGain.gain.setTargetAtTime(0.010 + 0.018 * c, t, 0.4);
    n.bassPluckGain.gain.setTargetAtTime(0.010 + 0.016 * c, t, 0.6);
    n.shimmerGain.gain.setTargetAtTime(0.0012 + 0.012 * Math.max(0, c - 0.28), t, 0.6);
    // 常驻低音长音：v1.4.24 再降 10dB（×0.316）。用户确认「每隔几秒浮上来、响几秒」
    // 的那层嗡嗡声就是它——用 bassGate 的 3~5.5s 渐入 + 5~13s 保持 + 3.5~6.5s 落下
    // 对得上实测曲线（3 秒爬到顶、6.5 秒保持）。降到这个电平后它只剩极微弱的底衬，
    // 低频骨架交给节奏贝斯；再想更干净就直接删掉这一层，其余层不依赖它。
    n.bassGain.gain.setTargetAtTime(0.00022 + 0.00051 * c, t, 0.9);
  }

  tick() {
    const ctx = this.a.ctx;
    if (!this.running || !ctx || ctx.state !== 'running') return;
    this.applyPredator();
    // 音乐音量拉到 0 时不再排音符，省掉没必要的振荡器创建（默认 0.4 会正常演奏）
    if (this.level < 0.001) { this.nextTime = ctx.currentTime + 0.1; return; }
    const eighth = 30 / this.bpm;          // 八分音符时长 = (60/bpm)/2
    const now = ctx.currentTime;
    if (this.nextTime < now) this.nextTime = now + 0.03;   // 切后台回来不补排
    let guard = 0;
    while (this.nextTime < now + 0.12 && guard++ < 24) {
      this.schedule(this.nextTime, this.step);
      this.step++;
      this.nextTime += eighth;
    }
  }

  schedule(t, step) {
    const c = this.smooth;
    const bar = Math.floor(step / 8);      // 4/4 拍，每小节 8 个八分音符
    const pos = step % 8;
    // 和声每两小节评估一次档位：带滞回，避免在阈值附近来回跳
    if (pos === 0 && bar % 2 === 0) {
      const cur = this.chordIdx;
      let idx = cur;
      if (cur === 0 && c > 0.42) idx = 1;
      else if (cur === 1 && c < 0.30) idx = 0;
      else if (cur === 1 && c > 0.68) idx = 2;
      else if (cur === 2 && c < 0.58) idx = 1;
      this.chordIdx = idx;
      this.chord(t, idx, 16 * (30 / this.bpm));
      // 低音的「若隐若现」：每个双小节节点掷一次骰子，群体越抱团越容易出现
      if (Math.random() < 0.22 + 0.30 * c) this.bassFlicker(t);
    }
    // 节奏组（v1.4.23）：鼓点与贝斯共用同一组拍点，力度再由聚集度决定。
    // 与以前「按概率撒低频短击」的区别是拍点是**固定**的——固定的骨架才叫鼓点，
    // 随机撒点听起来是心跳。散开时只剩每小节第 1 拍（dens≈0 时其余全不出现），
    // 抱团后才补上第 3 拍、贝斯第二音与反拍镲，所以「节奏密度」也成了群体状态的读数。
    const dens = Math.max(0, Math.min(1, (c - 0.1) / 0.62));
    if (pos === 0) {
      this.kick(t, false);
      this.bassNote(t, 0);
    } else if (pos === 4) {
      this.kick(t, true);
      if (Math.random() < 0.30 + 0.55 * dens) this.bassNote(t, 1);
    }
    if ((pos === 2 || pos === 6) && Math.random() < 0.10 + 0.55 * dens) this.hat(t);
    // 泛音点：只在抱团到一定程度后才出现，密度限幅，避免过于叮当
    if (c > 0.28) {
      const p = Math.min(0.32, (c - 0.28) * 1.4);
      if (Math.random() < p) this.shimmer(t);
    }
  }

  chord(t, idx, dur) {
    const ctx = this.a.ctx, n = this.nodes;
    const degs = CHORDS[idx];
    const atk = Math.min(1.8, dur * 0.34);
    const rel = Math.min(2.0, dur * 0.42);
    // 受惊时整体下沉：最多一个半音，像乐队被压了一下
    const pitch = Math.pow(2, -this.tension / 12);
    this.counts.chord++;
    for (const deg of degs) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = pentaFreq(deg, 1) * pitch;
      o.detune.value = (Math.random() - 0.5) * 9;
      const g = ctx.createGain();
      const peak = 0.9 / degs.length;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + atk);
      g.gain.setValueAtTime(peak, t + Math.max(atk, dur - rel));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(n.padLp); g.connect(n.send);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  // 鼓点（v1.4.23）：一记很轻的「咚」。sine 从 92Hz 快速落到 44Hz，
  // 12ms 起音、强弱只差峰值与尾巴长度——音高不变（变音高听起来像走音，不像力度）。
  // 刻意不加点击噪声和失真：那会让它变成「电子鼓」，在一片环境声里非常扎眼。
  kick(t, weak) {
    const ctx = this.a.ctx, n = this.nodes;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(92, t);
    o.frequency.exponentialRampToValueAtTime(44, t + (weak ? 0.15 : 0.22));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(weak ? 0.58 : 0.92, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (weak ? 0.26 : 0.36));
    o.connect(g); g.connect(n.pulseGain);
    o.start(t); o.stop(t + 0.4);
    this.counts.kick++;
  }

  // 反拍闭镲：6.2kHz 以上的一小撮噪声，45ms 就收掉。
  // 峰值只有 kick 的 1/5 左右——它的作用只是「让反拍有个落点」，不是打节奏。
  hat(t) {
    const ctx = this.a.ctx, n = this.nodes;
    const src = ctx.createBufferSource();
    src.buffer = this.a.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 6200; hp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 + Math.random() * 0.07, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp); hp.connect(g); g.connect(n.pulseGain);
    src.start(t, Math.random() * 0.9, 0.07);
    this.counts.hat++;
  }

  // 贝斯（v1.4.23）：跟着 kick 走的短音，不是持续低音。
  // 以 A1(55Hz) 为主，第二音偶尔跳五度（73.4Hz）——都在五声音阶里，怎么跳都不跑调。
  // 过 320Hz 低通把谐波磨掉，只剩「闷闷的一下」，所以是垫在底下而不是顶出来；
  // 起音比 kick 晚 18ms：同拍同起会互相掩蔽，错开一点两个都听得见。
  bassNote(t, fifth) {
    const ctx = this.a.ctx, n = this.nodes;
    const tt = t + 0.018;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = pentaFreq(fifth ? 3 : 0, -1);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, tt);
    g.gain.exponentialRampToValueAtTime(0.7, tt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.42);
    o.connect(lp); lp.connect(g); g.connect(n.bassPluckGain);
    o.start(tt); o.stop(tt + 0.46);
    this.counts.bassNote++;
  }

  shimmer(t) {
    const ctx = this.a.ctx, n = this.nodes;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = pentaFreq(2 + Math.floor(Math.random() * 3), 2 + (Math.random() < 0.45 ? 1 : 0));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.8, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    o.connect(g); g.connect(n.shimmerGain); g.connect(n.send);
    o.start(t); o.stop(t + 1.6);
    this.counts.shimmer++;
  }
}
