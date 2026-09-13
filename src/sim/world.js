// The world: four layers that eat each other.
//
// Geosphere moves the continents, which steer the ocean, which steers the
// climate, which decides what can live where, which changes the carbon
// cycle, which changes the climate. The World object owns the shared state,
// runs the layers in that order, and is fully serialisable so that time can
// be rewound and branched.

import { SphereMesh } from '../core/sphere.js';
import { Rng, hashNumbers } from '../core/rng.js';
import { Ledger } from '../core/ledger.js';
import { Chronicle, IMPORTANCE, formatYear } from '../core/chronicle.js';
import { Geosphere } from './geosphere.js';
import { Civilisation } from './civilisation.js';
import { getModule } from './registry.js';
import { luminosity } from './climate.js';

/** Player-set multipliers. Everything the player can tune lives here, so a
 *  single object carries the whole of the intervention state. */
function defaultMods() {
  return {
    albedo: 1,
    insolation: 1,
    volcanism: 1,
    mantleHeat: 1,
    orogeny: 1,
    weathering: 1,
    heatTransport: 1,
    mutation: 1,
    productivity: 1,
    genesis: 1,
    humidity: 1,
  };
}

export const STAR_BIRTH_GYR = 0.05;   // the world is already this old at t=0

export class World {
  /**
   * @param {object} config { seed, cells, climateModel, biosphereModel, energyBudget }
   */
  constructor(config = {}) {
    this.config = Object.assign({
      seed: 'genesis',
      cells: 1800,
      climateModel: 'default',
      biosphereModel: 'default',
      energyBudget: 100,
      energyRegenPerMyr: 0.09,
    }, config);

    this.seed = String(this.config.seed);
    this.mesh = new SphereMesh(this.config.cells);
    this.rng = new Rng(this.seed);
    this.ledger = new Ledger();
    this.chronicle = new Chronicle();

    this.year = 0;
    this.steps = 0;
    this.mods = defaultMods();
    // Water arrives from the mantle, not from the start: the surface is dry
    // until volcanism has degassed enough of this reservoir to make an ocean.
    this.hydrosphere = { waterVolumeKm3: 0, mantleWaterKm3: 1.55e9, warnedLoss: false };
    this.energy = this.config.energyBudget;
    this.energySpent = 0;
    this.ended = null;         // { reason, text, year }
    this.history = [];         // sampled time series for the charts
    this.branchLabel = 'main';

    this.geosphere = new Geosphere(this.mesh, this.rng.fork('geo'));
    this.climate = getModule('climate', this.config.climateModel)
      .create(this.mesh, this.rng.fork('climate'), {});
    this.biosphere = getModule('biosphere', this.config.biosphereModel)
      .create(this.mesh, this.rng.fork('bio'), {});
    this.civilisation = null;

    this.chronicle.record(0, 'geosphere',
      'A young world: molten under a thin skin of basalt, wrapped in an '
      + 'unbreathable atmosphere, with no liquid water anywhere on its surface.',
      IMPORTANCE.EPOCHAL, { seed: this.seed });

    // One warm-up pass so that the opening screen shows a real planet
    // rather than a field of zeroes.
    this._settle();
  }

  starAgeGyr() { return STAR_BIRTH_GYR + this.year / 1e9; }

  _settle() {
    this.ledger.clear();
    this.climate._circulation(this);
    this.climate._energyBalance(this);
    this.climate._iceAndPrecipitation(1000, this);
    this.geosphere._updateSeaLevel(this);
    this.geosphere._updateStats();
    this._sample();
  }

  // ---------------------------------------------------------------

  /** One fixed simulation step. dtYears comes from the time scale, never
   *  from the frame time. */
  step(dtYears) {
    if (this.ended) return;
    this.ledger.clear();
    this.ledger.post('geo', 'Geosphere', 0, '', {});
    this.ledger.post('climate', 'Atmosphere and climate', 0, '', {});
    this.ledger.post('carbon', 'Carbon cycle', 0, '', {});
    this.ledger.post('bio', 'Biosphere', 0, '', {});
    if (this.civilisation) this.ledger.post('civ', 'Civilisation', 0, '', {});

    this.year += dtYears;
    this.steps++;

    this.geosphere.step(dtYears, this);
    this.climate.step(dtYears, this);
    this.biosphere.step(dtYears, this);

    if (!this.civilisation) {
      const candidate = this.biosphere.civilisationCandidate(this);
      if (candidate) this._foundCivilisation(candidate);
    }
    if (this.civilisation) this.civilisation.step(dtYears, this);

    // Energy regenerates with time, so patience is itself a resource.
    this.energy = Math.min(this.config.energyBudget,
      this.energy + this.config.energyRegenPerMyr * dtYears / 1e6);

    this._checkEndings();
    this._sample();
  }

  _foundCivilisation(species) {
    species.civilised = true;
    this.civilisation = new Civilisation(species, this);
    this.chronicle.record(this.year, 'civilisation',
      species.name + ' — ' + species.describe() + ' — lit a fire and kept it. '
      + 'From here they will reshape this planet faster than you can.',
      IMPORTANCE.EPOCHAL, { species: species.name });
  }

