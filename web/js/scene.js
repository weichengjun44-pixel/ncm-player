/**
 * NEBULA 视觉引擎 v2
 * ---------------------------------------------------------------
 * 设计（按需求重做）：
 *   1. 封面粒子化   专辑封面被采样成上万颗粒子，换歌时从宇宙深处飞回来重组
 *   2. 节拍追踪     低音冲击把粒子推出去，随后回位（追踪本体的弹簧感）
 *   3. 盒子空间     粒子在发光线框盒子中央，四周深空星场，内壁有浮尘
 *   4. 可转动视角   拖拽 = 360° 环绕，滚轮 = 推拉，松手带惯性，闲置自动慢转
 *   5. 频谱光环     128 段径向粒子，贴在盒子内
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
const BOX = 42;                 // 盒子半边长
const CYAN = new THREE.Color('#6ee7ff');
const VIOLET = new THREE.Color('#a78bfa');
const PINK = new THREE.Color('#ff7ac6');
const WHITE = new THREE.Color('#eaf2ff');

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
  uniform float uTime, uBass, uMid, uTreble, uLevel, uSwirl, uExpand, uPixel;
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
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixel * (300.0 / max(-mv.z, 1.0)) * (1.0 + uLevel * 0.7);
    vAlpha = 0.18 + 0.82 * aSeed;
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
    gl_FragColor = vec4(vColor * (0.75 + uLevel * 1.0), m * vAlpha * (0.45 + uLevel * 0.7));
  }
`;

/* 封面粒子：从散开位置飞回封面 + 节拍外推 + 回位 */
const VERT_COVER = /* glsl */ `
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

    vec3 outward = normalize(vec3(aHome.xy, 5.0));
    p += outward * uBass * (7.0 + 7.0 * aSeed) * e;

    p += vec3(fract(aSeed*13.1)-0.5, fract(aSeed*29.7)-0.5, fract(aSeed*7.3)-0.5) * uTreble * 3.4 * e;

    p.z += sin(uTime * 1.5 + aSeed * 26.0) * uMid * 4.0 * e;
    p.y += sin(uTime * 0.9 + aHome.x * 0.12) * uMid * 1.6 * e;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixel * (300.0 / max(-mv.z, 1.0)) * (0.7 + e * 0.5 + uLevel * 0.6);
    vAlpha = 0.30 + 0.70 * aSeed;
  }
`;
const FRAG_COVER = /* glsl */ `
  uniform float uLevel, uMorph;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float m = smoothstep(0.5, 0.03, d);
    if (m <= 0.002) discard;
    gl_FragColor = vec4(vColor * (0.85 + uLevel * 1.15), m * vAlpha * (0.35 + 0.55 * clamp(uMorph,0.0,1.0) + uLevel * 0.5));
  }
`;

