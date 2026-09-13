// Biosphere: heritable traits in ecological niches.
//
// There is no ladder from bacterium to human here. A species is a bundle of
// heritable traits; where those traits fit the planet, the species spreads;
// where a population straddles two different worlds, it splits. Intelligence
// is one trait among many, competing for the same biomass as size, cold
// tolerance and armour — which is why a run can perfectly well end with a
// technological civilisation of cephalopods, or of carnivorous plants.

import { IMPORTANCE } from '../core/chronicle.js';

export const HABITAT = { MARINE: 0, COASTAL: 1, LAND: 2, AERIAL: 3 };
export const HABITAT_NAMES = ['marine', 'coastal', 'terrestrial', 'aerial'];
export const METABOLISM = { CHEMO: 0, PHOTO: 1, HETERO: 2 };
export const METABOLISM_NAMES = ['chemotroph', 'phototroph', 'heterotroph'];

const BODY_PLANS = [
  'filament', 'mat', 'frond', 'shell', 'worm', 'arthropod', 'mollusc',
  'cephalopod', 'vertebrate', 'radial', 'colonial', 'vine', 'fungal',
];
const NAME_PREFIX = [
  'Thermo', 'Crypto', 'Litho', 'Halo', 'Photo', 'Neo', 'Palaeo', 'Pyro',
  'Chloro', 'Cyano', 'Xeno', 'Rhizo', 'Ostra', 'Placo', 'Grapto', 'Steno',
];
const NAME_SUFFIX = [
  'bacter', 'phyta', 'pod', 'saur', 'ceras', 'morpha', 'zoa', 'nema',
  'derm', 'branchia', 'ptera', 'ford', 'thrix', 'coccus',
];

let _uid = 0;

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export class Species {
  constructor(traits, opts = {}) {
    this.id = opts.id !== undefined ? opts.id : ++_uid;
    this.name = opts.name || 'unnamed';
    this.parentId = opts.parentId || 0;
    this.birthYear = opts.birthYear || 0;
    this.extinctYear = null;
    this.traits = traits;
    this.population = opts.population || 0.001;
    this.peakPopulation = this.population;
    this.range = 0;                    // number of cells occupied
    this.fitness = 0;
    this.lowCounter = 0;
    this.civilised = false;
  }

  get alive() { return this.extinctYear === null; }

  describe() {
    const t = this.traits;
    const bits = [HABITAT_NAMES[t.habitat], METABOLISM_NAMES[t.metabolism], t.plan];
    if (t.size > 0.6) bits.push('large-bodied');
    if (t.intelligence > 0.5) bits.push('intelligent');
    if (t.sociality > 0.6) bits.push('social');
    if (t.manipulation > 0.6) bits.push('dexterous');
    return bits.join(', ');
  }

  clone() {
    const s = new Species({ ...this.traits }, {
      id: this.id, name: this.name, parentId: this.parentId, birthYear: this.birthYear,
      population: this.population,
    });
    s.extinctYear = this.extinctYear;
    s.peakPopulation = this.peakPopulation;
    s.range = this.range;
    s.fitness = this.fitness;
    s.lowCounter = this.lowCounter;
    s.civilised = this.civilised;
    return s;
  }
}

export class Biosphere {
  constructor(mesh, rng, params = {}) {
    this.mesh = mesh;
    this.params = Object.assign({
      mutationRate: 1.0,
      speciationPressure: 1.0,
      extinctionThreshold: 6e-4,
      maxSpecies: 100,
      genesisChancePerMyr: 0.02,
    }, params);

    const n = mesh.n;
    this.producerDensity = new Float64Array(n);
    this.consumerDensity = new Float64Array(n);
    this.landCover = new Float64Array(n);
    this.dominant = new Int32Array(n).fill(-1);
    this.biome = new Int32Array(n);

    /** @type {Species[]} */
    this.species = [];
    this.lifeStarted = false;
    this.productivity = 0;         // GtC/yr fixed by photosynthesis
    this.burialFraction = 0.001;
    this.methanogenesis = 0;
    this.landVegetation = 0;
    this.diversity = 0;
    this.maxIntelligence = 0;
    this.extinctionWindow = [];
    this.milestones = {};
    this.oxygenCrisisDone = false;
  }

  // ---------------------------------------------------------------

