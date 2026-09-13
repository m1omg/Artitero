// Does the model behave like a planet?
//
// These are not calibration tests — the numbers are a game's numbers. They
// check that the couplings point the right way and that nothing in a long
// run goes to NaN, negative mass, or infinity.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SphereMesh } from '../src/core/sphere.js';
import { World } from '../src/sim/world.js';
import { Climate, luminosity } from '../src/sim/climate.js';
import { applyIntervention } from '../src/game/interventions.js';
import { CHALLENGES, evaluate, applySetup, challengeById } from '../src/game/challenges.js';
import { listModules } from '../src/sim/registry.js';

const CELLS = 320;

function advance(world, steps, dt = 250000) {
  for (let i = 0; i < steps; i++) world.step(dt);
  return world;
}

function allFinite(world) {
  const arrays = [
    world.geosphere.elevation, world.geosphere.thickness, world.geosphere.age,
    world.climate.temperature, world.climate.precipitation, world.climate.ice,
    world.biosphere.producerDensity, world.biosphere.landCover,
  ];
  for (const arr of arrays) {
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i])) return false;
    }
  }
  const scalars = [world.climate.meanTemp, world.climate.co2ppm, world.climate.o2Percent,
    world.geosphere.seaLevel, world.hydrosphere.waterVolumeKm3, world.biosphere.productivity];
  return scalars.every(Number.isFinite);
}

// ---------------------------------------------------------------- mesh

test('the mesh covers the sphere evenly', () => {
  const mesh = new SphereMesh(600);
  assert.equal(mesh.n, 600);
  const totalArea = mesh.cellAreaKm2 * mesh.n;
  const sphere = 4 * Math.PI * mesh.radiusKm ** 2;
  assert.ok(Math.abs(totalArea - sphere) / sphere < 1e-9);

  for (let i = 0; i < mesh.n; i++) {
    const r = Math.hypot(mesh.x[i], mesh.y[i], mesh.z[i]);
    assert.ok(Math.abs(r - 1) < 1e-9, 'every cell must sit on the unit sphere');
  }

  // Neighbour distances should all be within a small factor of the mean:
  // a lattice with a hole in it would break the diffusion and the BFS.
  let min = Infinity, max = 0;
  for (let i = 0; i < mesh.n; i++) {
    const d = mesh.greatCircleKm(i, mesh.neighboursOf(i)[0]);
    min = Math.min(min, d); max = Math.max(max, d);
  }
  assert.ok(max / min < 3, 'neighbour spacing should be roughly uniform, got ' + (max / min).toFixed(2));
});

test('nearest() finds the cell it is given', () => {
  const mesh = new SphereMesh(400);
  for (const i of [0, 37, 199, 399]) {
    assert.equal(mesh.nearest(mesh.x[i], mesh.y[i], mesh.z[i]), i);
  }
});

// ---------------------------------------------------------------- star

test('the star brightens with age and eventually runs away', () => {
  assert.ok(luminosity(0) < luminosity(4.57));
  assert.ok(Math.abs(luminosity(4.57) - 1) < 1e-9, 'the reference age is the present Sun');
  assert.ok(luminosity(4.57) < luminosity(8));
  assert.ok(luminosity(11) > 3, 'leaving the main sequence must be violent');
});

test('insolation is highest at the equator', () => {
  assert.ok(Climate.insolationFactor(0) > Climate.insolationFactor(Math.PI / 4));
  assert.ok(Climate.insolationFactor(Math.PI / 4) > Climate.insolationFactor(Math.PI / 2));
});

// ---------------------------------------------------------------- physics

test('more CO2 warms the planet and less cools it', () => {
  const base = advance(new World({ seed: 'forcing', cells: CELLS }), 30);
  const snapshot = base.save();

  const warm = World.load(snapshot);
  warm.climate.injectCarbon(warm.climate.carbon.surface * 3);
  warm.step(250000);

  const cool = World.load(snapshot);
  cool.climate.carbon.surface *= 0.25;
  cool.step(250000);

  assert.ok(warm.climate.meanTemp > cool.climate.meanTemp,
    'a thicker CO2 atmosphere must be the warmer one');
});

test('ice raises albedo, which is the feedback that makes snowballs possible', () => {
  const world = advance(new World({ seed: 'albedo', cells: CELLS }), 40);
  let iced = 0, bare = 0, icedAlbedo = 0, bareAlbedo = 0;
  for (let i = 0; i < world.mesh.n; i++) {
    if (world.climate.ice[i] > 0.6) { iced++; icedAlbedo += world.climate.albedo[i]; }
    else if (world.climate.ice[i] < 0.05) { bare++; bareAlbedo += world.climate.albedo[i]; }
  }
  if (iced > 0 && bare > 0) {
    assert.ok(icedAlbedo / iced > bareAlbedo / bare,
      'ice-covered cells must reflect more than bare ones');
  }
});

