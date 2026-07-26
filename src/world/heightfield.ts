import { Vec3, clamp } from '../core/math.ts';

export interface SurfaceSample {
  /** Terrain height at the queried point, metres. */
  height: number;
  /** Unit surface normal. */
  normal: Vec3;
  /** Depth of loose snow sitting on the base at this point, metres. */
  looseDepth: number;
  /** 0 = powder, 1 = ice. Local hardness including groomed and skied-out areas. */
  hardness: number;
}

/**
 * Regular grid of terrain heights with bilinear sampling.
 *
 * The board contact solver hits this roughly ten thousand times a second, so
 * sampling is written to avoid allocation and to reuse the caller's normal.
 */
export class Heightfield {
  readonly minX: number;
  readonly minZ: number;
  readonly resolution: number;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
  /** Per-cell hardness modifier, 0-1, updated as the snow gets skied out. */
  readonly hardness: Float32Array;

  constructor(minX: number, minZ: number, width: number, length: number, resolution: number) {
    this.minX = minX;
    this.minZ = minZ;
    this.resolution = resolution;
    this.nx = Math.max(2, Math.ceil(width / resolution) + 1);
    this.nz = Math.max(2, Math.ceil(length / resolution) + 1);
    this.heights = new Float32Array(this.nx * this.nz);
    this.hardness = new Float32Array(this.nx * this.nz);
  }

  get maxX(): number {
    return this.minX + (this.nx - 1) * this.resolution;
  }

  get maxZ(): number {
    return this.minZ + (this.nz - 1) * this.resolution;
  }

  index(ix: number, iz: number): number {
    return iz * this.nx + ix;
  }

  /** Grid coordinate (may be fractional) for a world X. */
  gridX(x: number): number {
    return (x - this.minX) / this.resolution;
  }

  gridZ(z: number): number {
    return (z - this.minZ) / this.resolution;
  }

  worldX(ix: number): number {
    return this.minX + ix * this.resolution;
  }

  worldZ(iz: number): number {
    return this.minZ + iz * this.resolution;
  }

  /** Raw grid height with clamped edge addressing. */
  heightAtCell(ix: number, iz: number): number {
    const cx = ix < 0 ? 0 : ix >= this.nx ? this.nx - 1 : ix;
    const cz = iz < 0 ? 0 : iz >= this.nz ? this.nz - 1 : iz;
    return this.heights[cz * this.nx + cx];
  }

  /** Bilinearly interpolated height, extended by clamping outside the grid. */
  heightAt(x: number, z: number): number {
    const gx = this.gridX(x);
    const gz = this.gridZ(z);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = clamp(gx - ix, 0, 1);
    const fz = clamp(gz - iz, 0, 1);
    const h00 = this.heightAtCell(ix, iz);
    const h10 = this.heightAtCell(ix + 1, iz);
    const h01 = this.heightAtCell(ix, iz + 1);
    const h11 = this.heightAtCell(ix + 1, iz + 1);
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  /**
   * Surface normal from central differences on the interpolated field. The
   * half-cell offset keeps the normal continuous across cell boundaries, which
   * matters a lot when a board is riding a jump transition.
   */
  normalAt(x: number, z: number, out: Vec3): Vec3 {
    const d = this.resolution;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    // Gradient of the surface; normal = normalize(-dh/dx, 1, -dh/dz).
    out.set(-hx / (2 * d), 1, -hz / (2 * d));
    return out.normalize();
  }

  hardnessAt(x: number, z: number): number {
    const gx = this.gridX(x);
    const gz = this.gridZ(z);
    const ix = clamp(Math.round(gx), 0, this.nx - 1);
    const iz = clamp(Math.round(gz), 0, this.nz - 1);
    return this.hardness[iz * this.nx + ix];
  }

  /**
   * Packs mountain height, normal and snow state into one sample. `base` carries
   * the level-wide snow settings that the local modifiers ride on top of.
   */
  sample(x: number, z: number, baseHardness: number, baseDepth: number, out: SurfaceSample): SurfaceSample {
    out.height = this.heightAt(x, z);
    this.normalAt(x, z, out.normal);
    const skiedOut = this.hardnessAt(x, z);
    // Repeated traffic packs snow: hardness rises toward ice, loose depth drops.
    out.hardness = clamp(baseHardness + skiedOut * (1 - baseHardness) * 0.8, 0, 1);
    out.looseDepth = Math.max(0, baseDepth * (1 - skiedOut));
    return out;
  }

  isInside(x: number, z: number): boolean {
    return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ;
  }

  /**
   * Records that snow was compressed at a point, packing it toward ice. Called
   * by the carve solver so a well-used line becomes faster and grippier.
   */
  packSnow(x: number, z: number, radius: number, amount: number): void {
    const r = Math.max(this.resolution, radius);
    const ix0 = clamp(Math.floor(this.gridX(x - r)), 0, this.nx - 1);
    const ix1 = clamp(Math.ceil(this.gridX(x + r)), 0, this.nx - 1);
    const iz0 = clamp(Math.floor(this.gridZ(z - r)), 0, this.nz - 1);
    const iz1 = clamp(Math.ceil(this.gridZ(z + r)), 0, this.nz - 1);
    const r2 = r * r;
    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = this.worldZ(iz) - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = this.worldX(ix) - x;
        const d2 = wx * wx + wz * wz;
        if (d2 > r2) continue;
        const falloff = 1 - d2 / r2;
        const i = iz * this.nx + ix;
        this.hardness[i] = Math.min(1, this.hardness[i] + amount * falloff);
      }
    }
  }

  /**
   * Cheap downhill ray march used for camera collision and feature placement in
   * the editor. Returns the distance along the ray or -1.
   */
  raycast(origin: Vec3, dir: Vec3, maxDist: number, step = 0.5): number {
    let t = 0;
    let prevAbove = origin.y - this.heightAt(origin.x, origin.z);
    while (t < maxDist) {
      t = Math.min(t + step, maxDist);
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      const above = y - this.heightAt(x, z);
      if (above <= 0 && prevAbove > 0) {
        // Linear refinement between the two samples.
        const frac = prevAbove / (prevAbove - above);
        return t - step + step * frac;
      }
      prevAbove = above;
      if (t >= maxDist) break;
    }
    return -1;
  }
}
