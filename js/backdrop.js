// ---------------------------------------------------------------- 背景地貌
// 只做氛围，不参与任何仿真。两层：
//   ① 地貌：草地 / 河流 / 村庄剪影，一次性画进 canvas 当纹理（静态，随窗口尺寸重画）
//   ② 云：另画一张可无缝平铺的小图，在着色器里按时间缓慢漂移，两层不同尺度叠出「若隐若现」
//
// 为什么用 canvas 画而不是在着色器里算噪声：地貌要的是「像形状的东西」——河得有河岸、
// 房子得有屋顶、草地得是一块块不规则的斑。噪声只能给出斑块，画不出这些。而且一次画完
// 之后每帧只剩两次纹理采样，比在片元着色器里堆 fbm 便宜得多。
//
// 亮度：canvas 里按 0.05~0.3 的 alpha 画（8 位通道才够分辨），着色器里再乘 uGain 压回
// 0.002~0.01 的线性亮度——比星云底亮一点点，绝不抢鸟群。整层是加法混合，
// 只「加亮」不遮挡，所以不需要处理透明排序。

const OVER = 1.30;      // 纹理比视口大 30%：给视差留余量，平移时不会露边
const PARALLAX = 0.22;  // 远景只跟着相机走 22% 的距离（越小越「远」）
const GAIN = 0.050;     // canvas alpha → 线性亮度的换算系数

