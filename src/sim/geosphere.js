// Geosphere: plates on a sphere.
//
// Plates are rigid caps rotating about Euler poles. Crust rides on them and
// is resampled along their motion, so continents genuinely travel: they
// collide and raise mountains, they rift and open oceans, they drift into
// the tropics or onto a pole. Continental positions are an input to the
// climate module, which is why breaking up a supercontinent is a climate
// intervention even when the player thinks they are doing geography.

import { rotateAbout } from '../core/sphere.js';
import { IMPORTANCE } from '../core/chronicle.js';

const OCEANIC_THICKNESS = 7;      // km
const CONTINENTAL_BASE = 35;      // km
const ISOSTATIC_REF = 31;         // km of crust that sits exactly at datum
const ISOSTATIC_GAIN = 120;       // m of elevation per km of excess crust
const CONTINENT_THRESHOLD = 20;   // km: thicker than this counts as continent
// A real continental shelf is far narrower than one cell of this mesh, so the
// shelf band has to stand in for shelf and upper slope together — the shallow,
// sunlit, sediment-trapping water where most carbon burial happens.
const SHELF_DEPTH = 1500;         // m

export class Geosphere {
  constructor(mesh, rng, params = {}) {
    this.mesh = mesh;
    this.params = Object.assign({
      plateCount: 9,
      plateSpeedKmPerYear: 0.00005,   // ~5 cm/yr
      orogenyGain: 1.0,
      erosionGain: 1.0,
      reorganiseEveryYears: 180e6,
      initialContinentFraction: 0.12,
    }, params);

    const n = mesh.n;
    this.thickness = new Float64Array(n);
    this.age = new Float64Array(n);          // Myr since the crust formed
    this.elevation = new Float64Array(n);    // m relative to the datum
    this.plateId = new Int32Array(n);
    this.strain = new Float64Array(n);       // + convergent, - divergent (mm/yr)
    this.volcanism = new Float64Array(n);    // relative outgassing weight
    this.sediment = new Float64Array(n);
    /** Ocean cells that touch land. A real continental shelf is a few tens of
     *  kilometres wide — far below one cell of any mesh this model can afford
     *  — so the shelf is carried as a flag on the coastal ring rather than
     *  pretended to be resolved. Most carbon burial, and the whole route from
     *  sea to land, happens here. */
    this.coastal = new Uint8Array(n);

    this.plates = [];
    this.seaLevel = -9000;                   // no surface water on a dead world
    this.waterVolumeKm3 = 0;
    this.lastReorganise = 0;
    this.supercontinentIndex = 0;
    this.stats = {
      landFraction: 0, mountainFraction: 0, shelfFraction: 0,
      subductionRate: 0, riftRate: 0, meanElevation: 0, maxElevation: 0,
      volcanicActivity: 1, coreHeat: 1,
    };

    this._init(rng);
  }

  _init(rng) {
    const mesh = this.mesh;
    const n = mesh.n;

    this._seedPlates(rng);

    // A young world: a hot, thin, almost entirely basaltic crust with a few
    // thickened proto-cratons where the first melt has already differentiated.
    const cratonCount = 4 + rng.int(4);
    const cratons = [];
    for (let c = 0; c < cratonCount; c++) {
      const i = rng.int(n);
      cratons.push({ x: mesh.x[i], y: mesh.y[i], z: mesh.z[i], r: rng.range(0.25, 0.55) });
    }
    for (let i = 0; i < n; i++) {
      let t = OCEANIC_THICKNESS + rng.range(-1.2, 1.2);
      for (const c of cratons) {
        const dot = mesh.x[i] * c.x + mesh.y[i] * c.y + mesh.z[i] * c.z;
        const d = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (d < c.r) {
          const f = 1 - d / c.r;
          t = Math.max(t, OCEANIC_THICKNESS + (CONTINENTAL_BASE - OCEANIC_THICKNESS) * f * f);
        }
      }
      this.thickness[i] = t;
      this.age[i] = rng.range(0, 40);
    }
    this._updateElevation();
    this._updateStats();
  }

