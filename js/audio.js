// ---------------------------------------------------------------- 声音
// 事件音共五类：加速逃逸 / 被吃掉 / 新生 / 草地降落 / 草地起飞；另有四层生成式音乐。
// 没有碰撞与琶音；静音时断开输出并挂起 AudioContext。
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
    try { this.mutedPref = localStorage.getItem('flocklab.audio.muted') === '1'; } catch (e) {}
    this.lastSprint = 0; this.sprintWindow = 0; this.sprintCount = 0;
    this.lastPred = 0;   this.predWindow = 0;   this.predCount = 0;
    this.lastBirth = 0;  this.birthWindow = 0;  this.birthCount = 0;
    this.lastLand = 0;   this.landWindow = 0;   this.landCount = 0;
    this.lastTake = 0;   this.takeWindow = 0;   this.takeCount = 0;
    this.lastDash = 0;   this.dashWindow = 0;   this.dashCount = 0;   // 捕食者加速音效
    this.lastSprintDur = 0;
    this.total = { sprint: 0, predate: 0, birth: 0, land: 0, takeoff: 0, dash: 0 };
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
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.value = this.p.master;
    this.master.disconnect();
    this.master.connect(this.ctx.destination);
    this.outputConnected = true;
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
      this.master.gain.value = this.p.master;
      this.master.connect(ctx.destination);
      this.outputConnected = true;

      // 音效总线：所有事件音先进这里，再进 master。
      // 这样「音效音量」只影响提示音，不会把音乐一起推大。
      this.fxBus = ctx.createGain();
      // 面板刻度直接就是增益：1.0 对应单位响度
      this.fxBus.gain.value = this.p.fxLevel;
      this.fxBus.connect(this.master);

      // 短噪声缓冲：逃逸气流声与被吃掉的咬合声共用
      const len = Math.floor(ctx.sampleRate * 0.25);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
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
    try { localStorage.setItem('flocklab.audio.muted', m ? '1' : '0'); } catch (e) {}
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
  sprint(intensity = 0) {
    if (!this.canPlay() || !this.p.predatorOn) return;
    const now = performance.now();
    if (now - this.lastSprint < 55) return;
    if (now > this.sprintWindow) { this.sprintWindow = now + 1000; this.sprintCount = 0; }
    if (this.sprintCount >= 12) return;
    this.lastSprint = now; this.sprintCount++; this.total.sprint++;
    this.flash.sprint = 1;

    const ctx = this.ctx, t = ctx.currentTime;
    const amp = 0.35 + 0.65 * Math.max(0, Math.min(1, intensity));
    const dur = 0.075 + Math.min(0.09, this.p.sprintDuration * 0.09);
    this.lastSprintDur = +dur.toFixed(3);

    // 公共出口：高通把 700Hz 以下全部切掉，避免任何低频「发闷」的成分漏出去
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 700; hp.Q.value = 0.7;
    let out = hp;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = (Math.random() * 2 - 1) * 0.6;
      hp.connect(pan); out = pan;
    }
    out.connect(this.fxBus);

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
  predate(J) {
    if (!this.canPlay() || !this.p.predatorOn) return;
    const now = performance.now();
    if (now - this.lastPred < 120) return;
    if (now > this.predWindow) { this.predWindow = now + 1000; this.predCount = 0; }
    if (this.predCount >= 5) return;
    this.lastPred = now; this.predCount++; this.total.predate++;
    this.flash.predate = 1;

    const ctx = this.ctx, t = ctx.currentTime;
    const amp = Math.max(0, Math.min(1, J));
    const f = 95 + 150 * Math.sqrt(amp);

    // 第一段：撞击（对应亮核爆闪）
    const o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.setValueAtTime(f, t);
    o1.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.10);
    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(0.065 + 0.055 * amp, t + 0.006);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o1.connect(g1); g1.connect(this.fxBus);
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
    src.connect(bp); bp.connect(g2); g2.connect(this.fxBus);
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
    o3.connect(g3); g3.connect(this.fxBus);
    o3.start(t3); o3.stop(t3 + 0.4);
  }

  // 4) 降落：一声很轻的低频「嗒」+ 一下收翅的气流声 + 一点点亮的小尾音。
  //    用窄带噪声做收翅气流，保证每只鸟的声音是独立颗粒，多了也不会糊。
  //    尾音（triangle 1.3kHz 下滑 40ms）就是「轻快」的来源：像鸟爪在草叶上点了一下。
  land() {
    if (!this.canPlay()) return;
    const now = performance.now();
    if (now - this.lastLand < 95) return;
    if (now > this.landWindow) { this.landWindow = now + 1000; this.landCount = 0; }
    if (this.landCount >= 5) return;
    this.lastLand = now; this.landCount++; this.total.land++;

    const ctx = this.ctx, t = ctx.currentTime;
    const f = 150 + Math.random() * 60;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.5, t + 0.085);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.026, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    o.connect(g); g.connect(this.fxBus);
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
    src.connect(bp); bp.connect(g2); g2.connect(this.fxBus);
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
    o3.connect(g3); g3.connect(this.fxBus);
    o3.start(t + 0.01); o3.stop(t + 0.1);
  }

  // 5) 起飞：一下轻快的扑翅 + 两声上行小音（五声音阶），比降落更亮、更有「起势」。
  takeoff() {
    if (!this.canPlay()) return;
    const now = performance.now();
    if (now - this.lastTake < 95) return;
    if (now > this.takeWindow) { this.takeWindow = now + 1000; this.takeCount = 0; }
    if (this.takeCount >= 5) return;
    this.lastTake = now; this.takeCount++; this.total.takeoff++;

    const ctx = this.ctx, t = ctx.currentTime;
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
    src.connect(bp); bp.connect(g); g.connect(this.fxBus);
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
      o.connect(g2); g2.connect(this.fxBus);
      o.start(tt); o.stop(tt + 0.09);
    }
  }

  // 6) 捕食者加速：和鸟的「高频振翅颗粒」完全不同的音色——
  //    低频气流「呼——」+ 一声短促下行的锐利嘶鸣，像猛禽收翅俯冲。
  //    只在加速度包络由低冲高时触发一次（main.js 里做边沿检测 + 每只限流）。
  predDash(amp) {
    if (!this.canPlay()) return;
    const now = performance.now();
    if (now - this.lastDash < 150) return;
    if (now > this.dashWindow) { this.dashWindow = now + 1000; this.dashCount = 0; }
    if (this.dashCount >= 4) return;
    this.lastDash = now; this.dashCount++;
    this.total.dash = (this.total.dash || 0) + 1;

    const ctx = this.ctx, t = ctx.currentTime;
    const a = Math.max(0.15, Math.min(1, amp));

    // 气流：窄带噪声从 700Hz 扫到 180Hz，0.22s；冲得越猛越响
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(720 + Math.random() * 180, t);
    bp.frequency.exponentialRampToValueAtTime(170, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.030 + 0.026 * a, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    src.connect(bp); bp.connect(g); g.connect(this.fxBus);
    src.start(t, Math.random() * 0.06, 0.28);

    // 嘶鸣：锯齿波下滑，带一点失真感；频率随机，避免每只一模一样
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = 780 + Math.random() * 260;
    o.frequency.setValueAtTime(f, t + 0.01);
    o.frequency.exponentialRampToValueAtTime(f * 0.42, t + 0.16);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 1.1;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t + 0.01);
    g2.gain.exponentialRampToValueAtTime(0.016 + 0.014 * a, t + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    o.connect(lp); lp.connect(g2); g2.connect(this.fxBus);
    o.start(t + 0.01); o.stop(t + 0.2);
  }

  // 3) 新生：两声短促上行的清亮提示音，捕获后被吃的声音之后响起。
  birth() {
    if (!this.canPlay()) return;
    const now = performance.now();
    if (now - this.lastBirth < 90) return;
    if (now > this.birthWindow) { this.birthWindow = now + 1000; this.birthCount = 0; }
    if (this.birthCount >= 5) return;
    this.lastBirth = now; this.birthCount++; this.total.birth++;
    this.flash.birth = 1;

    const ctx = this.ctx, t = ctx.currentTime;
    for (const [delay, f1, f2] of [[0, 740, 1100], [0.085, 990, 1480]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f1, t + delay);
      o.frequency.exponentialRampToValueAtTime(f2, t + delay + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + delay);
      g.gain.exponentialRampToValueAtTime(0.075, t + delay + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.09);
      o.connect(g); g.connect(this.fxBus);
      o.start(t + delay); o.stop(t + delay + 0.1);
    }
  }

  // 构造完再建音乐：FlockMusic 定义在本文件后面，运行到这里时已经就绪
  createMusic() {
    this.music = new FlockMusic(this, this.p);
    return this.music;
  }
}
// ---------------------------------------------------------------- 音乐
// 四层生成式音景，全部由「聚集度」C 驱动（0 = 铺满全屏，1 = 紧密成团）：
//   ① drone   低频嗡鸣：基音 + 五度 + 低八度，低通截止随 C 慢慢打开
//   ② pad     和声：开放五度 → 小三和弦 → 加九度音簇，每两小节换一次
//   ③ pulse   低频心跳：C 越高越密，散开时几乎不出声
//   ④ shimmer 高频泛音点：只有抱团到一定程度才零星出现
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
    this.counts = { chord: 0, pulse: 0, shimmer: 0, bass: 0 };
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

    // ③ pulse：低频短击，唯一有节拍的层
    const pulseGain = ctx.createGain(); pulseGain.gain.value = 0;
    pulseGain.connect(bus);

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

    this.nodes = { bus, send, droneGain, droneLp, padGain, padLp, pulseGain, shimmerGain,
                   bassGain, bassGate, orbitGain, orbitLp, orbitPan };
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
    this.nodes.bus.gain.setTargetAtTime(this.level, ctx.currentTime, 0.9);
    this.resumeScheduler();
  }

  stop() {
    this.running = false;
    this.pauseScheduler();
    if (this.nodes) this.nodes.bus.gain.setTargetAtTime(0, this.a.ctx.currentTime, 0.12);
  }

  // 静音 / 切后台时连 25ms 的调度器一起停，避免后台空转继续排音符
  pauseScheduler() { if (this.timer) { clearInterval(this.timer); this.timer = 0; } }
  resumeScheduler() { if (this.running && !this.timer) this.timer = setInterval(() => this.tick(), 25); }

  // 与声音总开关联动：静音时整个音乐总线归零，恢复时把调度指针拉回当前时刻，
  // 否则会把暂停期间「欠下」的音符一次性补排出来。
  mute(m) {
    if (!this.nodes || !this.a.ctx) return;
    const ctx = this.a.ctx;
    this.nodes.bus.gain.setTargetAtTime(m ? 0 : this.level, ctx.currentTime, 0.12);
    if (m) this.pauseScheduler();
    else { this.nextTime = ctx.currentTime + 0.08; this.step = 0; this.resumeScheduler(); }
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
    n.droneGain.gain.setTargetAtTime(0.0045 + 0.0105 * c, t, 0.35);
    n.droneLp.frequency.setTargetAtTime(220 + 700 * c * c, t, 0.45);
    n.padGain.gain.setTargetAtTime(0.004 + 0.012 * c, t, 0.5);
    n.padLp.frequency.setTargetAtTime(760 + 2400 * c, t, 0.5);
    n.pulseGain.gain.setTargetAtTime(0.003 + 0.010 * c, t, 0.4);
    n.shimmerGain.gain.setTargetAtTime(0.0012 + 0.012 * Math.max(0, c - 0.28), t, 0.6);
    n.bassGain.gain.setTargetAtTime(0.0011 + 0.0028 * c, t, 0.9);
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
    // 节奏：八分音符按聚集度稀疏化。散开时 dens≈0，几乎完全静音
    const dens = Math.max(0, Math.min(1, (c - 0.1) / 0.62));
    const accent = pos === 0 || pos === 4;
    if (Math.random() < dens * (accent ? 0.85 : 0.4)) this.pulse(t, accent);
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

  pulse(t, accent) {
    const ctx = this.a.ctx, n = this.nodes;
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = accent ? 88 : 146;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.5, t + (accent ? 0.26 : 0.16));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.95 : 0.5, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (accent ? 0.36 : 0.22));
    o.connect(g); g.connect(n.pulseGain);
    o.start(t); o.stop(t + 0.45);
    this.counts.pulse++;
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
