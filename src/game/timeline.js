// Time can be rewound and branched.
//
// The simulation is deterministic and fully serialisable, so a snapshot is
// a real point in history: go back fifty million years, change one
// intervention, and run both branches forward side by side. That is what
// turns a toy into a laboratory — it is the only way to isolate a single
// variable on a planet.

import { World } from '../sim/world.js';

export class Timeline {
  /**
   * @param {World} world the active world
   * @param {object} opts { keyframeEverySteps, maxKeyframes }
   */
  constructor(world, opts = {}) {
    this.opts = Object.assign({ keyframeEverySteps: 15, maxKeyframes: 300 }, opts);
    this.branches = [];
    this.activeId = null;
    this.compareId = null;
    this.nextBranchId = 1;
    this.addBranch(world, 'main', null);
  }

  addBranch(world, label, parentId) {
    const branch = {
      id: this.nextBranchId++,
      label,
      parentId,
      world,
      keyframes: [],
      colour: BRANCH_COLOURS[(this.nextBranchId - 2) % BRANCH_COLOURS.length],
      forkedAtYear: world.year,
    };
    world.branchLabel = label;
    this.branches.push(branch);
    if (this.activeId === null) this.activeId = branch.id;
    this.capture(branch);
    return branch;
  }

  get active() { return this.byId(this.activeId); }
  get compare() { return this.compareId === null ? null : this.byId(this.compareId); }
  byId(id) { return this.branches.find((b) => b.id === id) || null; }

  /** Called after every simulation step of a branch. */
  onStep(branch) {
    if (branch.world.steps % this.opts.keyframeEverySteps === 0) this.capture(branch);
  }

  capture(branch) {
    const frame = { year: branch.world.year, steps: branch.world.steps, data: branch.world.save() };
    const frames = branch.keyframes;
    if (frames.length && frames[frames.length - 1].steps === frame.steps) {
      frames[frames.length - 1] = frame;
      return frame;
    }
    frames.push(frame);
    // Thin the oldest half when the budget is reached: recent history is
    // what gets rewound, deep history only needs to stay navigable.
    if (frames.length > this.opts.maxKeyframes) {
      const kept = [];
      for (let i = 0; i < frames.length; i++) {
        if (i < frames.length / 2) { if (i % 2 === 0) kept.push(frames[i]); }
        else kept.push(frames[i]);
      }
      branch.keyframes = kept;
    }
    return frame;
  }

  /** Nearest keyframe at or before a given year. */
  frameAt(branch, year) {
    let best = branch.keyframes[0] || null;
    for (const f of branch.keyframes) {
      if (f.year <= year + 1e-6) best = f; else break;
    }
    return best;
  }

  /** Rewind a branch in place: the future after this point is discarded. */
  rewind(branch, year) {
    const frame = this.frameAt(branch, year);
    if (!frame) return null;
    branch.world.applySnapshot(frame.data);
    branch.keyframes = branch.keyframes.filter((f) => f.steps <= frame.steps);
    return frame;
  }

  /**
   * Fork: keep the original running and start a second world from the same
   * point in its history. Both branches share a seed and a past, so any
   * later difference between them is caused by what the player did.
   */
  fork(branch, year, label) {
    const frame = this.frameAt(branch, year);
    if (!frame) return null;
    const world = World.load(frame.data);
    const child = this.addBranch(world, label || ('branch ' + this.nextBranchId), branch.id);
    child.forkedAtYear = frame.year;
    world.chronicle.record(world.year, 'player',
      'History forked here. This branch runs from the same state as "' + branch.label
      + '", and every difference from here on is yours.', 2, { from: branch.label });
    return child;
  }

  removeBranch(id) {
    if (this.branches.length <= 1) return false;
    const idx = this.branches.findIndex((b) => b.id === id);
    if (idx < 0) return false;
    this.branches.splice(idx, 1);
    if (this.activeId === id) this.activeId = this.branches[0].id;
    if (this.compareId === id) this.compareId = null;
    return true;
  }

  /** Every branch that is currently being advanced. */
  running() {
    const out = [this.active];
    const cmp = this.compare;
    if (cmp && cmp !== this.active) out.push(cmp);
    return out.filter(Boolean);
  }
}

export const BRANCH_COLOURS = ['#7fd4ff', '#ffb072', '#a6e57f', '#e58fd0', '#e5d97f'];
