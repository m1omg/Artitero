// Sandbox and challenges.
//
// Free play stays — there is no mandatory goal, and a run ends only when a
// civilisation leaves or the star burns the world away. But alongside it sit
// objectives with measurable outcomes, checked against the same state the
// model already computes. That is the answer to "there's nothing to win":
// something to aim at, for the players who want one.

export const CHALLENGES = [
  {
    id: 'sandbox',
    name: 'Sandbox',
    blurb: 'No objective. Tune the parameters and see what crawls out.',
    setup: { seed: 'sandbox', energyBudget: 140 },
    objectives: [],
  },
  {
    id: 'breathable',
    name: 'The Great Oxygenation',
    blurb: 'Hold atmospheric oxygen between 18% and 24% for a billion years, '
      + 'without letting the biosphere collapse.',
    setup: { seed: 'oxygen', energyBudget: 110 },
    objectives: [
      {
        id: 'o2band',
        label: 'Oxygen within 18-24% for 1 Gyr',
        // Sustained conditions are measured against the sampled history, so
        // they cannot be faked by a single lucky step.
        progress(world) {
          return sustained(world, 1e9, (h) => h.o2 >= 18 && h.o2 <= 24);
        },
        format: (p) => (p * 100).toFixed(0) + '% of the required span',
      },
      {
        id: 'alive',
        label: 'At least 12 species still living',
        progress: (world) => Math.min(1, world.biosphere.diversity / 12),
        format: (p, world) => world.biosphere.diversity + ' species',
      },
    ],
  },
  {
    id: 'revive',
    name: 'Revive a burnt-out world',
    blurb: 'This planet has already cooked once: no water, no life, a dead '
      + 'mantle. Bring it back to a living biosphere.',
    setup: { seed: 'ashes', energyBudget: 190, scorched: true },
    objectives: [
      {
        id: 'ocean',
        label: 'An ocean of at least 800 million km3',
        progress: (world) => Math.min(1, world.hydrosphere.waterVolumeKm3 / 8e8),
        format: (p, world) => (world.hydrosphere.waterVolumeKm3 / 1e6).toFixed(0) + ' M km3',
      },
      {
        id: 'life',
        label: 'A biosphere of 20 or more species',
        progress: (world) => Math.min(1, world.biosphere.diversity / 20),
        format: (p, world) => world.biosphere.diversity + ' species',
      },
      {
        id: 'temperate',
        label: 'Mean temperature between 5 and 30 C for 200 Myr',
        progress: (world) => sustained(world, 2e8, (h) => h.temp >= 5 && h.temp <= 30),
        format: (p) => (p * 100).toFixed(0) + '% of the required span',
      },
    ],
  },
  {
    id: 'industry',
    name: 'Save them from themselves',
    blurb: 'A civilisation will arise and start burning the carbon its own '
      + 'biosphere buried. Get them to fusion without letting the planet swing '
      + 'more than 4 C.',
    setup: { seed: 'furnace', energyBudget: 90 },
    objectives: [
      {
        id: 'tech',
        label: 'Civilisation reaches fusion (tech 9)',
        progress: (world) => world.civilisation ? Math.min(1, world.civilisation.tech / 9) : 0,
        format: (p, world) => world.civilisation
          ? 'tech ' + world.civilisation.tech.toFixed(1) : 'no civilisation yet',
      },
      {
        id: 'stable',
        label: 'Temperature never swings more than 4 C after they appear',
        progress(world) {
          if (!world.civilisation) return 0;
          const from = world.civilisation.foundedYear;
          let lo = Infinity, hi = -Infinity;
          for (const h of world.history) {
            if (h.year < from) continue;
            lo = Math.min(lo, h.temp); hi = Math.max(hi, h.temp);
          }
          if (!Number.isFinite(lo)) return 1;
          return Math.max(0, Math.min(1, 1 - Math.max(0, hi - lo - 4) / 8));
        },
        format(p, world) {
          if (!world.civilisation) return 'not started';
          const from = world.civilisation.foundedYear;
          let lo = Infinity, hi = -Infinity;
          for (const h of world.history) {
            if (h.year < from) continue;
            lo = Math.min(lo, h.temp); hi = Math.max(hi, h.temp);
          }
          return Number.isFinite(lo) ? 'swing ' + (hi - lo).toFixed(1) + ' C' : 'no data';
        },
      },
      {
        id: 'survive',
        label: 'They do not collapse more than once',
        progress: (world) => world.civilisation
          ? (world.civilisation.collapses <= 1 ? 1 : 0) : 0,
        format: (p, world) => world.civilisation
          ? world.civilisation.collapses + ' collapses' : '-',
      },
    ],
  },
  {
    id: 'notus',
    name: 'Anything but vertebrates',
    blurb: 'Reach a technological civilisation whose founding species is not a '
      + 'large land vertebrate. Cephalopods count. So do carnivorous plants.',
    setup: { seed: 'others', energyBudget: 120 },
    objectives: [
      {
        id: 'civ',
        label: 'A civilisation exists',
        progress: (world) => world.civilisation ? 1 : 0,
        format: (p, world) => world.civilisation ? world.civilisation.speciesName : 'none yet',
      },
      {
        id: 'shape',
        label: 'Its founders are not large terrestrial vertebrates',
        progress(world) {
          if (!world.civilisation) return 0;
          const sp = world.biosphere.species.find((s) => s.id === world.civilisation.speciesId);
          if (!sp) return 0;
          const vertebrateAshore = sp.traits.plan === 'vertebrate'
            && sp.traits.habitat === 2 && sp.traits.size > 0.5;
          return vertebrateAshore ? 0 : 1;
        },
        format: (p, world) => world.civilisation ? world.civilisation.descriptor : '-',
      },
      {
        id: 'tech',
        label: 'They reach the information age (tech 7)',
        progress: (world) => world.civilisation ? Math.min(1, world.civilisation.tech / 7) : 0,
        format: (p, world) => world.civilisation
          ? 'tech ' + world.civilisation.tech.toFixed(1) : '-',
      },
    ],
  },
];

