uniform sampler2D panorama;
uniform sampler2D depthMap;
uniform vec3      parallaxOffset; 
uniform float     nearRadius;
uniform float     farRadius;
uniform float     depthStrength;
uniform float     numSteps;

varying vec3 vRayDir;

const float PI  = 3.14159265358979;
const float PI2 = 6.283159265358979; 

vec2 dirToUV(vec3 dir) {
    dir = normalize(dir);
    float u = atan(dir.z, dir.x) / PI2 + 0.5;
    float v = asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5;
    return vec2(u, v);
}

void main() {
    vec3 viewDir = normalize(vRayDir);
    
    vec3 rayDir = normalize(viewDir + (parallaxOffset * depthStrength));

    float numLayers = numSteps;
    float deltaDepth = 1.0 / numLayers;
    float currentLayerDepth = 0.0;

    vec2 uv = dirToUV(viewDir);

    
    
    for(float i = 0.0; i < 64.0; i++) {
        if (i >= numSteps) break;

        float sampledHeight = texture2D(depthMap, uv).r;

        float adjustedHeight = pow(sampledHeight, 1.5);

        float surfaceRadius = mix(farRadius, nearRadius, adjustedHeight);
        
        if (currentLayerDepth > 0.0 && currentLayerDepth >= surfaceRadius) {
            break;
        }

        currentLayerDepth += deltaDepth;
        
        float depthRange = farRadius - nearRadius;
        vec3 offsetRay = viewDir + (parallaxOffset * depthStrength * currentLayerDepth * depthRange);
        uv = dirToUV(offsetRay);
    }

    gl_FragColor = texture2D(panorama, uv);
}
