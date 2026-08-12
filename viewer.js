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
let fov = 110;
let screenQuat = new THREE.Quaternion();
let lastTouch = null;
let lastPinchDist = null;


let currentVersionIndex = 0;
let versions = []; // Array of folder names for the current location
let currentLocation = "";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
    // panoramaUrl: 'Delta_Amphitheater.jpg',
    // depthUrl: 'Delta_Amphitheater_Depth.png',

    // Parallax
    parallaxStrength: 0.75,         // max world-space camera offset (units)
    gyroSmoothing: 0.3,         // lerp factor toward target (lower = smoother)
    gyroRollSmoothing: 0.03,
    nearRadius: 0.001,         // sphere radius for near objects (depth=1)
    farRadius: 10.0,         // sphere radius for far objects  (depth=0)

    keyStep: 0.00005,        // how much each key press nudges velocity
};

async function resolveLocation() {
    currentLocation = window.location.hash.substring(1);
    if (!currentLocation) {
        console.log("No location specified in URL.");
        return;
    }
    try {
        const response = await fetch(`resources/${currentLocation}/manifest.json`);
        if (!response.ok) throw new Error("Manifest not found");
        const data = await response.json();
        versions = data.versions;
    } catch (e) {
        console.error("Could not load manifest for location:", currentLocation);
        document.body.innerHTML = "<h1>Error loading location views.</h1>";
    }
}


// ─── STATE ────────────────────────────────────────────────────────────────────
const keys = {};                        // currently held keyboard keys

const isMobile = /Mobi|Android/i.test(navigator.userAgent);

// Get camera's right and forward vectors in world space
const right = new THREE.Vector3();
const forward = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

// Gyroscope / device orientation state
let hasGyro = false;

const _targetGyroQ = new THREE.Quaternion(); // Temporary for delta calculation
const _currentGyroQ = new THREE.Quaternion(); // The accumulated camera rotation from gyro

// Stuff needed for isolating the twist component to dampen it more
const ROLL_AXIS = new THREE.Vector3(0, 0, 1);
const _targetSwingQ = new THREE.Quaternion();
const _targetTwistQ = new THREE.Quaternion();
const _currentSwingQ = new THREE.Quaternion();
const _currentTwistQ = new THREE.Quaternion();

let touchYaw = 0;
let touchPitch = 0;
const _touchOffsetQ = new THREE.Quaternion();
const _touchEuler = new THREE.Euler(0, 0, 0, 'YXZ');

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

    // 1. Check if we are on a "location" page or just the landing page
    const hash = window.location.hash;
    
    if (!hash) {
        console.log("Landing page detected. Standing by...");
        return; // Exit early. Don't start Three.js, don't load shaders.
    }

    document.body.innerHTML = '';

    await preloadShaders();


    // Initialize renderer
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

    const placeholderTex = new THREE.Texture();
    const placeholderDepth = new THREE.Texture();

    material = new THREE.ShaderMaterial({
        vertexShader: vertexShaderCode,
        fragmentShader: fragmentShaderCode,
        uniforms: {
            panorama: { value: placeholderTex },
            depthMap: { value: placeholderDepth },
            parallaxOffset: { value: new THREE.Vector3() },
            nearRadius: { value: CONFIG.nearRadius },
            farRadius: { value: CONFIG.farRadius },
            depthStrength: { value: CONFIG.parallaxStrength },
            depthCurve: {value: 2.0},
            numSteps: { value: 32 }
        },
        side: THREE.FrontSide,
    });

    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    await resolveLocation(); 
        if (versions.length > 0) {
            currentVersionIndex = Math.floor(Math.random() * versions.length);
            loadPanoramaVersion(versions[currentVersionIndex]);
        }


    setupEventListeners();
    setupCycleButton();

    // Show the permission button only on iOS
    if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        setupPermissionButton();
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
        _currentGyroQ.slerp(_targetGyroQ, CONFIG.gyroSmoothing);
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
    document.getElementById('permission-btn')?.remove();
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
        // const dy = (e.touches[0].clientY - lastTouch.y) * 0.002;
        lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };

        touchYaw += dx;
        // touchPitch += dy;

        // Clamp so vertical pan can't exceed 180° total (±90° from center)
        // const maxPitch = Math.PI / 2 - 0.001;
        // touchPitch = Math.max(-maxPitch, Math.min(maxPitch, touchPitch));

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
    fov = Math.max(30, Math.min(140, fov + delta));
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

    _touchEuler.set(0, touchYaw, 0, 'YXZ');
    _touchOffsetQ.setFromEuler(_touchEuler);

    if (hasGyro) {
        // Combine the accumulated gyro rotation with the touch offset
        const finalQ = _touchOffsetQ.clone().multiply(_currentGyroQ);
        camera.quaternion.copy(finalQ);
        return;
    }
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
}

