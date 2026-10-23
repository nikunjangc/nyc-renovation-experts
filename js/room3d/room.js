// The room built from a 360 photo: floor, walls and ceiling as real geometry,
// with the photo projected onto them from the spot where it was taken. From
// that spot the room looks exactly like the photo; from anywhere else the
// walls and floor stay put (so paint, floors and furniture line up), and only
// things that stick out of the walls (a sofa in the photo) look flat.
//
// Units are feet. The floor is y = 0 and the photo was taken at (0, h, 0).

import * as THREE from 'three';

import {
  SURF_FLOOR, SURF_CEIL, SURF_WALL0, MAX_SURF, floorPoint, sortCorners, squareUp, polygonArea,
  pointInPolygon, nearestWall, wallLengths, surfaceMap,
} from './layout.js';

export {
  SURF_FLOOR, SURF_CEIL, SURF_WALL0, MAX_SURF, floorPoint, sortCorners, squareUp, polygonArea,
  pointInPolygon, nearestWall, wallLengths, surfaceMap,
};

/* ---------- geometry ------------------------------------------------------- */

export function buildRoomGeometry(layout) {
  const { h, H: ceil, corners } = layout;
  const pos = [], surf = [], nor = [];
  const cam = new THREE.Vector3(0, h, 0);
  const push = (p, s, nrm) => { pos.push(p.x, p.y, p.z); surf.push(s); nor.push(nrm.x, nrm.y, nrm.z); };
  const tri = (a, b, c, s) => {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    // face the photo spot (inside the room)
    const toCam = new THREE.Vector3().subVectors(cam, a);
    if (n.dot(toCam) < 0) { const t = b; b = c; c = t; n.negate(); }
    n.normalize();
    push(a, s, n); push(b, s, n); push(c, s, n);
  };
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const a = corners[i], b = corners[(i + 1) % n];
    // split long walls so the projection interpolates well
    const A0 = new THREE.Vector3(a[0], 0, a[1]), B0 = new THREE.Vector3(b[0], 0, b[1]);
    const A1 = new THREE.Vector3(a[0], ceil, a[1]), B1 = new THREE.Vector3(b[0], ceil, b[1]);
    tri(A0, B0, B1, SURF_WALL0 + i);
    tri(A0, B1, A1, SURF_WALL0 + i);
  }
  const contour = corners.map(([x, z]) => new THREE.Vector2(x, z));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const [i, j, k] of faces) {
    const p = (q, y) => new THREE.Vector3(corners[q][0], y, corners[q][1]);
    tri(p(i, 0), p(j, 0), p(k, 0), SURF_FLOOR);
    tri(p(i, ceil), p(j, ceil), p(k, ceil), SURF_CEIL);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aSurf', new THREE.Float32BufferAttribute(surf, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/* ---------- the photo material --------------------------------------------- */

const VERT = /* glsl */`
attribute float aSurf;
varying vec3 vWorld;
varying float vSurf;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vSurf = aSurf;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */`
#define MAX_SURF ${MAX_SURF}
uniform sampler2D tPano;
uniform sampler2D tMask;
uniform sampler2D tFloor;
uniform vec3 uCenter;
uniform vec4 uPaint[MAX_SURF];
uniform vec3 uRef[MAX_SURF];
uniform float uFloorOn;
uniform float uFloorScale;
uniform float uFloorAspect;
uniform float uFloorRot;
uniform vec3 uFloorRef;
uniform vec3 uHighlight;
uniform float uSelSurf;
uniform float uSelGlow;
varying vec3 vWorld;
varying float vSurf;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 d = normalize(vWorld - uCenter);
  float u = atan(d.z, d.x) * 0.15915494309 + 0.5;
  float v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) * 0.31830988618;   // image row from the top
  vec2 uv = vec2(u, v);
  // derivatives that don't jump where the panorama wraps around
  vec2 uvB = vec2(fract(u + 0.5), v);
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  vec2 gxB = dFdx(uvB), gyB = dFdy(uvB);
  if (abs(gxB.x) < abs(gx.x)) gx.x = gxB.x;
  if (abs(gyB.x) < abs(gy.x)) gy.x = gyB.x;
  vec3 photo = textureGrad(tPano, uv, gx, gy).rgb;
  vec4 m = textureGrad(tMask, uv, gx, gy);
  vec3 col = photo;
  int s = int(vSurf + 0.5);
  if (s >= 1) {
    vec4 p = uPaint[s];
    float cov = s == 1 ? m.b : m.r;
    if (p.a > 0.5 && cov > 0.002) {
      vec3 ref = max(uRef[s], vec3(0.004));
      float lr = lum(photo) / max(lum(ref), 0.004);
      vec3 shade = clamp(mix(vec3(lr), photo / ref, 0.25), 0.0, 2.2);
      col = mix(col, p.rgb * shade, cov);
    }
  } else if (uFloorOn > 0.5 && m.g > 0.002) {
    vec2 q = vec2(vWorld.x, vWorld.z / uFloorAspect) / uFloorScale;
    float cr = cos(uFloorRot), sr = sin(uFloorRot);
    q = vec2(cr * q.x - sr * q.y, sr * q.x + cr * q.y);
    vec3 t = texture2D(tFloor, q).rgb;
    float lr = clamp(lum(photo) / max(lum(uFloorRef), 0.004), 0.0, 2.2);
    col = mix(col, t * lr, m.g);
  }
  if (m.a > 0.002) col = mix(col, uHighlight, m.a * 0.55);
  if (uSelGlow > 0.0 && abs(vSurf - uSelSurf) < 0.5) col = mix(col, uHighlight, uSelGlow);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export function makeRoomMaterial(panoTex, maskTex) {
  const paint = Array.from({ length: MAX_SURF }, () => new THREE.Vector4(0, 0, 0, 0));
  const ref = Array.from({ length: MAX_SURF }, () => new THREE.Vector3(0.5, 0.5, 0.5));
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      tPano: { value: panoTex },
      tMask: { value: maskTex },
      tFloor: { value: null },
      uCenter: { value: new THREE.Vector3(0, 5, 0) },
      uPaint: { value: paint },
      uRef: { value: ref },
      uFloorOn: { value: 0 },
      uFloorScale: { value: 3 },
      uFloorAspect: { value: 1 },
      uFloorRot: { value: 0 },
      uFloorRef: { value: new THREE.Vector3(0.3, 0.3, 0.3) },
      uHighlight: { value: new THREE.Color(0x3d8bfd) },
      uSelSurf: { value: -1 },
      uSelGlow: { value: 0 },
    },
    side: THREE.FrontSide,
    toneMapped: false,
  });
  return mat;
}

// Panorama texture: rows from the top (flipY off), sRGB, mipmapped, wraps
// around horizontally.
export function makePanoTexture(source) {
  const t = new THREE.Texture(source);
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export function makeMaskTexture(W, H) {
  const data = new Uint8Array(W * H * 4);
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.flipY = false;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
