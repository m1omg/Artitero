// The planetary cycle diagram.
//
// This is an ordinary window, not a bonus for enthusiasts. The frustration
// with old simulators was never the complexity — it was never finding out
// why your planet froze. So the carbon cycle is drawn as reservoirs and
// flows, with live numbers, taken from the same ledger the model wrote
// while it was stepping.

const RESERVOIRS = [
  { id: 'atmosphere', label: 'Atmosphere', x: 0.5, y: 0.14, get: (w) => w.climate.carbon.atmosphere },
  { id: 'ocean', label: 'Ocean', x: 0.16, y: 0.44, get: (w) => w.climate.carbon.ocean },
  { id: 'biosphere', label: 'Living biomass', x: 0.84, y: 0.40, get: (w) => w.biosphere.productivity * 12 },
  { id: 'organic', label: 'Buried organic', x: 0.72, y: 0.74, get: (w) => w.climate.carbon.organic },
  { id: 'carbonate', label: 'Crustal carbonate', x: 0.28, y: 0.74, get: (w) => w.climate.carbon.carbonate },
  { id: 'mantle', label: 'Mantle', x: 0.5, y: 0.93, get: (w) => w.climate.carbon.mantle },
];

const FLOWS = [
  { from: 'mantle', to: 'atmosphere', key: 'volcanism', label: 'volcanism', bend: -0.30 },
  { from: 'atmosphere', to: 'carbonate', key: 'weathering', label: 'silicate weathering', bend: 0.14 },
  { from: 'ocean', to: 'carbonate', key: 'seafloor', label: 'seafloor weathering', bend: 0.10 },
  { from: 'atmosphere', to: 'biosphere', key: 'photosynthesis', label: 'photosynthesis', bend: -0.12 },
  { from: 'biosphere', to: 'atmosphere', key: 'respiration', label: 'respiration', bend: 0.12 },
  { from: 'biosphere', to: 'organic', key: 'burial', label: 'burial', bend: 0 },
  { from: 'organic', to: 'atmosphere', key: 'oxidation', label: 'oxidation', bend: 0.34 },
  { from: 'carbonate', to: 'mantle', key: 'subduction', label: 'subduction', bend: 0.10 },
  { from: 'organic', to: 'atmosphere', key: 'anthropogenic', label: 'industry', bend: 0.46, accent: '#ff9d6b' },
];

export class CycleDiagram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hover = null;
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
    canvas.addEventListener('pointerleave', () => { this.hover = null; });
  }

  draw(world) {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 8 || h < 8) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const flows = world.climate.lastFlows || {};
    const pos = {};
    for (const r of RESERVOIRS) pos[r.id] = { x: r.x * w, y: r.y * h };

    // Flows first, so the reservoir chips sit on top of them.
    let maxFlow = 0.02;
    for (const f of FLOWS) maxFlow = Math.max(maxFlow, Math.abs(flows[f.key] || 0));

    let hovered = null;
    for (const f of FLOWS) {
      const value = flows[f.key] || 0;
      if (f.key === 'anthropogenic' && value <= 0) continue;
      const a = pos[f.from], b = pos[f.to];
      const width = 0.8 + 5.2 * Math.sqrt(Math.abs(value) / maxFlow);
      const mid = this._curve(ctx, a, b, f.bend, width,
        f.accent || (value > 0 ? 'rgba(150,196,255,0.55)' : 'rgba(120,120,140,0.3)'));
      if (this.hover && Math.hypot(this.hover.x - mid.x, this.hover.y - mid.y) < 26) {
        hovered = { label: f.label, value, x: mid.x, y: mid.y };
      }
      ctx.fillStyle = 'rgba(226,232,244,0.75)';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(fmtFlow(value), mid.x, mid.y - 4);
    }

    for (const r of RESERVOIRS) {
      const p = pos[r.id];
      const value = r.get(world);
      const label = r.label;
      const text = fmtStock(value);
      ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
      const tw = Math.max(ctx.measureText(label).width, ctx.measureText(text).width) + 18;
      const boxW = tw, boxH = 34;
      ctx.fillStyle = 'rgba(16,22,34,0.94)';
      ctx.strokeStyle = 'rgba(140,170,220,0.35)';
      roundRect(ctx, p.x - boxW / 2, p.y - boxH / 2, boxW, boxH, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#cfd9ea';
      ctx.textAlign = 'center';
      ctx.fillText(label, p.x, p.y - 2);
      ctx.fillStyle = '#8fb6ff';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(text, p.x, p.y + 12);
    }

    if (hovered) {
      const text = hovered.label + ': ' + fmtFlow(hovered.value) + ' GtC/yr';
      ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
      const tw = ctx.measureText(text).width + 14;
      ctx.fillStyle = 'rgba(8,12,20,0.95)';
      ctx.strokeStyle = 'rgba(140,170,220,0.5)';
      roundRect(ctx, hovered.x - tw / 2, hovered.y - 34, tw, 20, 5);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e8eef8';
      ctx.textAlign = 'center';
      ctx.fillText(text, hovered.x, hovered.y - 20);
    }
  }

  _curve(ctx, a, b, bend, width, colour) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const cx = mx - dy * bend, cy = my + dx * bend;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(cx, cy, b.x, b.y);
    ctx.stroke();

    // Arrow head at the far end, pointing along the tangent.
    const tx = b.x - cx, ty = b.y - cy;
    const len = Math.hypot(tx, ty) || 1;
    const ux = tx / len, uy = ty / len;
    const hx = b.x - ux * 13, hy = b.y - uy * 13;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(hx + ux * 9, hy + uy * 9);
    ctx.lineTo(hx - uy * 4.5, hy + ux * 4.5);
    ctx.lineTo(hx + uy * 4.5, hy - ux * 4.5);
    ctx.closePath();
    ctx.fill();
    // Point on the curve at t = 0.5, where the label goes.
    return { x: 0.25 * a.x + 0.5 * cx + 0.25 * b.x, y: 0.25 * a.y + 0.5 * cy + 0.25 * b.y };
  }
}

function fmtFlow(v) {
  const a = Math.abs(v);
  if (a < 0.0005) return '0';
  if (a < 1) return v.toFixed(3);
  return v.toFixed(2);
}

function fmtStock(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M GtC';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k GtC';
  return v.toFixed(0) + ' GtC';
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