function updateParallax() {
    camera.getWorldDirection(forward);

    const targetPosition = new THREE.Vector3();
    targetPosition.addScaledVector(forward, 0.1);

    material.uniforms.parallaxOffset.value.copy(targetPosition);
}


window.addEventListener('hashchange', () => {
        // This re-runs everything when the URL hash changes
        console.log("Hash changed to:", window.location.hash);
        location.reload(); 
    });

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


function loadPanoramaVersion(versionFolderName) {
    const basePath = `resources/${currentLocation}/${versionFolderName}/`;
    const imgName = `${versionFolderName}.jpg`;
    const depthName = `${versionFolderName}_depth.jpg`;
    console.log(`Loading: ${basePath}${imgName}`);
    const textureLoader = new THREE.TextureLoader();
    
    // Update the material textures
    const panoramaTex = textureLoader.load(`${basePath}${imgName}`, onTextureLoaded, undefined, onTextureError);
    const depthTex = textureLoader.load(`${basePath}${depthName}`, undefined, undefined, onDepthError);
    panoramaTex.minFilter = THREE.LinearFilter;
    depthTex.minFilter = THREE.LinearFilter;
    panoramaTex.wrapS = THREE.RepeatWrapping;
    depthTex.wrapS = THREE.RepeatWrapping;
    
    material.uniforms.panorama.value = panoramaTex;
    material.uniforms.depthMap.value = depthTex;
}

function setupCycleButton() {
    const btn = document.createElement('button');
    btn.id = 'cycle-btn';
    btn.innerHTML = 'Next View';
    btn.style.cssText = `
        position: absolute; bottom: 20px; right: 20px;
        background: rgba(0,0,0,0.5); color: white; border: 1px solid #fff;
        padding: 10px 15px; border-radius: 5px; cursor: pointer; font-family: monospace;
    `;
    btn.onclick = () => {
        currentVersionIndex = (currentVersionIndex + 1) % versions.length;
        loadPanoramaVersion(versions[currentVersionIndex]);
    };
    document.body.appendChild(btn);
}


function setupPermissionButton() {
    const btn = document.createElement('button');
    btn.id = 'permission-btn';
    btn.innerHTML = 'Enable Motion';
    btn.style.cssText = `
        position: absolute; bottom: 20px; left: 20px;
        background: rgba(0,0,0,0.5); color: white; border: 1px solid #fff;
        padding: 10px 15px; border-radius: 5px; cursor: pointer; font-family: monospace;
    `;
    btn.onclick = requestMotionPermission;
    document.body.appendChild(btn);
}


// UTILS

function lerp(a, b, t) {
    return a * (1 - t) + b * t;
}

function swingTwistDecompose(q, axis, outSwing, outTwist) {
    // Project the quaternion's vector part onto the twist axis
    const dot = q.x * axis.x + q.y * axis.y + q.z * axis.z;
    outTwist.set(axis.x * dot, axis.y * dot, axis.z * dot, q.w);

    const len = outTwist.length();
    if (len < 1e-6) {
        outTwist.set(0, 0, 0, 1); // no roll component at all
    } else {
        outTwist.normalize();
    }
    // swing = q * twist⁻¹  →  reconstruct later as swing * twist
    outSwing.copy(q).multiply(outTwist.clone().invert());
}