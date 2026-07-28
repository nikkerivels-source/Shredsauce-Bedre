import * as THREE from 'three';

/**
 * The output stage: anti-aliasing and resolution scale.
 *
 * The scene used to draw straight into the canvas and take whatever
 * anti-aliasing the WebGL context happened to be created with. That has two
 * problems. The flag can only be set once, at context creation, so changing the
 * quality preset while the game is running never changed the anti-aliasing —
 * and the flag was tied to pixel ratio, so the highest preset was the one
 * running without it, which is backwards: a dark tree line against lit snow is
 * the worst edge case there is and `high` was the setting that showed it worst.
 *
 * So the scene renders into a target this owns, and the target decides. Sample
 * count is a per-preset number rather than a boolean, resolution scale is a
 * separate knob the player can pull on a weak device, and FXAA is there for the
 * tier that cannot afford real samples. All three can change at any moment
 * without touching the WebGL context.
 *
 * When a preset asks for none of it — no samples, no FXAA, full resolution —
 * there is no target and no blit, and the scene draws directly to the canvas
 * exactly as it did before. The cheapest tier pays nothing for the machinery.
 */
export interface OutputSettings {
  /** MSAA samples on the scene target. 0 disables multisampling. */
  samples: number;
  /** Cheap post-hoc edge blend, for tiers that cannot afford samples. */
  fxaa: boolean;
  /** Render scale, 0.5–1. Below 1 the scene is drawn small and upscaled. */
  resolutionScale: number;
}

/**
 * Luma for edge detection.
 *
 * The target holds tone-mapped linear light, and FXAA's thresholds assume
 * perceptual values — run it on linear and a dark tree against bright snow
 * barely registers as an edge, which is the one case this exists for. `sqrt` is
 * the standard cheap stand-in for the sRGB transfer curve and costs one
 * instruction per tap.
 */
const FXAA_SHADER = {
  vertex: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragment: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;

    const float SPAN_MAX = 8.0;
    const float REDUCE_MUL = 1.0 / 8.0;
    const float REDUCE_MIN = 1.0 / 128.0;

    float luma(vec3 c) {
      return sqrt(dot(c, vec3(0.299, 0.587, 0.114)));
    }

    void main() {
      vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
      vec3 rgbNE = texture2D(tDiffuse, vUv + vec2(1.0, -1.0) * uTexel).rgb;
      vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
      vec3 rgbSE = texture2D(tDiffuse, vUv + vec2(1.0, 1.0) * uTexel).rgb;
      vec4 centre = texture2D(tDiffuse, vUv);

      float lumaNW = luma(rgbNW);
      float lumaNE = luma(rgbNE);
      float lumaSW = luma(rgbSW);
      float lumaSE = luma(rgbSE);
      float lumaM = luma(centre.rgb);
      float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
      float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));

      // Gradient of luma across the 2x2 neighbourhood, which points along the
      // edge; the blend then runs perpendicular to it.
      vec2 dir = vec2(
        -((lumaNW + lumaNE) - (lumaSW + lumaSE)),
        ((lumaNW + lumaSW) - (lumaNE + lumaSE))
      );
      float reduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
      float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
      dir = clamp(dir * rcpMin, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * uTexel;

      vec3 rgbA = 0.5 * (
        texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
        texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb
      );
      vec3 rgbB = rgbA * 0.5 + 0.25 * (
        texture2D(tDiffuse, vUv + dir * -0.5).rgb +
        texture2D(tDiffuse, vUv + dir * 0.5).rgb
      );

      // The wider blend overshoots on thin features; fall back to the tight one
      // when it lands outside the neighbourhood it came from.
      float lumaB = luma(rgbB);
      gl_FragColor = vec4(lumaB < lumaMin || lumaB > lumaMax ? rgbA : rgbB, centre.a);
      #include <colorspace_fragment>
    }
  `,
};

const COPY_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(tDiffuse, vUv);
    #include <colorspace_fragment>
  }
`;

export class OutputChain {
  private settings: OutputSettings;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fxaaMaterial: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private width = 1;
  private height = 1;

  constructor(settings: OutputSettings) {
    this.settings = { ...settings };

    const uniforms = () => ({
      tDiffuse: { value: null as THREE.Texture | null },
      uTexel: { value: new THREE.Vector2(1, 1) },
    });
    this.fxaaMaterial = new THREE.ShaderMaterial({
      uniforms: uniforms(),
      vertexShader: FXAA_SHADER.vertex,
      fragmentShader: FXAA_SHADER.fragment,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: uniforms(),
      vertexShader: FXAA_SHADER.vertex,
      fragmentShader: COPY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    // A single triangle rather than a quad: one fewer vertex, no diagonal seam,
    // and every pixel is shaded exactly once.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    this.quad = new THREE.Mesh(geo, this.copyMaterial);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** True when the scene has to go through a target to satisfy the settings. */
  get active(): boolean {
    const s = this.settings;
    return s.samples > 0 || s.fxaa || s.resolutionScale < 0.999;
  }

  setSettings(settings: OutputSettings, renderer: THREE.WebGLRenderer): void {
    const s = this.settings;
    const sampleChange = s.samples !== settings.samples;
    const scaleChange = Math.abs(s.resolutionScale - settings.resolutionScale) > 1e-4;
    this.settings = { ...settings };
    // Sample count and size are baked into the target, so those two need a new
    // one. Turning FXAA on or off only swaps a material.
    if (sampleChange || scaleChange) this.rebuild(renderer);
  }

  setSize(width: number, height: number, renderer: THREE.WebGLRenderer): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.rebuild(renderer);
  }

  private rebuild(renderer: THREE.WebGLRenderer): void {
    this.target?.dispose();
    this.target = null;
    if (!this.active) return;

    const scale = Math.min(1, Math.max(0.5, this.settings.resolutionScale));
    const w = Math.max(1, Math.round(this.width * scale));
    const h = Math.max(1, Math.round(this.height * scale));
    // Multisampled targets need WebGL2. Where it is missing the preset silently
    // loses its samples, so FXAA has to be able to stand in.
    const samples = renderer.capabilities.isWebGL2 ? this.settings.samples : 0;
    this.target = new THREE.WebGLRenderTarget(w, h, {
      samples,
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      // Linear light in, so the scene pass tone-maps but does not encode; the
      // blit below does the sRGB conversion on its way to the canvas.
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const u = this.fxaaMaterial.uniforms.uTexel.value as THREE.Vector2;
    u.set(1 / w, 1 / h);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    if (!this.target) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }

    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    const material = this.settings.fxaa ? this.fxaaMaterial : this.copyMaterial;
    material.uniforms.tDiffuse.value = this.target.texture;
    this.quad.material = material;
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.target?.dispose();
    this.quad.geometry.dispose();
    this.fxaaMaterial.dispose();
    this.copyMaterial.dispose();
  }
}
