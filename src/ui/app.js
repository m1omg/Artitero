// Wiring: clock, world, branches, panels.
//
// The render loop and the simulation loop are separate on purpose. The
// browser calls draw() whenever it likes; the clock consumes elapsed real
// seconds and issues whole simulation steps at a fixed rate. Frame time
// never reaches the model, so a 60 Hz and a 144 Hz display produce the same
// planet from the same seed.

import { World } from '../sim/world.js';
import { FixedStepClock, TIME_SCALES, scaleById } from '../core/clock.js';
import { formatYear } from '../core/chronicle.js';
import { listModules } from '../sim/registry.js';
import { Timeline } from '../game/timeline.js';
import { CHALLENGES, challengeById, applySetup } from '../game/challenges.js';
import { applyIntervention } from '../game/interventions.js';
import { GlobeView, VIEW_MODES } from './globe.js';
import { ChartView, SERIES } from './charts.js';
import { CycleDiagram } from './diagram.js';
import * as panels from './panels.js';
import { eraName } from '../sim/civilisation.js';

const $ = (sel) => document.querySelector(sel);

class App {
  constructor() {
    this.globe = new GlobeView($('#globe'));
    this.compareGlobe = new GlobeView($('#globe-compare'));
    this.charts = new ChartView($('#charts'));
    this.diagram = new CycleDiagram($('#cycle'));
    this.panelTab = 'model';
    this.lastPanelPaint = 0;
    this.toastTimer = 0;
    this.autoScaleDone = false;

    this.globe.onPick = () => this.paintPanels(true);
    this.charts.onScrub = (year) => this.previewScrub(year);

    this.clock = new FixedStepClock(() => {});
    this.newWorld(this.readSetupFromUrl());
    this.buildControls();
    this.loop = this.loop.bind(this);
    this.lastFrame = performance.now();
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------

  readSetupFromUrl() {
    const params = new URLSearchParams(location.hash.slice(1));
    return {
      seed: params.get('seed') || 'genesis',
      challenge: params.get('challenge') || 'sandbox',
      cells: Number(params.get('cells')) || 1400,
      climateModel: params.get('climate') || 'default',
      biosphereModel: params.get('biosphere') || 'default',
    };
  }

  writeUrl() {
    const p = new URLSearchParams();
    p.set('seed', this.setup.seed);
    p.set('challenge', this.challenge.id);
    p.set('cells', String(this.setup.cells));
    if (this.setup.climateModel !== 'default') p.set('climate', this.setup.climateModel);
    if (this.setup.biosphereModel !== 'default') p.set('biosphere', this.setup.biosphereModel);
    history.replaceState(null, '', '#' + p.toString());
  }

  newWorld(setup) {
    this.setup = setup;
    this.challenge = challengeById(setup.challenge);
    const world = new World({
      seed: setup.seed,
      cells: setup.cells,
      climateModel: setup.climateModel,
      biosphereModel: setup.biosphereModel,
      energyBudget: this.challenge.setup.energyBudget || 120,
    });
    applySetup(world, this.challenge);
    world._settle();
    this.timeline = new Timeline(world);
    this.clock = new FixedStepClock((dt) => this.stepAll(dt));
    this.clock.setScale(TIME_SCALES[0]);
    this.clock.setSpeed(0);
    this.autoScaleDone = false;
    this.globe.pickedCell = null;
    this.charts.markerYear = null;
    this.writeUrl();
    this.refreshHeader();
    this.paintPanels(true);
  }

  stepAll(dtYears) {
    for (const branch of this.timeline.running()) {
      branch.world.step(dtYears);
      this.timeline.onStep(branch);
    }
    const world = this.timeline.active.world;
    // A civilisation moves on a clock thousands of times faster than the
    // geology around it. Dropping the time scale for the player the moment
    // one appears is the difference between watching an industrial age and
    // finding out it happened.
    if (!this.autoScaleDone && world.civilisation) {
      this.autoScaleDone = true;
      this.setScale('ecological');
      this.toast('A civilisation has appeared. Time scale dropped to ecological.');
    }
    if (world.ended && !this._endShown) {
      this._endShown = true;
      this.clock.setSpeed(0);
      this.showEnding(world);
    }
  }

  // ---------------------------------------------------------------

  buildControls() {
    const scaleRow = $('#scales');
    scaleRow.textContent = '';
    for (const s of TIME_SCALES) {
      const b = document.createElement('button');
      b.className = 'scale-btn';
      b.dataset.scale = s.id;
      b.innerHTML = '<strong>' + s.label + '</strong><span>'
        + formatYear(s.years) + ' / step</span>';
      b.title = s.hint;
      b.addEventListener('click', () => this.setScale(s.id));
      scaleRow.appendChild(b);
    }

    const modeRow = $('#view-modes');
    modeRow.textContent = '';
    for (const m of VIEW_MODES) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.mode = m.id;
      b.textContent = m.label;
      b.title = m.hint;
      b.addEventListener('click', () => {
        this.globe.mode = m.id;
        this.compareGlobe.mode = m.id;
        this.refreshHeader();
      });
      modeRow.appendChild(b);
    }

    const seriesRow = $('#series-toggles');
    seriesRow.textContent = '';
    for (const s of SERIES) {
      const b = document.createElement('button');
      b.className = 'chip tiny';
      b.dataset.series = s.id;
      b.textContent = s.label;
      b.style.borderColor = s.colour;
      b.addEventListener('click', () => { this.charts.toggle(s.id); this.refreshHeader(); });
      seriesRow.appendChild(b);
    }

    $('#play').addEventListener('click', () => {
      this.clock.setSpeed(this.clock.paused ? 1 : 0);
      this.refreshHeader();
    });
    for (const speed of [1, 2, 4, 8]) {
      const b = document.createElement('button');
      b.className = 'chip tiny';
      b.dataset.speed = String(speed);
      b.textContent = speed + '×';
      b.addEventListener('click', () => { this.clock.setSpeed(speed); this.refreshHeader(); });
      $('#speeds').appendChild(b);
    }

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        this.panelTab = tab.dataset.tab;
        this.paintPanels(true);
      });
    }

    $('#spin').addEventListener('click', () => {
      this.globe.spinning = !this.globe.spinning;
      this.compareGlobe.spinning = this.globe.spinning;
      this.refreshHeader();
    });

    $('#rewind').addEventListener('click', () => this.rewindHere());
    $('#fork').addEventListener('click', () => this.forkHere());

    const seedInput = $('#seed-input');
    seedInput.value = this.setup.seed;
    $('#new-world').addEventListener('click', () => {
      this.newWorld({ ...this.setup, seed: seedInput.value.trim() || 'genesis' });
      this._endShown = false;
      $('#ending').classList.add('hidden');
    });
    $('#random-seed').addEventListener('click', () => {
      // The only place in the whole program that is allowed to be random:
      // choosing which deterministic world to run.
      const seed = Math.random().toString(36).slice(2, 10);
      seedInput.value = seed;
      this.newWorld({ ...this.setup, seed });
      this._endShown = false;
      $('#ending').classList.add('hidden');
    });

    const challengeSel = $('#challenge-select');
    for (const c of CHALLENGES) {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      challengeSel.appendChild(o);
    }
    challengeSel.value = this.challenge.id;
    challengeSel.addEventListener('change', () => {
      const c = challengeById(challengeSel.value);
      this.newWorld({ ...this.setup, challenge: c.id, seed: c.setup.seed || this.setup.seed });
      $('#seed-input').value = this.setup.seed;
      this._endShown = false;
      $('#ending').classList.add('hidden');
    });

    for (const [kind, sel] of [['climate', $('#climate-model')], ['biosphere', $('#biosphere-model')]]) {
      for (const m of listModules(kind)) {
        const o = document.createElement('option');
        o.value = m.id; o.textContent = m.label; o.title = m.describe;
        sel.appendChild(o);
      }
      sel.value = kind === 'climate' ? this.setup.climateModel : this.setup.biosphereModel;
      sel.addEventListener('change', () => {
        const next = { ...this.setup };
        if (kind === 'climate') next.climateModel = sel.value; else next.biosphereModel = sel.value;
        this.newWorld(next);
        this._endShown = false;
        $('#ending').classList.add('hidden');
      });
    }

    $('#share').addEventListener('click', () => {
      navigator.clipboard?.writeText(location.href);
      this.toast('Replay string copied. Same seed, same planet.');
    });
    $('#close-ending').addEventListener('click', () => $('#ending').classList.add('hidden'));

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
      if (e.key >= '1' && e.key <= '4') this.setScale(TIME_SCALES[Number(e.key) - 1].id);
      if (e.key === 'r') this.rewindHere();
      if (e.key === 'f') this.forkHere();
    });

    this.refreshHeader();
  }

  setScale(id) {
    this.clock.setScale(scaleById(id));
    this.refreshHeader();
  }

  // ---------------------------------------------------------------

  previewScrub(year) {
    this._scrubYear = year;
    $('#scrub-label').textContent = 'at ' + formatYear(year);
  }

  rewindHere() {
    const branch = this.timeline.active;
    const year = this._scrubYear !== undefined ? this._scrubYear : branch.world.year;
    const frame = this.timeline.rewind(branch, year);
    if (!frame) { this.toast('No keyframe that far back.'); return; }
    this.clock.setSpeed(0);
    this._endShown = false;
    $('#ending').classList.add('hidden');
    this.toast('Rewound to ' + formatYear(frame.year) + '. The future after it is gone.');
    this.paintPanels(true);
  }

  forkHere() {
    const branch = this.timeline.active;
    const year = this._scrubYear !== undefined ? this._scrubYear : branch.world.year;
    const child = this.timeline.fork(branch, year, 'branch ' + this.timeline.nextBranchId);
    if (!child) { this.toast('No keyframe that far back.'); return; }
    this.timeline.activeId = child.id;
    this.timeline.compareId = branch.id;
    this.clock.setSpeed(0);
    this.panelTab = 'branches';
    this.toast('Forked at ' + formatYear(child.world.year)
      + '. Both branches now run side by side.');
    this.paintPanels(true);
  }

  applyIntervention(id) {
    const world = this.timeline.active.world;
    const result = applyIntervention(world, id, { cell: this.globe.pickedCell ?? undefined });
    this.toast(result.ok ? result.message : result.message);
    this.paintPanels(true);
  }

  toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
  }

  showEnding(world) {
    const box = $('#ending');
    box.classList.remove('hidden');
    $('#ending-title').textContent = world.ended.reason === 'departed'
      ? 'They left.' : 'The world burned.';
    $('#ending-text').textContent = world.ended.text;
    const list = $('#ending-chronicle');
    list.textContent = '';
    for (const e of world.chronicle.entries.filter((x) => x.importance >= 3)) {
      const row = document.createElement('div');
      row.className = 'chron-entry imp-' + e.importance;
      const when = document.createElement('div');
      when.className = 'chron-when';
      when.textContent = formatYear(e.year);
      row.appendChild(when);
      const text = document.createElement('div');
      text.className = 'chron-text';
      text.textContent = e.text;
      row.appendChild(text);
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------

  refreshHeader() {
    const world = this.timeline.active.world;
    const s = world.summary();
    $('#year').textContent = formatYear(world.year);
    $('#year-sub').textContent = 'star age ' + world.starAgeGyr().toFixed(2)
      + ' Gyr · luminosity ' + s.luminosity.toFixed(2) + '×';
    const stats = [
      ['temperature', s.temp.toFixed(1) + ' C'],
      ['CO2', s.co2 >= 10000 ? (s.co2 / 1000).toFixed(1) + 'k ppm' : s.co2.toFixed(0) + ' ppm'],
      ['O2', s.o2.toFixed(1) + '%'],
      ['ice', (s.ice * 100).toFixed(0) + '%'],
      ['land', (s.land * 100).toFixed(0) + '%'],
      ['ocean', (s.water / 1e9).toFixed(2) + ' bn km³'],
      ['species', String(s.diversity)],
      ['energy', s.energy.toFixed(0)],
    ];
    if (world.civilisation) stats.push(['civilisation', eraName(world.civilisation.tech)]);
    const bar = $('#stats');
    bar.textContent = '';
    for (const [k, v] of stats) {
      const chip = document.createElement('div');
      chip.className = 'stat';
      const label = document.createElement('span');
      label.className = 'stat-label'; label.textContent = k;
      const value = document.createElement('span');
      value.className = 'stat-value'; value.textContent = v;
      chip.appendChild(label); chip.appendChild(value);
      bar.appendChild(chip);
    }

    $('#play').textContent = this.clock.paused ? '▶ run' : '❚❚ pause';
    $('#spin').textContent = this.globe.spinning ? 'spin: on' : 'spin: off';
    for (const b of document.querySelectorAll('.scale-btn')) {
      b.classList.toggle('on', b.dataset.scale === this.clock.scale.id);
    }
    for (const b of document.querySelectorAll('[data-speed]')) {
      b.classList.toggle('on', Number(b.dataset.speed) === this.clock.speed);
    }
    for (const b of document.querySelectorAll('[data-mode]')) {
      b.classList.toggle('on', b.dataset.mode === this.globe.mode);
    }
    for (const b of document.querySelectorAll('[data-series]')) {
      b.classList.toggle('on', this.charts.active.includes(b.dataset.series));
    }
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('on', t.dataset.tab === this.panelTab);
    }
    $('#fingerprint').textContent = world.fingerprint();
    const compare = this.timeline.compare;
    $('#compare-wrap').classList.toggle('hidden', !compare);
    $('#compare-label').textContent = compare ? compare.label : '';
  }

  paintPanels(force) {
    const now = performance.now();
    if (!force && now - this.lastPanelPaint < 180) return;
    this.lastPanelPaint = now;
    const world = this.timeline.active.world;
    const host = $('#panel-body');
    host.dataset.panel = this.panelTab;
    host.__rerender = () => this.paintPanels(true);

    switch (this.panelTab) {
      case 'model': panels.renderLedger(host, world); break;
      case 'chronicle': panels.renderChronicle(host, world); break;
      case 'species': panels.renderSpecies(host, world); break;
      case 'tools':
        panels.renderInterventions(host, world, {
          pickedCell: this.globe.pickedCell,
          onApply: (id) => this.applyIntervention(id),
        });
        break;
      case 'branches':
        panels.renderBranches(host, this.timeline, {
          onActivate: (id) => { this.timeline.activeId = id; this.paintPanels(true); },
          onCompare: (id) => {
            this.timeline.compareId = this.timeline.compareId === id ? null : id;
            this.paintPanels(true);
          },
          onDiscard: (id) => { this.timeline.removeBranch(id); this.paintPanels(true); },
        });
        break;
      case 'challenge': panels.renderChallenge(host, world, this.challenge); break;
    }
    panels.renderCell($('#cell-info'), GlobeView.describeCell(world, this.globe.pickedCell));
    this.refreshHeader();
  }

  loop(now) {
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this.clock.advance(dt);

    const active = this.timeline.active;
    this.globe.draw(active.world, dt);
    const compare = this.timeline.compare;
    if (compare) {
      this.compareGlobe.rotation = this.globe.rotation;
      this.compareGlobe.tilt = this.globe.tilt;
      this.compareGlobe.draw(compare.world, dt);
    }

    const tracks = [{ world: active.world, colour: active.colour, label: active.label }];
    if (compare) tracks.push({ world: compare.world, colour: compare.colour, label: compare.label });
    this.charts.draw(tracks);
    this.diagram.draw(active.world);

    this.paintPanels(false);
    requestAnimationFrame(this.loop);
  }
}

window.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