// 固定种子的伪随机：窗口尺寸变了要重画，重画后地貌必须还在原地，
// 不能每 resize 一次就把村庄换到别处去。
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 地貌：把「剪影」画成一层层极淡的加法色。顺序即层次：草地 → 河流 → 村庄。
function drawLand(ctx, W, H, rnd) {
  ctx.clearRect(0, 0, W, H);
  // 全程用 lighter（加法）合成：形状互相叠加是「累积」而不是「后画的盖住先画的」，
  // 和着色器里的加法混合一致，叠起来才有远近层次。
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const U = Math.min(W, H);

  // ---- ① 草地：一片片不规则的软斑（每块由 4 个错开的椭圆渐变叠成，不是正圆）----
  // 偏长条、略斜：像一片片田或草滩；正圆看起来会像「水渍」。
  // 按 4×3 的抖动网格铺（不是纯随机）：纯随机会一半挤在角落、另一半空着，
  // 而这张图的随机种子是固定的，那点空就会永远空着。
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const cx = W * ((gx + 0.12 + rnd() * 0.76) / 4);
      const cy = H * ((gy + 0.12 + rnd() * 0.76) / 3);
      const R = U * (0.09 + rnd() * 0.10);
      const tilt = (rnd() - 0.5) * 0.9;
      for (let l = 0; l < 4; l++) {
        const ox = cx + (rnd() - 0.5) * R * 1.5, oy = cy + (rnd() - 0.5) * R * 0.8;
        const r = R * (0.4 + rnd() * 0.5);
        ctx.save();
        ctx.translate(ox, oy);
        ctx.rotate(tilt);
        ctx.scale(1.55, 1);          // 拉长成条状
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, 'rgba(86,182,124,0.062)');
        g.addColorStop(0.55, 'rgba(68,150,104,0.032)');
        g.addColorStop(1, 'rgba(52,118,86,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832); ctx.fill();
        ctx.restore();
      }
    }
  }

  // ---- ② 河流：纵向蜿蜒，三层叠出水感（暗河岸 → 水面 → 断续反光） ----
  // 基准线压在画面中间三分之一：纹理比视口大 30%，太靠边的话静止时根本看不到河。
  const ph1 = rnd() * 6.283, ph2 = rnd() * 6.283;
  const baseX = W * (0.38 + rnd() * 0.24);
  const riverX = (v) => baseX
    + Math.sin(v * 6.283 * 0.62 + ph1) * W * 0.085
    + Math.sin(v * 6.283 * 1.35 + ph2) * W * 0.032;
  const river = new Path2D();
  for (let i = 0; i <= 116; i++) {
    const v = -0.08 + (i / 116) * 1.16;
    const x = riverX(v), y = v * H;
    if (i === 0) river.moveTo(x, y); else river.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(46,78,132,0.075)';   // 河岸
  ctx.lineWidth = U * 0.055;
  ctx.stroke(river);
  ctx.strokeStyle = 'rgba(88,142,206,0.085)';  // 水面
  ctx.lineWidth = U * 0.032;
  ctx.stroke(river);
  ctx.setLineDash([U * 0.055, U * 0.075]);     // 反光：断续，否则像一根电线
  ctx.strokeStyle = 'rgba(150,205,246,0.085)';
  ctx.lineWidth = U * 0.007;
  ctx.stroke(river);
  ctx.setLineDash([]);

  // ---- ③ 村庄：两三簇贴着河的小村子 ----
  // 关键是「成串」而不是「撒点」：房子沿着一条村道排开、朝向统一，才看得出是村子；
  // 撒在一个圆里的做法只会变成一堆碎屑。
  for (let c = 0, cn = 2 + ((rnd() * 2) | 0); c < cn; c++) {
    // 第一簇放上半、第二簇放下半，避免两簇叠在同一处；纹理边缘 15% 是视差留白，
    // 所以 v 收在 0.18~0.82 之间，静止时一定看得见。
    const v = c === 0 ? 0.18 + rnd() * 0.22 : 0.52 + rnd() * 0.3;
    const side = rnd() < 0.5 ? -1 : 1;
    const cx0 = riverX(v) + side * U * (0.05 + rnd() * 0.05);
    const cy0 = v * H;
    const roadAng = (rnd() - 0.5) * 1.1 + (side > 0 ? 0 : Math.PI);   // 大致与河平行
    const half = U * (0.035 + rnd() * 0.03);                          // 村道半长
    const dx = Math.cos(roadAng), dy = Math.sin(roadAng) * 0.8;
    // 村道本身：一条极淡的细线，房子骑在它两侧
    ctx.strokeStyle = 'rgba(150,172,214,0.05)';
    ctx.lineWidth = Math.max(1, U * 0.0022);
    ctx.beginPath();
    ctx.moveTo(cx0 - dx * half * 1.2, cy0 - dy * half * 1.2);
    ctx.lineTo(cx0 + dx * half * 1.2, cy0 + dy * half * 1.2);
    ctx.stroke();
    for (let h = 0, hn = 7 + ((rnd() * 7) | 0); h < hn; h++) {
      const tt = (h / Math.max(1, hn - 1) - 0.5) * 2;
      const off = (rnd() < 0.5 ? -1 : 1) * U * (0.008 + rnd() * 0.012);
      const hx = cx0 + dx * half * tt - dy * off;
      const hy = cy0 + dy * half * tt + dx * off;
      const s = U * (0.0068 + rnd() * 0.0045);
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(roadAng);
      ctx.fillStyle = 'rgba(146,166,206,0.17)';
      ctx.fillRect(-s * 0.62, -s * 0.48, s * 1.24, s * 0.96);
      // 屋脊：一条比屋顶亮一点的横线，远远看去就是「一栋房子」
      ctx.strokeStyle = 'rgba(206,224,255,0.13)';
      ctx.lineWidth = Math.max(0.7, s * 0.1);
      ctx.beginPath();
      ctx.moveTo(-s * 0.62, -s * 0.14);
      ctx.lineTo(s * 0.62, -s * 0.14);
      ctx.stroke();
      if (rnd() < 0.5) {
        ctx.fillStyle = 'rgba(255,200,128,0.26)';
        ctx.fillRect(s * 0.1, s * 0.02, s * 0.24, s * 0.26);
      }
      ctx.restore();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

// 云：画成可无缝平铺的小图——每个团在 3×3 个偏移位置各画一遍，跨边界的部分自然接上，
// 着色器里就能用 RepeatWrapping 无限漂移而不露接缝。
function drawCloud(ctx, W, H, rnd) {
  ctx.clearRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  // 云的形状：宁可少而大。22 个小团铺满一张图会变成均匀的雾；
  // 12 个大团才有「一大片云正从画面上飘过」的样子。
  const blobs = [];
  for (let i = 0; i < 12; i++) {
    blobs.push({ x: rnd() * W, y: rnd() * H, r: W * (0.13 + rnd() * 0.16), a: 0.10 + rnd() * 0.16 });
  }
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (const b of blobs) {
        const x = b.x + ox * W, y = b.y + oy * H;
        const g = ctx.createRadialGradient(x, y, 0, x, y, b.r);
        g.addColorStop(0, `rgba(255,255,255,${b.a.toFixed(3)})`);
        g.addColorStop(0.55, `rgba(255,255,255,${(b.a * 0.45).toFixed(3)})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, b.r, 0, 6.2832); ctx.fill();
      }
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

export function createBackdrop(THREE) {
  const landCanvas = document.createElement('canvas');
  const landTex = new THREE.CanvasTexture(landCanvas);
  landTex.colorSpace = THREE.NoColorSpace;      // canvas 里的数值当线性亮度直接用
  landTex.minFilter = landTex.magFilter = THREE.LinearFilter;
  landTex.generateMipmaps = false;
  landTex.wrapS = landTex.wrapT = THREE.ClampToEdgeWrapping;

  const cloudCanvas = document.createElement('canvas');
  cloudCanvas.width = cloudCanvas.height = 512;
  drawCloud(cloudCanvas.getContext('2d'), 512, 512, mulberry32(0x9e3779b9));
  const cloudTex = new THREE.CanvasTexture(cloudCanvas);
  cloudTex.colorSpace = THREE.NoColorSpace;
  cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uLand: { value: landTex },
      uCloud: { value: cloudTex },
      uHalf: { value: new THREE.Vector2(1, 1) },
      uView: { value: new THREE.Vector2(0, 0) },
      uTime: { value: 0 },
      uGain: { value: GAIN },
      // 草地挖洞：每片草地一个 (x, y, R) + 谐波 (a1, p1, a2, p2)。
      // 只做「地貌层避让」——云照常从草地上方飘过，因为云在天上。
      uG: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uGH: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uGN: { value: 0 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform sampler2D uLand;
      uniform sampler2D uCloud;
      uniform vec2 uHalf;
      uniform vec2 uView;
      uniform float uTime;
      uniform float uGain;
      uniform vec4 uG[3];
      uniform vec4 uGH[3];
      uniform int uGN;

      void main() {
        // ---- 地貌：跟着平移 22%，偏移量夹在纹理留白之内（OVER=1.30 → 每边 15%）----
        vec2 off = uView * ${PARALLAX.toFixed(3)} / (uHalf * ${(OVER * 2).toFixed(3)});
        off = clamp(off, vec2(-0.12), vec2(0.12));
        vec4 lt = texture2D(uLand, vUv + off);
        vec3 col = lt.rgb * lt.a * uGain;

        // ---- 草地避让：这个像素对应的世界点若落在某片草地里，就把地貌抹掉 ----
        // 用世界坐标判定（而不是按屏幕坐标擦纹理），所以拖拽平移、缩放都永远对得上；
        // 轮廓用和草地完全相同的极坐标谐波，边界再留 8% + 2 个单位的余量，
        // 于是河 / 村庄都会「绕开草地」，而不是从草上穿过去。
        vec2 wp = (vUv - 0.5) * 2.0 * uHalf + uView;
        float keep = 1.0;
        for (int i = 0; i < 3; i++) {
          if (i >= uGN) break;
          vec2 d = wp - uG[i].xy;
          float R = uG[i].z;
          float th = atan(d.y, d.x);
          float rr = R * (1.0 + uGH[i].x * sin(3.0 * th + uGH[i].y)
                              + uGH[i].z * sin(5.0 * th + uGH[i].w));
          keep *= smoothstep(rr * 1.04, rr * 1.14 + 2.6, length(d));
        }
        col *= keep;

        // ---- 云：两层不同尺度、不同方向，按世界坐标慢慢漂 ----
        vec2 cuv = vUv * ${(1.25).toFixed(2)} + off * 2.6;
        float c1 = texture2D(uCloud, cuv + vec2(uTime * 0.0042, uTime * 0.0016)).a;
        float c2 = texture2D(uCloud, cuv * 1.9 + vec2(0.41, 0.73) - vec2(uTime * 0.0026, uTime * 0.0040)).a;
        float cl = c1 * 0.85 + c2 * 0.55;

        // 云压住地貌（厚处像被遮了一下），自己再带一点冷调月光——「若隐若现」就靠这一压一亮。
        // 阈值给得高、系数给得小：大部分时候云几乎不可见，只有叠得最厚的地方才透出来一点，
        // 那才是「若隐若现」；一旦让云铺满整屏就变成一层奶白色的雾了。
        col *= 1.0 - 0.6 * smoothstep(0.42, 1.3, cl);
        col += vec3(0.0019, 0.0026, 0.0040) * smoothstep(0.42, 1.35, cl);

        // 和星云同一套暗角：加法层如果不跟着压暗，四周会凭空"发灰"，跟中间断成两层
        vec2 vp = (vUv - 0.5) * 2.0;
        float vig = smoothstep(1.05, 0.12, length(vp * vec2(1.0, 0.88)));
        col *= 0.42 + 0.58 * vig;

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false;

  let lastW = 0, lastH = 0;

  // 视口尺寸一变就重画地貌（按视口的 1.3 倍生成，给视差留余量）。
  // 长边压到 2048 以内：4K 屏上不必为了这点极淡的剪影白烧一次 fill。
  function setViewport(cssW, cssH) {
    if (Math.abs(cssW - lastW) < 2 && Math.abs(cssH - lastH) < 2) return;
    lastW = cssW; lastH = cssH;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    let w = Math.round(cssW * OVER * dpr), h = Math.round(cssH * OVER * dpr);
    const k = Math.min(1, 2048 / Math.max(1, Math.max(w, h)));
    w = Math.max(2, Math.round(w * k));
    h = Math.max(2, Math.round(h * k));
    landCanvas.width = w; landCanvas.height = h;
    drawLand(landCanvas.getContext('2d'), w, h, mulberry32(0x1234567));
    landTex.needsUpdate = true;
  }

  // 视锥（含缩放）变化时调用：平面铺满视口，并同步着色器里的视口尺寸
  function setProjection(halfW, halfH) {
    mesh.scale.set(halfW * 2 * OVER, halfH * 2 * OVER, 1);
    mat.uniforms.uHalf.value.set(halfW, halfH);
  }

  function update(t, viewX, viewY) {
    mat.uniforms.uTime.value = t;
    mat.uniforms.uView.value.set(viewX, viewY);
  }

  // 草地避让：传进来的是 grass.js 的真实 patch（x, y, R, a1, p1, a2, p2）。
  // 传空数组 = 不避让（草地关掉时地貌就该露出来）。
  // 用世界坐标在着色器里判定，所以草地重建、拖拽平移、缩放都不需要重画纹理。
  function setGrass(patches) {
    const list = patches || [];
    const n = Math.min(3, list.length);
    for (let i = 0; i < n; i++) {
      const gp = list[i];
      mat.uniforms.uG.value[i].set(gp.x, gp.y, gp.R, 0);
      mat.uniforms.uGH.value[i].set(gp.a1, gp.p1, gp.a2, gp.p2);
    }
    mat.uniforms.uGN.value = n;
  }

  return { mesh, setViewport, setProjection, update, setGrass, uniforms: mat.uniforms };
}
