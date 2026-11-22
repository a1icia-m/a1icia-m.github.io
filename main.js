/* =====================================================================
   Pond ripple background
   - A low-res wave simulation runs on the CPU (cheap, works everywhere).
   - Its slopes are uploaded as a texture each frame.
   - A WebGL shader uses those slopes to bend the water painting.
   Only the water is distorted; lily pads and ducks sit on top, untouched.
   ===================================================================== */
(function pond() {
  const canvas = document.getElementById('water');
  const ducks = document.getElementById('ducks');
  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- tuning knobs ----
  const SIM_WIDTH = window.innerWidth < 700 ? 160 : 240; // simulation columns
  const DAMPING = 0.986;          // how long ripples last (0.98 short … 0.995 long)
  const DISTORTION = 0.018;       // how much the painting bends
  const SHINE = 0.22;             // highlight strength on ripple edges
  const RAIN_EVERY_MS = 1600;     // ambient drops so the pond is alive when idle

  // Where the painting is "anchored" when the screen crops it (0 = left, 1 = right).
  // On narrow screens we shift right so the ducks stay in view.
  function focusX() { return window.innerWidth < 900 ? 0.95 : 0.5; }

  // ---------------- ducks fade out on scroll ----------------
  function updateDucks() {
    const fade = 1 - Math.min(1, window.scrollY / (window.innerHeight * 0.55));
    ducks.style.opacity = fade.toFixed(3);
    ducks.style.visibility = fade <= 0 ? 'hidden' : 'visible';
  }
  window.addEventListener('scroll', updateDucks, { passive: true });
  updateDucks();

  // ---------------- WebGL setup ----------------
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false });
  if (!gl) { canvas.remove(); return; } // CSS background shows the still painting instead

  const vert = `
    attribute vec2 p;
    varying vec2 vUv;
    void main() {
      vUv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
      gl_Position = vec4(p, 0.0, 1.0);
    }`;
  const frag = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uWater;
    uniform sampler2D uRipple;
    uniform vec2 uScreen;
    uniform vec2 uImage;
    uniform float uFocus;
    uniform float uDistort;
    uniform float uShine;

    vec2 coverUv(vec2 uv) {
      float sr = uScreen.x / uScreen.y;
      float ir = uImage.x / uImage.y;
      vec2 s = sr > ir ? vec2(1.0, ir / sr) : vec2(sr / ir, 1.0);
      vec2 anchor = vec2(uFocus, 0.5);
      return uv * s + (1.0 - s) * anchor;
    }

    void main() {
      vec2 slope = texture2D(uRipple, vUv).rg * 2.0 - 1.0;
      vec2 uv = vUv + slope * uDistort;
      vec3 col = texture2D(uWater, clamp(coverUv(uv), 0.001, 0.999)).rgb;
      float light = dot(slope, normalize(vec2(-0.55, -0.8)));
      col += max(light, 0.0) * uShine;
      col -= max(-light, 0.0) * uShine * 0.35;
      gl_FragColor = vec4(col, 1.0);
    }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = name => gl.getUniformLocation(prog, name);
  gl.uniform1i(u('uWater'), 0);
  gl.uniform1i(u('uRipple'), 1);
  gl.uniform1f(u('uDistort'), DISTORTION);
  gl.uniform1f(u('uShine'), SHINE);

  function makeTexture(unit) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const waterTex = makeTexture(0);
  const rippleTex = makeTexture(1);
  let waterReady = false;

  const img = new Image();
  img.onload = () => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, waterTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.uniform2f(u('uImage'), img.naturalWidth, img.naturalHeight);
    waterReady = true;
  };
  img.src = 'assets/water.webp';

  // ---------------- wave simulation ----------------
  let W, H, cur, prev, packed;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u('uScreen'), canvas.width, canvas.height);

    const fx = focusX();
    gl.uniform1f(u('uFocus'), fx);
    root.style.setProperty('--focus-x', (fx * 100) + '%');

    W = SIM_WIDTH;
    H = Math.max(40, Math.round(SIM_WIDTH * window.innerHeight / window.innerWidth));
    cur = new Float32Array(W * H);
    prev = new Float32Array(W * H);
    packed = new Uint8Array(W * H * 4);
  }
  resize();
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  // Drop a disturbance at screen position (px, py).
  function disturb(px, py, strength, radius) {
    const cx = (px / window.innerWidth) * W;
    const cy = (py / window.innerHeight) * H;
    const r = Math.ceil(radius);
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = Math.sqrt(x * x + y * y);
        if (d > radius) continue;
        const ix = Math.round(cx + x), iy = Math.round(cy + y);
        if (ix < 1 || iy < 1 || ix >= W - 1 || iy >= H - 1) continue;
        prev[iy * W + ix] += strength * (0.5 + 0.5 * Math.cos(Math.PI * d / radius));
      }
    }
  }

  function step() {
    for (let y = 1; y < H - 1; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const k = row + x;
        cur[k] = ((prev[k - 1] + prev[k + 1] + prev[k - W] + prev[k + W]) * 0.5 - cur[k]) * DAMPING;
      }
    }
    const t = prev; prev = cur; cur = t;
  }

  function upload() {
    const h = prev;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        const l = h[x > 0 ? k - 1 : k], r = h[x < W - 1 ? k + 1 : k];
        const t = h[y > 0 ? k - W : k], b = h[y < H - 1 ? k + W : k];
        const gx = Math.max(-1, Math.min(1, (r - l) * 1.6));
        const gy = Math.max(-1, Math.min(1, (b - t) * 1.6));
        const o = k * 4;
        packed[o] = (gx * 127 + 128) | 0;
        packed[o + 1] = (gy * 127 + 128) | 0;
        packed[o + 2] = 128;
        packed[o + 3] = 255;
      }
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, rippleTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, packed);
  }

  // ---------------- input ----------------
  let last = null;
  function trail(x, y, strength) {
    if (last) {
      const dx = x - last.x, dy = y - last.y;
      const dist = Math.hypot(dx, dy);
      const steps = Math.min(12, Math.ceil(dist / 14));
      for (let i = 1; i <= steps; i++) {
        disturb(last.x + dx * i / steps, last.y + dy * i / steps, strength, 2.2);
      }
    }
    last = { x, y };
  }
  window.addEventListener('pointermove', e => trail(e.clientX, e.clientY, reduceMotion ? 0.12 : 0.35), { passive: true });
  window.addEventListener('pointerleave', () => { last = null; });
  window.addEventListener('pointerdown', e => disturb(e.clientX, e.clientY, reduceMotion ? 1.2 : 3.2, 4));

  if (!reduceMotion) {
    setInterval(() => {
      if (document.hidden) return;
      disturb(Math.random() * window.innerWidth, Math.random() * window.innerHeight, 1.6 + Math.random() * 1.4, 3);
    }, RAIN_EVERY_MS);
  }

  // ---------------- loop (fixed 60 steps/sec, any refresh rate) ----------------
  let acc = 0, then = performance.now();
  function frame(now) {
    acc += Math.min(100, now - then);
    then = now;
    while (acc >= 16.67) { step(); acc -= 16.67; }
    if (waterReady) {
      upload();
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

/* =====================================================================
   Nav: highlight the section you're currently in
   ===================================================================== */
(function nav() {
  const links = [...document.querySelectorAll('.nav nav a')];
  const sections = links.map(a => document.getElementById(a.dataset.section));
  function update() {
    const mid = window.innerHeight * 0.35;
    let current = sections[0];
    for (const s of sections) if (s.getBoundingClientRect().top <= mid) current = s;
    links.forEach(a => a.classList.toggle('active', a.dataset.section === current.id));
  }
  window.addEventListener('scroll', update, { passive: true });
  update();
})();

/* =====================================================================
   Artwork lightbox: click a piece to zoom; info slides up from the bottom
   ===================================================================== */
(function lightbox() {
  const box = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  const title = document.getElementById('lb-title');
  const meta = document.getElementById('lb-meta');
  const closeBtn = document.getElementById('lb-close');
  let opener = null;

  function open(fig) {
    const pic = fig.querySelector('img');
    img.src = pic.src;
    img.alt = pic.alt;
    title.textContent = fig.dataset.title || '';
    meta.textContent = [fig.dataset.medium, fig.dataset.size].filter(Boolean).join(' · ');
    opener = fig;
    box.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => box.classList.add('open'));
    closeBtn.focus();
  }
  function close() {
    box.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => { box.hidden = true; }, 300);
    if (opener) opener.focus();
  }

  document.querySelectorAll('figure.art-piece').forEach(fig => {
    fig.addEventListener('click', () => open(fig));
    fig.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(fig); }
    });
  });
  closeBtn.addEventListener('click', close);
  box.addEventListener('click', e => { if (e.target === box) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !box.hidden) close(); });
})();
