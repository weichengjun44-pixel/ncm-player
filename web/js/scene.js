/**
 * NEBULA 视觉引擎 v2
 * ---------------------------------------------------------------
 * 设计（按需求重做）：
 *   1. 封面粒子化   专辑封面被采样成上万颗粒子，换歌时从宇宙深处飞回来重组
 *   2. 节拍追踪     低音冲击把粒子推出去，随后回位（追踪本体的弹簧感）
 *   3. 盒子空间     粒子在发光线框盒子中央，四周深空星场，内壁有浮尘
 *   4. 可转动视角   拖拽 = 360° 环绕，滚轮 = 推拉，松手带惯性，闲置自动慢转
 *   6. 后期处理     UnrealBloom 泛光 + 指数雾（纵深）
 *
 * 数据来源：Web Audio AnalyserNode（由 app.js 传入）
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const BANDS = 128;
const BOX = 110;                 // 盒子半边长（再次放大 → 空间更辽阔）
const COVER_W = 74;             // 封面粒子平面宽度（放大一点，细节更看得清）
const LYRIC_W = 64;             // 歌词粒子平面宽度
const IVORY = new THREE.Color('#fff3e2');    // 星尘主色：暖白（不是冷白）
const AMBER = new THREE.Color('#ffb35c');    // 琥珀：暖色点缀
const ROSE = new THREE.Color('#ff6fae');     // 玫红
const MAGENTA = new THREE.Color('#c86bff');  // 品红偏紫（替代原来的蓝紫）
const BLACK = new THREE.Color('#000000');

/** 备用色组：从封面提不出颜色时用它（都是中低亮度的彩色，刻意避开纯白） */
const FALLBACK_PALETTE = ['#ffb35c', '#ff6fae', '#c86bff', '#ffe7bd', '#ff8f6b'].map((h) => new THREE.Color(h));

