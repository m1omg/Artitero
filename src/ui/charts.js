// Time series, drawn against deep time.
//
// A run spans four billion years and a thousand-fold range in CO2, so the
// series are drawn on their own scales with a shared time axis, and two
// branches can be overlaid on the same axes for comparison.

export const SERIES = [
  { id: 'temp', label: 'Temperature', unit: 'C', colour: '#ff8b6b', scale: 'linear' },
  { id: 'co2', label: 'CO2', unit: 'ppm', colour: '#9ad9a0', scale: 'log' },
  { id: 'o2', label: 'O2', unit: '%', colour: '#7fc4ff', scale: 'linear' },
  { id: 'ice', label: 'Ice cover', unit: 'fraction', colour: '#dfe9f5', scale: 'linear' },
  { id: 'land', label: 'Land', unit: 'fraction', colour: '#d0b189', scale: 'linear' },
  { id: 'diversity', label: 'Species', unit: 'count', colour: '#c9a6ff', scale: 'linear' },
  { id: 'productivity', label: 'Productivity', unit: 'GtC/yr', colour: '#8fe3c8', scale: 'linear' },
  { id: 'tech', label: 'Technology', unit: 'level', colour: '#ffd479', scale: 'linear' },
];

export function seriesById(id) { return SERIES.find((s) => s.id === id) || SERIES[0]; }

export class ChartView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.active = ['temp', 'co2', 'o2'];
    this.markerYear = null;      // scrub position, for rewinding
    this.onScrub = null;
    this._bind();
  }

  _bind() {
    const pick = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const t = (e.clientX - rect.left - this._pad) / Math.max(1, this._plotW);
      if (!this._span) return;
      const year = this._span[0] + (this._span[1] - this._span[0]) * Math.max(0, Math.min(1, t));
      this.markerYear = year;
      if (this.onScrub) this.onScrub(year);
    };
    this.canvas.addEventListener('pointerdown', (e) => { this._down = true; pick(e); });
    this.canvas.addEventListener('pointermove', (e) => { if (this._down) pick(e); });
    window.addEventListener('pointerup', () => { this._down = false; });
  }

  toggle(id) {
    const i = this.active.indexOf(id);
    if (i >= 0) { if (this.active.length > 1) this.active.splice(i, 1); }
    else this.active.push(id);
  }

  /**
   * @param {Array<{world:object,colour:string,label:string}>} tracks
   */
  draw(tracks) {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!tracks.length) return;

    const pad = 34;
    this._pad = pad;
    const plotW = w - pad * 2;
    const plotH = h - 26;
    this._plotW = plotW;

    let maxYear = 0;
    for (const t of tracks) maxYear = Math.max(maxYear, t.world.year);
    maxYear = Math.max(maxYear, 1);
    this._span = [0, maxYear];

    // Time grid, in units that make sense for the span reached so far.
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.lineWidth = 1;
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const x = pad + (plotW * i) / ticks;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, plotH); ctx.stroke();
      const year = (maxYear * i) / ticks;
      const label = maxYear >= 1e9 ? (year / 1e9).toFixed(1) + ' Gyr'
        : maxYear >= 1e6 ? (year / 1e6).toFixed(0) + ' Myr'
          : (year / 1e3).toFixed(0) + ' kyr';
      ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
      ctx.fillText(label, x, h - 8);
    }

    for (const id of this.active) {
      const spec = seriesById(id);
      // One shared range per series across all tracks, so two branches are
      // genuinely comparable rather than each filling its own box.
      let lo = Infinity, hi = -Infinity;
      for (const t of tracks) {
        for (const s of t.world.history) {
          const v = this._value(spec, s[id]);
          if (!Number.isFinite(v)) continue;
          if (v < lo) lo = v; if (v > hi) hi = v;
        }
      }
      if (!Number.isFinite(lo) || hi - lo < 1e-9) { hi = lo + 1; }

      for (let k = 0; k < tracks.length; k++) {
        const track = tracks[k];
        ctx.strokeStyle = tracks.length > 1 ? track.colour : spec.colour;
        ctx.globalAlpha = tracks.length > 1 && k > 0 ? 0.75 : 1;
        ctx.lineWidth = 1.4;
        ctx.setLineDash(tracks.length > 1 && k > 0 ? [4, 3] : []);
        ctx.beginPath();
        let started = false;
        for (const s of track.world.history) {
          const v = this._value(spec, s[id]);
          if (!Number.isFinite(v)) continue;
          const x = pad + (s.year / maxYear) * plotW;
          const y = plotH - ((v - lo) / (hi - lo)) * (plotH - 12) - 6;
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // Label with the current value of the first track.
      const last = tracks[0].world.history[tracks[0].world.history.length - 1];
      if (last) {
        ctx.fillStyle = spec.colour;
        ctx.textAlign = 'left';
        const idx = this.active.indexOf(id);
        ctx.fillText(spec.label + ' ' + formatValue(spec, last[id]), pad + 4, 12 + idx * 12);
      }
    }

    if (this.markerYear !== null) {
      const x = pad + (this.markerYear / maxYear) * plotW;
      ctx.strokeStyle = '#ffd479';
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  _value(spec, raw) {
    if (raw === undefined || raw === null) return NaN;
    if (spec.scale === 'log') return Math.log10(Math.max(1e-3, raw));
    return raw;
  }
}

export function formatValue(spec, raw) {
  if (raw === undefined || raw === null) return '-';
  if (spec.unit === 'ppm') return raw >= 1000 ? (raw / 1000).toFixed(1) + 'k' : raw.toFixed(0);
  if (spec.unit === 'fraction') return (raw * 100).toFixed(0) + '%';
  if (spec.unit === 'count') return String(Math.round(raw));
  return raw.toFixed(raw < 10 ? 1 : 0);
}
