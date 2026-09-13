// Interventions: what the player actually does.
//
// You are not a general or a city planner. You tune the parameters of a
// system and then watch what crawls out. Every intervention costs energy
// from a limited budget, so a planet cannot simply be spammed with
// volcanoes — and the subtle tools are cheap precisely because their
// consequences are hard to predict.

import { IMPORTANCE } from '../core/chronicle.js';
import { HABITAT } from '../sim/biosphere.js';

/**
 * @typedef {object} Intervention
 * @property {string} id
 * @property {string} label
 * @property {'subtle'|'strong'|'blunt'} weight
 * @property {string} group
 * @property {number} cost energy
 * @property {boolean} [needsTarget] requires a cell to be picked on the globe
 * @property {string} describe
 * @property {(world:object, ctx:object)=>string} apply returns a log line
 * @property {(world:object)=>boolean} [available]
 */

/** @type {Intervention[]} */
export const INTERVENTIONS = [
  // --- subtle ------------------------------------------------------
  {
    id: 'albedo.brighten',
    label: 'Brighten the surface',
    group: 'Climate', weight: 'subtle', cost: 3,
    describe: 'Nudge the planet\'s reflectivity up by 4%. Cheap, slow, and it '
      + 'compounds with the ice it helps create.',
    apply(world) {
      world.mods.albedo = Math.min(1.6, world.mods.albedo * 1.04);
      return 'Surface albedo raised to ' + world.mods.albedo.toFixed(3) + ' x baseline.';
    },
  },
  {
    id: 'albedo.darken',
    label: 'Darken the surface',
    group: 'Climate', weight: 'subtle', cost: 3,
    describe: 'Nudge reflectivity down by 4%. The usual way out of a snowball, '
      + 'if you get there before the ice does.',
    apply(world) {
      world.mods.albedo = Math.max(0.5, world.mods.albedo * 0.96);
      return 'Surface albedo lowered to ' + world.mods.albedo.toFixed(3) + ' x baseline.';
    },
  },
  {
    id: 'humidity.raise',
    label: 'Thicken the water cycle',
    group: 'Climate', weight: 'subtle', cost: 4,
    describe: 'More evaporation and more rain. Wetter continents weather faster, '
      + 'which pulls CO2 down — and greens more of the land.',
    apply(world) {
      world.mods.humidity = Math.min(2.2, world.mods.humidity * 1.12);
      world.mods.weathering = Math.min(3, world.mods.weathering * 1.08);
      return 'Humidity raised to ' + world.mods.humidity.toFixed(2) + ' x baseline.';
    },
  },
  {
    id: 'humidity.lower',
    label: 'Dry the atmosphere',
    group: 'Climate', weight: 'subtle', cost: 4,
    describe: 'Less rain, slower weathering, drier interiors. Warms the planet '
      + 'the long way round.',
    apply(world) {
      world.mods.humidity = Math.max(0.35, world.mods.humidity * 0.9);
      world.mods.weathering = Math.max(0.25, world.mods.weathering * 0.92);
      return 'Humidity lowered to ' + world.mods.humidity.toFixed(2) + ' x baseline.';
    },
  },
  {
    id: 'transport.raise',
    label: 'Strengthen ocean circulation',
    group: 'Climate', weight: 'subtle', cost: 5,
    describe: 'Move more heat from the tropics to the poles. Evens the planet out '
      + 'and keeps the ice margins back.',
    apply(world) {
      world.mods.heatTransport = Math.min(2.5, world.mods.heatTransport * 1.15);
      return 'Poleward heat transport at ' + world.mods.heatTransport.toFixed(2) + ' x baseline.';
    },
  },
  {
    id: 'mutation.raise',
    label: 'Raise mutation rate',
    group: 'Life', weight: 'subtle', cost: 5,
    describe: 'Faster trait drift and faster speciation. Innovation and extinction '
      + 'arrive together; they always do.',
    apply(world) {
      world.mods.mutation = Math.min(4, world.mods.mutation * 1.3);
      return 'Mutation rate at ' + world.mods.mutation.toFixed(2) + ' x baseline.';
    },
  },
  {
    id: 'mutation.lower',
    label: 'Lower mutation rate',
    group: 'Life', weight: 'subtle', cost: 5,
    describe: 'Stabilise what you have. Lineages last longer and change less.',
    apply(world) {
      world.mods.mutation = Math.max(0.15, world.mods.mutation * 0.75);
      return 'Mutation rate at ' + world.mods.mutation.toFixed(2) + ' x baseline.';
    },
  },
  {
    id: 'productivity.raise',
    label: 'Fertilise the biosphere',
    group: 'Life', weight: 'subtle', cost: 6,
    describe: 'More nutrients, more primary production, more carbon buried — and '
      + 'in time, more oxygen.',
    apply(world) {
      world.mods.productivity = Math.min(3.5, world.mods.productivity * 1.25);
      return 'Primary productivity at ' + world.mods.productivity.toFixed(2) + ' x baseline.';
    },
  },

  // --- strong -------------------------------------------------------
  {
    id: 'life.seed',
    label: 'Seed life',
    group: 'Life', weight: 'strong', cost: 18,
    describe: 'Start the whole thing off, now, instead of waiting for chemistry '
      + 'to find its own way. Needs liquid water and a survivable surface.',
    available: (world) => !world.biosphere.lifeStarted
      && world.hydrosphere.waterVolumeKm3 > 2e8
      && world.climate.meanTemp > 0 && world.climate.meanTemp < 95,
    apply(world) {
      world.biosphere.seedLife(world, 'a pool you chose yourself');
      return 'Life seeded.';
    },
  },
  {
    id: 'water.deliver',
    label: 'Divert a comet swarm',
    group: 'Climate', weight: 'strong', cost: 14,
    describe: 'Add roughly a tenth of an ocean. The fastest way to give a dry '
      + 'world a hydrosphere — and a hydrological cycle to go with it.',
    apply(world) {
      world.hydrosphere.waterVolumeKm3 += 1.3e8;
      world.chronicle.record(world.year, 'player',
        'A swarm of ice bodies was steered into the planet. The sky rained for '
        + 'a very long time.', IMPORTANCE.MAJOR);
      return 'Delivered 130 million km3 of water.';
    },
  },
  {
    id: 'carbon.inject',
    label: 'Degas the mantle',
    group: 'Climate', weight: 'strong', cost: 10,
    describe: 'Push carbon out of the deep reservoir and into the air. The '
      + 'standard remedy for a frozen planet.',
    apply(world) {
      const gt = 2500;
      world.climate.injectCarbon(gt);
      world.climate.carbon.mantle = Math.max(0, world.climate.carbon.mantle - gt);
      return 'Released ' + gt + ' GtC into the surface carbon pool.';
    },
  },
  {
    id: 'carbon.scrub',
    label: 'Accelerate weathering',
    group: 'Climate', weight: 'strong', cost: 10,
    describe: 'Shatter and expose silicate rock across the continents, and let '
      + 'the rain do the rest.',
    apply(world) {
      world.mods.weathering = Math.min(4, world.mods.weathering * 1.45);
      return 'Weathering at ' + world.mods.weathering.toFixed(2) + ' x baseline.';
    },
  },
  {
    id: 'plume',
    label: 'Raise a mantle plume',
    group: 'Geology', weight: 'strong', cost: 16, needsTarget: true,
    describe: 'A hotspot under the chosen point: flood basalts, a new highland, '
      + 'and a great deal of CO2.',
    apply(world, ctx) {
      world.geosphere.plume(ctx.cell, world, 1);
      world.climate.injectCarbon(1800);
      world.chronicle.record(world.year, 'player',
        'You opened a mantle plume. Basalt is flooding out over an area the size '
        + 'of a small continent.', IMPORTANCE.MAJOR);
      return 'Plume raised.';
    },
  },
  {
    id: 'heat.raise',
    label: 'Stoke the mantle',
    group: 'Geology', weight: 'strong', cost: 12,
    describe: 'Faster convection: quicker plates, more volcanism, more carbon '
      + 'out of the deep. A tired old planet can be woken up.',
    apply(world) {
      world.mods.mantleHeat = Math.min(3, world.mods.mantleHeat * 1.3);
      return 'Mantle heat at ' + world.mods.mantleHeat.toFixed(2) + ' x baseline.';
    },
  },
  {
    id: 'orogeny',
    label: 'Amplify mountain building',
    group: 'Geology', weight: 'strong', cost: 11,
    describe: 'Collisions pile crust higher. More relief means more fresh rock, '
      + 'and fresh rock is a carbon sink.',
    apply(world) {
      world.mods.orogeny = Math.min(3, world.mods.orogeny * 1.35);
      return 'Orogeny at ' + world.mods.orogeny.toFixed(2) + ' x baseline.';
    },
  },

  // --- blunt --------------------------------------------------------
  {
    id: 'rift',
    label: 'Rift the crust',
    group: 'Geology', weight: 'blunt', cost: 22, needsTarget: true,
    describe: 'Tear a new plate boundary open under the chosen point. Breaking '
      + 'up a supercontinent is a climate intervention, whatever it looks like.',
    apply(world, ctx) {
      world.geosphere.rift(ctx.cell, world, 1);
      world.chronicle.record(world.year, 'player',
        'You split the crust. A new ocean will grow in the gap.',
        IMPORTANCE.MAJOR);
      return 'Rift opened.';
    },
  },
  {
    id: 'impact',
    label: 'Meteor strike',
    group: 'Catastrophe', weight: 'blunt', cost: 26, needsTarget: true,
    describe: 'A large body, at the chosen point. Crater, dust, darkness, and a '
      + 'sharp reduction in whatever was dominant.',
    apply(world, ctx) {
      world.geosphere.impact(ctx.cell, 0.28, world);
      world.climate.injectCarbon(900);
      world.mods.albedo = Math.min(1.6, world.mods.albedo * 1.18);   // dust, for a while
      if (world.biosphere.lifeStarted) {
        world.biosphere.shock(0.55, world, 'A body several kilometres across struck the planet.');
      } else {
        world.chronicle.record(world.year, 'player',
          'A body several kilometres across struck the planet. There was nothing '
          + 'alive to notice.', IMPORTANCE.MAJOR);
      }
      return 'Impact delivered.';
    },
  },
  {
    id: 'extinction.targeted',
    label: 'Targeted extinction',
    group: 'Catastrophe', weight: 'blunt', cost: 20,
    describe: 'Erase the dominant lineage and see what fills the space. The niche '
      + 'does not stay empty for long.',
    available: (world) => world.biosphere.lifeStarted && world.biosphere.diversity > 2,
    apply(world) {
      let top = null;
      for (const sp of world.biosphere.species) {
        if (!sp.alive) continue;
        if (!top || sp.population > top.population) top = sp;
      }
      if (!top) return 'Nothing to erase.';
      const name = top.name;
      world.biosphere.cull((sp) => sp.id === top.id, world, 'targeted extinction');
      return 'Erased ' + name + '.';
    },
  },
  {
    id: 'extinction.clade',
    label: 'Erase a whole clade',
    group: 'Catastrophe', weight: 'blunt', cost: 30,
    describe: 'Remove every land-dwelling lineage at once, and hand the continents '
      + 'back to whatever is still in the sea.',
    available: (world) => world.biosphere.lifeStarted,
    apply(world) {
      const n = world.biosphere.cull(
        (sp) => sp.traits.habitat === HABITAT.LAND || sp.traits.habitat === HABITAT.AERIAL,
        world, 'clade erasure');
      return n ? 'Erased ' + n + ' terrestrial species.' : 'Nothing lived on land.';
    },
  },
  {
    id: 'civ.nudge',
    label: 'Inspire the civilisation',
    group: 'Civilisation', weight: 'strong', cost: 15,
    describe: 'A hint, dropped where they will find it. Raises stability and their '
      + 'understanding of the planet they are standing on.',
    available: (world) => !!world.civilisation && world.civilisation.alive,
    apply(world) {
      const c = world.civilisation;
      c.stability = Math.min(1, c.stability + 0.25);
      c.awareness = Math.min(1, c.awareness + 0.2);
      return 'Stability now ' + (c.stability * 100).toFixed(0) + '%.';
    },
  },
];

export function interventionById(id) {
  return INTERVENTIONS.find((i) => i.id === id) || null;
}

/** Apply an intervention, charging the energy budget. Returns a result the
 *  UI can show, and records what was done in the chronicle. */
export function applyIntervention(world, id, ctx = {}) {
  const iv = interventionById(id);
  if (!iv) return { ok: false, message: 'No such intervention.' };
  if (world.ended) return { ok: false, message: 'The run is over.' };
  if (iv.available && !iv.available(world)) {
    return { ok: false, message: 'Not available on this world right now.' };
  }
  if (iv.needsTarget && ctx.cell === undefined) {
    return { ok: false, message: 'Pick a point on the globe first.' };
  }
  if (world.energy < iv.cost) {
    return { ok: false, message: 'Not enough energy: ' + iv.cost + ' needed, '
      + world.energy.toFixed(1) + ' available.' };
  }
  world.energy -= iv.cost;
  world.energySpent += iv.cost;
  const message = iv.apply(world, ctx);
  world.chronicle.record(world.year, 'player', iv.label + ': ' + message,
    IMPORTANCE.NOTABLE, { intervention: iv.id, cost: iv.cost });
  return { ok: true, message, cost: iv.cost };
}