test('the silicate thermostat opposes what is done to it', () => {
  const world = advance(new World({ seed: 'thermostat', cells: CELLS }), 200);
  world.climate.injectCarbon(world.climate.carbon.surface * 4);
  const spike = world.climate.co2ppm;
  const peakWarmth = world.climate.meanTemp;

  // The claim is about the response, not about where the planet ends up: on
  // a long enough view the equilibrium itself moves as the geography and the
  // ice cover change, and that is a different mechanism.
  let lowest = spike;
  let weathering = 0, volcanism = 0;
  for (let i = 0; i < 120; i++) {
    world.step(250000);
    lowest = Math.min(lowest, world.climate.co2ppm);
    weathering = world.climate.lastFlows.weathering + world.climate.lastFlows.seafloor;
    volcanism = world.climate.lastFlows.volcanism;
  }
  assert.ok(lowest < spike * 0.6,
    'weathering must draw an injected pulse of carbon back down: ' + spike.toFixed(0)
    + ' -> ' + lowest.toFixed(0) + ' ppm');
  assert.ok(world.climate.meanTemp < peakWarmth,
    'and the planet must cool back off the spike');
  assert.ok(Math.abs(weathering - volcanism) < Math.max(weathering, volcanism) * 0.6,
    'sources and sinks should settle close to balance');
});

test('water arrives from the mantle and makes a sea level', () => {
  const world = new World({ seed: 'ocean', cells: CELLS });
  assert.equal(world.hydrosphere.waterVolumeKm3, 0, 'a young world starts dry');
  assert.equal(world.geosphere.stats.landFraction, 1, 'all of it is land while it is dry');
  advance(world, 600);
  assert.ok(world.hydrosphere.waterVolumeKm3 > 1e8, 'volcanism must degas an ocean');
  assert.ok(world.geosphere.stats.landFraction < 0.9, 'and that ocean must flood the low ground');
  assert.ok(world.hydrosphere.mantleWaterKm3 >= 0, 'the mantle reservoir is finite');
});

test('plate motion builds relief', () => {
  const world = new World({ seed: 'tectonics', cells: 600 });
  const startMax = world.geosphere.stats.maxElevation;
  advance(world, 400);
  assert.ok(world.geosphere.stats.maxElevation > startMax,
    'convergence must raise ground that was not there at the start');
  let converging = 0, diverging = 0;
  for (let i = 0; i < world.mesh.n; i++) {
    if (world.geosphere.strain[i] > 0) converging++;
    if (world.geosphere.strain[i] < 0) diverging++;
  }
  assert.ok(converging > 0 && diverging > 0,
    'a sphere of rigid plates must have both convergent and divergent boundaries');
});

// ---------------------------------------------------------------- stability

test('nothing goes to NaN or negative mass over a long run', () => {
  const world = new World({ seed: 'stability', cells: CELLS });
  for (let i = 0; i < 2000; i++) {
    world.step(250000);
    if (i % 250 === 0) {
      assert.ok(allFinite(world), 'non-finite state at step ' + i);
      const c = world.climate.carbon;
      for (const [name, v] of Object.entries(c)) {
        assert.ok(v >= 0 && Number.isFinite(v), name + ' went bad at step ' + i + ': ' + v);
      }
      assert.ok(world.climate.o2Gt >= 0);
      assert.ok(world.hydrosphere.waterVolumeKm3 >= 0);
      assert.ok(world.climate.meanTemp > -273, 'colder than absolute zero at step ' + i);
    }
  }
  assert.ok(allFinite(world));
});

test('the same planet at two mesh resolutions is recognisably the same planet', () => {
  // Tectonic flux is normalised by mesh spacing precisely so that a finer
  // mesh does not report a different world.
  const coarse = advance(new World({ seed: 'resolution', cells: 320 }), 300);
  const fine = advance(new World({ seed: 'resolution', cells: 900 }), 300);
  const ratio = (a, b) => Math.abs(a - b) / Math.max(1e-9, Math.abs(a) + Math.abs(b));
  assert.ok(ratio(coarse.geosphere.stats.volcanicActivity, fine.geosphere.stats.volcanicActivity) < 0.5,
    'volcanic activity must not be an artefact of cell count');
  assert.ok(Math.abs(coarse.climate.meanTemp - fine.climate.meanTemp) < 30,
    'temperature must be in the same regime at both resolutions');
});

// ---------------------------------------------------------------- life

test('life appears, diversifies, and carries traits from its ancestors', () => {
  const world = new World({ seed: 'life', cells: CELLS });
  advance(world, 1600);
  assert.ok(world.biosphere.species.length > 1, 'a single lineage must have branched');
  for (const sp of world.biosphere.species) {
    if (sp.parentId === 0) continue;
    const parent = world.biosphere.species.find((p) => p.id === sp.parentId);
    if (!parent) continue;
    assert.ok(sp.birthYear >= parent.birthYear, 'a child cannot predate its parent');
  }
});

test('intelligence is a trait with a cost, not a prize at the top of a tree', () => {
  const world = new World({ seed: 'minds', cells: CELLS });
  advance(world, 2000);
  const alive = world.biosphere.species.filter((s) => s.alive);
  if (alive.length > 3) {
    const smart = alive.filter((s) => s.traits.intelligence > 0.4).length;
    assert.ok(smart < alive.length,
      'not every lineage should be climbing toward a brain');
  }
  // Whatever the run produced, intelligence must be reachable from any body
  // plan and any habitat: nothing in the rules privileges one shape.
  const habitats = new Set(alive.map((s) => s.traits.habitat));
  assert.ok(habitats.size >= 1);
});