  _checkEndings() {
    if (this.ended) return;
    const lum = luminosity(this.starAgeGyr());
    if (this.climate.meanTemp > 150 && lum > 1.4) {
      this.endRun('burned',
        'The star swelled, the oceans went to vapour and the rock began to glow. '
        + 'The world you tuned is gone.');
    }
  }

  endRun(reason, text) {
    if (this.ended) return;
    this.ended = { reason, text, year: this.year };
    this.chronicle.record(this.year, 'player', text, IMPORTANCE.EPOCHAL, { reason });
  }

  // ---------------------------------------------------------------
  // Time series
  // ---------------------------------------------------------------

  _sample() {
    const cl = this.climate;
    const geo = this.geosphere;
    const bio = this.biosphere;
    this.history.push({
      year: this.year,
      temp: cl.meanTemp,
      co2: cl.co2ppm,
      o2: cl.o2Percent,
      ice: cl.iceFraction,
      land: geo.stats.landFraction,
      sealevel: geo.seaLevel,
      diversity: bio.diversity,
      productivity: bio.productivity,
      intelligence: bio.maxIntelligence,
      tech: this.civilisation ? this.civilisation.tech : 0,
      water: this.hydrosphere.waterVolumeKm3,
    });
    // Thin the series as it grows so a billion-year run stays cheap to draw
    // without ever losing its overall shape.
    if (this.history.length > 4000) {
      const kept = [];
      for (let i = 0; i < this.history.length; i += 2) kept.push(this.history[i]);
      kept.push(this.history[this.history.length - 1]);
      this.history = kept;
    }
  }

  // ---------------------------------------------------------------
  // Serialisation: the basis of rewind and branching
  // ---------------------------------------------------------------

  save() {
    return {
      version: 1,
      seed: this.seed,
      config: { ...this.config },
      year: this.year,
      steps: this.steps,
      rng: this.rng.save(),
      mods: { ...this.mods },
      hydrosphere: { ...this.hydrosphere },
      energy: this.energy,
      energySpent: this.energySpent,
      ended: this.ended ? { ...this.ended } : null,
      branchLabel: this.branchLabel,
      geosphere: this.geosphere.save(),
      climate: this.climate.save(),
      biosphere: this.biosphere.save(),
      civilisation: this.civilisation ? this.civilisation.save() : null,
      chronicle: this.chronicle.save(),
      history: this.history.map((h) => ({ ...h })),
    };
  }

  /** Rebuild a world from a snapshot. The mesh is regenerated from the seed
   *  and cell count rather than stored: it is a pure function of both. */
  static load(snapshot) {
    const w = new World(snapshot.config);
    w.applySnapshot(snapshot);
    return w;
  }

  applySnapshot(s) {
    this.seed = s.seed;
    this.year = s.year;
    this.steps = s.steps;
    this.rng = Rng.load(s.rng);
    this.mods = { ...s.mods };
    this.hydrosphere = { ...s.hydrosphere };
    this.energy = s.energy;
    this.energySpent = s.energySpent;
    this.ended = s.ended ? { ...s.ended } : null;
    this.branchLabel = s.branchLabel || 'main';
    this.geosphere.load(s.geosphere);
    this.climate.load(s.climate);
    this.biosphere.load(s.biosphere);
    this.civilisation = s.civilisation ? Civilisation.load(s.civilisation) : null;
    this.chronicle = Chronicle.load(s.chronicle);
    this.history = s.history.map((h) => ({ ...h }));
    this.ledger.clear();
  }

  /** A compact fingerprint of everything that matters, used to prove that
   *  the same seed and the same inputs give the same planet. */
  fingerprint() {
    const values = [this.year, this.climate.meanTemp, this.climate.co2ppm,
      this.climate.o2Percent, this.geosphere.seaLevel, this.geosphere.stats.landFraction,
      this.biosphere.diversity, this.biosphere.productivity,
      this.civilisation ? this.civilisation.tech : 0];
    for (let i = 0; i < this.mesh.n; i += 7) {
      values.push(this.geosphere.elevation[i], this.climate.temperature[i]);
    }
    return hashNumbers(values);
  }

  summary() {
    const cl = this.climate, geo = this.geosphere, bio = this.biosphere;
    return {
      year: this.year,
      yearLabel: formatYear(this.year),
      temp: cl.meanTemp,
      co2: cl.co2ppm,
      o2: cl.o2Percent,
      ch4: cl.ch4ppb,
      ice: cl.iceFraction,
      water: this.hydrosphere.waterVolumeKm3,
      seaLevel: geo.seaLevel,
      land: geo.stats.landFraction,
      diversity: bio.diversity,
      productivity: bio.productivity,
      tech: this.civilisation ? this.civilisation.tech : 0,
      energy: this.energy,
      luminosity: luminosity(this.starAgeGyr()),
      ended: this.ended,
    };
  }
}