  step(dtYears, world) {
    const ledger = world.ledger;

    if (!this.lifeStarted) this._maybeGenesis(dtYears, world);
    if (this.lifeStarted) {
      this._evaluate(dtYears, world);
      this._speciate(dtYears, world);
      this._prune(dtYears, world);
      this._milestones(world);
    }

    ledger.post('bio.productivity', 'Primary productivity', this.productivity, 'GtC/yr', {
      of: 'bio',
      note: 'Carbon fixed by phototrophs. Most is breathed straight back; the small buried remainder is what oxygenates a world.',
    });
    ledger.post('bio.diversity', 'Living species', this.diversity, 'species', { of: 'bio' });
    ledger.post('bio.landcover', 'Land vegetation', this.landVegetation * 100, '%', {
      of: 'bio',
      note: 'Roots hold soil and accelerate silicate weathering: greening a continent is a cooling event.',
    });
    ledger.post('bio.intelligence', 'Peak intelligence', this.maxIntelligence * 100, 'index', { of: 'bio' });
  }

  // ---------------------------------------------------------------
  // Origin
  // ---------------------------------------------------------------

  _maybeGenesis(dtYears, world) {
    const c = world.climate;
    const hasWater = world.hydrosphere.waterVolumeKm3 > 2e8;
    const habitable = c.meanTemp > 2 && c.meanTemp < 92;
    if (!hasWater || !habitable) return;
    const perMyr = this.params.genesisChancePerMyr * world.mods.genesis;
    const p = 1 - Math.exp(-perMyr * dtYears / 1e6);
    if (!world.rng.chance(p)) return;
    this.seedLife(world, 'the deep, warm dark around a hydrothermal vent');
  }

  /** Also reachable as a player intervention. */
  seedLife(world, where = 'a shallow, sunlit pool') {
    if (this.lifeStarted) return;
    const rng = world.rng;
    const first = new Species({
      habitat: HABITAT.MARINE,
      metabolism: METABOLISM.CHEMO,
      plan: 'filament',
      thermalOpt: Math.max(4, Math.min(95, world.climate.meanTemp + rng.range(2, 25))),
      thermalTol: rng.range(18, 34),
      size: 0.02,
      intelligence: 0.01,
      sociality: 0.02,
      manipulation: 0.01,
      oxygenNeed: 0,
      oxygenTolerance: 0.05,
      aridityTolerance: 0.0,
      mutability: rng.range(0.7, 1.4),
      defence: 0.05,
    }, { name: this._nameFor(rng), birthYear: world.year, population: 0.01 });
    this.species.push(first);
    this.lifeStarted = true;
    world.chronicle.record(world.year, 'biosphere',
      'Life began in ' + where + '. A chemotroph, blind and single-celled, '
      + 'began copying itself.', IMPORTANCE.EPOCHAL, { species: first.name });
  }

  _nameFor(rng) {
    return rng.pick(NAME_PREFIX) + rng.pick(NAME_SUFFIX).toLowerCase();
  }

  // ---------------------------------------------------------------
  // Fitness, competition, populations
  // ---------------------------------------------------------------

