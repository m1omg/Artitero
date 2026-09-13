// Swappable model modules.
//
// The climate and evolution models are not welded into the world: they are
// registered implementations chosen by id. A custom model can be dropped in
// and benchmarked against the defaults on the same seed, which is the only
// honest way to compare two models of a planet.

import { Climate } from './climate.js';
import { Biosphere } from './biosphere.js';

const registry = {
  climate: new Map(),
  biosphere: new Map(),
};

/**
 * @param {'climate'|'biosphere'} kind
 * @param {string} id
 * @param {{label:string, describe?:string, create:(mesh,rng,params)=>object}} impl
 */
export function registerModule(kind, id, impl) {
  if (!registry[kind]) throw new Error('unknown module kind: ' + kind);
  registry[kind].set(id, impl);
  return id;
}

export function getModule(kind, id) {
  const impl = registry[kind].get(id);
  if (!impl) throw new Error('no ' + kind + ' module registered as "' + id + '"');
  return impl;
}

export function listModules(kind) {
  return [...registry[kind].entries()].map(([id, impl]) => ({ id, label: impl.label, describe: impl.describe || '' }));
}

registerModule('climate', 'default', {
  label: 'Energy balance + carbon cycle',
  describe: 'Per-cell radiative balance with diffusive transport, silicate weathering thermostat, '
    + 'ice-albedo feedback and an explicit carbon reservoir model.',
  create: (mesh, rng, params) => new Climate(mesh, rng, params),
});

registerModule('climate', 'sensitive', {
  label: 'High sensitivity variant',
  describe: 'The same physics with a hotter response to forcing and weaker heat transport: '
    + 'useful for seeing how much of a run is thermostat and how much is luck.',
  create: (mesh, rng, params) => new Climate(mesh, rng, Object.assign({
    climateSensitivity: 1.15, heatTransport: 0.3,
  }, params)),
});

registerModule('biosphere', 'default', {
  label: 'Trait-space evolution',
  describe: 'Heritable traits, niche competition for carrying capacity, speciation driven by '
    + 'range fragmentation. Intelligence is an ordinary, expensive trait.',
  create: (mesh, rng, params) => new Biosphere(mesh, rng, params),
});

registerModule('biosphere', 'volatile', {
  label: 'High-mutation variant',
  describe: 'The same rules with a much faster trait drift and lower speciation threshold: '
    + 'radiations and extinctions both come quickly.',
  create: (mesh, rng, params) => new Biosphere(mesh, rng, Object.assign({
    mutationRate: 2.4, speciationPressure: 2.0, maxSpecies: 96,
  }, params)),
});
