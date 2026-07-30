import * as THREE from 'three';
import { DEG, Vec3, clamp, clamp01, fbm2D, lerp, makeRng } from '../core/math.ts';
import type { Heightfield } from '../world/heightfield.ts';
import type { LevelDef, PropKind } from '../world/level.ts';
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
    color: 0xfcfdff,
    roughness: 0.82,
    metalness: 0.0,
    vertexColors: true,
    flatShading: false,
  });

  material.userData.uniforms = {
    uGroomed: { value: level.snow.groomed ? 1 : 0 },
    uHardness: { value: level.snow.hardness },
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5).normalize() },
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
         uniform vec3 uSunDir;
         varying vec3 vWorldPos;
         varying vec3 vWorldNormal;

         float hash21(vec2 p) {
           p = fract(p * vec2(123.34, 456.21));
           p += dot(p, p + 45.32);
           return fract(p.x * p.y);
         }

         float valueNoise(vec2 p) {
           vec2 i = floor(p);
           vec2 f = fract(p);
           f = f * f * (3.0 - 2.0 * f);
           float a = hash21(i);
           float b = hash21(i + vec2(1.0, 0.0));
           float c = hash21(i + vec2(0.0, 1.0));
           float d = hash21(i + vec2(1.0, 1.0));
           return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
         }

         float fbm(vec2 p) {
           float v = 0.0;
           float amp = 0.5;
           for (int i = 0; i < 4; i++) {
             v += valueNoise(p) * amp;
             p *= 2.03;
             amp *= 0.5;
           }
           return v;
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         vec3 wn = normalize(vWorldNormal);
         float slope = 1.0 - clamp(wn.y, 0.0, 1.0);

         // Steep, wind-scoured pitches lose their loose snow and go blue.
         vec3 iceTint = vec3(0.82, 0.88, 0.97);
         diffuseColor.rgb = mix(diffuseColor.rgb, iceTint, smoothstep(0.16, 0.62, slope) * (0.28 + uHardness * 0.3));

         // Rock. Snow does not hold past about fifty degrees, so anything
         // steeper than that is stone — which on this terrain means cliff
         // bands, the cut faces of an urban ledge, and the skirt falling away
         // to the valley. A slope you can ski never reaches it.
         float rockPatch = fbm(vWorldPos.xz * 0.055);
         float rockMask = smoothstep(0.52, 0.80, slope + rockPatch * 0.22 - 0.11);
         vec3 rock = vec3(0.27, 0.27, 0.30) * (0.72 + rockPatch * 0.6);
         diffuseColor.rgb = mix(diffuseColor.rgb, rock, rockMask * 0.92);

         // Wind texture. Sastrugi run across the prevailing wind and are what
         // stops an open face reading as a bedsheet; they fade out where the
         // groomer has been.
         float sastrugi = fbm(vWorldPos.xz * vec2(0.42, 0.11) + 3.7);
         float exposed = (1.0 - uGroomed) * (1.0 - rockMask);
         diffuseColor.rgb *= mix(1.0, 0.945 + sastrugi * 0.11, exposed * (0.35 + uHardness * 0.5));

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

         // Blue shade.
         //
         // The single most recognisable thing about snow is that its shadows
         // are blue: a face turned away from the sun is lit only by the sky,
         // and the sky is blue. PBR alone gives grey shade here, which is why
         // untinted snow looks like paper. Biasing the albedo by how much the
         // surface faces the sun puts that back.
         float sunFacing = clamp(dot(wn, uSunDir), 0.0, 1.0);
         vec3 shadeTint = vec3(0.70, 0.79, 0.96);
         float shaded = 1.0 - smoothstep(0.0, 0.42, sunFacing);
         diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * shadeTint, shaded * (1.0 - rockMask * 0.6));

         // Keep snow reading as snow rather than as a tinted surface — but not
         // over rock, which is supposed to be dark.
         diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), 0.2 * (1.0 - rockMask));`,
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
  /** Unit vector from the ground toward the sun. */
  direction: THREE.Vector3;
  update(level: LevelDef): void;
  /** Frees the backdrop texture. */
  dispose(): void;
}

const WHITE = new THREE.Color(0xffffff);

/**
 * Haze at which the horizon is fully washed out.
 *
 * Above this the horizon colour is the pale one the shader has always used;
 * below it, it closes on the zenith colour, and at zero the sky is one flat
 * blue. 0.6 is roughly "properly overcast" — cloud 0.7, or cloud 0.5 with a
 * third of a fog.
 */
const HAZE_FULL_WASH = 0.6;

export function createSky(scene: THREE.Scene, level: LevelDef): SkyRig {
  const uniforms = {
    uTopColor: { value: new THREE.Color(0x2f6bd8) },
    uHorizonColor: { value: new THREE.Color(0xdce9ff) },
    uSunDirection: { value: new THREE.Vector3(0.4, 0.6, 0.7) },
    uSunColor: { value: new THREE.Color(0xfff2d8) },
    uHaze: { value: 0.25 },
    uBackdrop: { value: null as THREE.Texture | null },
    uBackdropMix: { value: 0 },
    uBackdropRotation: { value: 0 },
    uBackdropHorizon: { value: 0.5 },
    uBackdropScale: { value: 1 },
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
      uniform sampler2D uBackdrop;
      uniform float uBackdropMix;
      uniform float uBackdropRotation;
      uniform float uBackdropHorizon;
      uniform float uBackdropScale;
      varying vec3 vDir;

      void main() {
        vec3 dir = normalize(vDir);

        // Horizon colour at the horizon, zenith colour at the zenith.
        //
        // The old curve was pow(dir.y*0.5+0.5, 0.75), which is 60% of the way
        // to the zenith colour *at* the horizon: the two endpoint colours never
        // appeared where they were named, and the ramp did not finish until
        // straight up. This one starts and ends where it says, with the change
        // packed into the low part of the sky, which is where real atmosphere
        // puts it.
        //
        // How *visible* the ramp is does not live here — that is the distance
        // between the two colours, and on a clear day uHorizonColor is now
        // nearly uTopColor, so this evaluates to a flat sky no matter what
        // shape it is. Weather opens the two apart and the wash appears.
        float k = pow(clamp(dir.y, 0.0, 1.0), 0.55);
        vec3 sky = mix(uHorizonColor, uTopColor, k);

        // Sun disc plus a wide forward-scattering glow through the haze.
        float cosAngle = dot(dir, normalize(uSunDirection));
        float disc = smoothstep(0.9985, 0.9995, cosAngle);
        float glow = pow(max(cosAngle, 0.0), 12.0) * 0.5 + pow(max(cosAngle, 0.0), 3.0) * 0.18;
        sky += uSunColor * (disc * 6.0 + glow * (0.5 + uHaze));

        // Flat light: overcast washes everything toward the horizon colour.
        sky = mix(sky, uHorizonColor * 1.02, uHaze * 0.75);

        // Backdrop picture, wrapped round the horizon as a cylinder.
        //
        // A photograph is not a full sphere, so it is only trusted near eye
        // level: full strength at and below the horizon, gone by about forty
        // degrees up. Stretching one across the zenith instead is what makes a
        // custom sky look like a smeared thumb-print, and the painted gradient
        // above it is better than anything the stretch would produce.
        if (uBackdropMix > 0.001) {
          float u = fract(atan(dir.z, dir.x) / 6.2831853 + 0.5 + uBackdropRotation);
          // three.js uploads textures flipped, so v = 1 is the top of the
          // picture, while the horizon setting is authored from the top edge.
          // Hence the inversion; looking up walks v upward, not down.
          float v = clamp((1.0 - uBackdropHorizon) + dir.y * 0.85 * uBackdropScale, 0.0, 1.0);
          vec3 picture = texture2D(uBackdrop, vec2(u, v)).rgb;
          float band = smoothstep(0.68, 0.02, dir.y);
          // Keep the sun's own glow on top, so the light still agrees with the
          // shadows the terrain is casting.
          sky = mix(sky, picture, uBackdropMix * band);
          sky += uSunColor * disc * 4.0 * uBackdropMix * band;
        }

        gl_FragColor = vec4(sky, 1.0);
      }`,
  });

  // Radius stays well inside the camera far plane; the dome is re-centred on
  // the camera every frame, so it reads as infinitely far without ever clipping.
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2600, 32, 20), material);
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

  // The loaded backdrop, keyed by the image it came from so a level that keeps
  // the same picture across an edit does not re-decode it every frame.
  let backdropKey = '';
  let backdropTexture: THREE.Texture | null = null;

  let current: LevelDef['backdrop'] = null;

  const applyPlacement = () => {
    if (!current || !uniforms.uBackdrop.value) {
      uniforms.uBackdropMix.value = 0;
      return;
    }
    uniforms.uBackdropMix.value = current.opacity;
    uniforms.uBackdropRotation.value = current.rotation / 360;
    uniforms.uBackdropHorizon.value = current.horizon;
    uniforms.uBackdropScale.value = current.scale;
  };

  const setBackdrop = (backdrop: LevelDef['backdrop']) => {
    current = backdrop;
    const key = backdrop?.image ?? '';
    if (key !== backdropKey) {
      backdropKey = key;
      backdropTexture?.dispose();
      backdropTexture = null;
      uniforms.uBackdrop.value = null;
      uniforms.uBackdropMix.value = 0;
      if (key) {
        const texture = new THREE.TextureLoader().load(key, () => {
          // Only switch it on once the pixels are actually there, or the first
          // frames sample an empty texture and the sky flashes black.
          //
          // The load lands several frames after the level did, and update()
          // only runs on a level or weather change — so the placement has to
          // be re-applied here as well, or the picture decodes and is never
          // switched on.
          uniforms.uBackdrop.value = texture;
          applyPlacement();
        });
        texture.colorSpace = THREE.SRGBColorSpace;
        // Wraps horizontally because it rings the horizon; clamped vertically
        // because the top and bottom of a photograph are not periodic.
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        backdropTexture = texture;
      }
    }
    applyPlacement();
  };

  const rig: SkyRig = {
    mesh,
    sun,
    ambient,
    direction: new THREE.Vector3(0.4, 0.7, 0.5).normalize(),
    dispose() {
      backdropTexture?.dispose();
      backdropTexture = null;
      backdropKey = '';
    },
    update(next: LevelDef) {
      const w = next.weather;
      setBackdrop(next.backdrop);
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
      rig.direction.copy(dir);

      // Low sun goes warm and the sky deepens; overcast flattens everything.
      const warmth = 1 - clamp01(Math.sin(elevation) / 0.6);
      const sunColor = new THREE.Color().setHSL(lerp(0.12, 0.07, warmth), lerp(0.25, 0.75, warmth), 0.62);
      uniforms.uSunColor.value.copy(sunColor);
      const topSat = lerp(0.75, 0.15, w.cloud);
      const topLum = lerp(0.42, 0.72, w.cloud);
      uniforms.uTopColor.value.setHSL(0.6, topSat, topLum);

      // The horizon colour is the whole horizon-haze control.
      //
      // It used to be a fixed near-white — saturation 0.35, luminance 0.86 —
      // against a zenith at 0.75 and 0.42, on every level, in every weather.
      //
      // The measurement is worth stating precisely, because the obvious guess
      // about it is wrong. Sampling a 1080p frame, the colour distance between
      // the sky just above the skyline and the sky at the top of the frame was
      // only 17-21 of 255: the *gradient* inside the visible sky was never
      // steep. What was wrong was where the whole thing sat. Because the ramp
      // is anchored at that near-white and the visible sky is the bottom
      // fraction of it, every pixel of sky was dragged toward the pale end —
      // measured at rgb(180,205,234) above the skyline, a blue-minus-red of 54.
      // Not a wash climbing out of the horizon so much as a sky that had been
      // mixed with fog before it was ever drawn.
      //
      // So the pale colour is now something weather buys. At zero haze the
      // horizon is the zenith, opened a little — real clear sky does lighten
      // and desaturate slightly toward the horizon, and killing that outright
      // looks like a painted wall rather than a sky. Same frame afterwards:
      // rgb(145,197,233), blue-minus-red 88, two thirds more separation, with
      // the near-skyline-to-top distance down to 15. Flat, and blue.
      //
      // The skyline itself was already a hard edge and stays one: the terrain
      // silhouette measures a single pixel plus its antialiasing in both. What
      // changed is that there is now something for it to be an edge *between*.
      // By HAZE_FULL_WASH the horizon is back to the old near-white, so
      // overcast, snow and dusk are unchanged.
      const haze = clamp01(w.cloud * 0.7 + w.fog * 0.5);
      uniforms.uHaze.value = haze;
      const wash = clamp01(haze / HAZE_FULL_WASH);
      uniforms.uHorizonColor.value.setHSL(
        0.58,
        lerp(topSat * 0.82, lerp(0.35, 0.06, w.cloud), wash),
        lerp(Math.min(0.95, topLum + 0.11), lerp(0.86, 0.83, w.cloud), wash),
      );

      sun.position.copy(dir).multiplyScalar(180);
      sun.intensity = lerp(3.1, 0.55, w.cloud) * lerp(0.35, 1, clamp01(Math.sin(elevation) * 2));
      sun.color.copy(sunColor).lerp(new THREE.Color(0xffffff), 0.45);
      ambient.intensity = lerp(0.9, 1.9, w.cloud);
      // Sky light is bluish but nowhere near as saturated as the zenith itself;
      // using the raw sky colour turns snow into a blue sheet.
      ambient.color.copy(uniforms.uTopColor.value).lerp(WHITE, 0.68);
      ambient.groundColor.set(0xeef3fa);

      // Aerial perspective, and the only source of it — the range bakes no
      // distance wash of its own, because stacking the two turned every peak
      // white and erased the rock before anyone saw it.
      //
      // The clear-day floor used to be 0.00035, which is a 54% wash at two
      // kilometres. Real visibility on a bluebird day is tens of kilometres,
      // and the range lives between 1.3 and 3.9 km out, so that density was
      // dissolving the entire skyline into the sky. It also bought nothing
      // nearby: at two hundred metres it contributes under one percent either
      // way. Overcast and snowfall still stack it up to a genuine whiteout.
      const fogColor = uniforms.uHorizonColor.value.clone().lerp(WHITE, 0.35 + w.cloud * 0.35);
      //
      // The ramp is exponential, not linear. Linearly interpolating to the
      // whiteout value put a level with a mild 0.2 fog and a little snow at
      // 0.001 — which is 98% opacity two kilometres out, enough to dissolve
      // the entire mountain range into flat white. Painting the range bright
      // green and still seeing a white skyline is what finally showed it.
      // Visibility is a multiplicative quantity, so the control should be too.
      const murk = clamp01(w.fog * 0.75 + w.cloud * 0.16 + w.snowfall * 0.3);
      const density = 0.00016 * Math.pow(22, murk);
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
// Park boxes are poured concrete, the same pale grey as the real thing.
const CONCRETE = new THREE.MeshStandardMaterial({ color: 0xc2c6ca, roughness: 0.92, metalness: 0.02 });
const WOOD = new THREE.MeshStandardMaterial({ color: 0x6a5342, roughness: 0.85, metalness: 0 });
const FLAG = new THREE.MeshStandardMaterial({ color: 0xff5a3c, roughness: 0.7, side: THREE.DoubleSide });
const TRUNK = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 });
const NEEDLE = new THREE.MeshStandardMaterial({ color: 0x1b2c22, roughness: 0.95 });
const SNOWCAP = new THREE.MeshStandardMaterial({ color: 0xf6faff, roughness: 0.85 });
const ROCK = new THREE.MeshStandardMaterial({ color: 0x8d9298, roughness: 0.96, flatShading: true });
const PAINT = new THREE.MeshStandardMaterial({ color: 0x0b5cff, roughness: 0.55, metalness: 0.05 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x23272f, roughness: 0.7, metalness: 0.1 });
const GLASS = new THREE.MeshStandardMaterial({ color: 0x1d2b3a, roughness: 0.18, metalness: 0.5 });
const NET = new THREE.MeshStandardMaterial({
  color: 0xff7a2f,
  roughness: 0.9,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.55,
});
const EMBER = new THREE.MeshStandardMaterial({ color: 0xff7a1f, emissive: 0xff5a10, emissiveIntensity: 1.4 });


