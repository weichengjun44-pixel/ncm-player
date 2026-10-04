/**
 * NEBULA 视觉引擎
 * ---------------------------------------------------------------
 * 组成：
 *   1. 星场      深空背景，缓慢漂移 + 闪烁
 *   2. 星云      6 万粒子螺旋盘，随低频扩张、高频抖动、缓慢自转
 *   3. 核心光晕  随节拍脉动的中心光团
 *   4. 频谱光环  128 段径向粒子，长度=频段能量，颜色=频率
 *   5. 节拍涟漪  低音冲击时向外扩散的粒子环
 *   6. 封面圆盘  专辑封面悬浮在空中缓慢旋转
 *   7. 后期处理  UnrealBloom 泛光 + 雾（空间纵深）
 *
 * 数据来源：Web Audio AnalyserNode（由 app.js 传入）
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const BANDS = 128;        // 频谱段数
const CYAN = new THREE.Color('#6ee7ff');
const VIOLET = new THREE.Color('#a78bfa');
const PINK = new THREE.Color('#ff7ac6');
const WHITE = new THREE.Color('#eaf2ff');

/** 圆形羽化贴图（封面圆盘 / 光晕用） */
function discTexture(soft = 0.72) {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(soft, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.94, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 中心光团贴图 */
function glowTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(160,240,255,0.55)');
  grd.addColorStop(0.55, 'rgba(120,150,255,0.16)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

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

    // 差异化自转：内圈快、外圈慢
    float ang = uSwirl * uTime * (2.2 / (1.0 + r * 0.055));
    float s = sin(ang), c = cos(ang);
    p.xz = mat2(c, -s, s, c) * p.xz;

    // 低频 → 整体扩张；中频 → 上下起伏
    p *= 1.0 + uBass * 0.26 * uExpand;
    p.y += sin(uTime * 0.7 + aSeed * 21.0) * (1.2 + uMid * 5.5);

    // 高频 → 细碎抖动（星空"沙沙"感）
    vec3 jitter = vec3(
      fract(aSeed * 71.3) - 0.5,
      fract(aSeed * 39.7) - 0.5,
      fract(aSeed * 57.1) - 0.5
    );
    p += jitter * uTreble * 4.2 * (0.3 + aSeed);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixel * (300.0 / max(-mv.z, 1.0)) * (1.0 + uLevel * 0.8);
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
    gl_FragColor = vec4(vColor * (0.75 + uLevel * 1.1), m * vAlpha * (0.45 + uLevel * 0.75));
  }
`;

function pointsMaterial(extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uTreble: { value: 0 },
      uLevel: { value: 0 },
      uSwirl: { value: 0.12 },
      uExpand: { value: 1 },
      uPixel: { value: 1 },
      ...extra,
    },
    vertexShader: VERT_POINTS,
    fragmentShader: FRAG_POINTS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export class VisualEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.analyser = null;
    this.freq = null;
    this.time = 0;
    this.beat = 0;
    this.bassSmooth = 0;
    this.midSmooth = 0;
    this.trebleSmooth = 0;
    this.levelSmooth = 0;
    this.playing = false;
    this.mode = 0;            // 0 星云 / 1 星海 / 2 引力
    this.pointer = new THREE.Vector2();
    this.pointerTarget = new THREE.Vector2();
    this.bassHist = new Array(60).fill(0);
    this.setupScene();
    this.setupUI();
    this.loop = this.loop.bind(this);
    this.clock = new THREE.Clock();
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- 场景
  setupScene() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x04050c, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x04050c, 0.0030);

    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 3000);
    this.camera.position.set(0, 13, 64);
    this.camera.lookAt(0, 0, 0);

    // ---- 星场 ----
    {
      const N = 14000;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      const seed = new Float32Array(N);
      const size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const r = 160 + Math.random() * 620;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(Math.random() * 2 - 1);
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph) * 0.55;
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        c.copy(WHITE).lerp(CYAN, Math.random() * 0.5).lerp(VIOLET, Math.random() * 0.25);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        seed[i] = Math.random();
        size[i] = 1.4 + Math.random() * 3.4;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.starMat = pointsMaterial({ uSwirl: { value: 0.006 }, uExpand: { value: 0.25 } });
      this.starMat.uniforms.uPixel.value = dpr;
      this.stars = new THREE.Points(g, this.starMat);
      this.scene.add(this.stars);
    }

    // ---- 星云（螺旋盘，3 旋臂）----
    {
      const N = 60000;
      const ARMS = 3;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      const seed = new Float32Array(N);
      const size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const arm = i % ARMS;
        const t = Math.pow(Math.random(), 0.62);           // 向内密集
        const r = 7 + t * 78;
        const spin = r * 0.055;
        const ang = arm * ((Math.PI * 2) / ARMS) + spin + (Math.random() - 0.5) * 0.62;
        const spread = (1 - t) * 4.5 + 1.6;
        pos[i * 3] = Math.cos(ang) * r + (Math.random() - 0.5) * spread;
        pos[i * 3 + 1] = (Math.random() - 0.5) * (3.2 + (1 - t) * 7.5);
        pos[i * 3 + 2] = Math.sin(ang) * r + (Math.random() - 0.5) * spread;

        // 内暖（粉/紫）→ 中青 → 外蓝紫
        const k = t;
        if (k < 0.35) c.copy(PINK).lerp(VIOLET, k / 0.35);
        else if (k < 0.7) c.copy(VIOLET).lerp(CYAN, (k - 0.35) / 0.35);
        else c.copy(CYAN).lerp(new THREE.Color('#3b5cff'), (k - 0.7) / 0.3);
        const dim = 0.55 + Math.random() * 0.6;
        col[i * 3] = c.r * dim; col[i * 3 + 1] = c.g * dim; col[i * 3 + 2] = c.b * dim;
        seed[i] = Math.random();
        size[i] = 1.1 + Math.random() * 3.2;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.nebulaMat = pointsMaterial({ uSwirl: { value: 0.1 } });
      this.nebulaMat.uniforms.uPixel.value = dpr;
      this.nebula = new THREE.Points(g, this.nebulaMat);
      this.scene.add(this.nebula);
    }

    // ---- 核心光团 ----
    this.core = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTexture(),
        color: 0xbff2ff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.core.scale.setScalar(30);
    this.scene.add(this.core);

    // ---- 频谱光环（128 段 × 4 点径向）----
    {
      const N = BANDS * 4;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      const seed = new Float32Array(N);
      const size = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const b = Math.floor(i / 4);
        const h = (b / BANDS) * 0.78 + 0.5;             // 色相：青 → 紫 → 粉
        const c = new THREE.Color().setHSL(h % 1, 0.85, 0.62);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        seed[i] = Math.random();
        size[i] = 1.6 + (i % 4) * 0.5;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.haloMat = pointsMaterial({ uSwirl: { value: 0.05 }, uExpand: { value: 0.4 } });
      this.haloMat.uniforms.uPixel.value = dpr;
      this.halo = new THREE.Points(g, this.haloMat);
      this.halo.frustumCulled = false;
      this.scene.add(this.halo);
      this.haloPos = g.attributes.position;
    }

    // ---- 节拍涟漪池 ----
    this.ripples = [];
    for (let k = 0; k < 7; k++) {
      const N = 420;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      const seed = new Float32Array(N);
      const size = new Float32Array(N);
      const c = new THREE.Color();
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + Math.random() * 0.02;
        const rr = 1 + Math.random() * 0.06;
        pos[i * 3] = Math.cos(a) * rr;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 0.35;
        pos[i * 3 + 2] = Math.sin(a) * rr;
        c.copy(CYAN).lerp(PINK, Math.random());
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        seed[i] = Math.random();
        size[i] = 1.6 + Math.random() * 2.6;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      const mat = pointsMaterial({ uSwirl: { value: 0.0 }, uExpand: { value: 0.0 } });
      mat.uniforms.uPixel.value = dpr;
      const pts = new THREE.Points(g, mat);
      pts.visible = false;
      this.scene.add(pts);
      this.ripples.push({ pts, mat, life: 0, max: 0 });
    }

    // ---- 专辑封面圆盘 ----
    {
      const geo = new THREE.PlaneGeometry(26, 26);
      this.coverMat = new THREE.MeshBasicMaterial({
        map: discTexture(0.62),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
      });
      this.coverDisc = new THREE.Mesh(geo, this.coverMat);
      this.coverDisc.position.set(0, 0, -14);
      this.scene.add(this.coverDisc);
      // 圆盘外圈的散射粒子
      const N = 900;
      const pos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      const seed = new Float32Array(N);
      const size = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 13.5 + Math.random() * 6.5;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = Math.sin(a) * r;
        pos[i * 3 + 2] = -14 + (Math.random() - 0.5) * 2.2;
        const c = new THREE.Color().setHSL(0.52 + Math.random() * 0.2, 0.8, 0.62);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
        seed[i] = Math.random();
        size[i] = 1.2 + Math.random() * 2.6;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      this.ringMat = pointsMaterial({ uSwirl: { value: 0.25 } });
      this.ringMat.uniforms.uPixel.value = dpr;
      this.ring = new THREE.Points(g, this.ringMat);
      this.scene.add(this.ring);
    }

    // ---- 后期：泛光 ----
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.05,   // strength
      0.62,   // radius
      0.11    // threshold
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    window.addEventListener('resize', () => this.onResize());
  }

  setupUI() {
    window.addEventListener('pointermove', (e) => {
      this.pointerTarget.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        (e.clientY / window.innerHeight) * 2 - 1
      );
    });
    window.addEventListener('dblclick', () => {
      this.mode = (this.mode + 1) % 3;
      this.applyMode();
      window.dispatchEvent(new CustomEvent('vis-mode', { detail: this.modeName() }));
    });
    this.applyMode();
  }

  modeName() {
    return ['星云', '星海', '引力'][this.mode];
  }

  setMode(m) {
    this.mode = ((m % 3) + 3) % 3;
    this.applyMode();
    return this.modeName();
  }

  nextMode() {
    return this.setMode(this.mode + 1);
  }

  applyMode() {
    const { stars, nebula, starMat, nebulaMat, halo } = this;
    if (this.mode === 0) {            // 星云
      nebula.visible = true;
      nebulaMat.uniforms.uSwirl.value = 0.1;
      nebulaMat.uniforms.uExpand.value = 1;
      starMat.uniforms.uExpand.value = 0.25;
      this.ring.visible = true;
      this.coverDisc.visible = true;
      this.bloom.strength = 1.05;
    } else if (this.mode === 1) {     // 星海：只剩深空 + 光核，安静
      nebula.visible = false;
      starMat.uniforms.uExpand.value = 1.6;
      this.ring.visible = false;
      this.coverDisc.visible = true;
      this.bloom.strength = 1.25;
    } else {                          // 引力：收缩、盘旋更快、更敏感
      nebula.visible = true;
      nebulaMat.uniforms.uSwirl.value = 0.34;
      nebulaMat.uniforms.uExpand.value = 2.1;
      starMat.uniforms.uExpand.value = 0.8;
      this.ring.visible = true;
      this.coverDisc.visible = true;
      this.bloom.strength = 1.15;
    }
    halo.visible = true;
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  // ---------------------------------------------------------------- 音频
  setAnalyser(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
  }

  setPlaying(v) { this.playing = v; }

  /** 每帧：把频谱变成几组能量 + 节拍 */
  analyse() {
    if (!this.analyser || !this.playing) {
      // 暂停时能量缓降，画面不会突然死掉
      this.bassSmooth *= 0.92;
      this.midSmooth *= 0.92;
      this.trebleSmooth *= 0.92;
      this.levelSmooth *= 0.92;
      return {};
    }
    this.analyser.getByteFrequencyData(this.freq);
    const n = this.freq.length;
    const bi = Math.floor(n * 0.09);      // 低频段
    const mi = Math.floor(n * 0.34);
    const hi = Math.floor(n * 0.72);
    let bass = 0, mid = 0, treble = 0, all = 0;
    for (let i = 0; i < bi; i++) bass += this.freq[i];
    for (let i = bi; i < mi; i++) mid += this.freq[i];
    for (let i = hi; i < n; i++) treble += this.freq[i];
    for (let i = 0; i < n; i++) all += this.freq[i];
    bass = bass / bi / 255;
    mid = mid / (mi - bi) / 255;
    treble = treble / (n - hi) / 255;
    all = all / n / 255;

    // 平滑
    this.bassSmooth += (bass - this.bassSmooth) * 0.35;
    this.midSmooth += (mid - this.midSmooth) * 0.25;
    this.trebleSmooth += (treble - this.trebleSmooth) * 0.4;
    this.levelSmooth += (all - this.levelSmooth) * 0.2;

    // 节拍：低频能量显著超过近 60 帧均值
    this.bassHist.push(bass);
    if (this.bassHist.length > 60) this.bassHist.shift();
    const avg = this.bassHist.reduce((a, b) => a + b, 0) / this.bassHist.length;
    if (bass > avg * 1.34 && bass > 0.24 && this.time - this.beat > 0.22) {
      this.beat = this.time;
      this.spawnRipple(this.bassSmooth);
    }
    return { bass, mid, treble };
  }

  spawnRipple(power) {
    const r = this.ripples.find((x) => x.life <= 0);
    if (!r) return;
    r.life = 1;
    r.max = 1.5 + power * 1.4;
    r.power = power;
    r.pts.visible = true;
    r.mat.uniforms.uLevel.value = 0.6 + power;
  }

  updateRipples(dt) {
    for (const r of this.ripples) {
      if (r.life <= 0) continue;
      r.life -= dt / r.max;
      if (r.life <= 0) {
        r.life = 0;
        r.pts.visible = false;
        continue;
      }
      const p = 1 - r.life;                       // 0→1
      const radius = 8 + p * 62;
      r.pts.scale.setScalar(radius);
      r.pts.rotation.x = p * 0.5;
      r.mat.uniforms.uLevel.value = (0.5 + r.power) * (1 - p) ** 1.4;
      r.mat.uniforms.uBass.value = r.power * (1 - p);
    }
  }

  /** 频谱光环的几何更新 */
  updateHalo() {
    if (!this.freq) return;
    const arr = this.haloPos.array;
    const usable = Math.floor(this.freq.length * 0.82);
    const step = Math.max(1, Math.floor(usable / BANDS));
    const rot = this.time * 0.14;
    for (let b = 0; b < BANDS; b++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += this.freq[b * step + k] || 0;
      const v = sum / step / 255;
      const a = (b / BANDS) * Math.PI * 2 + rot;
      const r0 = 9.5;
      const len = v * v * 30 + v * 6;
      for (let j = 0; j < 4; j++) {
        const f = j / 3;
        const r = r0 + len * f;
        const i = (b * 4 + j) * 3;
        arr[i] = Math.cos(a) * r;
        arr[i + 1] = Math.sin(f * Math.PI) * v * 5.5 * (j === 3 ? 1 : 0.5);
        arr[i + 2] = Math.sin(a) * r;
      }
    }
    this.haloPos.needsUpdate = true;
  }

  setCover(url) {
    if (!url) {
      this.coverMat.opacity = 0;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const old = this.coverMat.map;
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      this.coverMat.map = tex;
      this.coverMat.needsUpdate = true;
      this.coverMat.opacity = 0;   // 由动画渐入
      this.coverTarget = 0.92;
      if (old && old.isCanvasTexture !== true) old.dispose?.();
    };
    img.onerror = () => { this.coverTarget = 0; };
    img.src = url;
  }

  clearCover() {
    this.coverTarget = 0;
  }

  // ---------------------------------------------------------------- 主循环
  loop() {
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.time += dt;

    const e = this.analyse();
    const bass = this.bassSmooth;
    const mid = this.midSmooth;
    const treble = this.trebleSmooth;
    const level = this.levelSmooth;
    const beatAge = this.time - this.beat;
    const kick = beatAge < 0.35 ? (1 - beatAge / 0.35) ** 2 : 0;

    // 指针缓动（视差）
    this.pointer.lerp(this.pointerTarget, 0.045);

    for (const m of [this.starMat, this.nebulaMat, this.haloMat, this.ringMat]) {
      m.uniforms.uTime.value = this.time;
      m.uniforms.uBass.value = bass;
      m.uniforms.uMid.value = mid;
      m.uniforms.uTreble.value = treble;
      m.uniforms.uLevel.value = level;
    }

    // 核心光团脉动
    const coreScale = 26 + bass * 46 + kick * 16;
    this.core.scale.setScalar(coreScale);
    this.core.material.opacity = 0.55 + level * 0.5;

    // 封面圆盘
    this.coverTarget = this.coverTarget ?? 0;
    this.coverMat.opacity += (this.coverTarget - this.coverMat.opacity) * 0.06;
    if (this.coverDisc && this.coverDisc.visible) {
      this.coverDisc.rotation.z = this.time * 0.06;
      this.coverDisc.scale.setScalar(1 + bass * 0.12 + kick * 0.05);
      this.coverDisc.position.y = Math.sin(this.time * 0.4) * 1.6;
    }
    this.ring.rotation.z = -this.time * 0.05;
    this.ringMat.uniforms.uLevel.value = level;

    this.updateHalo();
    this.updateRipples(dt);

    // 相机：缓慢巡游 + 鼠标视差 + 节拍轻推
    const t = this.time;
    const camZ = (this.mode === 2 ? 52 : 64) - kick * 3.2;
    this.camera.position.x = Math.sin(t * 0.055) * 9 + this.pointer.x * 7;
    this.camera.position.y = 13 + Math.sin(t * 0.082) * 4.2 - this.pointer.y * 5 - bass * 4;
    this.camera.position.z = camZ + Math.cos(t * 0.047) * 6;
    this.camera.lookAt(0, Math.sin(t * 0.06) * 1.5, 0);

    this.composer.render();
  }
}
