let vertexShaderCode = '';
let fragmentShaderCode = '';

async function preloadShaders() {
    try {
        console.log("Trying to fetch shaders...")
        const [vert, frag] = await Promise.all([
            fetch('parallax.vert').then(res => res.text()),
            fetch('parallax.frag').then(res => res.text())
        ]);
        vertexShaderCode = vert;
        fragmentShaderCode = frag;
        console.log("Loaded shader successfully!");
    } catch (err) {
        console.error("Damn, couldn't load the shaders:", err);
    }
}

let renderer;
let scene;
let camera;
let material;
let fov = 90;
let screenQuat = new THREE.Quaternion();
let lastTouch = null;
let lastPinchDist = null;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
    panoramaUrl: 'Delta_Amphitheater.jpg',   // swap for your equirectangular image
    depthUrl: 'Delta_Amphitheater_Depth.png',      // grayscale depth map (white = near, black = far)

    // Parallax
    parallaxStrength: 0.1,         // max world-space camera offset (units)
    gyroSmoothing: 0.2,         // lerp factor toward target (lower = smoother)
    nearRadius: 0.0,         // sphere radius for near objects (depth=1)
    farRadius: 20.0,         // sphere radius for far objects  (depth=0)

    // Keyboard simulation (desktop testing)
    keyStep: 0.00005,                 // how much each key press nudges velocity
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const keys = {};                        // currently held keyboard keys
let parallaxVelocity = new THREE.Vector3();
let parallaxPosition = new THREE.Vector3();
//let targetOffset     = new THREE.Vector3();

const isMobile = /Mobi|Android/i.test(navigator.userAgent);

// Get camera's right and forward vectors in world space
const right = new THREE.Vector3();
const forward = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

// Gyroscope / device orientation state
let prevDeviceAlpha = null; // Store previous alpha to calculate delta
let hasGyro = false;

const _targetGyroQ = new THREE.Quaternion(); // Temporary for delta calculation
const _currentGyroQ = new THREE.Quaternion(); // The accumulated camera rotation from gyro

// We'll store the touch offset separately so it doesn't get mixed into the gyro accumulation incorrectly
let _touchOffsetQ = new THREE.Quaternion().identity();

const PIVOT_RADIUS = 0.005; // metres, distance from phone to head pivot

// Mouse-drag state (desktop fallback for rotation)
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let yaw = 0, pitch = 0;               // radians

// Portrait: device Y = screen Y, no correction needed beyond the base tilt
const screenQuatPortrait = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const screenQuatLandscapeLeft = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2).premultiply(screenQuatPortrait);
const screenQuatLandscapeRight = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2).premultiply(screenQuatPortrait);

// ─── SCENE SETUP ─────────────────────────────────────────────────────────────

async function setupScene() {
    await preloadShaders();

    renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(fov, window.innerWidth / window.innerHeight, 0.01, 10);
    camera.position.set(0, 0, 0);
    camera.rotation.order = 'YXZ';

    const geometry = new THREE.SphereGeometry(1, 128, 64);
    // Flip normals so we see the inside
    geometry.scale(-1, 1, 1);

    // Load textures
    const textureLoader = new THREE.TextureLoader();
    const panoramaTex = textureLoader.load(CONFIG.panoramaUrl, onTextureLoaded, undefined, onTextureError);
    const depthTex = textureLoader.load(CONFIG.depthUrl, null, undefined, onDepthError);

    panoramaTex.minFilter = THREE.LinearFilter;
    depthTex.minFilter = THREE.LinearFilter;

    material = new THREE.ShaderMaterial({
        vertexShader: vertexShaderCode,
        fragmentShader: fragmentShaderCode,
        uniforms: {
            panorama: { value: panoramaTex },
            depthMap: { value: depthTex },
            parallaxOffset: { value: new THREE.Vector3() },
            nearRadius: { value: CONFIG.nearRadius },
            farRadius: { value: CONFIG.farRadius },
            depthStrength: { value: CONFIG.parallaxStrength },
            numSteps: { value: 32 }
        },
        side: THREE.FrontSide,
    });

    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    setupEventListeners();

    // Show the permission button only on iOS
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        document.getElementById('permission-btn').style.display = 'block';
    } else {
        startGyroscope();
    }

    updateScreenOrientation(); // call once on load

    animate();
}



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
        data[i] = 20 + Math.random() * 30;
        data[i + 1] = 20 + Math.random() * 60;
        data[i + 2] = 80 + Math.random() * 80;
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

function setupEventListeners() {

    // ─── MOUSE DRAG (DESKTOP ROTATION) ───────────────────────────────────────────
    renderer.domElement.addEventListener('mousedown', e => {
        isDragging = true;
        dragStart.x = e.clientX;
        dragStart.y = e.clientY;
    });
    window.addEventListener('mouseup', () => { isDragging = false; });
    window.addEventListener('mousemove', e => {
        if (!isDragging) return;
        yaw += (e.clientX - dragStart.x) * 0.002;
        pitch += (e.clientY - dragStart.y) * 0.002;
        pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch));
        dragStart.x = e.clientX;
        dragStart.y = e.clientY;
    });

    // Touch rotation

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
        const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx);
        const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy);
        _touchOffsetQ.multiply(qYaw).multiply(qPitch);

        e.preventDefault();
    }, { passive: false });

    // Scroll wheel
    renderer.domElement.addEventListener('wheel', e => {
        applyZoom(e.deltaY * 0.05);
        e.preventDefault();
    }, { passive: false });

    // Pinch

    renderer.domElement.addEventListener('touchstart', e => {
        if (e.touches.length === 2) lastPinchDist = null;
    });
    renderer.domElement.addEventListener('touchmove', e => {
        if (e.touches.length !== 2) { lastPinchDist = null; return; }
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastPinchDist !== null) applyZoom((lastPinchDist - dist) * 0.2);
        lastPinchDist = dist;
        e.preventDefault();
    }, { passive: false });


    window.addEventListener('orientationchange', updateScreenOrientation);

    // ─── RESIZE ───────────────────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

}

function applyZoom(delta) {
    fov = Math.max(30, Math.min(120, fov + delta));
    camera.fov = fov;
    camera.updateProjectionMatrix();
}


function updateScreenOrientation() {
    const angle = screen.orientation?.angle ?? window.orientation ?? 0;
    if (angle === 90) screenQuat.copy(screenQuatLandscapeLeft);
    else if (angle === -90 || angle === 270) screenQuat.copy(screenQuatLandscapeRight);
    else screenQuat.copy(screenQuatPortrait);
}

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

function updateParallax() {
    // // Extract right and up from current camera orientation
    camera.getWorldDirection(forward);

    const targetPosition = new THREE.Vector3();
    targetPosition.addScaledVector(forward, -0.1);

    material.uniforms.parallaxOffset.value.copy(targetPosition);
}


setupScene();


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


// UTILS

function lerp(a, b, t) {
    return a * (1 - t) + b * t;
}