/**
 * How far below the level's own surface the ground has fallen by the time it
 * reaches a point outside the run. The skirt and the mountain range both use it
 * so the two meet without a seam.
 */
function skirtDrop(field: Heightfield, x: number, z: number): number {
  const cx = (field.minX + field.maxX) / 2;
  const cz = (field.minZ + field.maxZ) / 2;
  const halfX = (field.maxX - field.minX) / 2;
  const halfZ = (field.maxZ - field.minZ) / 2;
  // Distance beyond the level boundary, measured as a rectangle not a circle.
  const outX = Math.max(0, Math.abs(x - cx) - halfX);
  const outZ = Math.max(0, Math.abs(z - cz) - halfZ);
  // Steep, because this is a valley wall and not a plain. At the old 0.16 —
  // about nine degrees — the apron stayed so high for so far that it stood in
  // front of the mountain range and hid it: painting the range bright red
  // showed only a couple of slivers at the frame edges, with the entire white
  // skyline turning out to be this. A real piste has ground falling away below
  // it and peaks rising behind that, which needs the fall to be a fall.
  return Math.hypot(outX, outZ) * 0.38;
}

/**
 * Ground beyond the edge of the run.
 *
 * The playable heightfield is a rectangle, so without this you can see over its
 * edge into empty sky — a hard horizon line with nothing under it. The skirt
 * extends the boundary outward and gently downward until it reaches the foot of
 * the mountain range, and because it is welded to the terrain's own edge heights
 * it can never open a seam.
 */