  /** How well a species does in one cell, 0..1. */
  cellFitness(sp, i, world) {
    const geo = world.geosphere;
    const cl = world.climate;
    const t = sp.traits;
    const isOcean = geo.elevation[i] <= geo.seaLevel;
    const depth = geo.seaLevel - geo.elevation[i];

    // Habitat gate.
    switch (t.habitat) {
      case HABITAT.MARINE: if (!isOcean) return 0; break;
      case HABITAT.COASTAL: if (!isOcean || !geo.coastal[i]) return 0; break;
      case HABITAT.LAND: if (isOcean) return 0; break;
      case HABITAT.AERIAL: if (isOcean && depth > 200) return 0; break;
    }

    // Temperature: a Gaussian around the species' optimum. A mind widens
    // that curve — shelter, clothing, migration, moving into the shade are
    // all the same trick, and they are the first thing intelligence buys.
    const temp = cl.temperature[i];
    const tolerance = Math.max(3, t.thermalTol) * (1 + 0.9 * t.intelligence);
    const dT = (temp - t.thermalOpt) / tolerance;
    let fit = Math.exp(-dT * dT);
    if (fit < 1e-4) return 0;

    // Ice is a wall for almost everything.
    fit *= 1 - 0.92 * cl.ice[i];

    // Light, for anything that eats it.
    if (t.metabolism === METABOLISM.PHOTO) {
      const light = !isOcean || geo.coastal[i] ? 1 : Math.max(0, 1 - depth / 900);
      fit *= 0.15 + 0.85 * light;
    }

    // Oxygen: a requirement for some, a poison for others.
    const o2 = cl.o2Percent;
    if (t.oxygenNeed > 0) {
      // A saturating requirement with a floor, not a cliff: when the air goes
      // anoxic an aerobic lineage is crippled, not instantly erased. Sharp
      // thresholds here would let one oscillation in the atmosphere sterilise
      // a planet.
      fit *= 0.08 + 0.92 * (o2 / (o2 + t.oxygenNeed));
    } else {
      // Oxygen poisons anaerobes, but it never quite reaches everywhere:
      // there is always anoxic mud, and deep water that the surface never
      // mixes with. The floor is what keeps an oxygen catastrophe from
      // sterilising a planet outright.
      fit *= 0.35 + 0.65 * clamp01(1 - (o2 - t.oxygenTolerance * 21) / 10);
    }

    // Land is dry, and drying out is the first problem of living there.
    if (t.habitat === HABITAT.LAND || t.habitat === HABITAT.AERIAL) {
      const wet = cl.precipitation[i];
      const need = 1 - t.aridityTolerance;
      fit *= clamp01(0.25 + (wet / Math.max(0.12, need)) * 0.75);
      // Before there is an ozone layer, the surface is sterilised by UV.
      if (o2 < 0.5) fit *= 0.04;
    }

    // Heterotrophs need something to eat, here, in this cell. Finding food
    // that is hiding from you is exactly the problem a brain is good at, and
    // hunting together multiplies it — which is why intelligence and
    // sociality pay for a predator and not for a mat of algae.
    if (t.metabolism === METABOLISM.HETERO) {
      const food = this.producerDensity[i] + 0.3 * this.consumerDensity[i];
      const foraging = 1 + 2.5 * t.intelligence
        + 0.7 * t.sociality * t.intelligence     // coordinated hunting
        + 0.9 * t.manipulation;                  // handling what you catch
      fit *= clamp01(food * 2.2 * foraging);
    }

    // The leftovers of a young mantle are poisonous.
    fit *= clamp01(1 - world.climate.toxicityGt / 20000 * (1 - t.oxygenTolerance));

    // Big bodies, big brains and elaborate hands all cost energy that could
    // have gone into offspring. Nothing here is free.
    fit *= 1 - 0.25 * t.size * t.size
      - 0.15 * t.intelligence * t.intelligence
      - 0.08 * t.manipulation * t.manipulation
      - 0.05 * t.sociality * t.sociality;
    return Math.max(0, fit);
  }

