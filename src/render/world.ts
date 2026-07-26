import * as THREE from 'three';
import { DEG, Vec3, clamp, clamp01, lerp, makeRng } from '../core/math.ts';
import type { Heightfield } from '../world/heightfield.ts';
import type { LevelDef, PropFeature } from '../world/level.ts';
import type { GrindSurface } from '../physics/rails.ts';

/**
 * Snow material.
 *
 * Built on the standard PBR material so it keeps real lighting and shadows, with
 * three things injected: slope tinting (steep pitches scour down to blue ice),
 * a groomer corduroy pattern that runs across the fall line, and a view-
 * dependent sparkle so flat light still reads as snow rather than white paper.
 */
export function createSnowMaterial(level: LevelDef): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xf2f7ff,
    roughness: 0.78,
    metalness: 0.0,
    vertexColors: true,
    flatShading: false,
  });

  material.userData.uniforms = {
    uGroomed: { value: level.snow.groomed ? 1 : 0 },
    uHardness: { value: level.snow.hardness },
    uTime: { value: 0 },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWorldPos;
         varying vec3 vWorldNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
         vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
         vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uGroomed;
         uniform float uHardness;
         uniform float uTime;
         varying vec3 vWorldPos;
         varying vec3 vWorldNormal;

         float hash21(vec2 p) {
           p = fract(p * vec2(123.34, 456.21));
           p += dot(p, p + 45.32);
           return fract(p.x * p.y);
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         float slope = 1.0 - clamp(vWorldNormal.y, 0.0, 1.0);

         // Steep, wind-scoured pitches lose their loose snow and go blue.
         vec3 iceTint = vec3(0.74, 0.83, 0.95);
         diffuseColor.rgb = mix(diffuseColor.rgb, iceTint, smoothstep(0.12, 0.55, slope) * (0.35 + uHardness * 0.4));

         // Corduroy: fine ridges left by the groomer, across the fall line.
         float cord = sin(vWorldPos.z * 7.5) * 0.5 + 0.5;
         float cordFade = 1.0 - smoothstep(0.18, 0.5, slope);
         diffuseColor.rgb *= mix(1.0, 0.965 + cord * 0.07, uGroomed * cordFade);

         // Sparkle. Anchored to world position so it sits still in the snow, on
         // a coarse grid and faded with range — a per-fragment version aliases
         // into television static as soon as the camera moves.
         float grain = hash21(floor(vWorldPos.xz * 12.0));
         float sparkleFade = 1.0 - smoothstep(4.0, 22.0, length(vWorldPos - cameraPosition));
         float sparkle = pow(grain, 110.0) * 0.75 * sparkleFade;
         diffuseColor.rgb += sparkle * (0.35 + uHardness * 0.4);

         // Keep snow reading as snow rather than as a tinted surface.
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), 0.12);`,
      );
  };

  return material;
}

/** Builds the visible terrain mesh from the baked heightfield. */
export function buildTerrainMesh(
  field: Heightfield,
  material: THREE.Material,
  triangleBudget = 260_000,
): THREE.Mesh {
  // Pick a render step that keeps the triangle count inside budget while never
  // going finer than the physics grid itself.
  let step = 1;
  for (;;) {
    const nx = Math.floor((field.nx - 1) / step) + 1;
    const nz = Math.floor((field.nz - 1) / step) + 1;
    if ((nx - 1) * (nz - 1) * 2 <= triangleBudget || step > 16) break;
    step++;
  }

  const nx = Math.floor((field.nx - 1) / step) + 1;
  const nz = Math.floor((field.nz - 1) / step) + 1;
  const vertexCount = nx * nz;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  const normal = new Vec3();

  for (let jz = 0; jz < nz; jz++) {
    const iz = Math.min(field.nz - 1, jz * step);
    const wz = field.worldZ(iz);
    for (let jx = 0; jx < nx; jx++) {
      const ix = Math.min(field.nx - 1, jx * step);
      const wx = field.worldX(ix);
      const h = field.heights[iz * field.nx + ix];
      const i = jz * nx + jx;

      positions[i * 3] = wx;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = wz;

      // Analytic normal from the heightfield beats deriving it from the
      // decimated mesh, which would flatten every jump lip.
      field.normalAt(wx, wz, normal);
      normals[i * 3] = normal.x;
      normals[i * 3 + 1] = normal.y;
      normals[i * 3 + 2] = normal.z;

      // Vertex colour carries how skied-out the snow is, so tracked-out areas
      // read grey and untouched powder stays bright.
      const packed = field.hardness[iz * field.nx + ix];
      const shade = 1 - packed * 0.13;
      colors[i * 3] = shade;
      colors[i * 3 + 1] = shade * (1 - packed * 0.02);
      colors[i * 3 + 2] = shade;

      uvs[i * 2] = wx * 0.05;
      uvs[i * 2 + 1] = wz * 0.05;
    }
  }

  const indexCount = (nx - 1) * (nz - 1) * 6;
  const indices = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let k = 0;
  for (let jz = 0; jz < nz - 1; jz++) {
    for (let jx = 0; jx < nx - 1; jx++) {
      const a = jz * nx + jx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'terrain';
  mesh.userData.step = step;
  return mesh;
}

/** Refreshes the vertex colours after the snow has been skied on. */
export function refreshTerrainWear(mesh: THREE.Mesh, field: Heightfield): void {
  const step: number = mesh.userData.step ?? 1;
  const colors = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
  const nx = Math.floor((field.nx - 1) / step) + 1;
  const nz = Math.floor((field.nz - 1) / step) + 1;
  for (let jz = 0; jz < nz; jz++) {
    const iz = Math.min(field.nz - 1, jz * step);
    for (let jx = 0; jx < nx; jx++) {
      const ix = Math.min(field.nx - 1, jx * step);
      const packed = field.hardness[iz * field.nx + ix];
      const shade = 1 - packed * 0.13;
      const i = jz * nx + jx;
      colors.setXYZ(i, shade, shade * (1 - packed * 0.02), shade);
    }
  }
  colors.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Sky and light
// ---------------------------------------------------------------------------

export interface SkyRig {
  mesh: THREE.Mesh;
  sun: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  update(level: LevelDef): void;
}

const WHITE = new THREE.Color(0xffffff);

export function createSky(scene: THREE.Scene, level: LevelDef): SkyRig {
  const uniforms = {
    uTopColor: { value: new THREE.Color(0x2f6bd8) },
    uHorizonColor: { value: new THREE.Color(0xdce9ff) },
    uSunDirection: { value: new THREE.Vector3(0.4, 0.6, 0.7) },
    uSunColor: { value: new THREE.Color(0xfff2d8) },
    uHaze: { value: 0.25 },
  };

  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uTopColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uSunDirection;
      uniform vec3 uSunColor;
      uniform float uHaze;
      varying vec3 vDir;

      void main() {
        vec3 dir = normalize(vDir);
        float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 sky = mix(uHorizonColor, uTopColor, pow(h, 0.75));

        // Sun disc plus a wide forward-scattering glow through the haze.
        float cosAngle = dot(dir, normalize(uSunDirection));
        float disc = smoothstep(0.9985, 0.9995, cosAngle);
        float glow = pow(max(cosAngle, 0.0), 12.0) * 0.5 + pow(max(cosAngle, 0.0), 3.0) * 0.18;
        sky += uSunColor * (disc * 6.0 + glow * (0.5 + uHaze));

        // Flat light: overcast washes everything toward the horizon colour.
        sky = mix(sky, uHorizonColor * 1.02, uHaze * 0.75);
        gl_FragColor = vec4(sky, 1.0);
      }`,
  });

  // Radius stays well inside the camera far plane; the dome is re-centred on
  // the camera every frame, so it reads as infinitely far without ever clipping.
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 20), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  scene.add(mesh);

  const sun = new THREE.DirectionalLight(0xfff4e2, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  const ambient = new THREE.HemisphereLight(0xbcd6ff, 0xdfe9f5, 1.15);
  scene.add(ambient);

  const rig: SkyRig = {
    mesh,
    sun,
    ambient,
    update(next: LevelDef) {
      const w = next.weather;
      // Sun elevation over the day, peaking at solar noon.
      const dayFraction = clamp01((w.timeOfDay - 6) / 12);
      const elevation = Math.sin(dayFraction * Math.PI) * 62 * DEG;
      const azimuth = lerp(-140, -40, dayFraction) * DEG;
      const dir = new THREE.Vector3(
        Math.cos(elevation) * Math.sin(azimuth),
        Math.max(0.04, Math.sin(elevation)),
        Math.cos(elevation) * Math.cos(azimuth),
      ).normalize();
      uniforms.uSunDirection.value.copy(dir);

      // Low sun goes warm and the sky deepens; overcast flattens everything.
      const warmth = 1 - clamp01(Math.sin(elevation) / 0.6);
      const sunColor = new THREE.Color().setHSL(lerp(0.12, 0.07, warmth), lerp(0.25, 0.75, warmth), 0.62);
      uniforms.uSunColor.value.copy(sunColor);
      uniforms.uTopColor.value.setHSL(0.60, lerp(0.75, 0.15, w.cloud), lerp(0.42, 0.72, w.cloud));
      uniforms.uHorizonColor.value.setHSL(0.58, lerp(0.35, 0.06, w.cloud), lerp(0.86, 0.83, w.cloud));
      uniforms.uHaze.value = clamp01(w.cloud * 0.7 + w.fog * 0.5);

      sun.position.copy(dir).multiplyScalar(180);
      sun.intensity = lerp(3.1, 0.55, w.cloud) * lerp(0.35, 1, clamp01(Math.sin(elevation) * 2));
      sun.color.copy(sunColor).lerp(new THREE.Color(0xffffff), 0.45);
      ambient.intensity = lerp(0.9, 1.9, w.cloud);
      // Sky light is bluish but nowhere near as saturated as the zenith itself;
      // using the raw sky colour turns snow into a blue sheet.
      ambient.color.copy(uniforms.uTopColor.value).lerp(WHITE, 0.68);
      ambient.groundColor.set(0xeef3fa);

      const fogColor = uniforms.uHorizonColor.value.clone().lerp(WHITE, 0.35 + w.cloud * 0.35);
      const density = lerp(0.0006, 0.006, clamp01(w.fog * 0.7 + w.cloud * 0.3 + w.snowfall * 0.35));
      scene.fog = new THREE.FogExp2(fogColor.getHex(), density);
    },
  };

  rig.update(level);
  return rig;
}

