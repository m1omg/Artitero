// Civilisation: the first crisis you did not cause.
//
// Once a lineage carries enough intelligence, sociality and manipulation,
// it stops being a passenger. From fire to fusion it reshapes the planet
// faster than the player can, burning in a few centuries the carbon the
// biosphere spent an aeon burying. The player still has tools — but the
// civilisation has its own momentum, and its own opinions.

import { IMPORTANCE } from '../core/chronicle.js';

/** Tech is a continuous level; these are the thresholds worth naming. */
export const TECH_ERAS = [
  { at: 0.0, name: 'Fire and stone' },
  { at: 1.0, name: 'Agriculture' },
  { at: 2.0, name: 'Metallurgy' },
  { at: 3.0, name: 'Writing and cities' },
  { at: 4.0, name: 'Mechanisation' },
  { at: 5.0, name: 'Fossil industry' },
  { at: 6.0, name: 'Electrification' },
  { at: 7.0, name: 'Information' },
  { at: 8.0, name: 'Fission and orbit' },
  { at: 9.0, name: 'Fusion' },
  { at: 10.0, name: 'Interstellar' },
];

export function eraName(tech) {
  let name = TECH_ERAS[0].name;
  for (const e of TECH_ERAS) if (tech >= e.at) name = e.name;
  return name;
}

export class Civilisation {
  constructor(species, world) {
    this.speciesId = species.id;
    this.speciesName = species.name;
    this.descriptor = species.describe();
    this.foundedYear = world.year;
    this.tech = 0;
    this.population = 0.5;         // millions
    this.stability = 0.8;          // 0 collapsed .. 1 serene
    this.awareness = 0;            // how well they understand their own planet
    this.carbonEmission = 0;       // GtC/yr, read by the carbon cycle
    this.fossilBurned = 0;
    this.energyUse = 0;            // TW
    this.crises = [];
    this.collapses = 0;
    this.departed = false;
    this.extinct = false;
    this.lastEra = eraName(0);
    this.climateBaseline = world.climate.meanTemp;
  }

  get alive() { return !this.extinct; }

  step(dtYears, world) {
    if (this.extinct || this.departed) return;
    const cl = world.climate;
    const bio = world.biosphere;
    const ledger = world.ledger;

    const host = world.biosphere.species.find((s) => s.id === this.speciesId);
    // A bad step is not the end of a species. The founding lineage has to be
    // gone, or nearly gone, for several steps running before the civilisation
    // is counted as having died with it.
    if (!host || !host.alive || host.population < 1e-4) {
      this._hostFailing = (this._hostFailing || 0) + 1;
      if (this._hostFailing > 3) {
        this.extinct = true;
        world.chronicle.record(world.year, 'civilisation',
          'The civilisation of ' + this.speciesName + ' ended with its species.',
          IMPORTANCE.MAJOR);
      }
      return;
    }
    this._hostFailing = 0;

    // Civilisations run on a far shorter clock than the rest of the model,
    // so a geological step is integrated in pieces rather than applied at
    // once — otherwise a whole industrial age would vanish between frames.
    const sub = Math.max(1, Math.min(24, Math.ceil(dtYears / 200)));
    const h = dtYears / sub;
    for (let s = 0; s < sub && !this.departed && !this.extinct; s++) {
      this._advance(h, world, host);
    }

    ledger.post('civ.tech', 'Technology level', this.tech, 'level', {
      of: 'civ', note: eraName(this.tech) + '. Advances with population, stability and energy.',
    });
    ledger.post('civ.pop', 'Population', this.population, 'millions', { of: 'civ' });
    ledger.post('civ.emission', 'Carbon emission', this.carbonEmission, 'GtC/yr', {
      of: 'civ', note: 'Goes straight into the atmospheric term of the carbon cycle.',
    });
    ledger.post('civ.stability', 'Stability', this.stability * 100, '%', {
      of: 'civ', note: 'Falls with climate shock, famine and resource exhaustion. At zero, things come apart.',
    });
  }