  _seedPlates(rng) {
    const mesh = this.mesh;
    const k = this.params.plateCount;
    const seeds = [];
    for (let p = 0; p < k; p++) {
      const i = rng.int(mesh.n);
      // Euler pole: a random axis; angular rate set so surface speed is
      // realistic for the distance from the pole.
      let ax = rng.normal(), ay = rng.normal(), az = rng.normal();
      const len = Math.hypot(ax, ay, az) || 1;
      ax /= len; ay /= len; az /= len;
      const speed = this.params.plateSpeedKmPerYear * rng.range(0.35, 1.8);
      seeds.push({
        id: p,
        cx: mesh.x[i], cy: mesh.y[i], cz: mesh.z[i],
        ax, ay, az,
        omega: speed / mesh.radiusKm * (rng.chance(0.5) ? 1 : -1),
        shift: 0,
      });
    }
    this.plates = seeds;
    this._assignPlates();
  }

  /** Spherical Voronoi assignment of cells to plate centres. */
  _assignPlates() {
    const mesh = this.mesh;
    for (let i = 0; i < mesh.n; i++) {
      let best = 0, bestDot = -Infinity;
      for (let p = 0; p < this.plates.length; p++) {
        const pl = this.plates[p];
        const d = mesh.x[i] * pl.cx + mesh.y[i] * pl.cy + mesh.z[i] * pl.cz;
        if (d > bestDot) { bestDot = d; best = p; }
      }
      this.plateId[i] = best;
    }
  }

  /** Nearest cell to a direction, found by walking the mesh from a hint.
   *  Plate motion is always small compared to cell spacing, so the walk
   *  converges in a couple of hops. */
  _walkNearest(start, vx, vy, vz) {
    const mesh = this.mesh;
    let cur = start;
    let curDot = mesh.x[cur] * vx + mesh.y[cur] * vy + mesh.z[cur] * vz;
    for (let iter = 0; iter < 24; iter++) {
      const nb = mesh.neighboursOf(cur);
      let bestJ = -1, bestDot = curDot;
      for (let s = 0; s < nb.length; s++) {
        const j = nb[s];
        const d = mesh.x[j] * vx + mesh.y[j] * vy + mesh.z[j] * vz;
        if (d > bestDot) { bestDot = d; bestJ = j; }
      }
      if (bestJ < 0) break;
      cur = bestJ; curDot = bestDot;
    }
    return cur;
  }

  /** Surface velocity of the plate under cell i, in km/yr, as a 3-vector. */
  velocityAt(i, out) {
    const mesh = this.mesh;
    const pl = this.plates[this.plateId[i]];
    const w = pl.omega * mesh.radiusKm;
    out[0] = (pl.ay * mesh.z[i] - pl.az * mesh.y[i]) * w;
    out[1] = (pl.az * mesh.x[i] - pl.ax * mesh.z[i]) * w;
    out[2] = (pl.ax * mesh.y[i] - pl.ay * mesh.x[i]) * w;
    return out;
  }

  step(dtYears, world) {
    const mesh = this.mesh;
    const n = mesh.n;
    const ledger = world.ledger;

    // Radiogenic heat decays, so the engine driving the plates winds down
    // over the life of the world. A cold planet stops resurfacing itself.
    const ageGyr = world.year / 1e9;
    const heat = Math.exp(-ageGyr * 0.22) * world.mods.mantleHeat;
    this.stats.coreHeat = heat;

    this._accumulateDrift(dtYears, heat);
    this._strainAndOrogeny(dtYears, heat, world);
    this._erode(dtYears, world);
    this._updateElevation();
    this._updateSeaLevel(world);
    this._updateStats();
    this._maybeReorganise(world);

    ledger.post('geo.subduction', 'Subduction rate', this.stats.subductionRate, 'index', {
      of: 'geo', note: 'Total convergent boundary flux. Drives arc volcanism, and with it the deep carbon source.',
    });
    ledger.post('geo.land', 'Land fraction', this.stats.landFraction * 100, '%', { of: 'geo' });
    ledger.post('geo.mountains', 'Mountain fraction', this.stats.mountainFraction * 100, '%', {
      of: 'geo', note: 'Fresh rock above 1500 m. Exposed silicate surface is the planet\'s carbon sink.',
    });
    ledger.post('geo.sealevel', 'Sea level', this.seaLevel, 'm', { of: 'geo' });
    ledger.post('geo.supercontinent', 'Supercontinent index', this.supercontinentIndex * 100, '%', {
      of: 'geo', note: 'Share of all land sitting in one connected mass. A high value dries continental interiors.',
    });
  }

