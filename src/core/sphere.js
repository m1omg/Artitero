// A geodesic point mesh on a sphere.
//
// The geosphere is not a grid of tiles: cells are points scattered evenly
// over a real sphere (a Fibonacci lattice), each with a neighbourhood, an
// area, and a position that plate motion rotates through. Latitude is a
// consequence of position, so a continent that drifts to the pole really
// does freeze.

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export class SphereMesh {
  /**
   * @param {number} n number of cells
   * @param {number} radiusKm planetary radius
   */
  constructor(n, radiusKm = 6371) {
    this.n = n;
    this.radiusKm = radiusKm;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.lat = new Float64Array(n);
    this.lon = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      // Even area distribution: z uniform, longitude by the golden angle.
      const z = 1 - (2 * i + 1) / n;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const theta = GOLDEN_ANGLE * i;
      this.x[i] = r * Math.cos(theta);
      this.y[i] = r * Math.sin(theta);
      this.z[i] = z;
      this.lat[i] = Math.asin(z);
      this.lon[i] = Math.atan2(this.y[i], this.x[i]);
    }

    // Every cell carries the same share of the planet's surface.
    this.cellAreaKm2 = (4 * Math.PI * radiusKm * radiusKm) / n;
    this.surfaceAreaKm2 = 4 * Math.PI * radiusKm * radiusKm;

    this._buildNeighbours();
  }

  /** k nearest neighbours, found through a latitude-banded index so that
   *  mesh construction stays roughly linear instead of quadratic. */
  _buildNeighbours(k = 6) {
    const n = this.n;
    const bands = Math.max(1, Math.floor(Math.sqrt(n)));
    const bandOf = (i) => Math.min(bands - 1, Math.floor(((this.z[i] + 1) / 2) * bands));
    const buckets = [];
    for (let b = 0; b < bands; b++) buckets.push([]);
    for (let i = 0; i < n; i++) buckets[bandOf(i)].push(i);

    this.neighbours = new Int32Array(n * k);
    this.neighbourCount = k;
    const bestIdx = new Int32Array(k);
    const bestD = new Float64Array(k);

    for (let i = 0; i < n; i++) {
      for (let s = 0; s < k; s++) { bestIdx[s] = -1; bestD[s] = Infinity; }
      const b = bandOf(i);
      // Three bands of candidates is always enough for a Fibonacci lattice;
      // widen near the poles where bands hold few cells.
      let span = 2;
      let found = 0;
      while (found < k + 1 && span < bands + 2) {
        found = 0;
        for (let bb = b - span; bb <= b + span; bb++) {
          if (bb < 0 || bb >= bands) continue;
          found += buckets[bb].length;
        }
        if (found >= k + 1) break;
        span++;
      }
      for (let bb = Math.max(0, b - span); bb <= Math.min(bands - 1, b + span); bb++) {
        const bucket = buckets[bb];
        for (let q = 0; q < bucket.length; q++) {
          const j = bucket[q];
          if (j === i) continue;
          const dx = this.x[i] - this.x[j];
          const dy = this.y[i] - this.y[j];
          const dz = this.z[i] - this.z[j];
          const d = dx * dx + dy * dy + dz * dz;
          if (d >= bestD[k - 1]) continue;
          let s = k - 1;
          while (s > 0 && bestD[s - 1] > d) { bestD[s] = bestD[s - 1]; bestIdx[s] = bestIdx[s - 1]; s--; }
          bestD[s] = d; bestIdx[s] = j;
        }
      }
      for (let s = 0; s < k; s++) this.neighbours[i * k + s] = bestIdx[s] >= 0 ? bestIdx[s] : i;
    }

    // Mean neighbour distance, in km: the natural length scale of the mesh.
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const j = this.neighbours[i * k];
      sum += this.greatCircleKm(i, j);
    }
    this.spacingKm = sum / n;
  }

  neighboursOf(i) {
    const k = this.neighbourCount;
    return this.neighbours.subarray(i * k, i * k + k);
  }

  greatCircleKm(i, j) {
    let dot = this.x[i] * this.x[j] + this.y[i] * this.y[j] + this.z[i] * this.z[j];
    dot = Math.max(-1, Math.min(1, dot));
    return Math.acos(dot) * this.radiusKm;
  }

  /** Index of the cell nearest to a unit vector. Linear, but only ever
   *  called from UI picking and intervention targeting. */
  nearest(vx, vy, vz) {
    let best = 0, bestDot = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = this.x[i] * vx + this.y[i] * vy + this.z[i] * vz;
      if (d > bestDot) { bestDot = d; best = i; }
    }
    return best;
  }

  static unitFromLatLon(latRad, lonRad) {
    const c = Math.cos(latRad);
    return [c * Math.cos(lonRad), c * Math.sin(lonRad), Math.sin(latRad)];
  }
}

/** Rotate a vector about a unit axis by `angle` radians (Rodrigues). */
export function rotateAbout(vx, vy, vz, ax, ay, az, angle, out) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dot = ax * vx + ay * vy + az * vz;
  const cx = ay * vz - az * vy;
  const cy = az * vx - ax * vz;
  const cz = ax * vy - ay * vx;
  out[0] = vx * c + cx * s + ax * dot * (1 - c);
  out[1] = vy * c + cy * s + ay * dot * (1 - c);
  out[2] = vz * c + cz * s + az * dot * (1 - c);
  return out;
}
