// Fixed simulation step, decoupled from rendering.
//
// The model advances in whole steps at a fixed rate. The renderer draws
// whenever the display asks it to. A 60 Hz monitor and a 144 Hz monitor
// therefore run the *same* simulation at the same speed, and the same seed
// yields the same planet on both. Frame time never enters the model.

/** Time scales the player switches between. `years` is the simulated span
 *  of one step; `stepsPerSecond` is how fast those steps are issued at
 *  speed 1, which affects only how quickly the player watches it happen. */
export const TIME_SCALES = [
  { id: 'geological', label: 'Geological', years: 250000, stepsPerSecond: 12, hint: 'plates, orogeny, deep carbon' },
  { id: 'evolutionary', label: 'Evolutionary', years: 20000, stepsPerSecond: 12, hint: 'speciation, radiations, extinctions' },
  { id: 'ecological', label: 'Ecological', years: 500, stepsPerSecond: 12, hint: 'populations, biomes, early cultures' },
  { id: 'technological', label: 'Technological', years: 5, stepsPerSecond: 12, hint: 'a civilisation reshaping the world' },
];

export function scaleById(id) {
  return TIME_SCALES.find((s) => s.id === id) || TIME_SCALES[0];
}

export class FixedStepClock {
  constructor(onStep) {
    this.onStep = onStep;
    this.accumulator = 0;       // seconds of unconsumed wall time
    this.speed = 1;             // 0 = paused, 1..8 = multiplier
    this.scale = TIME_SCALES[0];
    /** Hard cap on steps consumed per frame. Without it, a tab that was
     *  backgrounded for a minute would try to catch up in one frame and
     *  lock the page; the simulation simply runs slower than wall time
     *  instead, which is fine because nothing in the model reads a clock. */
    this.maxStepsPerFrame = 40;
    this.stepsTaken = 0;
  }

  setScale(scale) { this.scale = scale; this.accumulator = 0; }
  setSpeed(speed) { this.speed = speed; if (speed === 0) this.accumulator = 0; }
  get paused() { return this.speed === 0; }

  /**
   * Feed the clock the wall-clock time since the last frame.
   * @param {number} dtSeconds real seconds; clamped, never passed to the model
   * @returns {number} steps actually executed
   */
  advance(dtSeconds) {
    if (this.speed === 0) return 0;
    // A long stall must not become a burst of simulation.
    const dt = Math.min(Math.max(dtSeconds, 0), 0.25);
    const stepInterval = 1 / (this.scale.stepsPerSecond * this.speed);
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= stepInterval && steps < this.maxStepsPerFrame) {
      this.accumulator -= stepInterval;
      this.onStep(this.scale.years);
      steps++;
      this.stepsTaken++;
    }
    if (steps === this.maxStepsPerFrame) this.accumulator = 0;
    return steps;
  }

  /** Run n steps immediately, ignoring wall time. Used by fast-forward,
   *  by challenge scoring and by the headless tests. */
  runSteps(n) {
    for (let i = 0; i < n; i++) { this.onStep(this.scale.years); this.stepsTaken++; }
  }
}