  _evaluate(dtYears, world) {
    const mesh = this.mesh;
    const n = mesh.n;
    const living = this.species.filter((s) => s.alive);
    const cellArea = mesh.cellAreaKm2 / mesh.surfaceAreaKm2;

    const prevProducers = this.producerDensity;
    const newProducers = new Float64Array(n);
    const newConsumers = new Float64Array(n);
    this.landCover.fill(0);
    this.dominant.fill(-1);
    const bestFit = new Float64Array(n);

    // Producers first: consumers are scored against the standing crop of
    // the previous step, which keeps the food web causal instead of
    // circular.
    const ordered = living.slice().sort((a, b) => a.traits.metabolism - b.traits.metabolism);

    // Niche competition: everything in the same niche divides the same
    // carrying capacity in proportion to how well it fits.
    // Fitness is evaluated once per species per cell and kept, because it is
    // needed twice: to size the population, and then to paint that population
    // back onto the map.
    if (!this._fitBuffer || this._fitBuffer.length < ordered.length * n) {
      this._fitBuffer = new Float64Array(Math.max(ordered.length, 16) * n);
    }
    const fitBuf = this._fitBuffer;

    const nicheTotals = new Map();
    const perSpecies = [];
    for (let k = 0; k < ordered.length; k++) {
      const sp = ordered[k];
      const base = k * n;
      let sum = 0, range = 0;
      for (let i = 0; i < n; i++) {
        const f = this.cellFitness(sp, i, world);
        fitBuf[base + i] = f;
        if (f > 0.02) { sum += f; range++; }
      }
      sp.fitness = sum / n;
      sp.range = range;
      const key = this._nicheKey(sp);
      nicheTotals.set(key, (nicheTotals.get(key) || 0) + sp.fitness * sp.population);
      perSpecies.push({ sp, key, base });
    }

    // Growth rate per step: fast at ecological scale, saturated at
    // geological scale (a population cannot grow more than "full").
    const growth = 1 - Math.exp(-dtYears / 4000);

    let totalProducer = 0, totalConsumer = 0, maxInt = 0;
    for (const { sp, key, base } of perSpecies) {
      const nicheTotal = Math.max(1e-9, nicheTotals.get(key));
      const share = (sp.fitness * sp.population) / nicheTotal;
      // Carrying capacity is the niche's habitable area, split by share.
      let capacity = sp.fitness * share * this._nicheCapacity(key, world);
      // A species that farms is no longer bounded by what the land happens to
      // grow for it. This is the one place where the civilisation layer feeds
      // back into the biosphere that produced it.
      if (sp.civilised && world.civilisation && world.civilisation.alive) {
        capacity *= 1 + Math.max(0, world.civilisation.tech) * 0.45;
      }
      sp.population += (capacity - sp.population) * growth;
      sp.population = Math.max(0, sp.population);
      if (sp.population > sp.peakPopulation) sp.peakPopulation = sp.population;
      if (sp.traits.intelligence > maxInt && sp.population > 1e-3) maxInt = sp.traits.intelligence;

      if (sp.population < 1e-9) continue;
      // Paint the species onto the map.
      for (let i = 0; i < n; i++) {
        const f = fitBuf[base + i];
        if (f <= 0.02) continue;
        const density = f * sp.population;
        if (sp.traits.metabolism === METABOLISM.PHOTO) {
          newProducers[i] += density;
          if (world.geosphere.elevation[i] > world.geosphere.seaLevel) {
            this.landCover[i] = Math.min(1, this.landCover[i] + density * 3);
          }
        } else newConsumers[i] += density;
        if (density > bestFit[i]) { bestFit[i] = density; this.dominant[i] = sp.id; }
      }
      if (sp.traits.metabolism === METABOLISM.PHOTO) totalProducer += sp.population * sp.fitness;
      else totalConsumer += sp.population * sp.fitness;
    }

    this.producerDensity = newProducers;
    this.consumerDensity = newConsumers;
    this.diversity = living.filter((s) => s.population > this.params.extinctionThreshold).length;
    this.maxIntelligence = maxInt;

    // Aggregate exports for the climate module. Photosynthesis is limited by
    // the CO2 available to fix, which is the loop that stops a runaway
    // biosphere from stripping its own atmosphere to nothing: draw the carbon
    // down far enough and the thing doing the drawing starves.
    const co2Limit = world.climate.co2ppm / (world.climate.co2ppm + 60);
    this.productivity = totalProducer * 140 * co2Limit * world.mods.productivity;
    // Burial is favoured by shallow seas, swamps and cold water.
    const shelf = world.geosphere.stats.shelfFraction;
    // Fire is the other half of the oxygen thermostat: in a very oxygen-rich
    // atmosphere organic matter burns before it can ever be buried, so the
    // process that made the oxygen shuts itself down.
    const fire = 1 / (1 + Math.pow(world.climate.o2Percent / 20, 2));
    // Almost everything that is fixed gets breathed back. The fraction that
    // escapes into sediment is tiny — and it is the whole reason there is an
    // oxygen atmosphere and a fossil record.
    this.burialFraction = Math.min(0.05,
      (0.0006 + shelf * 0.005 + this.landVegetation * 0.003) * fire);
    // Anaerobes make methane where there is no oxygen to stop them.
    const anaerobicShare = Math.max(0, 1 - world.climate.o2Percent / 3);
    this.methanogenesis = totalProducer * 0.9 * anaerobicShare * 4e-6;

    let landVeg = 0, landCells = 0;
    for (let i = 0; i < n; i++) {
      if (world.geosphere.elevation[i] > world.geosphere.seaLevel) {
        landCells++; landVeg += this.landCover[i];
      }
    }
    this.landVegetation = landCells ? landVeg / landCells : 0;
    this._classifyBiomes(world);
  }

  _nicheKey(sp) {
    const t = sp.traits;
    const zone = t.thermalOpt < 2 ? 'polar' : t.thermalOpt < 20 ? 'temperate' : 'tropical';
    const size = t.size < 0.25 ? 'micro' : t.size < 0.6 ? 'meso' : 'macro';
    return HABITAT_NAMES[t.habitat] + '|' + METABOLISM_NAMES[t.metabolism] + '|' + zone + '|' + size;
  }

  /** How much biomass a niche can support, given the planet's current
   *  geography. Habitat area is the hard limit. */
  _nicheCapacity(key, world) {
    const geo = world.geosphere;
    const habitat = key.split('|')[0];
    const land = geo.stats.landFraction;
    let area;
    if (habitat === 'marine') area = 1 - land;
    else if (habitat === 'coastal') area = geo.stats.shelfFraction;
    else area = land;
    const trophic = key.split('|')[1];
    // Each trophic step throws away most of the energy it eats.
    const efficiency = trophic === 'heterotroph' ? 0.12 : 1;
    return Math.max(0.001, area) * efficiency * 1.2;
  }

  // ---------------------------------------------------------------
  // Speciation
  // ---------------------------------------------------------------

