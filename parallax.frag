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
    float depth = texture2D(depthMap, baseUV).r;
    depth = pow(depth, 2.0);

    // Place the surface point on a sphere whose radius varies with depth.
    // Near objects (depth≈1) sit on a smaller sphere → parallax more.
    // Far objects (depth≈0) sit on a larger sphere → parallax less.
    float radius = mix(farRadius, nearRadius, depth);
    //radius = pow(radius, 0.5);
    vec3 surfacePoint = vRayDir * radius;

    // Shift the surface point as if the camera moved in the opposite direction.
    vec3 displaced = surfacePoint - parallaxOffset * depthStrength;

    // Re-project back to equirectangular UV for the final colour sample.
    vec2 warpedUV = dirToUV(displaced);

    gl_FragColor = texture2D(panorama, warpedUV);
}