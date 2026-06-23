varying vec3 vRayDir;
void main() {
    // Pass the world-space position of each vertex as the ray direction.
    // The sphere is centered at origin so position == direction.
    vRayDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}