// ---------------------------------------------------------------------------
// Features and props
// ---------------------------------------------------------------------------

const METAL = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.32, metalness: 0.85 });
const PLASTIC = new THREE.MeshStandardMaterial({ color: 0x2f3a4a, roughness: 0.55, metalness: 0.1 });
const WOOD = new THREE.MeshStandardMaterial({ color: 0x6a5342, roughness: 0.85, metalness: 0 });
const FLAG = new THREE.MeshStandardMaterial({ color: 0xff5a3c, roughness: 0.7, side: THREE.DoubleSide });
const TRUNK = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 });
const NEEDLE = new THREE.MeshStandardMaterial({ color: 0x22402f, roughness: 0.9 });
const SNOWCAP = new THREE.MeshStandardMaterial({ color: 0xf6faff, roughness: 0.85 });
const ROCK = new THREE.MeshStandardMaterial({ color: 0x5c5f66, roughness: 0.95, flatShading: true });

/** Builds meshes for every rail and box in the level. */
export function buildGrindMeshes(surfaces: readonly GrindSurface[]): THREE.Group {
  const group = new THREE.Group();
  group.name = 'grinds';

  for (const surface of surfaces) {
    for (let i = 1; i < surface.points.length; i++) {
      const a = surface.points[i - 1];
      const b = surface.points[i];
      const start = new THREE.Vector3(a.x, a.y, a.z);
      const end = new THREE.Vector3(b.x, b.y, b.z);
      const length = start.distanceTo(end);
      if (length < 0.01) continue;

      const isRail = surface.kind === 'rail';
      const geometry = isRail
        ? new THREE.CylinderGeometry(surface.halfWidth, surface.halfWidth, length, 12)
        : new THREE.BoxGeometry(surface.halfWidth * 2, 0.12, length);
      const mesh = new THREE.Mesh(geometry, isRail ? METAL : PLASTIC);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      const mid = start.clone().add(end).multiplyScalar(0.5);
      mesh.position.copy(mid);
      const dir = end.clone().sub(start).normalize();
      if (isRail) {
        // Cylinders are built along +Y, so stand it up along the rail.
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      } else {
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        mesh.position.y += 0.06;
      }
      group.add(mesh);

      // Legs, so rails do not float.
      const legCount = Math.max(2, Math.round(length / 2.6));
      for (let s = 0; s <= legCount; s++) {
        const t = s / legCount;
        const at = start.clone().lerp(end, t);
        const drop = Math.max(0.1, at.y - (at.y - 1.4));
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, drop, 6), METAL);
        leg.position.set(at.x, at.y - drop / 2, at.z);
        leg.castShadow = true;
        group.add(leg);
      }
    }
  }
  return group;
}