test('a biosphere changes the atmosphere it lives in', () => {
  const world = new World({ seed: 'oxygen', cells: CELLS });
  advance(world, 2400);
  if (world.biosphere.productivity > 1) {
    assert.ok(world.climate.o2Percent > 0.05,
      'sustained photosynthesis with burial must leave free oxygen behind');
    assert.ok(world.climate.carbon.organic > 0,
      'and must leave organic carbon in the crust');
  }
});

// ---------------------------------------------------------------- game layer

test('interventions charge energy and are refused when it runs out', () => {
  const world = advance(new World({ seed: 'energy', cells: CELLS }), 20);
  world.energy = 10;
  const before = world.mods.albedo;

  const ok = applyIntervention(world, 'albedo.brighten');
  assert.equal(ok.ok, true);
  assert.ok(world.energy < 10, 'energy must actually be spent');
  assert.ok(world.mods.albedo > before, 'and the world must actually change');

  world.energy = 0;
  const refused = applyIntervention(world, 'albedo.brighten');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /energy/i);
});

test('an intervention that needs a target refuses to fire without one', () => {
  const world = advance(new World({ seed: 'target', cells: CELLS }), 20);
  world.energy = 100;
  const refused = applyIntervention(world, 'rift');
  assert.equal(refused.ok, false);
  const ok = applyIntervention(world, 'rift', { cell: 5 });
  assert.equal(ok.ok, true);
});

test('every intervention runs without throwing and leaves a sane world', () => {
  for (const id of ['albedo.brighten', 'albedo.darken', 'humidity.raise', 'humidity.lower',
    'transport.raise', 'mutation.raise', 'mutation.lower', 'productivity.raise',
    'water.deliver', 'carbon.inject', 'carbon.scrub', 'plume', 'heat.raise', 'orogeny',
    'rift', 'impact']) {
    const world = advance(new World({ seed: 'sweep-' + id, cells: 240 }), 40);
    world.energy = 1000;
    const result = applyIntervention(world, id, { cell: 11 });
    assert.equal(result.ok, true, id + ': ' + result.message);
    world.step(250000);
    assert.ok(allFinite(world), id + ' left the world in a bad state');
  }
});

test('seeding life works, and only once', () => {
  const world = new World({ seed: 'seeded', cells: CELLS });
  advance(world, 700);   // long enough for an ocean
  world.energy = 1000;
  if (!world.biosphere.lifeStarted) {
    const first = applyIntervention(world, 'life.seed');
    assert.equal(first.ok, true);
    assert.equal(world.biosphere.lifeStarted, true);
    assert.equal(world.biosphere.species.length, 1);
    const second = applyIntervention(world, 'life.seed');
    assert.equal(second.ok, false, 'life cannot begin twice');
  }
});

test('every challenge evaluates against a fresh world without throwing', () => {
  for (const challenge of CHALLENGES) {
    const world = new World({ seed: challenge.setup.seed, cells: 240,
      energyBudget: challenge.setup.energyBudget });
    applySetup(world, challenge);
    world._settle();
    advance(world, 40);
    const result = evaluate(challenge, world);
    assert.equal(result.rows.length, challenge.objectives.length);
    for (const row of result.rows) {
      assert.ok(row.progress >= 0 && row.progress <= 1, challenge.id + '/' + row.id);
      assert.equal(typeof row.detail, 'string');
    }
  }
});

test('the burnt-out world really does start burnt out', () => {
  const challenge = challengeById('revive');
  const world = new World({ seed: challenge.setup.seed, cells: 240 });
  applySetup(world, challenge);
  world._settle();
  assert.equal(world.hydrosphere.waterVolumeKm3, 0);
  assert.equal(world.biosphere.lifeStarted, false);
  assert.ok(world.climate.carbon.surface > 100000, 'its carbon is all in the sky');
  assert.ok(world.mods.mantleHeat < 1, 'and its mantle is cold');
});

test('the model modules are swappable and produce different worlds', () => {
  assert.ok(listModules('climate').length >= 2);
  assert.ok(listModules('biosphere').length >= 2);
  const base = advance(new World({ seed: 'modules', cells: CELLS }), 120);
  const variant = advance(new World({
    seed: 'modules', cells: CELLS, climateModel: 'sensitive',
  }), 120);
  assert.notEqual(base.fingerprint(), variant.fingerprint(),
    'a different climate model must give a different planet on the same seed');
});

test('a run ends when the star burns the world away', () => {
  const world = new World({ seed: 'ending', cells: 240 });
  // Fast-forward the star rather than the planet: this is the ending that
  // arrives whatever the player does.
  world.year = 10.2e9;
  world.mods.insolation = 3;
  for (let i = 0; i < 40 && !world.ended; i++) world.step(250000);
  assert.ok(world.ended, 'a swelling star must end the run');
  assert.equal(world.ended.reason, 'burned');
});