/** Fraction of a required span that the world has actually held a condition,
 *  measured over the sampled history rather than over a running counter, so
 *  that rewinding time rewinds progress too. */
function sustained(world, requiredYears, predicate) {
  const h = world.history;
  let best = 0, runStart = null, prev = null;
  for (const sample of h) {
    if (predicate(sample)) {
      if (runStart === null) runStart = sample.year;
      best = Math.max(best, sample.year - runStart);
    } else {
      runStart = null;
    }
    prev = sample;
  }
  return Math.min(1, best / requiredYears);
}

export function challengeById(id) {
  return CHALLENGES.find((c) => c.id === id) || CHALLENGES[0];
}

/** Evaluate every objective of a challenge against a world. */
export function evaluate(challenge, world) {
  const rows = challenge.objectives.map((o) => {
    const p = Math.max(0, Math.min(1, o.progress(world)));
    return { id: o.id, label: o.label, progress: p, detail: o.format ? o.format(p, world) : '' };
  });
  const complete = rows.length > 0 && rows.every((r) => r.progress >= 0.999);
  return { rows, complete };
}

/** Some challenges start from a world that is not the default young planet. */
export function applySetup(world, challenge) {
  if (!challenge.setup.scorched) return;
  // A world that has already been through a runaway greenhouse: its water is
  // gone, its mantle is cold, and its carbon is all in the air.
  world.hydrosphere.waterVolumeKm3 = 0;
  world.hydrosphere.mantleWaterKm3 = 2.2e8;
  world.climate.carbon.surface = 620000;
  world.climate.carbon.atmosphere = 620000;
  world.climate.carbon.ocean = 0;
  world.climate.carbon.organic = 0;
  world.mods.mantleHeat = 0.35;
  world.chronicle.record(0, 'geosphere',
    'This world has already died once. The oceans boiled off, the carbon is all '
    + 'in the sky, and the mantle barely turns over. Nothing here is alive.',
    4, { challenge: challenge.id });
}