/** Trees, rocks and course markers. */
export function buildProps(level: LevelDef, field: Heightfield): THREE.Group {
  const group = new THREE.Group();
  group.name = 'props';
  const rng = makeRng(level.seed ^ 0x5eed);

  const placed: PropFeature[] = level.features.filter((f): f is PropFeature => f.kind === 'prop');

  // Scatter trees down the sides so the run reads as a corridor.
  const auto: Array<{ x: number; z: number; scale: number; kind: 'pine' | 'rock' }> = [];
  const half = level.terrain.width / 2;
  const count = Math.floor(level.terrain.length / 6);
  for (let i = 0; i < count; i++) {
    const z = rng() * level.terrain.length;
    const side = rng() < 0.5 ? -1 : 1;
    // Bias toward the edges, leaving the middle of the run clear.
    const t = 0.62 + rng() * 0.38;
    const x = side * half * t;
    auto.push({ x, z, scale: 0.7 + rng() * 0.9, kind: rng() < 0.86 ? 'pine' : 'rock' });
  }

  for (const tree of auto) {
    const y = field.heightAt(tree.x, tree.z);
    group.add(tree.kind === 'pine' ? makePine(tree.x, y, tree.z, tree.scale, rng) : makeRock(tree.x, y, tree.z, tree.scale, rng));
  }

  for (const prop of placed) {
    const y = field.heightAt(prop.x, prop.z);
    group.add(makeProp(prop, y, rng));
  }

  for (const gate of level.features) {
    if (gate.kind !== 'gate') continue;
    const y = field.heightAt(gate.x, gate.z);
    group.add(makeGate(gate.x, y, gate.z, gate.width, gate.heading));
  }

  return group;
}