  _speciate(dtYears, world) {
    const rng = world.rng;
    const living = this.species.filter((s) => s.alive && s.population > 1e-3);
    if (living.length === 0) return;
    if (this.species.filter((s) => s.alive).length >= this.params.maxSpecies) return;

    for (const sp of living) {
      // A wide range across a varied planet is what splits a lineage: the
      // population at one end of it stops meeting the population at the other.
      const spread = Math.min(1, sp.range / (this.mesh.n * 0.25));
      const rate = 0.6 * spread * sp.traits.mutability * this.params.speciationPressure
        * world.mods.mutation;
      const p = 1 - Math.exp(-rate * dtYears / 1.2e7);
      if (!rng.chance(p)) continue;
      const child = this._mutate(sp, world, rng);
      if (!child) continue;
      this.species.push(child);
      const event = this._innovationEvent(sp, child, world);
      if (event) {
        world.chronicle.record(world.year, 'biosphere', event.text, event.importance,
          { species: child.name, from: sp.name });
      }
      if (this.species.filter((s) => s.alive).length >= this.params.maxSpecies) return;
    }
  }

  _mutate(parent, world, rng) {
    const t = { ...parent.traits };
    const m = parent.traits.mutability * world.mods.mutation;
    const jitter = (v, sd, lo, hi) => Math.max(lo, Math.min(hi, v + rng.normal(0, sd * m)));

    t.thermalOpt = jitter(t.thermalOpt, 6, -40, 110);
    t.thermalTol = jitter(t.thermalTol, 3, 4, 60);
    t.size = jitter(t.size, 0.09, 0.01, 1);
    t.mutability = Math.max(0.2, Math.min(2.2, t.mutability + rng.normal(0, 0.08)));
    t.defence = jitter(t.defence, 0.08, 0, 1);
    t.aridityTolerance = jitter(t.aridityTolerance, 0.08, 0, 1);
    // Oxygen tolerance drifts like any trait, but with a bias toward the air
    // the lineage actually lives in: a world that is oxygenating selects hard
    // for anything that can stand it, and the variants keep arriving.
    const ambient = Math.min(1, world.climate.o2Percent / 21);
    t.oxygenTolerance = jitter(t.oxygenTolerance + (ambient - t.oxygenTolerance) * 0.35, 0.06, 0, 1);

    // Intelligence, sociality and manipulation drift like anything else.
    // They are expensive, so they only persist where they pay for themselves.
    t.intelligence = jitter(t.intelligence, 0.05, 0, 1);
    t.sociality = jitter(t.sociality, 0.07, 0, 1);
    t.manipulation = jitter(t.manipulation, 0.08, 0, 1);
    // The three co-evolve. A lineage already paying for a brain finds hands
    // and company cheaper to add than one starting from nothing, which is why
    // the whole behavioural suite tends to arrive together or not at all.
    const suite = t.intelligence * m;
    t.sociality = Math.min(1, t.sociality + rng.range(0, 0.06) * suite);
    t.manipulation = Math.min(1, t.manipulation + rng.range(0, 0.06) * suite);

    const cl = world.climate;

    // Metabolic innovations: rare, and gated by what the planet offers.
    if (t.metabolism === METABOLISM.CHEMO && rng.chance(0.16 * m)) {
      t.metabolism = METABOLISM.PHOTO;
    } else if (t.metabolism === METABOLISM.PHOTO && rng.chance(0.10 * m) && cl.o2Percent > 0.4) {
      t.metabolism = METABOLISM.HETERO;
      t.oxygenNeed = Math.max(t.oxygenNeed, 1.5);
    } else if (t.metabolism === METABOLISM.CHEMO && rng.chance(0.06 * m) && cl.o2Percent > 1) {
      t.metabolism = METABOLISM.HETERO;
      t.oxygenNeed = Math.max(t.oxygenNeed, 1.0);
    }
    if (t.oxygenNeed === 0 && cl.o2Percent > 0.8 && rng.chance(0.3 * m)) {
      t.oxygenNeed = Math.max(0.8, Math.min(3, cl.o2Percent * 0.4));   // aerobic respiration: far more energy per meal
      t.size = Math.min(1, t.size + 0.12);
    }

    // Habitat shifts: each one is a frontier.
    if (rng.chance(0.14 * m)) {
      if (t.habitat === HABITAT.MARINE) t.habitat = HABITAT.COASTAL;
      else if (t.habitat === HABITAT.COASTAL && cl.o2Percent > 1.5) {
        t.habitat = HABITAT.LAND;
        t.aridityTolerance = Math.max(t.aridityTolerance, 0.25);
      } else if (t.habitat === HABITAT.LAND && t.size < 0.5 && cl.o2Percent > 12) {
        t.habitat = HABITAT.AERIAL;
      } else if (t.habitat === HABITAT.COASTAL) t.habitat = HABITAT.MARINE;
    }
    if (rng.chance(0.2 * m)) t.plan = rng.pick(BODY_PLANS);

    const child = new Species(t, {
      name: this._nameFor(rng),
      parentId: parent.id,
      birthYear: world.year,
      population: Math.max(1e-4, parent.population * 0.12),
    });
    parent.population *= 0.88;
    return child;
  }