/* ------------------------------------------------------------ 贴图工具 */
function glowTexture(inner = 'rgba(255,255,255,1)') {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.4, 'rgba(150,220,255,0.28)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------ 通用粒子着色器 */
const VERT_POINTS = /* glsl */ `
  uniform float uTime, uBass, uMid, uTreble, uLevel, uSwirl, uExpand, uPixel, uInflow;
  attribute vec3 aColor;
  attribute float aSeed;
  attribute float aSize;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vec3 p = position;
    float r = length(p.xz);
    float ang = uSwirl * uTime * (2.2 / (1.0 + r * 0.05));
    float s = sin(ang), c = cos(ang);
    p.xz = mat2(c, -s, s, c) * p.xz;
    p *= 1.0 + uBass * 0.2 * uExpand;
    p.y += sin(uTime * 0.7 + aSeed * 21.0) * (1.0 + uMid * 4.0);
    p += vec3(fract(aSeed*71.3)-0.5, fract(aSeed*39.7)-0.5, fract(aSeed*57.1)-0.5) * uTreble * 3.6 * (0.3 + aSeed);

    // 反向交换：极少数浮尘会被"吸"向中心一段再退回（uInflow=0 的层不受影响）
    if (uInflow > 0.0) {
      float cyc2 = fract(uTime * 0.03 + fract(aSeed * 11.3));
      float pull = pow(max(0.0, sin(cyc2 * 6.2831853)), 14.0) * uInflow;
      p -= normalize(p + 0.0001) * pull * 16.0;
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = min(aSize * uPixel * (300.0 / max(-mv.z, 1.0)) * (1.0 + uLevel * 0.7), 4.0 * uPixel);
    vAlpha = (0.18 + 0.82 * aSeed) * mix(1.0, 0.42, smoothstep(150.0, 22.0, -mv.z));   // 贴脸时压暗，别糊成一片白
  }
`;
const FRAG_POINTS = /* glsl */ `
  uniform float uLevel;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float m = smoothstep(0.5, 0.02, d);
    if (m <= 0.001) discard;
    // 压亮度：避免叠加后过曝成刺眼的白
    gl_FragColor = vec4(vColor * (0.60 + uLevel * 0.55), m * vAlpha * (0.34 + uLevel * 0.46));
  }
`;

/* 封面粒子：从散开位置飞回封面 + 节拍外推 + 回位 */
const VERT_COVER = /* glsl */ `
  uniform float uTime, uBass, uMid, uTreble, uLevel, uMorph, uPixel, uSize, uHalfW, uEntropy;
  attribute vec3 aHome;
  attribute vec3 aScatter;
  attribute vec3 aColor;
  attribute float aSeed;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAway;
  varying float vEdge;
  void main() {
    vColor = aColor;
    float m = clamp(uMorph, 0.0, 1.0);
    float e = 1.0 - pow(1.0 - m, 3.0);
    vec3 p = mix(aScatter, aHome, e);

    vec3 outward = normalize(vec3(aHome.xy, 5.0));
    p += outward * uBass * (5.0 + 5.0 * aSeed) * e;

    // ---- 先把"内外圈"算出来：0 = 内区（锁死）／1 = 最外圈（负责扩散）----
    float rn = max(abs(aHome.x), abs(aHome.y)) / max(uHalfW, 1.0);
    vEdge = smoothstep(0.62, 1.00, rn);        // 内侧 ~62% 完全不动 → 保证清晰
    float react = mix(0.22, 1.0, vEdge);       // 内区只留一点点音频反应

    p += vec3(fract(aSeed*13.1)-0.5, fract(aSeed*29.7)-0.5, fract(aSeed*7.3)-0.5) * uTreble * 2.6 * react * e;

    p.z += sin(uTime * 1.5 + aSeed * 26.0) * uMid * 3.0 * react * e;
    p.y += sin(uTime * 0.9 + aHome.x * 0.12) * uMid * 1.2 * react * e;

    // 外圈常驻摆动（内区为 0，所以中间不会晃）
    vec3 edgeDir = normalize(vec3(aHome.xy, 2.5));
    float wob = sin(uTime * 0.55 + aSeed * 47.0) * 0.5 + sin(uTime * 0.23 + aSeed * 91.0) * 0.5;
    p += edgeDir * wob * vEdge * 9.0 * e;

    // ---- 熵增：只有外圈粒子会离家飘进空间，再自己回来；内区永不动 ----
    float cyc = fract(uTime * 0.034 + fract(aSeed * 13.7));
    float pulse = pow(max(0.0, sin(cyc * 6.2831853)), 10.0);
    vAway = pulse * vEdge * uEntropy * e;
    p += edgeDir * vAway * (34.0 + 52.0 * fract(aSeed * 7.7));
    p += vec3(fract(aSeed*29.7)-0.5, fract(aSeed*53.1)-0.5, fract(aSeed*17.3)-0.5) * vAway * 26.0;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = min(uSize * uPixel * (300.0 / max(-mv.z, 1.0)) * (0.7 + e * 0.5 + uLevel * 0.6), 4.0 * uPixel);
    vAlpha = (0.72 + 0.28 * aSeed) * (1.0 - vEdge * 0.28) * mix(1.0, 0.42, smoothstep(150.0, 22.0, -mv.z));
  }
`;
const FRAG_COVER = /* glsl */ `
  uniform float uLevel, uMorph;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vAway;
  varying float vEdge;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float m = smoothstep(0.5, 0.44, d);          // 更硬：细节最锐（软边会糊成一团光）
    if (m <= 0.004) discard;
    // 飘出去的粒子褪色成暖白 → 看起来就是"扩散进浮尘里的物质"
    vec3 col = mix(vColor, vec3(1.0, 0.93, 0.84), clamp(vAway * 1.6, 0.0, 1.0));
    float fade = 1.0 - clamp(vAway, 0.0, 1.0) * 0.55;
    gl_FragColor = vec4(col * (0.60 + uLevel * 0.28), m * vAlpha * fade * (0.052 + 0.072 * clamp(uMorph,0.0,1.0) + uLevel * 0.06));
  }
`;

/* 歌词粒子专用着色器：要"清晰可读"，所以硬边、几乎不抖、亮度压在泛光阈值以下 */
const VERT_LYRIC = /* glsl */ `
  uniform float uTime, uBass, uMid, uTreble, uLevel, uMorph, uPixel, uSize;
  attribute vec3 aHome;
  attribute vec3 aScatter;
  attribute vec3 aColor;
  attribute float aSeed;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    float m = clamp(uMorph, 0.0, 1.0);
    float e = 1.0 - pow(1.0 - m, 3.0);
    vec3 p = mix(aScatter, aHome, e);

    // 极小抖动：字形要清楚，所以只留一点点生气
    p += vec3(fract(aSeed*13.1)-0.5, fract(aSeed*29.7)-0.5, fract(aSeed*7.3)-0.5) * (0.25 + uTreble * 0.45);
    // 极轻的呼吸（不破坏可读性）
    p.z += sin(uTime * 1.05 + aSeed * 17.0) * 0.45;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixel * (300.0 / max(-mv.z, 1.0));
    vAlpha = 0.55 + 0.45 * aSeed;
  }
`;
const FRAG_LYRIC = /* glsl */ `
  uniform float uLevel, uMorph;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float m = smoothstep(0.5, 0.33, d);          // 硬边 → 笔画清晰，不发糊
    if (m <= 0.01) discard;
    // 亮度压到 0.38：低于泛光阈值起跳点，叠加后也不会糊成一片白
    gl_FragColor = vec4(vColor * 0.38, m * vAlpha * 0.70 * clamp(uMorph, 0.0, 1.0));
  }
`;

function pointsMaterial(extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uLevel: { value: 0 }, uSwirl: { value: 0.08 }, uExpand: { value: 1 }, uPixel: { value: 1 }, uInflow: { value: 0 },
      ...extra,
    },
    vertexShader: VERT_POINTS,
    fragmentShader: FRAG_POINTS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

/* 取色用的临时对象（避免每像素 new） */
const _tmpSrc = new THREE.Color();
const _tmpOut = new THREE.Color();
const _hslSrc = { h: 0, s: 0, l: 0 };
const _hslPal = { h: 0, s: 0, l: 0 };

export class VisualEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.analyser = null;
    this.freq = null;
    this.time = 0;
    this.beat = 0;
    this.playing = false;
    this.bassSmooth = this.midSmooth = this.trebleSmooth = this.levelSmooth = 0;
    this.bassHist = new Array(60).fill(0);
    this.bassHistIdx = 0;
    this.coverGroup = null;
    this.coverMat = null;
    this.coverPoints = 0;
    this.morph = 0;
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsN = 0;

    this.view = { theta: 0.5, phi: 1.25, radius: 200, vTheta: 0, vPhi: 0 };
    this.dragging = false;
    this.lastDrag = 0;
    this.pointer = new THREE.Vector2();

    this.setupScene();
    this.bindInteraction();
    this.clock = new THREE.Clock();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /* ---------------------------------------------------------- 场景 */
  setupScene() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
      preserveDrawingBuffer: true,   // 允许 canvas.toDataURL() 截图（探针回传画面用）
    });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 1);   // 纯黑底：宇宙不是蓝的
    this.renderer.toneMapping = THREE.LinearToneMapping;   // 黑就是黑，不发灰
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x000000, 0.0024);   // 很淡的雾：只压远处，不发灰
    this.camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.1, 4000);
    this.scene.add(this.camera);   // 相机入场景图：MV 平面要挂在相机下（固定在视野正中）

    // ---- 深空星场（三层景深：近/中/远，转动时视差明显）----
    {
      const N = 16000;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const seed = new Float32Array(N), size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const band = i % 10;
        // 三层：30% 近景(视差强) / 30% 中景 / 40% 远景
        const r = band < 3 ? 130 + Math.random() * 170
                : band < 6 ? 340 + Math.random() * 320
                : 700 + Math.random() * 900;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        c.copy(IVORY).lerp(AMBER, Math.random() * 0.5).lerp(MAGENTA, Math.random() * 0.18);
        // 近的稍亮、远的更暗 —— 天然的纵深明暗层次
        const dim = band < 3 ? 1.0 : band < 6 ? 0.72 : 0.5;
        col[i * 3] = c.r * 0.85 * dim; col[i * 3 + 1] = c.g * 0.85 * dim; col[i * 3 + 2] = c.b * 0.85 * dim;
        seed[i] = Math.random();
        size[i] = 1.4 + Math.random() * 3.2;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.starMat = pointsMaterial({ uSwirl: { value: 0.004 }, uExpand: { value: 0.2 } });
      this.starMat.uniforms.uPixel.value = dpr;
      this.stars = new THREE.Points(g, this.starMat);
      this.scene.add(this.stars);
    }

    // ---- 盒子：只留内壁浮尘（边界线按需求隐藏，空间感靠雾与浮尘）----
    {
      const N = 2400;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const seed = new Float32Array(N), size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const face = i % 6;
        const a = (Math.random() * 2 - 1) * BOX, b = (Math.random() * 2 - 1) * BOX;
        const s = BOX * (0.9 + Math.random() * 0.1);
        // 让浮尘不要贴在正中平面上：加一点向内偏移，形成体积
        const inset = BOX * 0.02 * Math.random();
        if (face === 0) { pos[i * 3] = s - inset; pos[i * 3 + 1] = a; pos[i * 3 + 2] = b; }
        else if (face === 1) { pos[i * 3] = -s + inset; pos[i * 3 + 1] = a; pos[i * 3 + 2] = b; }
        else if (face === 2) { pos[i * 3 + 1] = s - inset; pos[i * 3] = a; pos[i * 3 + 2] = b; }
        else if (face === 3) { pos[i * 3 + 1] = -s + inset; pos[i * 3] = a; pos[i * 3 + 2] = b; }
        else if (face === 4) { pos[i * 3 + 2] = s - inset; pos[i * 3] = a; pos[i * 3 + 1] = b; }
        else { pos[i * 3 + 2] = -s + inset; pos[i * 3] = a; pos[i * 3 + 1] = b; }
        c.copy(IVORY).lerp(MAGENTA, Math.random() * 0.3).lerp(AMBER, Math.random() * 0.25);
        col[i * 3] = c.r * 0.34; col[i * 3 + 1] = c.g * 0.34; col[i * 3 + 2] = c.b * 0.34;
        seed[i] = Math.random();
        size[i] = 1.0 + Math.random() * 2.0;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.wallMat = pointsMaterial({ uSwirl: { value: 0.008 }, uExpand: { value: 0.06 } });
      this.wallMat.uniforms.uPixel.value = dpr;
      this.walls = new THREE.Points(g, this.wallMat);
      this.scene.add(this.walls);
      this.boxEdges = null;        // 边界线不显示
      this.cornerPoints = null;    // 角点也不显示
    }

    // ---- 盒内体积浮尘：填满内部空间，转动时视差最强，是"空间延伸感"的主力 ----
    {
      const N = 10000;                     // 按需求降低浮尘密度（它也是灰雾感的来源）
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const seed = new Float32Array(N), size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const r = BOX * 1.02 * Math.pow(Math.random(), 0.5);     // 均匀填满（不是全堆在外壳）
        const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph) * 0.78;
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        c.copy(IVORY).lerp(AMBER, Math.random() * 0.45).lerp(MAGENTA, Math.random() * 0.22);
        const near = 1 - r / (BOX * 1.05);                       // 越靠中心越亮 → 中心像"核"
        const dim = 0.22 + near * 0.55;
        col[i * 3] = c.r * dim; col[i * 3 + 1] = c.g * dim; col[i * 3 + 2] = c.b * dim;
        seed[i] = Math.random();
        size[i] = 0.9 + Math.random() * 2.1;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.dustMat = pointsMaterial({ uSwirl: { value: 0.02 }, uExpand: { value: 0.55 }, uInflow: { value: 1 } });
      this.dustMat.uniforms.uPixel.value = dpr;
      this.dust = new THREE.Points(g, this.dustMat);
      this.scene.add(this.dust);
    }

    // ---- 封面正中的核心光团：按需求已删除（原来是一团贴在封面中心、随音量呼吸的加色光晕）----
    this.core = null;

    // ---- 频谱光环：按需求已删除（原来绕着封面的那圈粒子环）----
    this.halo = null;
    this.haloMat = null;
    this.haloPos = null;

    // ---- 节拍涟漪池 ----
    this.ripples = [];
    for (let k = 0; k < 6; k++) {
      const N = 360;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const seed = new Float32Array(N), size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        pos[i * 3] = Math.cos(a);
        pos[i * 3 + 1] = (Math.random() - 0.5) * 0.3;
        pos[i * 3 + 2] = Math.sin(a);
        c.copy(AMBER).lerp(ROSE, Math.random());
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        seed[i] = Math.random();
        size[i] = 1.5 + Math.random() * 2.4;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      const mat = pointsMaterial({ uSwirl: { value: 0 }, uExpand: { value: 0 } });
      mat.uniforms.uPixel.value = dpr;
      const pts = new THREE.Points(g, mat);
      pts.visible = false;
      this.scene.add(pts);
      this.ripples.push({ pts, mat, life: 0, max: 1.6, power: 0 });
    }

    // ---- MV 视频粒子：每颗粒子实时读 MV 画面的像素颜色（默认隐藏）----
    {
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.loop = true;
      this.video.playsInline = true;
      this.video.preload = 'auto';
      // 注意：不要设 opacity:0 —— 某些内核会因此不给视频解帧（drawImage 全黑）；
      // 也不能设 crossOrigin（同源不需要，且遇代理跳转会直接加载失败）。
      // 这里用"2x2 像素、几乎透明、压到最底层"做到看不见但照常解码。
      this.video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
      document.body.appendChild(this.video);

      this.VW = 384;                       // 采样分辨率（16:9）—— 平面放大后同步提密度
      this.VH = 216;
      this.videoCanvas = document.createElement('canvas');
      this.videoCanvas.width = this.VW;
      this.videoCanvas.height = this.VH;
      this.videoCtx = this.videoCanvas.getContext('2d', { willReadFrequently: true });

      const N = this.VW * this.VH;
      const planeW = 300;                  // 挂相机前 260 处，铺满视口（视口在 260 处约 287 单位宽）
      const planeH = planeW * (this.VH / this.VW);
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);   // 每帧刷新
      const seed = new Float32Array(N);
      const size = new Float32Array(N);
      const cellW = planeW / this.VW;
      const cellH = planeH / this.VH;
      for (let y = 0; y < this.VH; y++) {
        for (let x = 0; x < this.VW; x++) {
          const i = y * this.VW + x;
          pos[i * 3] = (x - this.VW / 2 + 0.5) * cellW + (Math.random() - 0.5) * cellW * 0.7;
          pos[i * 3 + 1] = -(y - this.VH / 2 + 0.5) * cellH + (Math.random() - 0.5) * cellH * 0.7;
          pos[i * 3 + 2] = (Math.random() - 0.5) * 2.5;
          seed[i] = Math.random();
          size[i] = 2.6 + Math.random() * 1.0;   // 点径再加大 → 画面更"实"（点数几乎盖满格子）
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      // 边缘渐隐：外圈 18% 逐渐淡出 → 不会出现一块生硬的"视频方块"
      this.videoFade = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const px = i % this.VW;
        const py = Math.floor(i / this.VW);
        const nx = Math.abs(px / (this.VW - 1) * 2 - 1);
        const ny = Math.abs(py / (this.VH - 1) * 2 - 1);
        const e = Math.max(nx, ny);
        // 边缘渐隐 + 中央柔和减光（封面占 MV 宽度的约 22%，这里对正中 30% 区压暗到一半，
        // 否则视频较亮的镜头会把封面粒子冲淡——两者都能看清才是目标）
        const central = 0.12 + 0.88 * Math.min(1, Math.max(0, (e - 0.30) / 0.12));  // 封面范围(≤0.30)只留 12%，外圈迅速全亮
        this.videoFade[i] = (1 - Math.min(1, Math.max(0, (e - 0.82) / 0.18)) ** 1.5) * central;
      }
      this.videoGeo = g;
      this.videoMat = pointsMaterial({ uSwirl: { value: 0.004 }, uExpand: { value: 0.06 } });
      this.videoMat.uniforms.uPixel.value = dpr;
      this.videoPoints = new THREE.Points(g, this.videoMat);
      this.videoPoints.frustumCulled = false;
      this.videoPoints.visible = false;
      this.videoPoints.position.set(0, 0, -260);     // 相机坐标系：永远在视野正中，转视角也不动
      this.camera.add(this.videoPoints);             // 挂相机 → 固定视角正中（不是世界坐标）
      this.videoLast = 0;
      this.videoUrl = null;
      this.videoAlpha = 1.35;              // MV 亮度系数（用户要求"更亮、清晰可见"；封面正后另有 88% 减光保护封面）
    }

    // ---- 后期 ----
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.46, 0.48, 0.52);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', () => this.onResize());
  }

  /* ---------------------------------------------------------- 交互 */
  bindInteraction() {
    const el = this.canvas;
    let px = 0, py = 0;
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      px = e.clientX; py = e.clientY;
      this.view.vTheta = 0; this.view.vPhi = 0;
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
      if (!this.dragging) return;
      const dx = e.clientX - px, dy = e.clientY - py;
      px = e.clientX; py = e.clientY;
      this.view.theta -= dx * 0.006;
      this.view.phi = Math.max(0.22, Math.min(Math.PI - 0.22, this.view.phi - dy * 0.005));
      this.view.vTheta = -dx * 0.006;
      this.view.vPhi = -dy * 0.005;
      this.lastDrag = this.time;
    });
    window.addEventListener('pointerup', () => {
      this.dragging = false;
      this.lastDrag = this.time;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      // 比例式缩放：远处一步跨度大、近处很细腻（deltaY>0 是拉远）
      const k = Math.exp(e.deltaY * 0.0011);
      this.view.radius = Math.max(4, Math.min(520, this.view.radius * k));
    }, { passive: false });
    el.addEventListener('dblclick', () => this.resetView());
  }

  resetView() {
    this.view.theta = 0.5; this.view.phi = 1.25; this.view.radius = 200;
    this.view.vTheta = 0; this.view.vPhi = 0;
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  /* ---------------------------------------------------------- 音频 */
  setAnalyser(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
  }
  setPlaying(v) { this.playing = v; }

  analyse() {
    if (!this.analyser || !this.playing) {
      this.bassSmooth *= 0.92; this.midSmooth *= 0.92;
      this.trebleSmooth *= 0.92; this.levelSmooth *= 0.92;
      return;
    }
    this.analyser.getByteFrequencyData(this.freq);
    const n = this.freq.length;
    const bi = Math.floor(n * 0.09), mi = Math.floor(n * 0.34), hi = Math.floor(n * 0.72);
    let bass = 0, mid = 0, treble = 0, all = 0;
    for (let i = 0; i < bi; i++) bass += this.freq[i];
    for (let i = bi; i < mi; i++) mid += this.freq[i];
    for (let i = hi; i < n; i++) treble += this.freq[i];
    for (let i = 0; i < n; i++) all += this.freq[i];
    bass = bass / bi / 255; mid = mid / (mi - bi) / 255;
    treble = treble / (n - hi) / 255; all = all / n / 255;

    this.bassSmooth += (bass - this.bassSmooth) * 0.35;
    this.midSmooth += (mid - this.midSmooth) * 0.25;
    this.trebleSmooth += (treble - this.trebleSmooth) * 0.4;
    this.levelSmooth += (all - this.levelSmooth) * 0.2;

    this.bassHistIdx = (this.bassHistIdx + 1) % 60;
    this.bassHist[this.bassHistIdx] = bass;
    let avg = 0;
    for (const v of this.bassHist) avg += v;
    avg /= this.bassHist.length;
    if (bass > avg * 1.32 && bass > 0.22 && this.time - this.beat > 0.2) {
      this.beat = this.time;
      this.spawnRipple(this.bassSmooth);
    }
  }

  spawnRipple(power) {
    const r = this.ripples.find((x) => x.life <= 0);
    if (!r) return;
    r.life = 1; r.max = 1.4 + power * 1.2; r.power = power;
    r.pts.visible = true;
    r.mat.uniforms.uLevel.value = 0.6 + power;
  }

  updateRipples(dt) {
    for (const r of this.ripples) {
      if (r.life <= 0) continue;
      r.life -= dt / r.max;
      if (r.life <= 0) { r.life = 0; r.pts.visible = false; continue; }
      const p = 1 - r.life;
      r.pts.scale.setScalar(3 + p * (BOX * 0.85));
      r.pts.rotation.x = p * 0.5;
      r.mat.uniforms.uLevel.value = (0.5 + r.power) * Math.pow(1 - p, 1.4);
      r.mat.uniforms.uBass.value = r.power * (1 - p);
    }
  }

  updateHalo() {
    if (!this.freq || !this.haloPos) return;      // 光环已删除
    const arr = this.haloPos.array;
    const usable = Math.floor(this.freq.length * 0.82);
    const step = Math.max(1, Math.floor(usable / BANDS));
    const rot = this.time * 0.1;
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += this.freq[b * step + k] || 0;
      const v = sum / step / 255;
      const a = (b / BANDS) * Math.PI * 2 + rot;
      const r0 = BOX * 0.62;
      const len = v * v * 17 + v * 3.5;
      for (let j = 0; j < 4; j++) {
        const f = j / 3;
        const r = r0 + len * f;
        const i = (b * 4 + j) * 3;
        arr[i] = Math.cos(a) * r;
        arr[i + 1] = Math.sin(f * Math.PI) * v * 4.0 * (j === 3 ? 1 : 0.45);
        arr[i + 2] = Math.sin(a) * r;
      }
    }
    this.haloPos.needsUpdate = true;
  }

  /* ---------------------------------------------------------- 色组 */
  /** 从封面像素里提取色组（调色板）：色相分桶，取权重最高的几桶，
   *  再统一压成"中低亮度 + 够饱和"的颜色 —— 这就是不晃眼、不廉价的关键 */
  derivePalette(data, W, H) {
    const BINS = 24;
    const bins = new Array(BINS).fill(0);
    const acc = Array.from({ length: BINS }, () => ({ s: 0, l: 0, n: 0 }));
    const col = new THREE.Color();
    const hsl = { h: 0, s: 0, l: 0 };
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (data[o + 3] / 255 < 0.2) continue;
      col.setRGB(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255);
      col.getHSL(hsl);
      const lum = col.r * 0.2126 + col.g * 0.7152 + col.b * 0.0722;
      if (lum < 0.05 || lum > 0.985) continue;                 // 纯黑/纯白不进色组
      const w = Math.pow(hsl.s, 1.4) * (0.35 + lum) + 0.02;
      const b = Math.min(BINS - 1, Math.floor(hsl.h * BINS));
      bins[b] += w;
      acc[b].s += hsl.s; acc[b].l += hsl.l; acc[b].n++;
    }
    const out = [];
    for (const { i } of bins.map((w, i) => ({ i, w })).sort((x, y) => y.w - x.w)) {
      if (out.length >= 5) break;
      if (!acc[i].n) continue;
      const s = acc[i].s / acc[i].n;
      const l = acc[i].l / acc[i].n;
      out.push(new THREE.Color().setHSL(
        (i + 0.5) / BINS,
        Math.min(0.92, Math.max(0.42, s * 1.15)),
        Math.min(0.66, Math.max(0.40, l * 0.95)),
      ));
    }
    return out.length >= 3 ? out : FALLBACK_PALETTE.map((c2) => c2.clone());
  }

  /** 把像素颜色映射到色组：按色相找最近色，亮度按像素明暗微调（上限 0.72，永不发白） */
  mapToPalette(r, g, b, lum) {
    const pal = this.palette && this.palette.length ? this.palette : FALLBACK_PALETTE;
    _tmpSrc.setRGB(r, g, b);
    _tmpSrc.getHSL(_hslSrc);
    let best = pal[0], bestD = Infinity;
    for (const p of pal) {
      p.getHSL(_hslPal);
      let d = Math.abs(_hslPal.h - _hslSrc.h);
      if (d > 0.5) d = 1 - d;                                  // 色相是环形的
      const score = d + Math.abs(_hslPal.l - _hslSrc.l) * 0.35;
      if (score < bestD) { bestD = score; best = p; }
    }
    best.getHSL(_hslPal);
    // 亮度主要跟像素自身的明暗走（权重 0.78）→ 画面层次保得住、看得清；
    // 色相/饱和度来自色组 → 整体色彩仍然成体系
    let l = Math.min(0.86, Math.max(0.10, _hslPal.l * 0.42 + lum * 0.78));
    l = l * l * (3.0 - 2.0 * l);                       // S 曲线：拉开明暗，免发灰
    const s = Math.min(0.98, _hslPal.s * (0.60 + 0.60 * Math.min(1, _hslSrc.s * 2.0)));
    return _tmpOut.setHSL(_hslPal.h, s, l);
  }

  /* ---------------------------------------------------------- 歌词 → 粒子 */
  /** 把一句歌词栅格化后采样成粒子，浮在空间里（始终朝向相机） */
  setLyricParticles(text) {
    const t = (text || '').trim();
    if (!t) { this.clearLyricParticles(); return; }
    if (t === this.lyricText) return;
    this.lyricText = t;

    let FS = 150;                                    // 字号加大 → 采样更细，字形更清楚
    const pad = 40;
    const mctx = document.createElement('canvas').getContext('2d');
    const fontOf = (size) => `700 ${size}px "PingFang SC","Microsoft YaHei",sans-serif`;
    mctx.font = fontOf(FS);
    let textW = Math.ceil(mctx.measureText(t).width);
    if (textW + pad * 2 > 4096) {                    // 太长的句子按比例缩字号，别被裁掉
      FS = Math.max(48, Math.floor((FS * (4096 - pad * 2)) / textW));
      mctx.font = fontOf(FS);
      textW = Math.ceil(mctx.measureText(t).width);
    }
    const font = fontOf(FS);
    const w = Math.min(4096, textW + pad * 2);
    const h = Math.ceil(FS * 1.6);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(t, w / 2, h / 2);
    let img;
    try {
      img = ctx.getImageData(0, 0, w, h).data;
    } catch { return; }

    // 采样步长：按"目标粒子数"反推，句子长短都稳定在 ~1.6 万颗，字形边缘够细
    const TARGET = 16000;
    let step = Math.max(1, Math.round(Math.sqrt((w * h * 0.30) / TARGET)));
    const homes = [], scatters = [], colors = [], seeds = [];
    const scale = LYRIC_W / w;
    const pal = this.palette && this.palette.length ? this.palette : FALLBACK_PALETTE;
    const c = new THREE.Color();
    const half = step * 0.5;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (img[(y * w + x) * 4 + 3] < 150) continue;          // 阈值提高 → 只取笔画实体，边缘不糊
        // 亚像素抖动：打散规则网格，看起来更"手工"、不呆板
        const jx = (Math.random() - 0.5) * half;
        const jy = (Math.random() - 0.5) * half;
        homes.push((x + jx - w / 2) * scale, -(y + jy - h / 2) * scale, (Math.random() - 0.5) * 0.9);
        const rr = 150 + Math.random() * 320;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
        scatters.push(rr * Math.sin(ph) * Math.cos(th), rr * Math.cos(ph) * 0.6, rr * Math.sin(ph) * Math.sin(th));
        c.copy(pal[Math.min(pal.length - 1, Math.floor((x / w) * pal.length))]);   // 横向渐变取色组
        colors.push(c.r, c.g, c.b);
        seeds.push(Math.random());
      }
    }
    if (homes.length < 60) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(homes, 3));
    geo.setAttribute('aHome', new THREE.Float32BufferAttribute(homes, 3));
    geo.setAttribute('aScatter', new THREE.Float32BufferAttribute(scatters, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
        uLevel: { value: 0 }, uMorph: { value: 0 }, uPixel: { value: this.dpr }, uSize: { value: 1.05 },
      },
      vertexShader: VERT_LYRIC,
      fragmentShader: FRAG_LYRIC,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    const group = new THREE.Group();
    group.add(pts);
    group.position.set(0, BOX * 0.46, 0);       // 浮在封面上方（封面放大后同步抬高）
    this.scene.add(group);

    // 换句时旧的那行不直接消失，而是往回收（散掉），过渡更细
    if (this.lyricGroup && this.lyricMat) {
      this.lyricFade = { group: this.lyricGroup, mat: this.lyricMat, morph: this.lyricMorph || 1 };
    } else if (this.lyricGroup) {
      this.disposeGroup(this.lyricGroup);
    }
    this.lyricGroup = group;
    this.lyricMat = mat;
    this.lyricMorph = 0;
    this.lyricPoints = homes.length / 3;
  }

  /** 释放一组粒子（几何 + 材质） */
  disposeGroup(group) {
    this.scene.remove(group);
    group.traverse((o) => {
      o.geometry?.dispose?.();
      o.material?.dispose?.();
    });
  }

  clearLyricParticles() {
    if (this.lyricGroup) {
      this.disposeGroup(this.lyricGroup);
      this.lyricGroup = null;
      this.lyricMat = null;
      this.lyricPoints = 0;
    }
    if (this.lyricFade) {
      this.disposeGroup(this.lyricFade.group);
      this.lyricFade = null;
    }
    this.lyricText = '';
  }

  /* ---------------------------------------------------------- 封面 → 粒子 */
  /** 把专辑封面采样成粒子云；换歌时从远处飞回来重组（morph 0→1） */
  async setCoverToParticles(url, { width = 640 } = {}) {
    if (!url) { this.clearCover(); return; }
    let img;
    try {
      img = await new Promise((ok, no) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => ok(i);
        i.onerror = () => no(new Error('封面加载失败'));
        i.src = url;
      });
    } catch (e) {
      console.warn('[scene] 封面粒子化失败:', e.message);
      return;
    }

    const W = width;
    const H = Math.max(8, Math.round((W * img.height) / img.width));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    let data;
    try {
      data = ctx.getImageData(0, 0, W, H).data;
    } catch (e) {
      console.warn('[scene] 取像素失败:', e.message);
      return;
    }

    // ---- 色组：从封面里提取调色板，再把粒子颜色重映射进去 ----
    const palette = this.derivePalette(data, W, H);
    this.palette = palette;

    const homes = [], scatters = [], colors = [], seeds = [];
    const planeW = COVER_W;
    const px = planeW / W;
    const c = new THREE.Color();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, a = data[i + 3] / 255;
        if (a < 0.15) continue;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum < 0.055) continue;
        // 熵增：越靠边角的像素越容易被"吃掉"，轮廓因此不是一条直线
        const cx = Math.abs(x - W / 2) / (W / 2);
        const cy = Math.abs(y - H / 2) / (H / 2);
        const rn0 = Math.max(cx, cy);
        if (rn0 > 0.92 && Math.random() < (rn0 - 0.92) / 0.08 * 0.18) continue;   // 只啃最外 8%，轮廓保持锐
        // 亚像素抖动 + 更明显的弧面 → 既有细节又有体积，且不像"整齐的格子"
        const X = (x - W / 2 + 0.5 + (Math.random() - 0.5) * 0.7) * px;
        const Y = -(y - H / 2 + 0.5 + (Math.random() - 0.5) * 0.7) * px;
        const R2 = (X * X + Y * Y) / (planeW * planeW * 0.25);
        const Z = (1 - Math.min(R2, 1)) * 5.0 + (Math.random() - 0.5) * 0.7;
        homes.push(X, Y, Z);

        const rr = 240 + Math.random() * 420;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
        scatters.push(rr * Math.sin(ph) * Math.cos(th), rr * Math.cos(ph) * 0.7, rr * Math.sin(ph) * Math.sin(th));

        // 色彩还原：用色组里最接近的颜色，亮度按像素明暗微调（不出现纯白）
        c.copy(this.mapToPalette(r, g, b, lum));
        colors.push(c.r, c.g, c.b);
        seeds.push(Math.random());
      }
    }
    if (homes.length < 300) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(homes, 3));
    geo.setAttribute('aHome', new THREE.Float32BufferAttribute(homes, 3));
    geo.setAttribute('aScatter', new THREE.Float32BufferAttribute(scatters, 3));
    geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
        uLevel: { value: 0 }, uMorph: { value: 0 }, uPixel: { value: this.dpr }, uSize: { value: 0.62 },
        uHalfW: { value: COVER_W * 0.5 }, uEntropy: { value: 1.0 },
      },
      vertexShader: VERT_COVER,
      fragmentShader: FRAG_COVER,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    const group = new THREE.Group();
    group.add(pts);
    this.scene.add(group);

    if (this.coverGroup) {
      this.scene.remove(this.coverGroup);
      this.coverGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    }
    this.coverGroup = group;
    this.coverMat = mat;
    this.coverPoints = homes.length / 3;
    this.morph = 0;
  }

  clearCover() {
    if (this.coverGroup) {
      this.scene.remove(this.coverGroup);
      this.coverGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      this.coverGroup = null;
      this.coverMat = null;
      this.coverPoints = 0;
    }
  }

  /* ---------------------------------------------------------- MV 视频 → 粒子 */
  /** 挂一支 MV（同源 /mv?id=... 流），用它实时驱动背后的粒子幕 */
  attachVideo(url) {
    if (!this.video) return;
    if (this.videoUrl === url && this.videoPoints.visible) return;
    this.videoUrl = url;
    this.videoPoints.visible = true;
    this.video.src = url;
    this.video.play().catch(() => {});
  }

  detachVideo() {
    if (!this.video) return;
    this.videoUrl = null;
    this.videoPoints.visible = false;
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch {}
  }

  setVideoPlaying(v) {
    if (!this.video || !this.videoPoints.visible) return;
    try {
      if (v) this.video.play().catch(() => {});
      else this.video.pause();
    } catch {}
  }

  /** 每帧把 MV 画面采成粒子颜色（限频 30fps，避免 CPU 白烧） */
  updateVideoParticles() {
    if (!this.video || !this.videoPoints.visible) return;
    if (this.video.readyState < 2) return;
    if (this.time - this.videoLast < 1 / 30) return;
    this.videoLast = this.time;
    const { VW, VH } = this;
    try {
      this.videoCtx.drawImage(this.video, 0, 0, VW, VH);
      const d = this.videoCtx.getImageData(0, 0, VW, VH).data;
      const col = this.videoGeo.attributes.aColor.array;
      const N = VW * VH;
      let sum = 0;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const f = this.videoFade[i] * this.videoAlpha;   // 边缘渐隐 + 亮度系数（片元里还会再乘 0.34）
        col[i * 3] = (d[o] / 255) * f;
        col[i * 3 + 1] = (d[o + 1] / 255) * f;
        col[i * 3 + 2] = (d[o + 2] / 255) * f;
        sum += d[o] + d[o + 1] + d[o + 2];
      }
      this.videoLum = sum / (N * 3 * 255);        // 采样画面平均亮度（0~1）
      this.videoLumMax = Math.max(this.videoLumMax || 0, this.videoLum);   // 历史峰值：判断"一直黑"还是"恰好是黑镜头"
      const q = this.video.getVideoPlaybackQuality ? this.video.getVideoPlaybackQuality() : null;
      this.videoFrames = (q && q.totalVideoFrames) || this.video.webkitDecodedFrameCount || 0;
      this.videoGeo.attributes.aColor.needsUpdate = true;
    } catch (e) {
      console.warn('[scene] MV 取样失败，关闭视频粒子:', e.message);
      this.detachVideo();
    }
  }

  debugInfo() {
    return {
      coverPoints: this.coverPoints,
      lyricPoints: this.lyricPoints || 0,
      palette: (this.palette || []).length,
      mv: !this.videoPoints || !this.videoPoints.visible
        ? '无'
        : this.video.readyState >= 2
          ? this.video.videoWidth + 'x' + this.video.videoHeight
          : '加载中',
      mvLum: Math.round((this.videoLum || 0) * 100),                       // 采样画面平均亮度 %
      mvLumMax: Math.round((this.videoLumMax || 0) * 100),                 // 历史峰值 %
      mvFrames: this.videoFrames || 0,                                     // 已解码帧数
      mvT: this.video ? +this.video.currentTime.toFixed(1) : 0,            // 播放位置（秒）
      fps: Math.round(this.fps),
      theta: +this.view.theta.toFixed(2),
      radius: Math.round(this.view.radius),
      level: +this.levelSmooth.toFixed(3),
    };
  }

  /* ---------------------------------------------------------- 主循环 */
  loop() {
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc >= 0.5) { this.fps = this._fpsN / this._fpsAcc; this._fpsAcc = 0; this._fpsN = 0; }

    this.analyse();
    const bass = this.bassSmooth, mid = this.midSmooth, treble = this.trebleSmooth, level = this.levelSmooth;
    const beatAge = this.time - this.beat;
    const kick = beatAge < 0.35 ? Math.pow(1 - beatAge / 0.35, 2) : 0;

    if (this.coverMat) {
      this.morph = Math.min(1, this.morph + dt / 1.7);
      this.coverMat.uniforms.uMorph.value = this.morph;
      this.coverMat.uniforms.uTime.value = this.time;
      this.coverMat.uniforms.uBass.value = bass;
      this.coverMat.uniforms.uMid.value = mid;
      this.coverMat.uniforms.uTreble.value = treble;
      this.coverMat.uniforms.uLevel.value = level;
    }
    if (this.coverGroup) {
      this.coverGroup.rotation.y = Math.sin(this.time * 0.16) * 0.16 + this.pointer.x * 0.12;
      this.coverGroup.rotation.x = -this.pointer.y * 0.1 + Math.sin(this.time * 0.12) * 0.05;
      this.coverGroup.scale.setScalar(1 + bass * 0.05 + kick * 0.02);
    }

    // 歌词粒子：飞入 + 始终朝向相机（任何角度都读得出来）
    if (this.lyricMat) {
      this.lyricMorph = Math.min(1, this.lyricMorph + dt / 1.25);
      this.lyricMat.uniforms.uMorph.value = this.lyricMorph;
      this.lyricMat.uniforms.uTime.value = this.time;
      this.lyricMat.uniforms.uBass.value = bass;
      this.lyricMat.uniforms.uMid.value = mid;
      this.lyricMat.uniforms.uTreble.value = treble;
      this.lyricMat.uniforms.uLevel.value = level;
    }
    if (this.lyricGroup) {
      this.lyricGroup.quaternion.copy(this.camera.quaternion);
      this.lyricGroup.position.y = BOX * 0.46 + Math.sin(this.time * 0.5) * 1.3;
    }
    // 上一句正在散掉的那组
    if (this.lyricFade) {
      const f = this.lyricFade;
      f.morph = Math.max(0, f.morph - dt / 0.55);
      f.mat.uniforms.uMorph.value = f.morph;
      f.mat.uniforms.uTime.value = this.time;
      f.mat.uniforms.uTreble.value = treble;
      if (f.group) f.group.quaternion.copy(this.camera.quaternion);
      if (f.morph <= 0.001) {
        this.disposeGroup(f.group);
        this.lyricFade = null;
      }
    }

    // MV 粒子幕：取样 + 随低频轻微呼吸
    this.updateVideoParticles();
    if (this.videoPoints && this.videoPoints.visible) {
      this.videoMat.uniforms.uLevel.value = 0.30 + level * 0.45;
      this.videoPoints.rotation.z = Math.sin(this.time * 0.05) * 0.02;
      this.videoPoints.scale.setScalar(1 + bass * 0.03);
    }

    for (const m of [this.starMat, this.wallMat, this.dustMat, this.videoMat]) {
      m.uniforms.uTime.value = this.time;
      m.uniforms.uBass.value = bass;
      m.uniforms.uMid.value = mid;
      m.uniforms.uTreble.value = treble;
      m.uniforms.uLevel.value = level;
    }

    this.updateHalo();
    this.updateRipples(dt);

    // 边界线已隐藏（按需求），这里不再有盒子描边
    if (this.boxEdges) {
      this.boxEdges.material.opacity = 0.1 + level * 0.15;
      this.boxEdges.scale.setScalar(1 + bass * 0.012);
    }
    if (this.cornerPoints) this.cornerPoints.material.opacity = 0.5 + kick * 0.4;

    // 视角：拖拽惯性 + 闲置自动慢转
    const v = this.view;
    if (!this.dragging) {
      v.theta += v.vTheta;
      v.phi = Math.max(0.22, Math.min(Math.PI - 0.22, v.phi + v.vPhi));
      v.vTheta *= 0.93; v.vPhi *= 0.93;
      if (this.time - this.lastDrag > 2.5 && Math.abs(v.vTheta) < 0.002 && v.radius > 40) v.theta += dt * 0.035;
    }
    const r = v.radius - kick * 2.5;
    this.camera.position.set(
      r * Math.sin(v.phi) * Math.cos(v.theta),
      r * Math.cos(v.phi) * -1 + 4,
      r * Math.sin(v.phi) * Math.sin(v.theta),
    );
    this.camera.lookAt(0, 0, 0);

    this.composer.render();
  }
}