function makePine(x: number, y: number, z: number, scale: number, rng: () => number): THREE.Object3D {
  const g = new THREE.Group();
  const height = 4.5 * scale;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * scale, 0.14 * scale, height * 0.35, 6), TRUNK);
  trunk.position.y = height * 0.175;
  g.add(trunk);

  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    const r = (1.35 - t * 0.75) * scale;
    const h = (2.0 - t * 0.5) * scale;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 8), i === 0 ? NEEDLE : NEEDLE);
    cone.position.y = height * 0.3 + t * height * 0.42 + h * 0.35;
    cone.castShadow = true;
    g.add(cone);
    // Snow loading on the branches.
    const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.82, h * 0.42, 8), SNOWCAP);
    cap.position.y = cone.position.y + h * 0.3;
    g.add(cap);
  }
  g.position.set(x, y, z);
  g.rotation.y = rng() * Math.PI * 2;
  return g;
}

function makeRock(x: number, y: number, z: number, scale: number, rng: () => number): THREE.Object3D {
  const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8 * scale, 0), ROCK);
  rock.position.set(x, y + 0.15 * scale, z);
  rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
  rock.scale.set(1, 0.62 + rng() * 0.3, 1);
  rock.castShadow = true;
  rock.receiveShadow = true;
  return rock;
}

