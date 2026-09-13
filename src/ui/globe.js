// The planet, drawn.
//
// Cells are points on a real sphere, so the view is an orthographic
// projection of that sphere rather than a scrolling map. Rotation is driven
// by elapsed real time, never by frame count, so the globe turns at the
// same speed on a 60 Hz and a 144 Hz display — the same rule the simulation
// itself follows.

import { BIOME_NAMES } from '../sim/biosphere.js';

export const VIEW_MODES = [
  { id: 'surface', label: 'Surface', hint: 'Elevation, ice and sea, the way it would look' },
  { id: 'elevation', label: 'Elevation', hint: 'Crustal topography against sea level' },
  { id: 'plates', label: 'Plates', hint: 'Plate identity and the strain along the boundaries' },
  { id: 'temperature', label: 'Temperature', hint: 'Mean annual surface temperature' },
  { id: 'precipitation', label: 'Rainfall', hint: 'Where the water cycle actually delivers' },
  { id: 'biome', label: 'Biomes', hint: 'What the surface has become' },
  { id: 'life', label: 'Life', hint: 'Standing biomass, producers and consumers' },
];

const SEA_DEEP = [8, 24, 58];
const SEA_SHALLOW = [36, 92, 130];
const LAND_LOW = [88, 104, 70];
const LAND_HIGH = [150, 132, 104];
const PEAK = [228, 224, 214];
const ICE = [238, 246, 252];