  /** An innovation is only an epoch the first time it happens. The tenth
   *  lineage to crawl ashore is a footnote, not a headline — and a chronicle
   *  that announces each one as if it were the first is unreadable. */
  _innovationEvent(parent, child, world) {
    const t = child.traits, p = parent.traits;
    const first = (key) => {
      if (this.milestones['innov.' + key]) return false;
      this.milestones['innov.' + key] = world.year;
      return true;
    };

    if (p.metabolism !== t.metabolism) {
      if (t.metabolism === METABOLISM.PHOTO) {
        return first('photosynthesis')
          ? { importance: IMPORTANCE.EPOCHAL, text: child.name + ' learned to eat sunlight. '
            + 'Photosynthesis has begun, and with it the slow poisoning of the world by its '
            + 'own waste oxygen.' }
          : { importance: IMPORTANCE.MINOR, text: child.name + ' took up photosynthesis.' };
      }
      if (t.metabolism === METABOLISM.HETERO) {
        return first('predation')
          ? { importance: IMPORTANCE.MAJOR, text: child.name + ' stopped making its own food '
            + 'and started eating its neighbours. Predation exists.' }
          : { importance: IMPORTANCE.MINOR, text: child.name + ' turned predator.' };
      }
      return { importance: IMPORTANCE.MINOR, text: child.name + ' found a new way to make a living.' };
    }

    if (p.habitat !== t.habitat) {
      if (t.habitat === HABITAT.LAND) {
        return first('land')
          ? { importance: IMPORTANCE.EPOCHAL, text: child.name + ' crawled out of the water. '
            + 'The continents are no longer sterile.' }
          : { importance: IMPORTANCE.MINOR, text: child.name + ' colonised the land.' };
      }
      if (t.habitat === HABITAT.AERIAL) {
        return first('air')
          ? { importance: IMPORTANCE.MAJOR, text: child.name + ' took to the air.' }
          : { importance: IMPORTANCE.MINOR, text: child.name + ' learned to fly.' };
      }
      if (t.habitat === HABITAT.COASTAL) {
        return first('shallows')
          ? { importance: IMPORTANCE.NOTABLE, text: child.name + ' moved into the shallows, '
            + 'where the light reaches the bottom.' }
          : null;   // by now this happens constantly and means nothing
      }
      return null;
    }

    if (t.oxygenNeed > 0 && p.oxygenNeed === 0) {
      return first('aerobic')
        ? { importance: IMPORTANCE.MAJOR, text: child.name + ' began breathing oxygen — '
          + 'the poison became the fuel.' }
        : { importance: IMPORTANCE.MINOR, text: child.name + ' went aerobic.' };
    }

    if (t.intelligence > 0.5 && p.intelligence <= 0.5) {
      return first('intelligence')
        ? { importance: IMPORTANCE.MAJOR, text: child.name + ' shows the first real signs of a mind.' }
        : { importance: IMPORTANCE.MINOR, text: child.name + ' is unusually quick-witted.' };
    }
    return null;
  }

  // ---------------------------------------------------------------
  // Death
  // ---------------------------------------------------------------