export function buildTerrainSkirt(field: Heightfield, material: THREE.Material, reach = 700): THREE.Mesh {
  const step = Math.max(1, Math.floor(8 / field.resolution));
  const loop: Array<{ x: number; z: number; y: number }> = [];
  const push = (ix: number, iz: number) => {
    const x = field.worldX(ix);
    const z = field.worldZ(iz);
    loop.push({ x, z, y: field.heights[iz * field.nx + ix] });
  };

  // Walk the boundary once, in order, so the strip closes cleanly.
  for (let ix = 0; ix < field.nx - 1; ix += step) push(ix, 0);
  for (let iz = 0; iz < field.nz - 1; iz += step) push(field.nx - 1, iz);
  for (let ix = field.nx - 1; ix > 0; ix -= step) push(ix, field.nz - 1);
  for (let iz = field.nz - 1; iz > 0; iz -= step) push(0, iz);

  const cx = (field.minX + field.maxX) / 2;
  const cz = (field.minZ + field.maxZ) / 2;
  const bands = [0, reach * 0.25, reach * 0.6, reach];
  const cols = loop.length;
  const rows = bands.length;

  const positions = new Float32Array(cols * rows * 3);
  const colors = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = loop[c];
      let dx = p.x - cx;
      let dz = p.z - cz;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const out = bands[r];
      const x = p.x + dx * out;
      const z = p.z + dz * out;
      const i = r * cols + c;
      positions[i * 3] = x;
      positions[i * 3 + 1] = p.y - skirtDrop(field, x, z);
      positions[i * 3 + 2] = z;
      colors[i * 3] = 1;
      colors[i * 3 + 1] = 1;
      colors[i * 3 + 2] = 1;
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const c2 = (c + 1) % cols;
      const a = r * cols + c;
      const b = r * cols + c2;
      const d = (r + 1) * cols + c;
      const e = (r + 1) * cols + c2;
      indices.push(a, d, b, b, d, e);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'skirt';
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  return mesh;
}