function makeProp(prop: PropFeature, y: number, rng: () => number): THREE.Object3D {
  switch (prop.prop) {
    case 'rock':
      return makeRock(prop.x, y, prop.z, prop.scale, rng);
    case 'flag': {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), METAL);
      pole.position.y = 1.1;
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5), FLAG);
      cloth.position.set(0.35, 1.85, 0);
      g.add(pole, cloth);
      g.position.set(prop.x, y, prop.z);
      return g;
    }
    case 'liftTower': {
      const g = new THREE.Group();
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.34, 11, 8), METAL);
      tower.position.y = 5.5;
      tower.castShadow = true;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.22, 0.22), METAL);
      arm.position.y = 10.6;
      g.add(tower, arm);
      g.position.set(prop.x, y, prop.z);
      g.scale.setScalar(prop.scale);
      return g;
    }
    case 'cabin': {
      const g = new THREE.Group();
      const walls = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 4), WOOD);
      walls.position.y = 1.5;
      walls.castShadow = true;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.1, 1.8, 4), SNOWCAP);
      roof.position.y = 3.8;
      roof.rotation.y = Math.PI / 4;
      g.add(walls, roof);
      g.position.set(prop.x, y, prop.z);
      g.rotation.y = prop.heading * DEG;
      g.scale.setScalar(prop.scale);
      return g;
    }
    case 'tent': {
      const tent = new THREE.Mesh(new THREE.ConeGeometry(1.8, 2.4, 6), FLAG);
      tent.position.set(prop.x, y + 1.2, prop.z);
      tent.castShadow = true;
      tent.scale.setScalar(prop.scale);
      return tent;
    }
    case 'sign': {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2, 6), WOOD);
      pole.position.y = 1;
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.7, 0.06), FLAG);
      board.position.y = 1.9;
      g.add(pole, board);
      g.position.set(prop.x, y, prop.z);
      g.rotation.y = prop.heading * DEG;
      return g;
    }
    case 'tree':
    case 'pine':
    default:
      return makePine(prop.x, y, prop.z, prop.scale, rng);
  }
}

function makeGate(x: number, y: number, z: number, width: number, heading: number): THREE.Object3D {
  const g = new THREE.Group();
  const h = heading * DEG;
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), FLAG);
    pole.position.set(Math.cos(h) * side * (width / 2), 1.2, -Math.sin(h) * side * (width / 2));
    g.add(pole);
  }
  g.position.set(x, y, z);
  return g;
}

/**
 * Falling snow. A single points cloud that follows the camera and wraps around
 * it, so a small buffer covers an unbounded world.
 */
export class Snowfall {
  readonly points: THREE.Points;
  private velocities: Float32Array;
  private readonly count: number;
  private readonly box = 90;

  constructor(level: LevelDef) {
    this.count = Math.floor(lerp(300, 6000, clamp01(level.weather.snowfall)));
    const positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    const rng = makeRng(level.seed ^ 0xfa11);
    for (let i = 0; i < this.count; i++) {
      positions[i * 3] = (rng() - 0.5) * this.box;
      positions[i * 3 + 1] = (rng() - 0.5) * this.box;
      positions[i * 3 + 2] = (rng() - 0.5) * this.box;
      this.velocities[i * 3] = (rng() - 0.5) * 0.6;
      this.velocities[i * 3 + 1] = -1.1 - rng() * 1.4;
      this.velocities[i * 3 + 2] = (rng() - 0.5) * 0.6;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.09,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = this.count > 0 && level.weather.snowfall > 0.01;
  }

  update(dt: number, cameraPos: THREE.Vector3, wind: THREE.Vector3): void {
    if (!this.points.visible) return;
    const attr = this.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const half = this.box / 2;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      arr[o] += (this.velocities[o] + wind.x) * dt;
      arr[o + 1] += this.velocities[o + 1] * dt;
      arr[o + 2] += (this.velocities[o + 2] + wind.z) * dt;

      // Wrap relative to the camera so the field is effectively infinite.
      for (let axis = 0; axis < 3; axis++) {
        const rel = arr[o + axis];
        if (rel > half) arr[o + axis] = rel - this.box;
        else if (rel < -half) arr[o + axis] = rel + this.box;
      }
    }
    attr.needsUpdate = true;
    this.points.position.copy(cameraPos);
  }
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat && !SHARED_MATERIALS.has(mat)) mat.dispose();
  });
  root.parent?.remove(root);
}

const SHARED_MATERIALS = new Set<THREE.Material>([METAL, PLASTIC, WOOD, FLAG, TRUNK, NEEDLE, SNOWCAP, ROCK]);

export function clampLevelCamera(field: Heightfield, pos: THREE.Vector3, minAbove = 1.2): void {
  const ground = field.heightAt(pos.x, pos.z);
  if (pos.y < ground + minAbove) pos.y = ground + minAbove;
  pos.x = clamp(pos.x, field.minX - 40, field.maxX + 40);
  pos.z = clamp(pos.z, field.minZ - 40, field.maxZ + 40);
}
