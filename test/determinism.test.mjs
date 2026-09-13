// The two guarantees the whole design rests on:
//
//   1. the same seed always yields the same planet, and
//   2. a snapshot is a real point in history, so a branch that resumes from
//      one reproduces the future it was taken from.
//
// If either of these breaks, "rewind and compare two branches" stops being a
// laboratory and becomes a guess.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng, hashNumbers } from '../src/core/rng.js';
import { FixedStepClock, TIME_SCALES } from '../src/core/clock.js';
import { World } from '../src/sim/world.js';
import { Timeline } from '../src/game/timeline.js';

const CELLS = 320;          // small mesh: these tests care about equality, not realism
const STEP = 250000;

function run(world, steps) {
  for (let i = 0; i < steps; i++) world.step(STEP);
  return world;
}

test('the rng is reproducible and its forks are independent', () => {
  const a = new Rng('seed-one');
  const b = new Rng('seed-one');
  const c = new Rng('seed-two');
  const takeA = [], takeB = [], takeC = [];
  for (let i = 0; i < 64; i++) { takeA.push(a.next()); takeB.push(b.next()); takeC.push(c.next()); }
  assert.deepEqual(takeA, takeB, 'same seed must give the same stream');
  assert.notDeepEqual(takeA, takeC, 'different seeds must diverge');

  const parent = new Rng('fork-test');
  const f1 = parent.fork('geo');
  const f2 = parent.fork('bio');
  assert.notEqual(f1.next(), f2.next(), 'forks with different tags must differ');

  const parent2 = new Rng('fork-test');
  assert.equal(parent2.fork('geo').next(), new Rng('fork-test').fork('geo').next());
});

test('rng state survives a save/load round trip', () => {
  const r = new Rng('round-trip');
  for (let i = 0; i < 20; i++) r.next();
  const saved = r.save();
  const expected = [r.next(), r.next(), r.next()];
  const restored = Rng.load(saved);
  assert.deepEqual([restored.next(), restored.next(), restored.next()], expected);
});

test('the same seed yields the same planet', () => {
  const a = run(new World({ seed: 'identical', cells: CELLS }), 80);
  const b = run(new World({ seed: 'identical', cells: CELLS }), 80);
  assert.equal(a.fingerprint(), b.fingerprint());
  assert.equal(a.chronicle.entries.length, b.chronicle.entries.length);
  assert.equal(a.climate.co2ppm, b.climate.co2ppm);
});

test('different seeds yield different planets', () => {
  const a = run(new World({ seed: 'alpha', cells: CELLS }), 80);
  const b = run(new World({ seed: 'beta', cells: CELLS }), 80);
  assert.notEqual(a.fingerprint(), b.fingerprint());
});

test('a snapshot round trip changes nothing', () => {
  const world = run(new World({ seed: 'snapshot', cells: CELLS }), 60);
  const before = world.fingerprint();
  const snapshot = world.save();
  const restored = World.load(snapshot);
  assert.equal(restored.fingerprint(), before);
  assert.equal(restored.year, world.year);
  assert.equal(restored.biosphere.species.length, world.biosphere.species.length);
});

test('a branch resumed from a snapshot reproduces the future it was taken from', () => {
  // This is the property that makes "go back 50 Myr and change one thing"
  // meaningful: with nothing changed, both branches must stay identical.
  const world = run(new World({ seed: 'branching', cells: CELLS }), 50);
  const snapshot = world.save();
  const originalFuture = run(world, 40).fingerprint();

  const branch = World.load(snapshot);
  const branchFuture = run(branch, 40).fingerprint();
  assert.equal(branchFuture, originalFuture);
});

test('changing one intervention is the only difference between two branches', () => {
  const world = run(new World({ seed: 'isolate', cells: CELLS }), 40);
  const snapshot = world.save();

  const control = run(World.load(snapshot), 40);
  const treated = World.load(snapshot);
  treated.mods.albedo *= 1.12;
  run(treated, 40);

  assert.notEqual(control.fingerprint(), treated.fingerprint(),
    'a brighter planet must end up in a different state');
  assert.ok(treated.climate.meanTemp < control.climate.meanTemp,
    'raising albedo must cool the planet, not warm it');
});

test('the timeline forks without disturbing its parent', () => {
  const world = run(new World({ seed: 'timeline', cells: CELLS }), 45);
  const timeline = new Timeline(world, { keyframeEverySteps: 5 });
  for (let i = 0; i < 20; i++) { world.step(STEP); timeline.onStep(timeline.active); }

  const parentBefore = world.fingerprint();
  const child = timeline.fork(timeline.active, world.year - 5 * STEP, 'test branch');
  assert.ok(child, 'a keyframe should exist that far back');
  assert.equal(world.fingerprint(), parentBefore, 'forking must not touch the parent');
  assert.ok(child.world.year <= world.year);
  assert.equal(timeline.branches.length, 2);
});

test('rewinding restores an earlier state exactly', () => {
  const world = new World({ seed: 'rewind', cells: CELLS });
  const timeline = new Timeline(world, { keyframeEverySteps: 5 });
  for (let i = 0; i < 30; i++) { world.step(STEP); timeline.onStep(timeline.active); }
  const target = timeline.active.keyframes[3];
  const expected = World.load(target.data).fingerprint();

  timeline.rewind(timeline.active, target.year);
  assert.equal(world.fingerprint(), expected);
  assert.equal(world.year, target.year);
});

test('the simulation is independent of frame rate', () => {
  // The same elapsed wall time must produce the same number of steps whether
  // it arrives as a few long frames or many short ones.
  const count = (frames) => {
    let steps = 0;
    const clock = new FixedStepClock(() => { steps++; });
    clock.setScale(TIME_SCALES[0]);
    clock.setSpeed(1);
    for (const dt of frames) clock.advance(dt);
    return steps;
  };
  const seconds = 2;
  const at60 = new Array(60 * seconds).fill(1 / 60);
  const at144 = new Array(144 * seconds).fill(1 / 144);
  const at30 = new Array(30 * seconds).fill(1 / 30);
  assert.equal(count(at60), count(at144));
  assert.equal(count(at60), count(at30));
  assert.equal(count(at60), TIME_SCALES[0].stepsPerSecond * seconds);
});

test('a paused clock never steps, however much time passes', () => {
  let steps = 0;
  const clock = new FixedStepClock(() => { steps++; });
  clock.setSpeed(0);
  for (let i = 0; i < 500; i++) clock.advance(1 / 60);
  assert.equal(steps, 0);
});

test('a long stall does not become a burst of simulation', () => {
  let steps = 0;
  const clock = new FixedStepClock(() => { steps++; });
  clock.setScale(TIME_SCALES[0]);
  clock.setSpeed(1);
  clock.advance(600);   // a tab left in the background for ten minutes
  assert.ok(steps <= clock.maxStepsPerFrame,
    'catching up must be capped, or the page locks');
});

test('the fingerprint is stable and sensitive', () => {
  assert.equal(hashNumbers([1, 2, 3]), hashNumbers([1, 2, 3]));
  assert.notEqual(hashNumbers([1, 2, 3]), hashNumbers([1, 2, 3.0001]));
  // Below the quantisation floor, float noise must not change the result.
  assert.equal(hashNumbers([1, 2, 3]), hashNumbers([1, 2, 3 + 1e-12]));
});