/** Snow-covered rock of the surrounding range, shaded flat so it faces up. */
/**
 * Fades the procedural range out behind a backdrop picture.
 *
 * The generated peaks occupy the same band of sky the backdrop is drawn into,
 * so leaving them up hides most of the picture behind someone else's mountains
 * — which is not what supplying your own horizon is for.
 */
export function setRangeVisibility(range: THREE.Object3D | null, backdrop: LevelDef['backdrop']): void {
  const hidden = backdrop ? clamp01(backdrop.opacity) : 0;
  RIDGE.transparent = hidden > 0.001;
  RIDGE.opacity = 1 - hidden;
  RIDGE.depthWrite = hidden < 0.5;
  if (range) range.visible = hidden < 0.995;
}

const RIDGE = new THREE.MeshStandardMaterial({
  color: 0xf4f8ff,
  roughness: 0.95,
  metalness: 0,
  flatShading: true,
  vertexColors: true,
  // The range is an open surface and the camera lives inside the annulus, so
  // the whole near wall faces away and is culled — which shows as sky between
  // the terrain and the peaks, and as torn shards where a face happens to tip
  // toward the viewer. It is a landscape, not a closed solid; draw both sides.
  side: THREE.DoubleSide,
});

/**
 * The mountains that close in the horizon.
 *
 * An annular mesh around the level whose height comes from ridged noise in the
 * angular direction, so it reads as a real range of peaks and cols rather than a
 * bowl. Three concentric bands at different distances and heights give the
 * layered, receding look you get on a clear day, and atmospheric fog does the
 * rest — the farthest band is mostly haze, which is exactly how a distant range
 * actually looks.
 *
 * It is one merged, flat-shaded, non-shadowing mesh: pure backdrop, no cost
 * beyond a few thousand triangles that never move.
 */