  _advance(h, world, host) {
    const cl = world.climate;
    const geo = world.geosphere;

    // --- carrying capacity -------------------------------------------
    // How many of them the planet can feed depends on climate, land and
    // what they know how to do with both.
    const tempPenalty = Math.exp(-Math.pow((cl.meanTemp - 14) / 16, 2));
    const landFactor = Math.max(0.05, geo.stats.landFraction / 0.29);
    const habitatFactor = host.traits.habitat === 2 || host.traits.habitat === 3
      ? landFactor : Math.max(0.05, (1 - geo.stats.landFraction) / 0.7);
    const techYield = 1 + Math.pow(Math.max(0, this.tech), 1.9) * 0.9;
    const capacity = 60 * tempPenalty * habitatFactor * techYield * host.population * 4;

    // The logistic, solved exactly rather than stepped with Euler. A
    // geological step is tens of thousands of years long; an explicit step
    // that size overshoots the carrying capacity into negative population
    // and quietly kills the civilisation. The closed form is stable at any
    // step size, which is what lets the same model run at five years per
    // step and at a quarter of a million.
    const r = 0.012 * this.stability;
    const K = Math.max(0.001, capacity);
    const P = Math.max(1e-9, this.population);
    const e = Math.exp(Math.min(40, r * h));
    this.population = (K * P * e) / (K + P * (e - 1));

    // --- technology ---------------------------------------------------
    // Knowledge accumulates faster the more minds there are and the less
    // time those minds spend on survival.
    const minds = Math.log10(1 + this.population);
    const rate = 0.00003 * minds * this.stability * (0.5 + 0.5 * host.traits.intelligence);
    // Fossil carbon is the ladder from muscle to machine. A world whose
    // biosphere never buried anything has to find another way up, slowly.
    const fossil = Math.max(0, cl.carbon.organic);
    const fossilAvailable = fossil > 500 ? 1 : 0.35;
    const gate = this.tech > 4.5 && this.tech < 8.5 ? fossilAvailable : 1;
    // Capped per substep so that a single geological step cannot swallow the
    // entire arc from fire to fusion between two frames. The player is meant
    // to be able to drop to a finer time scale and watch it happen.
    this.tech += Math.min(0.02, rate * gate * h);
    this.awareness = Math.min(1, Math.max(0, (this.tech - 5.5) / 3));

    // --- energy and emissions ----------------------------------------
    // Calibrated against a familiar case: eight billion people at roughly
    // tech 7 use about 18 TW and put out about 10 GtC a year.
    this.energyUse = 1.8e-5 * this.population * Math.pow(Math.max(0, this.tech), 2.6);
    let fossilShare;
    if (this.tech < 4.5) fossilShare = 0.02;
    else if (this.tech < 8) fossilShare = 0.85;
    else fossilShare = Math.max(0, 0.85 - (this.tech - 8) * 0.8);
    // Once they understand what they are doing to the sky, some of them act.
    fossilShare *= 1 - 0.7 * this.awareness * this.stability;
    let emission = this.energyUse * fossilShare * 0.69;
    if (fossil <= 0) emission = 0;
    const burn = Math.min(fossil, emission * h);
    this.carbonEmission = h > 0 ? burn / h : 0;
    this.fossilBurned += burn;
    cl.carbon.organic = Math.max(0, cl.carbon.organic - burn);

    // --- stability ------------------------------------------------------
    // Stability relaxes toward whatever the current pressures allow, rather
    // than being integrated as a rate. A rate would depend on the step size,
    // and a civilisation is watched at four different step sizes.
    const warming = cl.meanTemp - this.climateBaseline;
    const climateStress = Math.max(0, Math.abs(warming) - 1.5) / 6;
    const crowding = Math.max(0, this.population / Math.max(1, capacity) - 0.95) * 2;
    const depletion = (this.tech > 5 && fossil < 200) ? 0.25 : 0;
    const target = Math.max(0, Math.min(1,
      (0.55 + 0.45 * this.awareness) - climateStress - crowding - depletion));
    this.stability += (target - this.stability) * (1 - Math.exp(-h / 2500));
    // Their own baseline drifts: a generation born hot thinks hot is normal.
    this.climateBaseline += (cl.meanTemp - this.climateBaseline) * Math.min(1, h / 600);

    this._crises(h, world, warming);

    // --- endings --------------------------------------------------------
    if (this.tech >= 10 && this.stability > 0.35 && !this.departed) {
      this.departed = true;
      world.chronicle.record(world.year, 'civilisation',
        'The ' + this.speciesName + ' left. Their ships are past the outer planets '
        + 'and still accelerating. Whatever happens to this world now, they will '
        + 'outlive it.', IMPORTANCE.EPOCHAL, { tech: this.tech, population: this.population });
      world.endRun('departed', 'Your civilisation left the planet.');
    }
    if (this.population < 0.0005) {
      this.extinct = true;
      world.chronicle.record(world.year, 'civilisation',
        'The last city fell silent. ' + this.speciesName + ' is no longer a civilisation, '
        + 'only a species — if that.', IMPORTANCE.MAJOR);
    }

    const era = eraName(this.tech);
    if (era !== this.lastEra) {
      this.lastEra = era;
      world.chronicle.record(world.year, 'civilisation',
        'The ' + this.speciesName + ' entered the age of ' + era.toLowerCase() + '.',
        IMPORTANCE.NOTABLE, { tech: this.tech, population: this.population });
    }
  }

