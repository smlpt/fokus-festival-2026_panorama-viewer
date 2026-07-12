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
    // The view direction in your spherical setup
    vec3 viewDir = normalize(vRayDir);
    
    // In POM, we need the direction of the ray relative to the surface.
    // Since it's a sphere, the 'normal' is just the viewDir itself.
    // We use parallaxOffset to simulate the camera moving away from the center.
    vec3 rayDir = normalize(viewDir + (parallaxOffset * depthStrength));

    // Step 1: Calculate how much we shift UV per layer
    // The LearnOpenGL logic uses: deltaUV = (P.xy / P.z) * height_diff
    // For a sphere, we'll approximate this by shifting the ray direction.
    float numStepsFloat = numSteps;
    float deltaDepth = 1.0 / numStepsFloat;
    float currentLayerDepth = 0.0;

    // Initial UV
    vec2 uv = dirToUV(viewDir);
    
    // We'll use a simple linear search as per the basic POM implementation
    // Step through depth layers
    for(float i = 0.0; i < 64.0; i++) {
        if (i >= numSteps) break;

        // Get height from map (1.0 is top/near, 0.0 is bottom/far)
        float sampledHeight = texture2D(depthMap, uv).r;

        float adjustedHeight = pow(sampledHeight, 1.5);

        // Convert the 0-1 heightmap value to an actual radius distance
        // White (1.0) -> nearRadius | Black (0.0) -> farRadius
        float surfaceRadius = mix(farRadius, nearRadius, adjustedHeight);
        
        // We want to find where our ray's current radius matches the surface radius
        // Since we are inside a sphere, we check if our "step" has reached the surface
        // This is an approximation for spherical POM
        if (currentLayerDepth > 0.0 && currentLayerDepth >= surfaceRadius) {
            break;
        }

        // Move to next layer
        currentLayerDepth += deltaDepth;
        
        // Now, use the radii to scale how much the UVs shift per step
        // This ensures that a larger radius range actually results in more parallax
        float depthRange = farRadius - nearRadius;
        vec3 offsetRay = viewDir + (parallaxOffset * depthStrength * currentLayerDepth * depthRange);
        uv = dirToUV(offsetRay);
    }

    // To avoid harsh edges, you could do a linear interpolation between 
    // the last two steps here (Parallax Occlusion Mapping), but let's 
    // get the basic search working first.
    gl_FragColor = texture2D(panorama, uv);
}