export function buildMountainRange(level: LevelDef, field: Heightfield): THREE.Group {
  const group = new THREE.Group();
  group.name = 'range';

  const centreX = 0;
  const centreZ = level.terrain.length * 0.5;
  const span = Math.max(level.terrain.width, level.terrain.length);
  // Pulled in from one-to-four spans. Relief four spans out subtends almost
  // nothing, and worse, it sits deep enough in the haze that no amount of rock
  // survives the fog. Closer is both bigger and clearer.
  const inner = span * 0.85;
  const outer = span * 2.0;
  // Real alpine relief above a valley floor is 1500-2500 m, and it has to be:
  // the inner rim is anchored to ground that has already fallen several hundred
  // metres by the time it gets out here, so a range scaled to the drop alone
  // ends up below the camera and you look down onto it. At 780 m over three
  // kilometres the crests subtended about ten degrees and read as a ribbon.
  const maxHeight = 1150;

  const rings = 34;
  const cols = 220;
  const vertexCount = (cols + 1) * (rings + 1);
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  /**
   * Height of the range at a point on the annulus.
   *
   * Two scales, because a real range is not one noise field: a broad massif
   * that decides where the big mountains are, and ridged detail folded about
   * zero on top of it for the crests. Sampling in both angle and radius puts
   * peaks at different distances, which is where the layered look comes from.
   */
  const shapeAt = (a: number, rt: number): number => {
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // fbm2D is signed, so the massif is remapped to 0..1 before it is used as
    // an amplitude. Left signed it drives the whole term negative across half
    // the ring and the skyline collapses into floating slivers.
    // Octave counts are limited by the column count, not by taste. At 220
    // columns around the ring, a fourth octave of a field based at cos*2.4
    // lands near Nyquist: adjacent columns alternate high and low and the
    // skyline comes out as a comb of identical spikes rather than ridgelines.
    // The radial offsets are small for the same reason — shifting the field
    // hard between rings makes neighbouring rings disagree, and the surface
    // between them fans into triangles.
    const massif = fbm2D(cos * 1.15 + rt * 0.8, sin * 1.15, level.seed + 4021, 3) * 0.5 + 0.5;
    const ridged = 1 - Math.abs(fbm2D(cos * 2.4 + rt * 0.7, sin * 2.4, level.seed + 11, 3));
    const fine = 1 - Math.abs(fbm2D(cos * 5.0 + rt * 1.0, sin * 5.0, level.seed + 907, 2));
    const grain = fbm2D(cos * 8.5 + rt * 1.6, sin * 8.5, level.seed + 331, 2);
    // The floor matters as much as the peaks: a skyline that dips to nothing
    // shows strips of sky under the range.
    return 0.50 + (0.44 + massif * 0.5) * (ridged * 0.48 + fine * 0.06) + grain * 0.018;
  };

  /**
   * The envelope climbs the whole way out and never comes back down — a range
   * that dips between rings shows strips of sky under the skyline. The exponent
   * decides *where* the big peaks are, and it has to do two jobs at once. Too
   * high and the height is still climbing at the outer ring, so everything tall
   * is kilometres away and reads as a ribbon. Too low near the rim and the far
   * valley wall does not rise fast enough to close the gap the skirt leaves
   * when it falls away, and the range appears to float with sky beneath it.
   */
  const envelopeAt = (rt: number): number => Math.pow(rt, 0.34);

  for (let ri = 0; ri <= rings; ri++) {
    const rt = ri / rings;
    // Radius grows geometrically so the near ridges get the vertex density and
    // the far haze does not waste triangles.
    const radius = inner * Math.pow(outer / inner, rt);

    for (let ci = 0; ci <= cols; ci++) {
      const a = (ci / cols) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);

      const shape = shapeAt(a, rt);
      const h = maxHeight * envelopeAt(rt) * shape;
      const i = ri * (cols + 1) + ci;
      const wx = centreX + cos * radius;
      const wz = centreZ + sin * radius;

      // The inner rim is anchored to the level's own terrain in that direction —
      // sampling clamps at the boundary — and sunk below it, so the range tucks
      // under the run instead of leaving a seam.
      const anchor = field.heightAt(wx, wz) - skirtDrop(field, wx, wz) - 20;
      positions[i * 3] = wx;
      positions[i * 3 + 1] = anchor + h;
      positions[i * 3 + 2] = wz;

      // Steepness of the *shape*, not of the metres.
      //
      // Each ring sits at a different radius, so a gradient measured in metres
      // per metre is an order of magnitude larger on the outer ring than the
      // inner one — thresholding that puts rock on the whole far range and none
      // on the near one. Differentiating the unit shape field instead is
      // scale-free, and it is the shape that decides where snow can sit.
      const da = (Math.PI * 2) / cols;
      const dr = 1 / rings;
      const gradA = (shapeAt(a + da, rt) - shapeAt(a - da, rt)) / (2 * da);
      const gradR = (shapeAt(a, Math.min(1, rt + dr)) - shapeAt(a, Math.max(0, rt - dr))) / (2 * dr);
      const steep = Math.hypot(gradA * 0.4, gradR * 0.22);

      // Altitude matters more than steepness here, and it took a probe to see
      // why. Rock was firing on 30% of the vertices — but only on the flanks,
      // and the flanks are exactly the part hidden behind the ring in front of
      // them. All anyone ever sees of a range is its crests. Those are also the
      // rockiest part of a real skyline, because the wind scours the summit
      // ridges bare while snow sits on the gentler ground below.
      const alt = clamp01((shape - 0.86) / 0.17);
      // Patchy, so the snowline is broken up rather than a clean contour.
      const patch = fbm2D(cos * 11 + rt * 6, sin * 11, level.seed + 5501, 3);
      const rock = clamp01((steep * 0.5 + alt * 0.85 - 0.28 + patch * 0.2) / 0.6);

      // Rock is a cool dark grey; the sunward side of a face is much lighter
      // than the shaded side, which is the other half of reading as stone.
      //
      // These numbers are much lower than a rock albedo has any right to be,
      // and deliberately. The scene runs a bright sun into ACES tone mapping,
      // which compresses the top of the range hard: a physically sensible 0.35
      // rock came out of the pipeline at about 77% grey, near enough to snow's
      // 94% that the whole skyline read as white. Working back from the wanted
      // output rather than forward from the material is what gets stone.
      const facing = clamp01(0.5 + gradA * 0.55);
      const rockShade = 0.07 + facing * 0.17;
      const snowShade = 0.9 + clamp01(h / maxHeight) * 0.1;

      // Aerial perspective is the scene's exponential fog, and only that.
      // Baking a second distance wash into the vertex colours here stacked on
      // top of it and turned the whole range white — the rock was being
      // computed correctly and then erased twice over.
      colors[i * 3] = lerp(snowShade * 0.97, rockShade * 1.02, rock);
      colors[i * 3 + 1] = lerp(snowShade * 0.99, rockShade * 1.0, rock);
      colors[i * 3 + 2] = lerp(snowShade * 1.0, rockShade * 1.06, rock);
    }
  }

  const indices: number[] = [];
  for (let ri = 0; ri < rings; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const a = ri * (cols + 1) + ci;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, RIDGE);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Always drawn: it is the horizon, and culling it pops the skyline in and out.
  mesh.frustumCulled = false;
  group.add(mesh);

  return group;
}

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
      const mesh = new THREE.Mesh(geometry, isRail ? METAL : CONCRETE);
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

