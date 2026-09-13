# A planet as the main character

You are handed a young, dead world — molten under a thin skin of basalt, an
unbreathable atmosphere, no liquid water anywhere on the surface — and a few
billion years. You are not a general or a city planner. You tune the
parameters of a system and then watch what crawls out.

There is no mandatory goal. A run ends when your civilisation leaves the
planet, or when the dying sun burns it away.

```
python3 -m http.server 8899     # or any static server
open http://localhost:8899/
```

No build step, no dependencies at runtime. It is ES modules and a canvas.

---

## How it plays

The simulation advances in fixed steps, and you switch between time scales —
geological (250,000 years per step) down to technological (5 years per step).
Every intervention costs energy from a limited budget, so you cannot spam
volcanoes. The tools run from subtle (albedo, mutation rate, humidity) to
blunt (meteor strike, rifting a continent, targeted extinction).

Energy regenerates slowly as the world ages, so waiting is itself a move.

## Four layers that eat each other

**Geosphere** — real plates on a sphere, not tiles on a grid. Cells are points
on a Fibonacci lattice; each plate is a rigid cap rotating about its own Euler
pole, and crust is resampled along that motion, so continents genuinely
travel. Convergence between two thick blocks piles up a mountain range;
convergence between thick and thin subducts one under the other and lights a
volcanic arc; divergence opens new ocean floor. Sea level is solved from the
water that exists against the shape the solid surface happens to be in.
Breaking up a supercontinent is a climate intervention, whatever it looks
like when you do it.

**Atmosphere and climate** — a per-cell radiative balance with diffusive heat
transport, and a carbon cycle with actual flows: volcanism adds, silicate and
seafloor weathering remove, organisms fix and bury and respire, subduction
carries crustal carbon back to the mantle. Ice reflects sunlight and cools,
which makes more ice. Continental positions decide whether the ocean can move
heat poleward at all. Feedback loops are your main enemy and your main ally.

**Biosphere** — life does not climb a fixed ladder from bacterium to human.
A species is a bundle of heritable traits occupying an ecological niche; when
a lineage's range spans a varied enough planet, it splits. Intelligence is one
trait among many, and an expensive one — it pays for itself only where finding
food is hard, which is why a run can perfectly well end with a technological
civilisation of cephalopods, or of carnivorous plants. (The reference run in
`test/` ends with a coastal photosynthetic fungal one.)

**Civilisation** — your creatures start reshaping the planet faster than you
can. From fire to fusion, burning in a few centuries the carbon the biosphere
spent an aeon burying, and with it the first crisis you did not cause.

## What it does differently

### The model is open, not a black box

Every number has a "why?" that unfolds into individual flows — how much carbon
comes from volcanism, how much weathering binds, how much respiration
releases. Those numbers are not captions: the modules post them to a ledger
*while they are computing them*, so the explanation is the arithmetic the
model actually ran.

The planetary cycle diagram is an ordinary window, not a bonus for
enthusiasts. The frustration with old simulators was never the complexity; it
was never finding out why your planet froze.

### The planet writes its own chronicle

The simulation continuously records significant events, with the numbers
attached. When a run ends you hold a history of a world, not just a graph:

```
   125.0 Myr  Life began in the deep, warm dark around a hydrothermal vent.
   229.5 Myr  Free oxygen passed 1% of the atmosphere. The oxygen sinks are
              full at last, and the sky is changing colour.
  1437.2 Myr  Stenoceras — coastal, phototroph, fungal, intelligent, social —
              lit a fire and kept it.
  1437.5 Myr  The Stenoceras left. Their ships are past the outer planets and
              still accelerating.
```

### Time can be rewound and branched

Go back fifty million years, change one intervention, and run both branches
side by side for comparison. That turns a toy into a laboratory: you can
finally isolate a single variable.

This only means anything because the simulation is exactly reproducible, so
the test suite asserts it directly — a branch resumed from a snapshot with
nothing changed reproduces the future it was taken from, bit for bit.

### Sandbox and challenges

Free play stays. Alongside it sit objectives with measurable outcomes, checked
against the same state the model already computes: hold oxygen between 18 and
24% for a billion years, revive a burnt-out world, get a civilisation to
fusion without letting the planet swing more than 4 °C, reach a technological
civilisation that is not a large land vertebrate. It answers the old complaint
that there is nothing to win.

## Under the hood

The simulation step is fixed and decoupled from rendering. Frame time never
reaches the model — the clock consumes elapsed real seconds and issues whole
steps at a fixed rate — so the model runs identically at 60 Hz and 144 Hz, and
a backgrounded tab never wakes up and simulates a burst. `npm test` asserts
that the same elapsed wall time yields the same number of steps whether it
arrives as 30, 60 or 144 frames.

Nothing in the model calls `Math.random()` or reads a clock. The same seed
always yields the same planet, and the whole setup is in the URL, so a run is
shareable as a string:

```
#seed=tethys&challenge=breathable&cells=1400&climate=sensitive
```

The climate and evolution modules are registered implementations chosen by id
(`src/sim/registry.js`), so a custom model can be dropped in and benchmarked
against the defaults on the same seed — the only honest way to compare two
models of a planet.

## Layout

```
index.html, styles.css         the shell
src/core/     rng, sphere mesh, fixed-step clock, flow ledger, chronicle
src/sim/      geosphere, climate, biosphere, civilisation, world, registry
src/game/     interventions, challenges, timeline (rewind and branching)
src/ui/       globe, charts, cycle diagram, panels, app wiring
test/         determinism and model suites, plus a headless browser check
```

## Tests

```
npm test                  # 35 assertions: determinism, branching, physics couplings
npm run smoke             # a headless run, printing a planet's history
npm run browser-check     # loads the page in Chromium and drives the UI
```

The determinism suite is the load-bearing one. The model suite checks that the
couplings point the right way (more CO2 warms; ice raises albedo; the silicate
thermostat pulls an injected carbon pulse back down; plate convergence raises
ground that was not there before) and that a two-thousand-step run never
produces a NaN, a negative reservoir, or a temperature below absolute zero.

## Known limits

- A continental shelf is far narrower than one cell at any affordable
  resolution, so the shelf is carried as a flag on the coastal ring rather
  than pretended to be resolved. Most carbon burial happens there, and so does
  the route from sea to land.
- Water vapour is not a tracked gas; it is a fast feedback folded into the
  outgoing-longwave coefficients.
- Ocean circulation is a heat-transport coefficient modulated by how open the
  latitude bands are, not a current field.
- The carbon cycle is integrated in substeps with a per-substep cap on
  reservoir change, because a quarter-million-year step is long compared to
  the residence times involved.
