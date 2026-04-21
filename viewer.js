// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  panoramaUrl:  'Delta_Amphitheater.jpg',   // swap for your equirectangular image
  depthUrl:     'Delta_Amphitheater_Depth.png',      // grayscale depth map (white = near, black = far)

  // Parallax
  parallaxStrength: 0.012,         // max world-space camera offset (units)
  parallaxDamping:  0.88,         // velocity decay per frame (0=instant, 1=no decay)
  parallaxSmooth:   0.2,         // lerp factor toward target (lower = smoother)
  nearRadius:       0.250,         // sphere radius for near objects (depth=1)
  farRadius:        1.00,         // sphere radius for far objects  (depth=0)

  // Keyboard simulation (desktop testing)
  keyStep: 0.00005,                 // how much each key press nudges velocity
};

// ─── VERTEX SHADER ───────────────────────────────────────────────────────────
const vertexShader = `
  varying vec3 vRayDir;
  void main() {
    // Pass the world-space position of each vertex as the ray direction.
    // The sphere is centered at origin so position == direction.
    vRayDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// ─── FRAGMENT SHADER ─────────────────────────────────────────────────────────
const fragmentShader = `
  uniform sampler2D panorama;
  uniform sampler2D depthMap;
  uniform vec3      parallaxOffset;   // world-space camera position offset
  uniform float     nearRadius;
  uniform float     farRadius;
  uniform float     depthStrength;    // tweak at runtime (default 1.0)

  varying vec3 vRayDir;

  const float PI  = 3.14159265358979;
  const float PI2 = 6.28318530717959;

  // Convert a world-space direction → equirectangular UV
  // Handles poles and the ±180° seam correctly.
  vec2 dirToUV(vec3 dir) {
    dir = normalize(dir);
    float u = atan(dir.z, dir.x) / PI2 + 0.5;
    float v = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;
    return vec2(u, v);
  }

  void main() {
    vec2 baseUV = dirToUV(vRayDir);

    // Sample depth at the base direction (no parallax needed for depth lookup)
    float depth = texture2D(depthMap, baseUV).r * depthStrength;
    depth = pow(depth, 2.0);

    // Place the surface point on a sphere whose radius varies with depth.
    // Near objects (depth≈1) sit on a smaller sphere → parallax more.
    // Far objects (depth≈0) sit on a larger sphere → parallax less.
    float radius = mix(farRadius, nearRadius, depth);
    //radius = pow(radius, 0.5);
    vec3 surfacePoint = vRayDir * radius;

    // Shift the surface point as if the camera moved in the opposite direction.
    vec3 displaced = surfacePoint - parallaxOffset;

    // Re-project back to equirectangular UV for the final colour sample.
    vec2 warpedUV = dirToUV(displaced);

    gl_FragColor = texture2D(panorama, warpedUV);
  }
