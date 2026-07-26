uniform sampler2D panorama;
uniform sampler2D depthMap;
uniform vec3      parallaxOffset;
uniform float     nearRadius;
uniform float     farRadius;
uniform float     depthStrength;    // scales how strong the offset's effect is
uniform float     depthCurve;       // contrast knob, default 1.0
uniform float     numSteps;

varying vec3 vRayDir;

const float PI  = 3.14159265358979;
const float PI2 = 6.283185307179586;

vec2 dirToUV(vec3 dir) {
    dir = normalize(dir);
    float u = atan(dir.z, dir.x) / PI2 + 0.5;
    float v = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;
    return vec2(u, v);
}

float depthToRadius(float rawSample) {
    float d = pow(rawSample, depthCurve);
    float logNear = log(nearRadius);
    float logFar  = log(farRadius);
    return exp(mix(logFar, logNear, d));
}

vec2 mixUvWrapped(vec2 uvA, vec2 uvB, float w) {
    float dx = uvB.x - uvA.x;
    if (dx > 0.5)  uvB.x -= 1.0;
    if (dx < -0.5) uvB.x += 1.0;

    vec2 result = mix(uvA, uvB, w);
    result.x = fract(result.x);
    return result;
}

void main() {
    vec3 viewDir = normalize(vRayDir);
    vec3 origin  = parallaxOffset * depthStrength;

    const float maxOffsetFraction = 0.25;
    float maxLen = nearRadius * maxOffsetFraction;
    float len = length(origin);
    if (len > maxLen) {
        origin *= maxLen / len * depthStrength;
    }

    float invNear = 1.0 / nearRadius;
    float invFar  = 1.0 / farRadius;

    float t = nearRadius;
    vec3  pos = origin + viewDir * t;
    vec2  uv  = dirToUV(pos);
    float prevT = t;
    vec2  prevUv = uv;
    float prevSurfaceR = depthToRadius(texture2D(depthMap, uv).r);

    for (float i = 1.0; i <= 64.0; i++) {
        if (i > numSteps) break;

        float frac = i / numSteps;
        float invR = mix(invNear, invFar, frac);
        t = 1.0 / invR;

        pos = origin + viewDir * t;
        uv = dirToUV(pos);
        float surfaceR = depthToRadius(texture2D(depthMap, uv).r);

        if (t >= surfaceR) {
            float currDiff = t - surfaceR;
            float prevDiff = prevT - prevSurfaceR;
            float w = currDiff / (currDiff - prevDiff);
            uv = mixUvWrapped(uv, prevUv, w);
            break;
        }

        prevT = t;
        prevUv = uv;
        prevSurfaceR = surfaceR;
    }

    gl_FragColor = texture2D(panorama, uv);
}