  /** Plate motion is far smaller than a cell per step, so displacement is
   *  accumulated and applied as a discrete resample once it is worth a
   *  cell. That keeps advection sharp instead of smearing the crust. */
  _accumulateDrift(dtYears, heat) {
    const mesh = this.mesh;
    const threshold = (mesh.spacingKm * 0.6) / mesh.radiusKm;  // radians
    let any = false;
    for (const pl of this.plates) {
      pl.shift += pl.omega * dtYears * heat;
      if (Math.abs(pl.shift) >= threshold) any = true;
    }
    if (!any) return;

    const n = mesh.n;
    const newThickness = new Float64Array(n);
    const newAge = new Float64Array(n);
    const newSediment = new Float64Array(n);
    const tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const pl = this.plates[this.plateId[i]];
      if (Math.abs(pl.shift) < threshold) {
        newThickness[i] = this.thickness[i];
        newAge[i] = this.age[i];
        newSediment[i] = this.sediment[i];
        continue;
      }
      // Where was this piece of surface one displacement ago?
      rotateAbout(mesh.x[i], mesh.y[i], mesh.z[i], pl.ax, pl.ay, pl.az, -pl.shift, tmp);
      const src = this._walkNearest(i, tmp[0], tmp[1], tmp[2]);
      newThickness[i] = this.thickness[src];
      newAge[i] = this.age[src];
      newSediment[i] = this.sediment[src];
    }
    this.thickness.set(newThickness);
    this.age.set(newAge);
    this.sediment.set(newSediment);
    for (const pl of this.plates) if (Math.abs(pl.shift) >= threshold) pl.shift = 0;
  }

  /** Convergence thickens crust; divergence thins it and makes new ocean
   *  floor. Which of the two happens at a boundary depends on what kind of
   *  crust meets there. */
  _strainAndOrogeny(dtYears, heat, world) {
    const mesh = this.mesh;
    const n = mesh.n;
    const dtMyr = dtYears / 1e6;
    const vi = [0, 0, 0], vj = [0, 0, 0];
    let subduction = 0, rifting = 0;

    for (let i = 0; i < n; i++) {
      this.volcanism[i] *= 0.5;   // arcs fade once convergence stops
      const nb = mesh.neighboursOf(i);
      this.velocityAt(i, vi);
      let convergence = 0;
      for (let s = 0; s < nb.length; s++) {
        const j = nb[s];
        if (this.plateId[j] === this.plateId[i]) continue;  // rigid interior
        this.velocityAt(j, vj);
        // Unit vector from i toward j, in the tangent plane.
        let dx = mesh.x[j] - mesh.x[i], dy = mesh.y[j] - mesh.y[i], dz = mesh.z[j] - mesh.z[i];
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
        // Positive when j moves toward i: the boundary is closing.
        convergence += -((vj[0] - vi[0]) * dx + (vj[1] - vi[1]) * dy + (vj[2] - vi[2]) * dz);
      }
      convergence *= heat;
      this.strain[i] = convergence * 1e6;   // km/yr -> mm/yr, for display

      if (convergence > 0) {
        // Closing. Two thick blocks cannot subduct past each other, so the
        // crust piles up; otherwise the denser plate goes down.
        let neighbourThick = 0, count = 0;
        for (let s = 0; s < nb.length; s++) {
          const j = nb[s];
          if (this.plateId[j] === this.plateId[i]) continue;
          neighbourThick += this.thickness[j]; count++;
        }
        neighbourThick = count ? neighbourThick / count : this.thickness[i];
        const mine = this.thickness[i];
        const closingKm = convergence * dtYears;
        if (mine > CONTINENT_THRESHOLD && neighbourThick > CONTINENT_THRESHOLD) {
          // Continental collision: a Himalaya.
          this.thickness[i] += closingKm * 0.012 * this.params.orogenyGain * world.mods.orogeny;
          this.age[i] = Math.max(0, this.age[i] - dtMyr * 0.2);
        } else if (mine <= neighbourThick) {
          // This side goes down. Its crust is recycled into the mantle.
          this.thickness[i] = Math.max(4, this.thickness[i] - closingKm * 0.004);
          subduction += convergence;
        } else {
          // Overriding side: a volcanic arc, thickening and degassing.
          this.thickness[i] += closingKm * 0.006 * this.params.orogenyGain * world.mods.orogeny;
          this.volcanism[i] = Math.min(3, this.volcanism[i] + convergence * 4e4);
          subduction += convergence * 0.5;
        }
        this.thickness[i] = Math.min(this.thickness[i], 78);
      } else if (convergence < 0) {
        // Opening: the crust is stretched, and new basalt floors the gap.
        const openingKm = -convergence * dtYears;
        const target = OCEANIC_THICKNESS;
        const relax = Math.min(1, openingKm * 0.002);
        this.thickness[i] += (target - this.thickness[i]) * relax;
        this.age[i] *= (1 - relax);
        this.volcanism[i] = Math.min(3, this.volcanism[i] - convergence * 2e4);
        rifting += -convergence;
      }
      this.age[i] += dtMyr;
    }

    // Convergence summed over cells times the mesh spacing is a boundary
    // flux, which is independent of how finely the sphere is divided — the
    // same planet must not report different tectonics at a different cell
    // count. The divisor normalises an Earth-like configuration to ~0.3.
    const fluxScale = mesh.spacingKm / 30;
    this.stats.subductionRate = subduction * fluxScale;
    this.stats.riftRate = rifting * fluxScale;

    // Background mantle degassing: hot young worlds resurface everywhere,
    // not only along arcs.
    this.stats.volcanicActivity = heat * (0.5 + 0.5 * (this.stats.subductionRate + this.stats.riftRate))
      * world.mods.volcanism;
  }

  /** Erosion moves rock from high ground to low, and it is wetter highlands
   *  that erode fastest — which is how climate feeds back into geography. */
  _erode(dtYears, world) {
    const mesh = this.mesh;
    const n = mesh.n;
    const climate = world.climate;
    const gain = this.params.erosionGain * 2.2e-9 * dtYears;
    if (gain <= 0) return;
    for (let i = 0; i < n; i++) {
      const elev = this.elevation[i];
      if (elev <= this.seaLevel) continue;
      const above = elev - this.seaLevel;
      const wet = climate ? Math.max(0.05, climate.precipitation[i]) : 0.4;
      // Bare rock on a lifeless world erodes faster: roots hold soil.
      const cover = world.biosphere ? 1 - 0.45 * world.biosphere.landCover[i] : 1;
      let removedKm = above * wet * cover * gain / 1000;
      removedKm = Math.min(removedKm, Math.max(0, this.thickness[i] - OCEANIC_THICKNESS) * 0.02);
      if (removedKm <= 0) continue;
      this.thickness[i] -= removedKm;
      // Deposit downslope, which builds shelves and deltas.
      const nb = mesh.neighboursOf(i);
      let lowest = -1, lowestElev = elev;
      for (let s = 0; s < nb.length; s++) {
        const j = nb[s];
        if (this.elevation[j] < lowestElev) { lowestElev = this.elevation[j]; lowest = j; }
      }
      if (lowest >= 0) { this.thickness[lowest] += removedKm * 0.75; this.sediment[lowest] += removedKm; }
    }
  }

  _updateElevation() {
    const n = this.mesh.n;
    for (let i = 0; i < n; i++) {
      const t = this.thickness[i];
      let e = (t - ISOSTATIC_REF) * ISOSTATIC_GAIN;
      if (t < CONTINENT_THRESHOLD) {
        // Ocean floor cools and sinks as it ages away from the ridge.
        e -= Math.min(2600, 320 * Math.sqrt(Math.max(0, this.age[i])));
      }
      this.elevation[i] = e;
    }
  }

  /** Sea level follows from how much water exists and what shape the solid
   *  surface is in — so a supercontinent really does drop the shoreline. */
  _updateSeaLevel(world) {
    this.waterVolumeKm3 = world.hydrosphere.waterVolumeKm3;
    const area = this.mesh.cellAreaKm2;
    if (this.waterVolumeKm3 <= 0) { this.seaLevel = -12000; return; }
    let lo = -12000, hi = 12000;
    for (let iter = 0; iter < 44; iter++) {
      const mid = (lo + hi) / 2;
      let vol = 0;
      for (let i = 0; i < this.mesh.n; i++) {
        const d = mid - this.elevation[i];
        if (d > 0) vol += d * 0.001 * area;   // m -> km
      }
      if (vol > this.waterVolumeKm3) hi = mid; else lo = mid;
    }
    this.seaLevel = (lo + hi) / 2;
  }

  _updateStats() {
    const mesh = this.mesh;
    const n = mesh.n;
    let land = 0, mountain = 0, shelf = 0, sum = 0, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const e = this.elevation[i];
      sum += e;
      if (e > max) max = e;
      if (e > this.seaLevel) {
        land++;
        if (e - this.seaLevel > 1500) mountain++;
      }
    }
    // Shelf: genuinely shallow sea, plus every ocean cell that touches a
    // coast. Without the second term a world whose hypsometry happens to be
    // sharply bimodal would report no shallow water anywhere, and quietly
    // lose both its carbon burial and its only bridge onto the land.
    this.coastal.fill(0);
    for (let i = 0; i < n; i++) {
      if (this.elevation[i] > this.seaLevel) continue;
      let touchesLand = false;
      const nb = mesh.neighboursOf(i);
      for (let s = 0; s < nb.length; s++) {
        if (this.elevation[nb[s]] > this.seaLevel) { touchesLand = true; break; }
      }
      if (touchesLand || this.seaLevel - this.elevation[i] < SHELF_DEPTH) {
        this.coastal[i] = 1;
        shelf++;
      }
    }
    this.stats.landFraction = land / n;
    this.stats.mountainFraction = mountain / n;
    this.stats.shelfFraction = shelf / n;
    this.stats.meanElevation = sum / n;
    this.stats.maxElevation = max;
    this.supercontinentIndex = this._largestLandmass();
  }

  /** Fraction of all land that sits in one connected mass. */
  _largestLandmass() {
    const mesh = this.mesh;
    const n = mesh.n;
    const seen = new Uint8Array(n);
    const stack = [];
    let total = 0, best = 0;
    for (let i = 0; i < n; i++) if (this.elevation[i] > this.seaLevel) total++;
    if (total === 0) return 0;
    for (let i = 0; i < n; i++) {
      if (seen[i] || this.elevation[i] <= this.seaLevel) continue;
      let size = 0;
      stack.length = 0; stack.push(i); seen[i] = 1;
      while (stack.length) {
        const c = stack.pop();
        size++;
        const nb = mesh.neighboursOf(c);
        for (let s = 0; s < nb.length; s++) {
          const j = nb[s];
          if (!seen[j] && this.elevation[j] > this.seaLevel) { seen[j] = 1; stack.push(j); }
        }
      }
      if (size > best) best = size;
    }
    return best / total;
  }

  /** Plate boundaries do not last forever. Every couple of hundred million
   *  years the pattern reorganises; the crust itself is untouched. */
  _maybeReorganise(world) {
    if (world.year - this.lastReorganise < this.params.reorganiseEveryYears) return;
    this.lastReorganise = world.year;
    const rng = world.rng;
    if (!rng.chance(0.6)) return;
    const mesh = this.mesh;
    for (const pl of this.plates) {
      const i = rng.int(mesh.n);
      pl.cx = mesh.x[i]; pl.cy = mesh.y[i]; pl.cz = mesh.z[i];
      let ax = rng.normal(), ay = rng.normal(), az = rng.normal();
      const len = Math.hypot(ax, ay, az) || 1;
      pl.ax = ax / len; pl.ay = ay / len; pl.az = az / len;
      pl.omega = this.params.plateSpeedKmPerYear * rng.range(0.35, 1.8) / mesh.radiusKm
        * (rng.chance(0.5) ? 1 : -1);
      pl.shift = 0;
    }
    this._assignPlates();
    world.chronicle.record(world.year, 'geosphere',
      'The plate pattern reorganised: old boundaries died and new ones opened.',
      IMPORTANCE.NOTABLE);
  }

  // --- interventions -------------------------------------------------

  /** Split the plates apart under a point — the way to break a supercontinent. */
  rift(cellIndex, world, strength = 1) {
    const mesh = this.mesh;
    const px = mesh.x[cellIndex], py = mesh.y[cellIndex], pz = mesh.z[cellIndex];
    // A new plate boundary is seeded at the target, with the two halves
    // driven apart.
    const rng = world.rng;
    for (let k = 0; k < 2; k++) {
      const sign = k === 0 ? 1 : -1;
      let ax = rng.normal(), ay = rng.normal(), az = rng.normal();
      const len = Math.hypot(ax, ay, az) || 1;
      ax /= len; ay /= len; az /= len;
      this.plates.push({
        id: this.plates.length,
        cx: px + sign * 0.18 * ax, cy: py + sign * 0.18 * ay, cz: pz + sign * 0.18 * az,
        ax, ay, az,
        omega: sign * this.params.plateSpeedKmPerYear * 2.2 * strength / mesh.radiusKm,
        shift: 0,
      });
    }
    // Renormalise the new centres back onto the sphere.
    for (const pl of this.plates) {
      const l = Math.hypot(pl.cx, pl.cy, pl.cz) || 1;
      pl.cx /= l; pl.cy /= l; pl.cz /= l;
    }
    this._assignPlates();
    // Thin the crust where the rift opens.
    for (let i = 0; i < mesh.n; i++) {
      const dot = mesh.x[i] * px + mesh.y[i] * py + mesh.z[i] * pz;
      const d = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (d < 0.22) {
        const f = 1 - d / 0.22;
        this.thickness[i] -= (this.thickness[i] - OCEANIC_THICKNESS) * 0.5 * f * strength;
        this.age[i] *= 1 - 0.6 * f;
      }
    }
    this._updateElevation();
    this._updateStats();
  }

  /** A meteor: a crater, a pulse of dust, and a wave of death handled by
   *  the biosphere. The geology part lives here. */
  impact(cellIndex, radiusRad, world) {
    const mesh = this.mesh;
    const px = mesh.x[cellIndex], py = mesh.y[cellIndex], pz = mesh.z[cellIndex];
    for (let i = 0; i < mesh.n; i++) {
      const dot = mesh.x[i] * px + mesh.y[i] * py + mesh.z[i] * pz;
      const d = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (d > radiusRad) continue;
      const f = 1 - d / radiusRad;
      this.thickness[i] -= this.thickness[i] * 0.25 * f;
      this.age[i] = 0;
      this.volcanism[i] += 2.5 * f;
    }
    this._updateElevation();
    this._updateStats();
  }

  /** A mantle plume: a hotspot, flood basalts, and a great deal of CO2. */
  plume(cellIndex, world, strength = 1) {
    const mesh = this.mesh;
    const px = mesh.x[cellIndex], py = mesh.y[cellIndex], pz = mesh.z[cellIndex];
    for (let i = 0; i < mesh.n; i++) {
      const dot = mesh.x[i] * px + mesh.y[i] * py + mesh.z[i] * pz;
      const d = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (d > 0.3) continue;
      const f = 1 - d / 0.3;
      this.thickness[i] += 3.5 * f * strength;
      this.volcanism[i] += 3 * f * strength;
      this.age[i] = 0;
    }
    this._updateElevation();
    this._updateStats();
  }

  save() {
    return {
      thickness: Array.from(this.thickness),
      age: Array.from(this.age),
      plateId: Array.from(this.plateId),
      sediment: Array.from(this.sediment),
      volcanism: Array.from(this.volcanism),
      plates: this.plates.map((p) => ({ ...p })),
      seaLevel: this.seaLevel,
      lastReorganise: this.lastReorganise,
      params: { ...this.params },
    };
  }

  load(s) {
    this.thickness.set(s.thickness);
    this.age.set(s.age);
    this.plateId.set(s.plateId);
    this.sediment.set(s.sediment);
    this.volcanism.set(s.volcanism);
    this.plates = s.plates.map((p) => ({ ...p }));
    this.seaLevel = s.seaLevel;
    this.lastReorganise = s.lastReorganise;
    this.params = { ...s.params };
    this._updateElevation();
    this._updateStats();
  }
}

export const GEO_CONSTANTS = {
  OCEANIC_THICKNESS, CONTINENTAL_BASE, ISOSTATIC_REF, ISOSTATIC_GAIN, CONTINENT_THRESHOLD,
};