  _prune(dtYears, world) {
    let died = 0, alive = 0;
    for (const sp of this.species) {
      if (!sp.alive) continue;
      alive++;
      if (sp.population < this.params.extinctionThreshold) {
        sp.lowCounter++;
        if (sp.lowCounter > 2) {
          sp.extinctYear = world.year;
          died++;
          if (sp.peakPopulation > 0.08) {
            world.chronicle.record(world.year, 'biosphere',
              sp.name + ' died out after ' + ((world.year - sp.birthYear) / 1e6).toFixed(1)
              + ' million years.', IMPORTANCE.MINOR, { species: sp.name });
          }
        }
      } else sp.lowCounter = 0;
    }

    // A mass extinction is a rate, not an event: it is noticed when a large
    // share of the living world disappears inside a short window.
    this.extinctionWindow.push({ year: world.year, died, alive: alive || 1 });
    while (this.extinctionWindow.length > 8) this.extinctionWindow.shift();
    let totalDied = 0, base = 0;
    for (const w of this.extinctionWindow) { totalDied += w.died; base = Math.max(base, w.alive); }
    if (base > 6 && totalDied / base > 0.45 && !this._recentMassExtinction(world.year)) {
      this._lastMassExtinction = world.year;
      world.chronicle.record(world.year, 'biosphere',
        'A mass extinction: ' + Math.round((totalDied / base) * 100) + '% of living species '
        + 'vanished. The survivors inherit an empty world.', IMPORTANCE.MAJOR,
        { fraction: totalDied / base });
    }

    if (this.lifeStarted && this.diversity === 0) {
      this._sterileCounter = (this._sterileCounter || 0) + 1;
    } else this._sterileCounter = 0;
    if (this._sterileCounter > 6 && this.lifeStarted) {
      world.chronicle.record(world.year, 'biosphere',
        'The last lineage failed. The planet is sterile again — though the '
        + 'chemistry that started it once is still there.', IMPORTANCE.EPOCHAL);
      // A sterile planet is not a finished one. Abiogenesis becomes possible
      // again, on the same terms as the first time.
      this.lifeStarted = false;
      this._sterileCounter = 0;
      this.species = [];
      this.milestones = {};
      this.productivity = 0;
      this.landVegetation = 0;
      this.maxIntelligence = 0;
      this.producerDensity.fill(0);
      this.consumerDensity.fill(0);
      this.landCover.fill(0);
    }
  }

  _recentMassExtinction(year) {
    return this._lastMassExtinction !== undefined && year - this._lastMassExtinction < 40e6;
  }

  // ---------------------------------------------------------------

  _milestones(world) {
    const cl = world.climate;
    const mark = (key, text, importance, data) => {
      if (this.milestones[key]) return;
      this.milestones[key] = world.year;
      world.chronicle.record(world.year, 'biosphere', text, importance, data);
    };

    if (cl.o2Percent > 1 && !this.milestones.oxygen) {
      mark('oxygen', 'Free oxygen passed 1% of the atmosphere. The oxygen sinks are '
        + 'full at last, and the sky is changing colour.', IMPORTANCE.EPOCHAL,
        { o2: cl.o2Percent });
    }
    if (cl.o2Percent > 15 && !this.milestones.highOxygen) {
      mark('highOxygen', 'Oxygen reached ' + cl.o2Percent.toFixed(0) + '%. Large, '
        + 'fast, hungry bodies are now energetically possible.', IMPORTANCE.MAJOR);
    }
    if (this.landVegetation > 0.15 && !this.milestones.greening) {
      const before = cl.co2ppm;
      mark('greening', 'Plants covered the continents. Rooted weathering is stripping '
        + 'CO2 out of the air far faster than volcanoes replace it.', IMPORTANCE.MAJOR,
        { co2: before, landCover: this.landVegetation });
    }
    if (this.maxIntelligence > 0.55 && !this.milestones.mind) {
      const smart = this._smartest();
      mark('mind', (smart ? smart.name : 'Something') + ' began solving problems it had '
        + 'never met before. Whatever else it is, it is thinking.', IMPORTANCE.MAJOR,
        { species: smart ? smart.name : null });
    }
  }

  _smartest() {
    let best = null;
    for (const sp of this.species) {
      if (!sp.alive || sp.population < 1e-3) continue;
      if (!best || sp.traits.intelligence > best.traits.intelligence) best = sp;
    }
    return best;
  }