function mix(a, b, t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function rgb(c, shade) {
  const s = shade === undefined ? 1 : shade;
  return 'rgb(' + Math.round(c[0] * s) + ',' + Math.round(c[1] * s) + ',' + Math.round(c[2] * s) + ')';
}

/** Blue-white-red, for signed fields. */
function diverging(v) {
  if (v < 0) return mix([70, 120, 210], [242, 244, 248], 1 + v);
  return mix([242, 244, 248], [208, 76, 52], v);
}

const BIOME_COLOURS = [
  [18, 44, 82],    // open ocean
  [186, 212, 230], // sea ice
  [238, 246, 252], // ice sheet
  [30, 86, 108],   // productive sea
  [198, 178, 126], // desert
  [130, 124, 116], // bare rock
  [148, 158, 140], // tundra
  [166, 164, 96],  // steppe
  [46, 112, 56],   // tropical forest
  [72, 124, 78],   // temperate forest
];

export class GlobeView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'surface';
    this.rotation = 0;          // radians about the polar axis
    this.tilt = 0.38;           // radians; a slight lean, so poles read
    this.spinRate = 0.045;      // radians per real second
    this.spinning = true;
    this.pickedCell = null;
    this.hoverCell = null;
    this._dragging = false;
    this._lastPointer = null;
    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      this._lastPointer = { x: e.clientX, y: e.clientY, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (this._dragging && this._lastPointer) {
        const dx = e.clientX - this._lastPointer.x;
        const dy = e.clientY - this._lastPointer.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) this._lastPointer.moved = true;
        this.rotation -= dx * 0.006;
        this.tilt = Math.max(-1.4, Math.min(1.4, this.tilt + dy * 0.005));
        this._lastPointer.x = e.clientX;
        this._lastPointer.y = e.clientY;
      }
      this.hoverCell = this._cellAt(e);
    });
    const release = (e) => {
      if (this._dragging && this._lastPointer && !this._lastPointer.moved) {
        const cell = this._cellAt(e);
        if (cell !== null) {
          this.pickedCell = cell;
          if (this.onPick) this.onPick(cell);
        }
      }
      this._dragging = false;
      this._lastPointer = null;
    };
    c.addEventListener('pointerup', release);
    c.addEventListener('pointercancel', () => { this._dragging = false; });
    c.addEventListener('pointerleave', () => { this.hoverCell = null; });
  }

  /** Screen point -> cell index, by inverting the projection. */
  _cellAt(event) {
    const world = this._world;
    if (!world) return null;
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const { cx, cy, radius } = this._layout(rect.width, rect.height);
    const x = (px - cx) / radius;
    const y = -(py - cy) / radius;
    const r2 = x * x + y * y;
    if (r2 > 1) return null;
    const z = Math.sqrt(1 - r2);
    // Undo the tilt, then the spin.
    const ct = Math.cos(-this.tilt), st = Math.sin(-this.tilt);
    const y1 = y * ct - z * st;
    const z1 = y * st + z * ct;
    const cr = Math.cos(-this.rotation), sr = Math.sin(-this.rotation);
    const wx = x * cr - z1 * sr;
    const wz = x * sr + z1 * cr;
    return world.mesh.nearest(wx, wz, y1);
  }

  _layout(w, h) {
    const radius = Math.min(w, h) * 0.44;
    return { cx: w / 2, cy: h / 2, radius };
  }

  /**
   * @param {object} world
   * @param {number} dtSeconds real elapsed time, used only for the spin
   */
  draw(world, dtSeconds) {
    this._world = world;
    if (this.spinning && !this._dragging) this.rotation += this.spinRate * dtSeconds;

    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { cx, cy, radius } = this._layout(w, h);
    const mesh = world.mesh;

    // Space, and the limb glow of an atmosphere.
    const halo = ctx.createRadialGradient(cx, cy, radius * 0.92, cx, cy, radius * 1.16);
    const thick = Math.min(1, Math.log10(Math.max(1, world.climate.co2ppm)) / 5);
    halo.addColorStop(0, 'rgba(120,180,255,' + (0.06 + 0.22 * thick).toFixed(3) + ')');
    halo.addColorStop(1, 'rgba(120,180,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, radius * 1.16, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#05070d';
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();

    const cr = Math.cos(this.rotation), sr = Math.sin(this.rotation);
    const ct = Math.cos(this.tilt), st = Math.sin(this.tilt);
    // Splat radius. Cells on a Fibonacci lattice sit about sqrt(4*pi/n)
    // radians apart, so a splat of half that angular spacing exactly touches
    // its neighbours; a little more than half makes the sphere read as a
    // surface rather than as a point cloud, at any cell count.
    const splat = radius * 2.05 / Math.sqrt(mesh.n);

    // Project once, then draw back to front. Splats overlap their neighbours,
    // so without an order the cell that happens to come last in mesh order
    // wins the overlap and the sphere acquires a scaly texture; drawing the
    // most face-on cells last keeps the visible surface the nearest one.
    if (!this._order || this._order.length !== mesh.n) {
      this._order = new Int32Array(mesh.n);
      this._proj = new Float64Array(mesh.n * 3);
    }
    const proj = this._proj;
    let visible = 0;
    const order = this._order;
    for (let i = 0; i < mesh.n; i++) {
      const x0 = mesh.x[i], y0 = mesh.y[i], z0 = mesh.z[i];
      const xr = x0 * cr + y0 * sr;
      const yr = -x0 * sr + y0 * cr;
      const yv = z0 * ct + yr * st;
      const zv = -z0 * st + yr * ct;
      if (zv <= 0.02) continue;                       // far hemisphere
      proj[i * 3] = xr; proj[i * 3 + 1] = yv; proj[i * 3 + 2] = zv;
      order[visible++] = i;
    }
    const slice = order.subarray(0, visible);
    Array.prototype.sort.call(slice, (a, b) => proj[a * 3 + 2] - proj[b * 3 + 2]);

    for (let k = 0; k < visible; k++) {
      const i = slice[k];
      const xr = proj[i * 3], yv = proj[i * 3 + 1], zv = proj[i * 3 + 2];
      // Lambert shading from a light a little to the left of the viewer.
      const shade = 0.60 + 0.40 * Math.max(0, zv * 0.55 + xr * -0.45 + yv * 0.25 + 0.45);
      ctx.fillStyle = this._colourOf(world, i, shade);
      ctx.beginPath();
      ctx.arc(cx + xr * radius, cy - yv * radius, splat, 0, Math.PI * 2);
      ctx.fill();
    }

    this._drawMarkers(ctx, world, cx, cy, radius, cr, sr, ct, st);
    this._drawLimb(ctx, cx, cy, radius);
  }

  _colourOf(world, i, shade) {
    const geo = world.geosphere;
    const cl = world.climate;
    const bio = world.biosphere;
    const ocean = geo.elevation[i] <= geo.seaLevel;
    const hasWater = world.hydrosphere.waterVolumeKm3 > 1e7;

    switch (this.mode) {
      case 'elevation': {
        const rel = geo.elevation[i] - geo.seaLevel;
        if (rel <= 0) return rgb(mix(SEA_DEEP, SEA_SHALLOW, 1 + rel / 6000), shade);
        return rgb(mix(LAND_LOW, PEAK, Math.min(1, rel / 6000)), shade);
      }
      case 'plates': {
        const p = geo.plateId[i];
        const hue = (p * 47) % 360;
        const strain = Math.min(1, Math.abs(geo.strain[i]) / 60);
        const light = 34 + strain * 40;
        return 'hsl(' + hue + ',' + (30 + strain * 55) + '%,' + (light * shade).toFixed(0) + '%)';
      }
      case 'temperature':
        return rgb(diverging(Math.max(-1, Math.min(1, (cl.temperature[i] - 12) / 32))), shade);
      case 'precipitation': {
        const p = Math.min(1, cl.precipitation[i] / 1.6);
        return rgb(mix([120, 96, 64], [40, 120, 190], p), shade);
      }
      case 'biome':
        return rgb(BIOME_COLOURS[bio.biome[i]] || BIOME_COLOURS[0], shade);
      case 'life': {
        const d = bio.producerDensity[i] * 2.5 + bio.consumerDensity[i] * 4;
        if (d < 0.01) return rgb(ocean ? SEA_DEEP : [64, 62, 58], shade * 0.8);
        return rgb(mix([40, 70, 60], [120, 224, 140], Math.min(1, d)), shade);
      }
      default: {
        // Surface: what it would look like from orbit.
        if (!hasWater) {
          const rel = geo.elevation[i] + 4000;
          return rgb(mix([62, 46, 40], [148, 126, 110], Math.min(1, rel / 8000)), shade);
        }
        if (cl.ice[i] > 0.35) return rgb(mix([190, 214, 232], ICE, cl.ice[i]), shade);
        if (ocean) {
          const depth = geo.seaLevel - geo.elevation[i];
          const base = mix(SEA_SHALLOW, SEA_DEEP, Math.min(1, depth / 4500));
          const bloom = Math.min(0.5, bio.producerDensity[i] * 1.6);
          return rgb(mix(base, [40, 118, 104], bloom), shade);
        }
        const rel = geo.elevation[i] - geo.seaLevel;
        let c = mix(LAND_LOW, LAND_HIGH, Math.min(1, rel / 3000));
        if (rel > 3000) c = mix(c, PEAK, Math.min(1, (rel - 3000) / 2500));
        const veg = bio.landCover[i];
        if (veg > 0.02) c = mix(c, [54, 104, 52], Math.min(0.85, veg));
        else if (cl.precipitation[i] < 0.25) c = mix(c, [186, 164, 116], 0.6);
        return rgb(c, shade);
      }
    }
  }

  _drawMarkers(ctx, world, cx, cy, radius, cr, sr, ct, st) {
    const mark = (i, colour, size, dashed) => {
      const mesh = world.mesh;
      const x0 = mesh.x[i], y0 = mesh.y[i], z0 = mesh.z[i];
      const xr = x0 * cr + y0 * sr;
      const yr = -x0 * sr + y0 * cr;
      const yv = z0 * ct + yr * st;
      const zv = -z0 * st + yr * ct;
      if (zv <= 0) return;
      ctx.save();
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5;
      if (dashed) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(cx + xr * radius, cy - yv * radius, size, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    };
    if (this.hoverCell !== null && this.hoverCell !== this.pickedCell) {
      mark(this.hoverCell, 'rgba(255,255,255,0.45)', 6, true);
    }
    if (this.pickedCell !== null) mark(this.pickedCell, '#ffd479', 9, false);
  }

  _drawLimb(ctx, cx, cy, radius) {
    ctx.save();
    ctx.strokeStyle = 'rgba(150,190,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  /** Text for the inspector when a cell is selected. */
  static describeCell(world, i) {
    if (i === null || i === undefined) return null;
    const geo = world.geosphere, cl = world.climate, bio = world.biosphere;
    const ocean = geo.elevation[i] <= geo.seaLevel;
    const lat = world.mesh.lat[i] * 180 / Math.PI;
    const lon = world.mesh.lon[i] * 180 / Math.PI;
    const dominant = bio.dominant[i] >= 0
      ? bio.species.find((s) => s.id === bio.dominant[i]) : null;
    return {
      index: i,
      position: lat.toFixed(1) + (lat >= 0 ? ' N ' : ' S ') + Math.abs(lon).toFixed(1)
        + (lon >= 0 ? ' E' : ' W'),
      elevation: geo.elevation[i],
      relative: geo.elevation[i] - geo.seaLevel,
      ocean,
      coastal: !!geo.coastal[i],
      crust: geo.thickness[i],
      crustAge: geo.age[i],
      plate: geo.plateId[i],
      strain: geo.strain[i],
      temperature: cl.temperature[i],
      precipitation: cl.precipitation[i],
      ice: cl.ice[i],
      biome: BIOME_NAMES[bio.biome[i]] || 'unknown',
      vegetation: bio.landCover[i],
      dominant: dominant ? dominant.name : null,
      dominantDesc: dominant ? dominant.describe() : null,
    };
  }
}