`;

// ─── STATE ────────────────────────────────────────────────────────────────────
const keys = {};                        // currently held keyboard keys
let parallaxVelocity = new THREE.Vector3();
let parallaxPosition = new THREE.Vector3();
let targetOffset     = new THREE.Vector3();

// Get camera's right and forward vectors in world space
const right   = new THREE.Vector3();
const forward = new THREE.Vector3();
const up      = new THREE.Vector3(0, 1, 0);

// Gyroscope / device orientation state
let deviceAlpha = 0, deviceBeta = 0, deviceGamma = 0;
let hasGyro = false;

// Mouse-drag state (desktop fallback for rotation)
let isDragging = false;
let dragStart  = { x: 0, y: 0 };
let yaw = 0, pitch = 0;               // radians

const screenQuatPortrait  = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const screenQuatLandscape = new THREE.Quaternion(-0.5, -0.5, 0.5, 0.5);

// ─── SCENE SETUP ─────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.01, 10);
let fov = 75;
camera.position.set(0, 0, 0);

// Sphere: coarse mesh — detail comes from the shader, not geometry
const geometry = new THREE.SphereGeometry(1, 128, 64);
// Flip normals so we see the inside
geometry.scale(-1, 1, 1);

// Load textures
const loader = new THREE.TextureLoader();
const panoramaTex = loader.load(CONFIG.panoramaUrl,  onTextureLoaded, undefined, onTextureError);
const depthTex    = loader.load(CONFIG.depthUrl,     null,            undefined, onDepthError);
panoramaTex.minFilter = THREE.LinearFilter;
depthTex.minFilter    = THREE.LinearFilter;

const material = new THREE.ShaderMaterial({
  vertexShader,
  fragmentShader,
  uniforms: {
    panorama:       { value: panoramaTex },
    depthMap:       { value: depthTex    },
    parallaxOffset: { value: new THREE.Vector3() },
    nearRadius:     { value: CONFIG.nearRadius   },
    farRadius:      { value: CONFIG.farRadius    },
    depthStrength:  { value: 1.0                 },
  },
  side: THREE.FrontSide,
});

const sphere = new THREE.Mesh(geometry, material);
scene.add(sphere);

// ─── TEXTURE CALLBACKS ───────────────────────────────────────────────────────
function onTextureLoaded() {
  console.log('[viewer] Panorama loaded OK');
}
function onTextureError() {
  console.warn('[viewer] Could not load panorama.jpg — using placeholder colour');
  material.uniforms.panorama.value = createPlaceholderTexture();
}
function onDepthError() {
  console.warn('[viewer] Could not load depth.jpg — parallax will be flat');
  material.uniforms.depthMap.value = createFlatDepthTexture();
}

function createPlaceholderTexture() {
  const size = 4;
  const data = new Uint8Array(size * size * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i]   = 20 + Math.random() * 30;
    data[i+1] = 20 + Math.random() * 60;
    data[i+2] = 80 + Math.random() * 80;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBFormat);
  t.needsUpdate = true;
  return t;
}
function createFlatDepthTexture() {
  const data = new Uint8Array([128, 128, 128, 128]);
  const t = new THREE.DataTexture(data, 2, 2, THREE.LuminanceFormat);
  t.needsUpdate = true;
  return t;
}

// ─── DEVICE ORIENTATION (GYROSCOPE) ──────────────────────────────────────────
function startGyroscope() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.alpha === null) return;
    hasGyro = true;
    deviceAlpha = e.alpha;   // compass heading 0–360
    deviceBeta  = e.beta;    // front/back tilt -180–180
    deviceGamma = e.gamma;   // left/right tilt -90–90
    document.getElementById('debug-gyro').textContent =
      `gyro: α${deviceAlpha.toFixed(1)} β${deviceBeta.toFixed(1)} γ${deviceGamma.toFixed(1)}`;
  }, true);
}

// iOS 13+ requires explicit permission
function requestMotionPermission() {
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(state => {
        if (state === 'granted') startGyroscope();
      })
      .catch(console.error);
  }
  document.getElementById('permission-btn').style.display = 'none';
}

// Show the permission button only on iOS
if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
  document.getElementById('permission-btn').style.display = 'block';
} else {
  startGyroscope();
}

// ─── DEVICE MOTION (ACCELEROMETER → PARALLAX) ────────────────────────────────
window.addEventListener('devicemotion', (e) => {
  const a = e.accelerationIncludingGravity;
  if (!a) return;

  // We only use lateral (x/y) acceleration for parallax offset.
  // The spring-damper below keeps it bounded and natural-feeling.
  const ax = (a.x || 0) * 0.001;
  const ay = (a.y || 0) * 0.001;

  parallaxVelocity.x += ax;
  parallaxVelocity.y += ay;
}, true);

// ─── KEYBOARD CONTROLS ───────────────────────────────────────────────────────
window.addEventListener('keydown', e => { keys[e.code] = true;  });
window.addEventListener('keyup',   e => { keys[e.code] = false; });

function applyKeyboardInput() {
  const s = CONFIG.keyStep;

  camera.getWorldDirection(forward);
  right.crossVectors(forward, up).normalize();
  // Project impulses onto camera basis
  if (keys['ArrowLeft']  || keys['KeyA']) parallaxVelocity.addScaledVector(right, s);
  if (keys['ArrowRight'] || keys['KeyD']) parallaxVelocity.addScaledVector(right,  -s);
  if (keys['ArrowUp']    || keys['KeyW']) parallaxVelocity.addScaledVector(forward, -s);
  if (keys['ArrowDown']  || keys['KeyS']) parallaxVelocity.addScaledVector(forward, s);
  if (keys['KeyQ']) parallaxVelocity.addScaledVector(up, s);
  if (keys['KeyE']) parallaxVelocity.addScaledVector(up,  -s);

  // Mouse-drag rotation via SHIFT+arrows
  if (keys['ShiftLeft'] || keys['ShiftRight']) {
    if (keys['ArrowLeft'])  yaw   += 0.01;
    if (keys['ArrowRight']) yaw   -= 0.01;
    if (keys['ArrowUp'])    pitch += 0.01;
    if (keys['ArrowDown'])  pitch -= 0.01;
    pitch = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, pitch));
  }
}

// ─── MOUSE DRAG (DESKTOP ROTATION) ───────────────────────────────────────────
renderer.domElement.addEventListener('mousedown', e => {
  isDragging = true;
  dragStart.x = e.clientX;
  dragStart.y = e.clientY;
});
window.addEventListener('mouseup',   () => { isDragging = false; });
window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  yaw   += (e.clientX - dragStart.x) * 0.002;
  pitch += (e.clientY - dragStart.y) * 0.002;
  pitch  = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, pitch));
  dragStart.x = e.clientX;
  dragStart.y = e.clientY;
});

// Touch rotation
let lastTouch = null;
renderer.domElement.addEventListener('touchstart', e => {
  if (e.touches.length === 1) lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
});
renderer.domElement.addEventListener('touchmove', e => {
  if (e.touches.length !== 1 || !lastTouch) return;
  yaw   += (e.touches[0].clientX - lastTouch.x) * 0.002;
  pitch += (e.touches[0].clientY - lastTouch.y) * 0.002;
  pitch  = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, pitch));
  lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  e.preventDefault();
}, { passive: false });

// --- ZOOMING -----------------------

function applyZoom(delta) {
  fov = Math.max(30, Math.min(110, fov + delta));
  camera.fov = fov;
  camera.updateProjectionMatrix();
}

// Scroll wheel
renderer.domElement.addEventListener('wheel', e => {
  applyZoom(e.deltaY * 0.05);
  e.preventDefault();
}, { passive: false });

// Pinch
let lastPinchDist = null;
renderer.domElement.addEventListener('touchstart', e => {
  if (e.touches.length === 2) lastPinchDist = null;
});
renderer.domElement.addEventListener('touchmove', e => {
  if (e.touches.length !== 2) { lastPinchDist = null; return; }
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (lastPinchDist !== null) applyZoom((lastPinchDist - dist) * 0.1);
  lastPinchDist = dist;
  e.preventDefault();
}, { passive: false });

// ─── GYRO → CAMERA QUATERNION ────────────────────────────────────────────────
const _euler = new THREE.Euler();
const _q     = new THREE.Quaternion();

let screenQuat = new THREE.Quaternion();

function updateScreenOrientation() {
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  screenQuat.copy(angle === 90 || angle === -90 ? screenQuatLandscape : screenQuatPortrait);
}

window.addEventListener('orientationchange', updateScreenOrientation);
updateScreenOrientation(); // call once on load

function applyGyroToCamera() {
  if (!hasGyro) {
    // Keyboard/mouse rotation
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    return;
  }
  _euler.set(
    THREE.MathUtils.degToRad(deviceBeta),
    THREE.MathUtils.degToRad(deviceAlpha),
    THREE.MathUtils.degToRad(-deviceGamma),
    'YXZ'
  );
  camera.quaternion.setFromEuler(_euler);
  camera.quaternion.multiply(screenQuat);
}

// ─── PARALLAX SPRING-DAMPER ───────────────────────────────────────────────────
const _maxOffset = CONFIG.parallaxStrength;

function updateParallax() {
  // Decay velocity (spring pull toward zero)
  parallaxVelocity.multiplyScalar(CONFIG.parallaxDamping);

  // Accumulate position
  parallaxPosition.add(parallaxVelocity);

  // Clamp to bounds
  parallaxPosition.clampScalar(-_maxOffset, _maxOffset);
  parallaxPosition.multiplyScalar(0.99);

  // Smooth lerp toward position
  targetOffset.lerp(parallaxPosition, CONFIG.parallaxSmooth);

  // Push to shader
  material.uniforms.parallaxOffset.value.copy(targetOffset);
}

// ─── RENDER LOOP ──────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);

  applyKeyboardInput();
  applyGyroToCamera();
  updateParallax();

  // Debug overlay
  const o = targetOffset;
  document.getElementById('debug-offset').textContent =
    `offset: ${o.x.toFixed(3)}, ${o.y.toFixed(3)}, ${o.z.toFixed(3)}`;

  renderer.render(scene, camera);
}
animate();

// ─── RESIZE ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