  _crises(h, world, warming) {
    const rng = world.rng;
    const cl = world.climate;

    // A climate crisis of their own making: the one the player did not cause.
    if (!this._climateCrisis && this.tech > 5.5 && warming > 2.2) {
      this._climateCrisis = true;
      this.crises.push({ year: world.year, kind: 'climate' });
      world.chronicle.record(world.year, 'civilisation',
        'Their own industry has warmed the planet by ' + warming.toFixed(1) + ' C in a '
        + 'geological instant. They know. They are arguing about it.',
        IMPORTANCE.MAJOR, { warming });
    }
    if (this._climateCrisis && warming < 1.2 && !this._climateResolved) {
      this._climateResolved = true;
      world.chronicle.record(world.year, 'civilisation',
        'They got the climate back under control — mostly by themselves.',
        IMPORTANCE.MAJOR);
    }

    // Collapse. A civilisation that has just come apart is not about to do it
    // again next century, so there is a recovery period before the next one
    // is possible at all.
    if (this._collapseCooldown > 0) this._collapseCooldown -= h;
    if (this.stability < 0.08 && !(this._collapseCooldown > 0)) {
      const p = 1 - Math.exp(-h / 4000);
      if (rng.chance(p)) {
        this._collapseCooldown = 20000;
        this.collapses++;
        this.population *= 0.25;
        this.tech = Math.max(0.5, this.tech - 1.6);
        this.stability = 0.45;
        this.crises.push({ year: world.year, kind: 'collapse' });
        world.chronicle.record(world.year, 'civilisation',
          'Collapse. Trade failed, then cities, then memory. They keep the wheel '
          + 'and lose the rest.', IMPORTANCE.MAJOR, { collapses: this.collapses });
      }
    }

    // The technological accident.
    if (this.tech > 7.2 && this.tech < 9 && this.stability < 0.4) {
      const p = 1 - Math.exp(-h / 60000);
      if (rng.chance(p)) {
        this.population *= 0.08;
        this.tech = Math.max(1, this.tech - 3);
        this.stability = 0.3;
        this.crises.push({ year: world.year, kind: 'war' });
        world.biosphere.shock(0.25, world, 'They turned their new physics on each other.');
        cl.toxicityGt += 400;
      }
    }
  }

  save() {
    return {
      speciesId: this.speciesId, speciesName: this.speciesName, descriptor: this.descriptor,
      foundedYear: this.foundedYear, tech: this.tech, population: this.population,
      stability: this.stability, awareness: this.awareness, carbonEmission: this.carbonEmission,
      fossilBurned: this.fossilBurned, energyUse: this.energyUse,
      crises: this.crises.map((c) => ({ ...c })), collapses: this.collapses,
      departed: this.departed, extinct: this.extinct, lastEra: this.lastEra,
      climateBaseline: this.climateBaseline,
      climateCrisis: !!this._climateCrisis, climateResolved: !!this._climateResolved,
      collapseCooldown: this._collapseCooldown || 0, hostFailing: this._hostFailing || 0,
    };
  }

  static load(s) {
    const c = Object.create(Civilisation.prototype);
    Object.assign(c, {
      speciesId: s.speciesId, speciesName: s.speciesName, descriptor: s.descriptor,
      foundedYear: s.foundedYear, tech: s.tech, population: s.population,
      stability: s.stability, awareness: s.awareness, carbonEmission: s.carbonEmission,
      fossilBurned: s.fossilBurned, energyUse: s.energyUse,
      crises: s.crises.map((x) => ({ ...x })), collapses: s.collapses,
      departed: s.departed, extinct: s.extinct, lastEra: s.lastEra,
      climateBaseline: s.climateBaseline,
    });
    c._climateCrisis = s.climateCrisis;
    c._climateResolved = s.climateResolved;
    c._collapseCooldown = s.collapseCooldown || 0;
    c._hostFailing = s.hostFailing || 0;
    return c;
  }
}
