// FlockLab · 草地：形状生成 + 着色器渲染
// 每片草地是一个 2×R 的平面，形状在片元着色器里用极坐标谐波求值，
// 所以怎么缩放都不糊；总面积固定为屏幕的固定比例（GRASS_FRAC）。

export const GRASS_FRAC = 0.15;
export const GRASS_N = 3;

/**
 * @param {{ THREE, scene, params, bounds2D }} deps
 *   bounds2D() 返回场地半宽/半高；params.grassOn 控制显隐。
 */
export function createGrass({ THREE, scene, params, bounds2D }) {

// 2~3 片「云朵状」草地：极坐标谐波 r(θ) = R·(1 + a₁sin(3θ+φ₁) + a₂sin(5θ+φ₂))，
// 在着色器里直接求值，所以缩放不糊、边缘能有柔和的发光过渡。
const grass = [];          // 每片：{ x, y, R, a1, p1, a2, p2, area, cap, count, members }
const grassMeshes = [];
const grassMatProto = new THREE.ShaderMaterial({
  uniforms: {
    uCenter: { value: new THREE.Vector2(0, 0) },
    uR: { value: 10 },
    uHarm: { value: new THREE.Vector4(0.1, 0, 0.06, 0) },
    uTime: { value: 0 },
    uFade: { value: 1 }
  },
  vertexShader: `
    varying vec2 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xy;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: `
    varying vec2 vWorld;
    uniform vec2 uCenter;
    uniform float uR;
    uniform vec4 uHarm;
    uniform float uTime;
    uniform float uFade;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    // 值噪声：草地内部的明暗斑块与细颗粒都靠它，比纯正弦更像真的植被
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i), b = hash(i + vec2(1.0, 0.0));
      float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    float fbm(vec2 p) {
      return vnoise(p) * 0.6 + vnoise(p * 2.13 + 7.3) * 0.28 + vnoise(p * 4.7 - 3.1) * 0.12;
    }
    void main() {
      vec2 d = vWorld - uCenter;
      float th = atan(d.y, d.x);
      float r = length(d);
      // 边缘：两条谐波叠一点极慢的角向扰动，让轮廓像被风轻轻推着
      float wob = 0.012 * sin(th * 7.0 + uTime * 0.21) + 0.008 * sin(th * 11.0 - uTime * 0.15);
      float rr = uR * (1.0 + uHarm.x * sin(3.0 * th + uHarm.y) + uHarm.z * sin(5.0 * th + uHarm.w) + wob);
      if (r > rr + 2.2) discard;
      float inside = 1.0 - smoothstep(rr - 0.9, rr + 0.35, r);
      float t = clamp(r / max(rr, 0.001), 0.0, 1.0);   // 0=中心 1=边缘

      // 底层：大块的明暗（r 越靠外越暗，像中间被照亮）
      float base = fbm(d * 0.16 + vec2(uTime * 0.02, 0.0));
      float shade = mix(1.0, 0.55, pow(t, 1.6));
      vec3 col = mix(vec3(0.035, 0.20, 0.13), vec3(0.16, 0.50, 0.33), base) * shade;

      // 草叶：沿角向切出来的细碎条纹，靠近边缘更明显（像草丛轮廓）
      float blade = fbm(vec2(th * 22.0, r * 0.55));
      blade = smoothstep(0.52, 0.95, blade) * smoothstep(0.25, 0.95, t);
      col += vec3(0.10, 0.42, 0.24) * blade * 0.55;

      // 细颗粒：近看才有的一点点杂色
      float grain = vnoise(d * 3.1) * 0.5 + vnoise(d * 7.7) * 0.5;
      col *= 0.86 + 0.28 * grain;

      // 边缘一圈很淡的荧光，和整体霓虹感一致
      float rim = exp(-abs(r - rr) * 2.4);
      float a = (inside * (0.10 + 0.07 * base + 0.10 * blade) + rim * 0.16) * uFade;
      if (a < 0.003) discard;
      gl_FragColor = vec4(col * (0.9 + 0.6 * rim), a);
      #include <colorspace_fragment>
    }
  `,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: false
});
// 停留时长：只要没危险就一直待着，最长 100~120 秒
const REST_MAX_MIN = 50000, REST_MAX_SPAN = 10000;    // ms（50~60 秒）

// 估算一片草地上落在场地内的面积（蒙特卡洛）：用于按目标面积反推 R，
// 这样即使草地压在边界上、被切掉一块，场地里看到的面积仍然是目标值。
function inFieldArea(gp, R, bd, samples = 900) {
  const ext = R * 1.4;
  const x0 = gp.x - ext, x1 = gp.x + ext, y0 = gp.y - ext, y1 = gp.y + ext;
  let hit = 0;
  for (let i = 0; i < samples; i++) {
    const x = x0 + Math.random() * (x1 - x0);
    const y = y0 + Math.random() * (y1 - y0);
    if (Math.abs(x) > bd.hx || Math.abs(y) > bd.hy) continue;
    const dx = x - gp.x, dy = y - gp.y;
    const th = Math.atan2(dy, dx);
    const rr = R * (1 + gp.a1 * Math.sin(3 * th + gp.p1) + gp.a2 * Math.sin(5 * th + gp.p2));
    if (Math.hypot(dx, dy) <= rr) hit++;
  }
  return (x1 - x0) * (y1 - y0) * hit / samples;
}

function buildGrass() {
  const bd = bounds2D();
  // 屏幕面积 = 4·hx·hy
  const totalArea = (2 * bd.hx * 2 * bd.hy) * GRASS_FRAC;
  grass.length = 0;
  const count = 2 + (Math.random() < 0.5 ? 1 : 0);   // 2 或 3 片
  const perArea = totalArea / count;
  for (let g = 0; g < count; g++) {
    const a1 = 0.10 + Math.random() * 0.13;
    const a2 = 0.04 + Math.random() * 0.09;
    const p1 = Math.random() * Math.PI * 2;
    const p2 = Math.random() * Math.PI * 2;
    const gp = { x: 0, y: 0, R: 1, a1, p1, a2, p2, area: perArea, cap: 0, count: 0, members: new Set() };
    // 位置：允许压在边界上（草地可以有一部分在场地外），但中心留在场内
    let x = 0, y = 0;
    for (let t = 0; t < 60; t++) {
      x = (Math.random() * 2 - 1) * bd.hx * 0.86;
      y = (Math.random() * 2 - 1) * bd.hy * 0.86;
      gp.x = x; gp.y = y;
      if (grass.every((e) => Math.hypot(e.x - x, e.y - y) > (e.R + 6) * 1.15)) break;
    }
    // 先按「完全在场内」估一个 R，再用实测面积反推（面积 ∝ R²，一次收敛）
    let R = Math.sqrt(perArea / (Math.PI * (1 + (a1 * a1 + a2 * a2) / 2)));
    for (let it = 0; it < 2; it++) {
      gp.R = R;
      const measured = Math.max(1e-3, inFieldArea(gp, R, bd));
      R = Math.min(R * Math.sqrt(perArea / measured), Math.max(bd.hx, bd.hy) * 1.1);
    }
    gp.R = R;
    // 容量按「每个个体 5.2 平方单位」估算，保证停稳后还能保持约 1.7 的间距
    gp.cap = Math.max(14, Math.floor(perArea / 6.6));
    grass.push(gp);
  }
  // 复用/补齐网格
  while (grassMeshes.length < GRASS_N) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), grassMatProto.clone());
    m.frustumCulled = false;
    m.renderOrder = -5;
    scene.add(m);
    grassMeshes.push(m);
  }
  for (let g = 0; g < grassMeshes.length; g++) {
    const m = grassMeshes[g], gp = grass[g];
    if (!gp) { m.visible = false; continue; }
    const span = gp.R * 2.6;           // 谐波最大 1.23 倍 R，再加角向扰动与边缘柔化
    m.scale.set(span, span, 1);
    m.position.set(gp.x, gp.y, -1);
    m.visible = params.grassOn;
    m.material.uniforms.uCenter.value.set(gp.x, gp.y);
    m.material.uniforms.uR.value = gp.R;
    m.material.uniforms.uHarm.value.set(gp.a1, gp.p1, gp.a2, gp.p2);
  }
}

  buildGrass();

  return {
    patches: grass,                 // 供仿真读取（成员、容量、形状参数）
    meshes: grassMeshes,
    build: buildGrass,
    inFieldArea,
    // 开关草地：不显示的片直接隐藏
    setVisible(on) {
      for (let g = 0; g < grassMeshes.length; g++) grassMeshes[g].visible = on && !!grass[g];
    },
    // 每帧推进形状内部的缓慢流动
    tick(t) {
      for (const m of grassMeshes) if (m.visible) m.material.uniforms.uTime.value = t;
    }
  };
}
