// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  panoramaUrl:  'Delta_Amphitheater.jpg',   // swap for your equirectangular image
  depthUrl:     'Delta_Amphitheater_Depth.png',      // grayscale depth map (white = near, black = far)

  // Parallax
  parallaxStrength: 0.5,         // max world-space camera offset (units)
  parallaxDamping:  0.9,         // velocity decay per frame (0=instant, 1=no decay)
  gyroSmoothing:    0.2,         // lerp factor toward target (lower = smoother)
  nearRadius:       0.20,         // sphere radius for near objects (depth=1)
  farRadius:        1.0,         // sphere radius for far objects  (depth=0)

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
//let targetOffset     = new THREE.Vector3();

const isMobile = /Mobi|Android/i.test(navigator.userAgent);

// Get camera's right and forward vectors in world space
const right   = new THREE.Vector3();
const forward = new THREE.Vector3();
const up      = new THREE.Vector3(0, 1, 0);

// Gyroscope / device orientation state
let prevDeviceAlpha = null; // Store previous alpha to calculate delta
let hasGyro = false;

const _targetGyroQ  = new THREE.Quaternion(); // Temporary for delta calculation
const _currentGyroQ = new THREE.Quaternion(); // The accumulated camera rotation from gyro

// We'll store the touch offset separately so it doesn't get mixed into the gyro accumulation incorrectly
let _touchOffsetQ = new THREE.Quaternion().identity(); 

const PIVOT_RADIUS = 0.005; // metres, distance from phone to head pivot

// Mouse-drag state (desktop fallback for rotation)
let isDragging = false;
let dragStart  = { x: 0, y: 0 };
let yaw = 0, pitch = 0;               // radians

// Portrait: device Y = screen Y, no correction needed beyond the base tilt
const screenQuatPortrait       = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), -Math.PI/2);
const screenQuatLandscapeLeft  = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), -Math.PI/2).premultiply(screenQuatPortrait);
const screenQuatLandscapeRight = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),  Math.PI/2).premultiply(screenQuatPortrait);

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
    depthStrength:  { value: CONFIG.parallaxStrength},
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

const _deltaQ  = new THREE.Quaternion();
const _rawQ = new THREE.Quaternion();
const _axis    = new THREE.Vector3();
const _smoothQ = new THREE.Quaternion(); // smoothed camera quaternion
const SMOOTH   = 0.6; // 0=no smoothing, 1=frozen — tune this

function startGyroscope() {
  window.addEventListener('deviceorientation', (e) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    hasGyro = true;
    // 1. Convert raw angles to a Quaternion
    const _tempEuler = new THREE.Euler(
      THREE.MathUtils.degToRad(e.beta),
      THREE.MathUtils.degToRad(e.alpha),
      THREE.MathUtils.degToRad(-e.gamma),
      'YXZ'
    );
    
    // 2. Apply screen orientation correction to get the "target" quaternion
    updateScreenOrientation();
    _targetGyroQ.setFromEuler(_tempEuler).multiply(screenQuat);
    // 3. Smoothly interpolate towards it
    _currentGyroQ.slerp(_targetGyroQ, CONFIG.gyroSmoothing);

    // document.getElementById('debug-gyro').textContent =
    //   `gyro: α${deviceAlpha.toFixed(1)} β${deviceBeta.toFixed(1)} γ${deviceGamma.toFixed(1)}`;
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
  if (e.touches.length === 1) {
    lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  } else {
    lastTouch = null; // clear on multi-touch to prevent jump
    if (e.touches.length === 2) lastPinchDist = null;
  }
});
renderer.domElement.addEventListener('touchmove', e => {
  if (e.touches.length !== 1 || !lastTouch) return;
  const dx = (e.touches[0].clientX - lastTouch.x) * 0.002;
  const dy = (e.touches[0].clientY - lastTouch.y) * 0.002;
  lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };

  // Apply touch delta as a rotation on top of whatever the gyro has set
  const qYaw   = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), dx);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), dy);
  _touchOffsetQ.premultiply(qYaw).multiply(qPitch);

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
  if (lastPinchDist !== null) applyZoom((lastPinchDist - dist) * 0.2);
  lastPinchDist = dist;
  e.preventDefault();
}, { passive: false });

// ─── GYRO → CAMERA QUATERNION ────────────────────────────────────────────────
const _euler = new THREE.Euler();

let screenQuat = new THREE.Quaternion();

function updateScreenOrientation() {
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  if (angle === 90) screenQuat.copy(screenQuatLandscapeLeft);
  else if (angle === -90 || angle === 270) screenQuat.copy(screenQuatLandscapeRight);
  else screenQuat.copy(screenQuatPortrait);
}

window.addEventListener('orientationchange', updateScreenOrientation);
updateScreenOrientation(); // call once on load

camera.rotation.order = 'YXZ';

function applyGyroToCamera() {
  if (hasGyro) {
    // Combine the accumulated gyro rotation with the touch offset
    const finalQ = _currentGyroQ.clone().multiply(_touchOffsetQ);

    camera.quaternion.copy(finalQ);
    return;
  }
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
}

// ─── PARALLAX SPRING-DAMPER ───────────────────────────────────────────────────
const _maxOffset = CONFIG.parallaxStrength;

function updateParallax() {
  // // Extract right and up from current camera orientation
  camera.getWorldDirection(forward);

  const targetPosition = new THREE.Vector3();
  targetPosition.addScaledVector(forward, -0.07);

  material.uniforms.parallaxOffset.value.copy(targetPosition);
}

// ─── RENDER LOOP ──────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);

  applyGyroToCamera();
  updateParallax();

  // Debug overlay
  // const o = targetOffset;
  // document.getElementById('debug-offset').textContent =
  //   `offset: ${o.x.toFixed(3)}, ${o.y.toFixed(3)}, ${o.z.toFixed(3)}`;

  renderer.render(scene, camera);
}
animate();

// ─── RESIZE ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});


// UTILS

function lerp(a, b, t) {
	return a * (1 - t) + b * t;
}