function pointsMaterial(extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
      uLevel: { value: 0 }, uSwirl: { value: 0.08 }, uExpand: { value: 1 }, uPixel: { value: 1 },
      ...extra,
    },
    vertexShader: VERT_POINTS,
    fragmentShader: FRAG_POINTS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

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

    this.view = { theta: 0.5, phi: 1.25, radius: 96, vTheta: 0, vPhi: 0 };
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
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x04050c, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x04050c, 0.0026);
    this.camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.1, 4000);

    // ---- 深空星场（盒子之外）----
    {
      const N = 12000;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const seed = new Float32Array(N), size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const r = 210 + Math.random() * 900;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph) * 0.6;
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        c.copy(WHITE).lerp(CYAN, Math.random() * 0.5).lerp(VIOLET, Math.random() * 0.25);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
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

    // ---- 盒子：线框 + 内壁浮尘 + 角落光点 ----
    {
      const box = new THREE.BoxGeometry(BOX * 2, BOX * 2, BOX * 2);
      this.boxEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(box),
        new THREE.LineBasicMaterial({ color: 0x5fd4ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending }),
      );
      this.scene.add(this.boxEdges);

      const N = 2600;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const seed = new Float32Array(N), size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const face = i % 6;
        const a = (Math.random() * 2 - 1) * BOX, b = (Math.random() * 2 - 1) * BOX;
        const s = BOX * (0.94 + Math.random() * 0.06);
        if (face === 0) { pos[i * 3] = s; pos[i * 3 + 1] = a; pos[i * 3 + 2] = b; }
        else if (face === 1) { pos[i * 3] = -s; pos[i * 3 + 1] = a; pos[i * 3 + 2] = b; }
        else if (face === 2) { pos[i * 3 + 1] = s; pos[i * 3] = a; pos[i * 3 + 2] = b; }
        else if (face === 3) { pos[i * 3 + 1] = -s; pos[i * 3] = a; pos[i * 3 + 2] = b; }
        else if (face === 4) { pos[i * 3 + 2] = s; pos[i * 3] = a; pos[i * 3 + 1] = b; }
        else { pos[i * 3 + 2] = -s; pos[i * 3] = a; pos[i * 3 + 1] = b; }
        c.copy(CYAN).lerp(VIOLET, Math.random());
        col[i * 3] = c.r * 0.6; col[i * 3 + 1] = c.g * 0.6; col[i * 3 + 2] = c.b * 0.6;
        seed[i] = Math.random();
        size[i] = 1.0 + Math.random() * 2.0;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.wallMat = pointsMaterial({ uSwirl: { value: 0.01 }, uExpand: { value: 0.1 } });
      this.wallMat.uniforms.uPixel.value = dpr;
      this.walls = new THREE.Points(g, this.wallMat);
      this.scene.add(this.walls);

      const corners = [];
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x * BOX, y * BOX, z * BOX]);
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
      this.cornerPoints = new THREE.Points(
        cg,
        new THREE.PointsMaterial({ size: 3.4, map: glowTexture(), color: 0x9fe8ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
      );
      this.scene.add(this.cornerPoints);
    }

    // ---- 核心光团 ----
    this.core = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture(), color: 0xbff2ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.core.scale.setScalar(20);
    this.scene.add(this.core);

    // ---- 频谱光环 ----
    {
      const N = BANDS * 4;
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      const seed = new Float32Array(N), size = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const b = Math.floor(i / 4);
        const c = new THREE.Color().setHSL((0.5 + (b / BANDS) * 0.45) % 1, 0.85, 0.62);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        seed[i] = Math.random();
        size[i] = 1.5 + (i % 4) * 0.5;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.haloMat = pointsMaterial({ uSwirl: { value: 0.05 }, uExpand: { value: 0.35 } });
      this.haloMat.uniforms.uPixel.value = dpr;
      this.halo = new THREE.Points(g, this.haloMat);
      this.halo.frustumCulled = false;
      this.scene.add(this.halo);
      this.haloPos = g.attributes.position;
    }

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
        c.copy(CYAN).lerp(PINK, Math.random());
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

    // ---- 后期 ----
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.0, 0.6, 0.12);
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
      this.view.radius = Math.max(52, Math.min(180, this.view.radius + e.deltaY * 0.06));
    }, { passive: false });
    el.addEventListener('dblclick', () => this.resetView());
  }

  resetView() {
    this.view.theta = 0.5; this.view.phi = 1.25; this.view.radius = 96;
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
    if (!this.freq) return;
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

  /* ---------------------------------------------------------- 封面 → 粒子 */
  /** 把专辑封面采样成粒子云；换歌时从远处飞回来重组（morph 0→1） */
  async setCoverToParticles(url, { width = 132 } = {}) {
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

    const homes = [], scatters = [], colors = [], seeds = [];
    const planeW = 40;
    const px = planeW / W;
    const c = new THREE.Color();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, a = data[i + 3] / 255;
        if (a < 0.15) continue;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (lum < 0.055) continue;                       // 丢掉纯黑，省点数也更通透
        const X = (x - W / 2 + 0.5) * px;
        const Y = -(y - H / 2 + 0.5) * px;
        const R2 = (X * X + Y * Y) / (planeW * planeW * 0.25);
        const Z = (1 - Math.min(R2, 1)) * 3.2;           // 轻微弧面，有体积感
        homes.push(X, Y, Z);

        const rr = 240 + Math.random() * 420;             // 从宇宙深处飞来
        const th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
        scatters.push(rr * Math.sin(ph) * Math.cos(th), rr * Math.cos(ph) * 0.7, rr * Math.sin(ph) * Math.sin(th));

        const boost = 1.25 + lum * 0.55;
        c.setRGB(Math.min(r * boost, 1), Math.min(g * boost, 1), Math.min(b * boost, 1));
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
        uLevel: { value: 0 }, uMorph: { value: 0 }, uPixel: { value: this.dpr }, uSize: { value: 1.55 },
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

  debugInfo() {
    return {
      coverPoints: this.coverPoints,
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

    for (const m of [this.starMat, this.wallMat, this.haloMat]) {
      m.uniforms.uTime.value = this.time;
      m.uniforms.uBass.value = bass;
      m.uniforms.uMid.value = mid;
      m.uniforms.uTreble.value = treble;
      m.uniforms.uLevel.value = level;
    }

    this.core.scale.setScalar(16 + bass * 34 + kick * 12);
    this.core.material.opacity = 0.32 + level * 0.4;

    this.updateHalo();
    this.updateRipples(dt);

    this.boxEdges.material.opacity = 0.12 + level * 0.22 + kick * 0.1;
    this.boxEdges.scale.setScalar(1 + bass * 0.012);
    this.cornerPoints.material.opacity = 0.6 + kick * 0.4;

    // 视角：拖拽惯性 + 闲置自动慢转
    const v = this.view;
    if (!this.dragging) {
      v.theta += v.vTheta;
      v.phi = Math.max(0.22, Math.min(Math.PI - 0.22, v.phi + v.vPhi));
      v.vTheta *= 0.93; v.vPhi *= 0.93;
      if (this.time - this.lastDrag > 2.5 && Math.abs(v.vTheta) < 0.002) v.theta += dt * 0.035;
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