/** Props that cannot be instanced, because they carry something besides a mesh. */
const ONE_OFF_PROPS = new Set<PropKind>(['firePit']);

interface PropPlacement {
  kind: PropKind;
  x: number;
  z: number;
  scale: number;
  heading: number;
  /** Extra per-instance tilt, used to stop rocks looking stamped. */
  tiltX?: number;
  tiltZ?: number;
  /** Vertical squash, for the same reason. */
  squashY?: number;
  /** Lift off the ground, for props modelled about their base. */
  lift?: number;
}

const _propPos = new THREE.Vector3();
const _propQuat = new THREE.Quaternion();
const _propScale = new THREE.Vector3();
const _propEuler = new THREE.Euler();
const _propWorld = new THREE.Matrix4();
const _propPart = new THREE.Matrix4();

/**
 * Trees, rocks and course markers, drawn instanced.
 *
 * This used to add one `Group` of four meshes per tree. A long run auto-scatters
 * a tree every six metres and the built levels place a couple of hundred more,
 * so Powder Bowl was pushing roughly nineteen hundred draw calls and as many
 * unique geometries before anything else in the scene was counted — and each of
 * them again in the shadow pass. That is fine on a desktop GPU and completely
 * unaffordable on the phone this is supposed to run on.
 *
 * Now each kind is modelled once at unit scale and every copy is an entry in an
 * `InstancedMesh` per part, so the same forest costs a handful of calls. Nothing
 * about the look changes: the per-tree yaw and per-rock tumble that used to be
 * baked into separate meshes moves into the instance matrix instead.
 */
export function buildProps(level: LevelDef, field: Heightfield): THREE.Group {
  const group = new THREE.Group();
  group.name = 'props';
  const rng = makeRng(level.seed ^ 0x5eed);

  const placements: PropPlacement[] = [];

  // Scatter trees down the sides so the run reads as a corridor.
  const half = level.terrain.width / 2;
  const count = Math.floor(level.terrain.length / 6);
  for (let i = 0; i < count; i++) {
    const z = rng() * level.terrain.length;
    const side = rng() < 0.5 ? -1 : 1;
    // Bias toward the edges, leaving the middle of the run clear.
    const t = 0.62 + rng() * 0.38;
    const x = side * half * t;
    const scale = 0.7 + rng() * 0.9;
    if (rng() < 0.86) {
      placements.push({ kind: 'pine', x, z, scale, heading: rng() * 360 });
    } else {
      placements.push({
        kind: 'rock',
        x,
        z,
        scale,
        heading: rng() * 360,
        tiltX: rng() * 3,
        tiltZ: rng() * 3,
        squashY: 0.62 + rng() * 0.3,
        lift: 0.15 * scale,
      });
    }
  }

  for (const prop of level.features) {
    if (prop.kind !== 'prop') continue;
    if (prop.prop === 'rock') {
      placements.push({
        kind: 'rock',
        x: prop.x,
        z: prop.z,
        scale: prop.scale,
        heading: prop.heading + rng() * 360,
        tiltX: rng() * 3,
        tiltZ: rng() * 3,
        squashY: 0.62 + rng() * 0.3,
        lift: 0.15 * prop.scale,
      });
    } else if (prop.prop === 'pine' || prop.prop === 'tree') {
      placements.push({ kind: 'pine', x: prop.x, z: prop.z, scale: prop.scale, heading: rng() * 360 });
    } else {
      placements.push({ kind: prop.prop, x: prop.x, z: prop.z, scale: prop.scale, heading: prop.heading });
    }
  }

  // Group by kind, then emit one InstancedMesh per part of each template.
  const byKind = new Map<PropKind, PropPlacement[]>();
  for (const p of placements) {
    const list = byKind.get(p.kind);
    if (list) list.push(p);
    else byKind.set(p.kind, [p]);
  }

  for (const [kind, list] of byKind) {
    if (ONE_OFF_PROPS.has(kind)) {
      for (const p of list) {
        const node = propTemplate(kind);
        node.position.set(p.x, field.heightAt(p.x, p.z), p.z);
        node.rotation.y = p.heading * DEG;
        node.scale.setScalar(p.scale);
        group.add(node);
      }
      continue;
    }

    const template = propTemplate(kind);
    template.updateMatrixWorld(true);
    const parts: Array<{ mesh: THREE.Mesh; local: THREE.Matrix4 }> = [];
    template.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) parts.push({ mesh: node as THREE.Mesh, local: node.matrixWorld.clone() });
    });
    if (parts.length === 0) continue;

    for (const part of parts) {
      const instanced = new THREE.InstancedMesh(part.mesh.geometry, part.mesh.material, list.length);
      instanced.castShadow = part.mesh.castShadow;
      instanced.receiveShadow = part.mesh.receiveShadow;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        _propPos.set(p.x, field.heightAt(p.x, p.z) + (p.lift ?? 0), p.z);
        _propEuler.set(p.tiltX ?? 0, p.heading * DEG, p.tiltZ ?? 0);
        _propQuat.setFromEuler(_propEuler);
        _propScale.set(p.scale, p.scale * (p.squashY ?? 1), p.scale);
        _propWorld.compose(_propPos, _propQuat, _propScale);
        instanced.setMatrixAt(i, _propPart.multiplyMatrices(_propWorld, part.local));
      }
      instanced.instanceMatrix.needsUpdate = true;
      // Culling uses the geometry's own bounds unless told otherwise, which
      // would cull the whole forest as soon as the origin left the frustum.
      instanced.computeBoundingSphere();
      group.add(instanced);
    }
  }

  // Gates instance too. A generated slalom can set sixty of them, and two
  // poles each is another hundred and twenty draws for a pair of sticks.
  const gates = level.features.filter((f) => f.kind === 'gate');
  if (gates.length > 0) {
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6);
    const poles = new THREE.InstancedMesh(poleGeo, FLAG, gates.length * 2);
    let i = 0;
    for (const gate of gates) {
      const y = field.heightAt(gate.x, gate.z);
      const h = gate.heading * DEG;
      for (const side of [-1, 1]) {
        // Gate width varies, so it rides in the matrix rather than forcing a
        // separate geometry per gate.
        _propPos.set(
          gate.x + Math.cos(h) * side * (gate.width / 2),
          y + 1.2,
          gate.z - Math.sin(h) * side * (gate.width / 2),
        );
        _propQuat.identity();
        _propScale.set(1, 1, 1);
        poles.setMatrixAt(i++, _propWorld.compose(_propPos, _propQuat, _propScale));
      }
    }
    poles.instanceMatrix.needsUpdate = true;
    poles.computeBoundingSphere();
    group.add(poles);
  }

  return group;
}

