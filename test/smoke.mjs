// Headless run: prints the shape of a planet's history so the model can be
// judged without a browser. Not an assertion test — see determinism.test.mjs
// and model.test.mjs for those.
//
//   node test/smoke.mjs [seed] [steps]

import { World } from '../src/sim/world.js';
import { formatYear } from '../src/core/chronicle.js';

const seed = process.argv[2] || 'genesis';
const steps = Number(process.argv[3] || 4000);

const world = new World({ seed, cells: 1200 });
const t0 = Date.now();
for (let i = 0; i < steps; i++) {
  world.step(250000);
  if (world.ended) break;
}
const ms = Date.now() - t0;

const s = world.summary();
console.log('seed            ', seed);
console.log('elapsed         ', formatYear(world.year), '  (' + world.steps + ' steps in ' + ms + ' ms)');
console.log('mean temperature', s.temp.toFixed(1), 'C');
console.log('CO2             ', s.co2.toFixed(1), 'ppm');
console.log('O2              ', s.o2.toFixed(2), '%');
console.log('ice cover       ', (s.ice * 100).toFixed(1), '%');
console.log('ocean           ', (s.water / 1e9).toFixed(3), 'billion km3');
console.log('sea level       ', s.seaLevel.toFixed(0), 'm');
console.log('land            ', (s.land * 100).toFixed(1), '%');
console.log('species         ', s.diversity);
console.log('productivity    ', s.productivity.toFixed(2), 'GtC/yr');
console.log('tech            ', s.tech.toFixed(2));
console.log('fingerprint     ', world.fingerprint());
console.log('ended           ', world.ended ? world.ended.reason : '-');
console.log('');
console.log('--- chronicle ---');
for (const e of world.chronicle.entries.filter((e) => e.importance >= 3)) {
  console.log(formatYear(e.year).padStart(10) + '  [' + e.category + '] ' + e.text);
}