  /** The lineage that can start a civilisation, if any. Note what is *not*
   *  required: being a vertebrate, living on land, or being large. */
  civilisationCandidate(world) {
    let best = null, bestScore = 0;
    for (const sp of this.species) {
      if (!sp.alive || sp.population < 0.004) continue;
      const t = sp.traits;
      if (world.climate.o2Percent < 8) continue;   // no fire, no metabolism for it
      const score = t.intelligence * 0.5 + t.sociality * 0.27 + t.manipulation * 0.23;
      if (t.intelligence > 0.62 && t.sociality > 0.45 && t.manipulation > 0.42 && score > bestScore) {
        best = sp; bestScore = score;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------

  _classifyBiomes(world) {
    const geo = world.geosphere;
    const cl = world.climate;
    for (let i = 0; i < this.mesh.n; i++) {
      const ocean = geo.elevation[i] <= geo.seaLevel;
      if (cl.ice[i] > 0.5) { this.biome[i] = ocean ? 1 : 2; continue; }  // sea ice / glacier
      if (ocean) {
        this.biome[i] = this.producerDensity[i] > 0.05 ? 3 : 0;          // productive / barren sea
        continue;
      }
      const veg = this.landCover[i];
      const t = cl.temperature[i];
      const p = cl.precipitation[i];
      if (veg < 0.05) this.biome[i] = p < 0.25 ? 4 : 5;                  // desert / bare rock
      else if (t < 2) this.biome[i] = 6;                                 // tundra
      else if (p < 0.4) this.biome[i] = 7;                               // steppe
      else if (t > 22) this.biome[i] = 8;                                // tropical forest
      else this.biome[i] = 9;                                            // temperate forest
    }
  }

  // --- interventions -------------------------------------------------

  /** Targeted extinction: the bluntest tool in the box. */
  cull(predicate, world, reason) {
    let n = 0;
    for (const sp of this.species) {
      if (!sp.alive) continue;
      if (!predicate(sp)) continue;
      sp.extinctYear = world.year;
      sp.population = 0;
      n++;
    }
    if (n > 0) {
      world.chronicle.record(world.year, 'player',
        'You erased ' + n + ' species. (' + reason + ')', IMPORTANCE.MAJOR, { count: n });
    }
    return n;
  }

  /** Kill in proportion to how badly a cell was hit — used by impacts. */
  shock(fractionKilled, world, reason) {
    for (const sp of this.species) {
      if (!sp.alive) continue;
      const survives = Math.pow(1 - fractionKilled, 1 + sp.traits.defence + (1 - sp.traits.size));
      sp.population *= survives;
    }
    world.chronicle.record(world.year, 'biosphere',
      reason + ' Roughly ' + Math.round(fractionKilled * 100) + '% of the living world died.',
      IMPORTANCE.MAJOR);
  }

  save() {
    return {
      species: this.species.map((s) => ({
        id: s.id, name: s.name, parentId: s.parentId, birthYear: s.birthYear,
        extinctYear: s.extinctYear, traits: { ...s.traits }, population: s.population,
        peakPopulation: s.peakPopulation, range: s.range, fitness: s.fitness,
        lowCounter: s.lowCounter, civilised: s.civilised,
      })),
      producerDensity: Array.from(this.producerDensity),
      consumerDensity: Array.from(this.consumerDensity),
      lifeStarted: this.lifeStarted,
      milestones: { ...this.milestones },
      extinctionWindow: this.extinctionWindow.map((w) => ({ ...w })),
      lastMassExtinction: this._lastMassExtinction,
      params: { ...this.params },
      uid: _uid,
      // Derived aggregates are cheap to store and expensive to be without:
      // a freshly forked branch has to be able to describe itself before it
      // has taken its first step.
      derived: {
        diversity: this.diversity, productivity: this.productivity,
        burialFraction: this.burialFraction, methanogenesis: this.methanogenesis,
        landVegetation: this.landVegetation, maxIntelligence: this.maxIntelligence,
      },
      landCover: Array.from(this.landCover),
      biome: Array.from(this.biome),
      dominant: Array.from(this.dominant),
    };
  }

  load(s) {
    this.species = s.species.map((d) => {
      const sp = new Species({ ...d.traits }, {
        id: d.id, name: d.name, parentId: d.parentId, birthYear: d.birthYear,
        population: d.population,
      });
      sp.extinctYear = d.extinctYear;
      sp.peakPopulation = d.peakPopulation;
      sp.range = d.range; sp.fitness = d.fitness; sp.lowCounter = d.lowCounter;
      sp.civilised = d.civilised;
      return sp;
    });
    this.producerDensity = Float64Array.from(s.producerDensity);
    this.consumerDensity = Float64Array.from(s.consumerDensity);
    this.lifeStarted = s.lifeStarted;
    this.milestones = { ...s.milestones };
    this.extinctionWindow = s.extinctionWindow.map((w) => ({ ...w }));
    this._lastMassExtinction = s.lastMassExtinction;
    this.params = { ...s.params };
    if (s.landCover) this.landCover.set(s.landCover);
    if (s.biome) this.biome.set(s.biome);
    if (s.dominant) this.dominant.set(s.dominant);
    if (s.derived) Object.assign(this, s.derived);
    // Exact restore, not a max: a rewound branch must re-issue the same
    // ids as the run it forked from, or replays would not match.
    if (s.uid !== undefined) _uid = s.uid;
  }
}

export const BIOME_NAMES = [
  'open ocean', 'sea ice', 'ice sheet', 'productive sea', 'desert', 'bare rock',
  'tundra', 'steppe', 'tropical forest', 'temperate forest',
];