function makePineTemplate(): THREE.Object3D {
  const g = new THREE.Group();
  const height = 4.5;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, height * 0.35, 6), TRUNK);
  trunk.position.y = height * 0.175;
  g.add(trunk);

  // Three stacked cones, no snow loading: against a white slope a conifer reads
  // as a near-black silhouette, and capping it just muddies the shape.
  for (let i = 0; i < 3; i++) {
    const t = i / 3;
    const r = 1.2 - t * 0.68;
    const h = 2.1 - t * 0.5;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), NEEDLE);
    cone.position.y = height * 0.3 + t * height * 0.42 + h * 0.35;
    cone.castShadow = true;
    g.add(cone);
  }
  return g;
}

function makeRockTemplate(): THREE.Mesh {
  // Tumble and squash are per-instance, so they live in the instance matrix
  // rather than in a geometry built once per rock.
  const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 0), ROCK);
  rock.castShadow = true;
  rock.receiveShadow = true;
  return rock;
}

/**
 * One copy of an item, modelled at unit scale about its base at the origin.
 *
 * Position, heading and scale are applied per instance by `buildProps`, so
 * nothing in here may read them — a template is built once and shared by every
 * copy on the mountain.
 */
function propTemplate(kind: PropKind): THREE.Object3D {
  switch (kind) {
    case 'rock':
      return makeRockTemplate();
    case 'flag': {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), METAL);
      pole.position.y = 1.1;
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.5), FLAG);
      cloth.position.set(0.35, 1.85, 0);
      g.add(pole, cloth);
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
      return g;
    }
    case 'tent': {
      const tent = new THREE.Mesh(new THREE.ConeGeometry(1.8, 2.4, 6), FLAG);
      tent.position.y = 1.2;
      tent.castShadow = true;
      return tent;
    }
    case 'sign': {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2, 6), WOOD);
      pole.position.y = 1;
      const board = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.7, 0.06), FLAG);
      board.position.y = 1.9;
      g.add(pole, board);
      return g;
    }
    case 'deadTree': {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.24, 5.2, 6), TRUNK);
      trunk.position.y = 2.6;
      trunk.castShadow = true;
      g.add(trunk);
      // Bare limbs, angled up and out. Deterministic from the level's rng, so
      // the same tree is the same tree on every load.
      for (let i = 0; i < 5; i++) {
        const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.09, 1.8, 4), TRUNK);
        limb.position.y = 2.6 + i * 0.55;
        limb.rotation.z = (i % 2 ? 1 : -1) * (0.72 + i * 0.09);
        limb.rotation.y = i * 2.4;
        limb.translateY(0.8);
        g.add(limb);
      }
      return g;
    }
    case 'marker': {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 3, 6), METAL);
      pole.position.y = 1.5;
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.5, 6), FLAG);
      tip.position.y = 2.85;
      g.add(pole, tip);
      return g;
    }
    case 'banner': {
      const g = new THREE.Group();
      const span = 6;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.6, 6), METAL);
        post.position.set(side * (span / 2), 1.3, 0);
        g.add(post);
      }
      const cloth = new THREE.Mesh(new THREE.PlaneGeometry(span, 1.1), PAINT);
      cloth.position.y = 2;
      g.add(cloth);
      return g;
    }
    case 'arch': {
      // An inflatable start arch: two legs and a curved top.
      const g = new THREE.Group();
      const legGeo = new THREE.CylinderGeometry(0.42, 0.5, 5, 8);
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, PAINT);
        leg.position.set(side * 5, 2.5, 0);
        leg.castShadow = true;
        g.add(leg);
      }
      const top = new THREE.Mesh(new THREE.TorusGeometry(5, 0.45, 8, 20, Math.PI), PAINT);
      top.position.y = 5;
      g.add(top);
      return g;
    }
    case 'netFence': {
      const g = new THREE.Group();
      const span = 8;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.2, 6), METAL);
        post.position.set(side * (span / 2), 1.1, 0);
        g.add(post);
      }
      const net = new THREE.Mesh(new THREE.PlaneGeometry(span, 1.9), NET);
      net.position.y = 1.05;
      g.add(net);
      return g;
    }
    case 'chair': {
      // A lift chair on its hanger, high enough to pass overhead.
      const g = new THREE.Group();
      const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3, 6), METAL);
      hanger.position.y = 8.5;
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.16, 0.7), PAINT);
      seat.position.y = 7;
      seat.castShadow = true;
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.1, 0.14), PAINT);
      back.position.set(0, 7.55, -0.34);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.1, 0.1), METAL);
      bar.position.set(0, 7.5, 0.5);
      g.add(hanger, seat, back, bar);
      return g;
    }
    case 'igloo': {
      const g = new THREE.Group();
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), SNOWCAP);
      dome.castShadow = true;
      const door = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.4, 10, 1, false, 0, Math.PI), SNOWCAP);
      door.rotation.z = Math.PI / 2;
      door.position.set(0, 0.7, 2);
      const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.62, 12), DARK);
      mouth.position.set(0, 0.7, 2.72);
      g.add(dome, door, mouth);
      return g;
    }
    case 'snowcat': {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.5, 5.4), FLAG);
      body.position.y = 1.9;
      body.castShadow = true;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.2, 2.2), GLASS);
      cab.position.set(0, 3.1, 0.4);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.1, 0.3), METAL);
      blade.position.set(0, 1.1, 3.3);
      blade.rotation.x = -0.2;
      for (const side of [-1, 1]) {
        const track = new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, 5.6), DARK);
        track.position.set(side * 1.7, 0.75, 0);
        g.add(track);
      }
      g.add(body, cab, blade);
      return g;
    }
    case 'snowGun': {
      const g = new THREE.Group();
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 4.6, 8), METAL);
      mast.position.y = 2.3;
      mast.castShadow = true;
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.72, 1.5, 12), PAINT);
      barrel.rotation.x = Math.PI / 2 - 0.35;
      barrel.position.set(0, 4.6, 0.3);
      const mouth = new THREE.Mesh(new THREE.CircleGeometry(0.58, 12), DARK);
      mouth.position.set(0, 4.85, 1.0);
      mouth.rotation.x = 0.35;
      g.add(mast, barrel, mouth);
      return g;
    }
    case 'speaker': {
      const g = new THREE.Group();
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.16, 2.4, 6), METAL);
      stand.position.y = 1.2;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.6), DARK);
      cab.position.y = 2.8;
      cab.castShadow = true;
      const cone = new THREE.Mesh(new THREE.CircleGeometry(0.24, 12), METAL);
      cone.position.set(0, 2.9, 0.31);
      g.add(stand, cab, cone);
      return g;
    }
    case 'bench': {
      const g = new THREE.Group();
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.5), WOOD);
      seat.position.y = 0.55;
      seat.castShadow = true;
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.45, 0.1), WOOD);
      back.position.set(0, 0.9, -0.22);
      for (const side of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.45), WOOD);
        leg.position.set(side * 0.9, 0.28, 0);
        g.add(leg);
      }
      g.add(seat, back);
      return g;
    }
    case 'firePit': {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.16, 6, 14), ROCK);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.16;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.1, 7), EMBER);
      flame.position.y = 0.7;
      const glow = new THREE.PointLight(0xff7a2f, 12, 14, 2);
      glow.position.y = 0.9;
      g.add(ring, flame, glow);
      return g;
    }
    case 'barrel': {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 12), FLAG);
      barrel.position.y = 0.55;
      barrel.castShadow = true;
      return barrel;
    }
    case 'crate': {
      const g = new THREE.Group();
      const geo = new THREE.BoxGeometry(1, 0.9, 1);
      const stack: Array<[number, number, number]> = [
        [0, 0.45, 0],
        [1.05, 0.45, 0.1],
        [0.5, 1.35, 0.05],
      ];
      for (const [bx, by, bz] of stack) {
        const crate = new THREE.Mesh(geo, WOOD);
        crate.position.set(bx, by, bz);
        crate.rotation.y = (bx - bz) * 0.22;
        crate.castShadow = true;
        g.add(crate);
      }
      return g;
    }
    case 'tree':
    case 'pine':
    default:
      return makePineTemplate();
  }
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

// Materials shared between levels must never be disposed with the objects that
// happen to use them, or the next level draws with a dead program.
const SHARED_MATERIALS = new Set<THREE.Material>([
  METAL,
  CONCRETE,
  WOOD,
  FLAG,
  TRUNK,
  NEEDLE,
  SNOWCAP,
  RIDGE,
  ROCK,
  PAINT,
  DARK,
  GLASS,
  NET,
  EMBER,
]);

export function clampLevelCamera(field: Heightfield, pos: THREE.Vector3, minAbove = 1.2): void {
  const ground = field.heightAt(pos.x, pos.z);
  if (pos.y < ground + minAbove) pos.y = ground + minAbove;
  pos.x = clamp(pos.x, field.minX - 40, field.maxX + 40);
  pos.z = clamp(pos.z, field.minZ - 40, field.maxZ + 40);
}
