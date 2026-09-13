// Panel rendering: the model inspector, the chronicle, the species list,
// the intervention tray, the branch list and the challenge sheet.
//
// All of it is plain DOM built from the live world state. Nothing here
// caches simulation numbers — if a panel shows a value, it read it from the
// model this frame.

import { formatAgo, formatYear } from '../core/chronicle.js';
import { INTERVENTIONS } from '../game/interventions.js';
import { evaluate } from '../game/challenges.js';
import { eraName } from '../sim/civilisation.js';
import { HABITAT_NAMES, METABOLISM_NAMES } from '../sim/biosphere.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmt(value, unit) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  const a = Math.abs(value);
  let s;
  if (a >= 1e6) s = (value / 1e6).toFixed(2) + 'M';
  else if (a >= 1e4) s = (value / 1e3).toFixed(1) + 'k';
  else if (a >= 100) s = value.toFixed(0);
  else if (a >= 1) s = value.toFixed(2);
  else if (a >= 0.001) s = value.toFixed(4);
  else if (a === 0) s = '0';
  else s = value.toExponential(2);
  return unit ? s + ' ' + unit : s;
}

// ---------------------------------------------------------------
// "Why?" — the model inspector
// ---------------------------------------------------------------

/** Which nodes the player has unfolded. Kept outside the render so that
 *  rebuilding the tree every frame does not collapse it under them. */
const openNodes = new Set(['climate', 'carbon']);

export function renderLedger(container, world) {
  container.textContent = '';
  const ledger = world.ledger;
  const roots = ledger.roots();
  if (!roots.length) {
    container.appendChild(el('p', 'muted', 'Run a step to populate the model.'));
    return;
  }
  const intro = el('p', 'muted');
  intro.textContent = 'Every number here is the arithmetic the model actually ran this step. '
    + 'Unfold one to see the flows it is made of.';
  container.appendChild(intro);
  for (const root of roots) container.appendChild(nodeRow(ledger, root, 0));
}

function nodeRow(ledger, node, depth) {
  const wrap = el('div', 'ledger-node');
  const children = ledger.childrenOf(node.id);
  const hasDetail = children.length > 0 || node.terms.length > 0;
  const row = el('div', 'ledger-row' + (hasDetail ? ' clickable' : ''));
  row.style.paddingLeft = (depth * 12) + 'px';

  if (hasDetail) {
    const caret = el('span', 'caret', openNodes.has(node.id) ? '▾' : '▸');
    row.appendChild(caret);
  } else {
    row.appendChild(el('span', 'caret', ' '));
  }
  row.appendChild(el('span', 'ledger-label', node.label));
  if (node.unit !== '' || node.value !== 0) {
    row.appendChild(el('span', 'ledger-value', fmt(node.value, node.unit)));
  }
  if (hasDetail) {
    row.addEventListener('click', () => {
      if (openNodes.has(node.id)) openNodes.delete(node.id); else openNodes.add(node.id);
      const panel = row.closest('[data-panel]');
      if (panel && panel.__rerender) panel.__rerender();
    });
  }
  wrap.appendChild(row);

  if (openNodes.has(node.id)) {
    if (node.note) {
      const note = el('div', 'ledger-note', node.note);
      note.style.paddingLeft = (depth * 12 + 18) + 'px';
      wrap.appendChild(note);
    }
    for (const term of node.terms) {
      const t = el('div', 'ledger-term');
      t.style.paddingLeft = (depth * 12 + 18) + 'px';
      const sign = term.value > 0 ? 'pos' : term.value < 0 ? 'neg' : '';
      t.appendChild(el('span', 'term-label', term.label));
      t.appendChild(el('span', 'term-value ' + sign, fmt(term.value, term.unit)));
      if (term.note) {
        const n = el('div', 'term-note', term.note);
        t.appendChild(n);
      }
      wrap.appendChild(t);
    }
    for (const child of children) wrap.appendChild(nodeRow(ledger, child, depth + 1));
  }
  return wrap;
}

// ---------------------------------------------------------------
// Chronicle
// ---------------------------------------------------------------

/** Chronicle filter, kept outside the render so it survives a repaint. */
const chronicleState = { minImportance: 1 };

export function renderChronicle(container, world, opts = {}) {
  container.textContent = '';

  // A four-billion-year chronicle is mostly footnotes. The filter is how the
  // player gets from "everything that happened" to "what this world was".
  const filters = el('div', 'chips');
  for (const [label, level] of [['everything', 1], ['notable', 2], ['turning points', 3]]) {
    const b = el('button', 'chip tiny' + (chronicleState.minImportance === level ? ' on' : ''), label);
    b.addEventListener('click', () => {
      chronicleState.minImportance = level;
      const panel = container.closest('[data-panel]') || container;
      if (panel.__rerender) panel.__rerender();
    });
    filters.appendChild(b);
  }
  container.appendChild(filters);

  const minImportance = opts.minImportance || chronicleState.minImportance;
  const entries = world.chronicle.recent(140, minImportance, opts.category || null);
  if (!entries.length) {
    container.appendChild(el('p', 'muted',
      minImportance > 1 ? 'Nothing at this level has happened yet.'
        : 'Nothing worth recording has happened yet.'));
    return;
  }
  for (const e of entries) {
    const row = el('div', 'chron-entry imp-' + e.importance + ' cat-' + e.category);
    const when = el('div', 'chron-when');
    when.appendChild(el('span', 'chron-abs', formatYear(e.year)));
    when.appendChild(el('span', 'chron-rel', formatAgo(e.year, world.year)));
    row.appendChild(when);
    row.appendChild(el('div', 'chron-text', e.text));
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------
// Species
// ---------------------------------------------------------------

export function renderSpecies(container, world) {
  container.textContent = '';
  const bio = world.biosphere;
  if (!bio.lifeStarted) {
    container.appendChild(el('p', 'muted',
      'Nothing is alive. Life needs liquid water and a surface that is neither '
      + 'frozen nor boiling — or you can seed it yourself.'));
    return;
  }
  const living = bio.species.filter((s) => s.alive && s.population > 1e-5)
    .sort((a, b) => b.population - a.population);
  const head = el('p', 'muted', living.length + ' living lineages, '
    + bio.species.filter((s) => !s.alive).length + ' extinct.');
  container.appendChild(head);

  for (const sp of living.slice(0, 50)) {
    const card = el('div', 'species-card');
    const top = el('div', 'species-top');
    top.appendChild(el('span', 'species-name', sp.name));
    if (sp.civilised) top.appendChild(el('span', 'badge', 'civilisation'));
    top.appendChild(el('span', 'species-pop', (sp.population * 100).toFixed(1) + '%'));
    card.appendChild(top);
    card.appendChild(el('div', 'species-desc', sp.describe()));

    const traits = el('div', 'trait-grid');
    const t = sp.traits;
    const bar = (label, value, colour) => {
      const b = el('div', 'trait');
      b.appendChild(el('span', 'trait-label', label));
      const track = el('span', 'trait-track');
      const fill = el('span', 'trait-fill');
      fill.style.width = Math.round(Math.max(0, Math.min(1, value)) * 100) + '%';
      if (colour) fill.style.background = colour;
      track.appendChild(fill);
      b.appendChild(track);
      traits.appendChild(b);
    };
    bar('intelligence', t.intelligence, '#ffd479');
    bar('sociality', t.sociality, '#9ad9a0');
    bar('manipulation', t.manipulation, '#7fc4ff');
    bar('size', t.size);
    bar('cold tolerance', 1 - Math.max(0, Math.min(1, (t.thermalOpt + 20) / 70)));
    bar('mutability', t.mutability / 2.2);
    card.appendChild(traits);

    const facts = el('div', 'species-facts');
    facts.textContent = 'optimum ' + t.thermalOpt.toFixed(0) + ' C ± ' + t.thermalTol.toFixed(0)
      + '  ·  ' + HABITAT_NAMES[t.habitat] + '  ·  ' + METABOLISM_NAMES[t.metabolism]
      + (t.oxygenNeed > 0 ? '  ·  needs ' + t.oxygenNeed.toFixed(1) + '% O2' : '  ·  anaerobic')
      + '  ·  arose ' + formatYear(sp.birthYear);
    card.appendChild(facts);
    container.appendChild(card);
  }
}

// ---------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------

export function renderInterventions(container, world, ctx) {
  container.textContent = '';
  const groups = new Map();
  for (const iv of INTERVENTIONS) {
    if (!groups.has(iv.group)) groups.set(iv.group, []);
    groups.get(iv.group).push(iv);
  }
  const budget = el('div', 'budget');
  budget.appendChild(el('span', 'budget-label', 'Energy'));
  const track = el('span', 'budget-track');
  const fill = el('span', 'budget-fill');
  fill.style.width = Math.round((world.energy / world.config.energyBudget) * 100) + '%';
  track.appendChild(fill);
  budget.appendChild(track);
  budget.appendChild(el('span', 'budget-value',
    world.energy.toFixed(1) + ' / ' + world.config.energyBudget));
  container.appendChild(budget);
  container.appendChild(el('p', 'muted',
    'Energy returns slowly as the world ages, so waiting is itself a move. '
    + (ctx.pickedCell === null
      ? 'Some tools need a point: click the globe to choose one.'
      : 'Target: cell ' + ctx.pickedCell + '.')));

  for (const [group, list] of groups) {
    container.appendChild(el('h4', 'group-title', group));
    for (const iv of list) {
      const available = !iv.available || iv.available(world);
      const affordable = world.energy >= iv.cost;
      const needsTarget = iv.needsTarget && ctx.pickedCell === null;
      const card = el('button', 'iv-card weight-' + iv.weight
        + (available && affordable && !needsTarget ? '' : ' disabled'));
      card.disabled = !available || !affordable || needsTarget || !!world.ended;
      const top = el('div', 'iv-top');
      top.appendChild(el('span', 'iv-label', iv.label));
      top.appendChild(el('span', 'iv-cost', iv.cost + ' E'));
      card.appendChild(top);
      card.appendChild(el('div', 'iv-desc', iv.describe));
      if (!available) card.appendChild(el('div', 'iv-warn', 'Not possible on this world yet.'));
      else if (needsTarget) card.appendChild(el('div', 'iv-warn', 'Needs a target on the globe.'));
      else if (!affordable) card.appendChild(el('div', 'iv-warn', 'Not enough energy.'));
      card.addEventListener('click', () => ctx.onApply(iv.id));
      container.appendChild(card);
    }
  }
}

// ---------------------------------------------------------------
// Branches
// ---------------------------------------------------------------

export function renderBranches(container, timeline, ctx) {
  container.textContent = '';
  container.appendChild(el('p', 'muted',
    'Go back, change one thing, and run both. Two branches share a seed and a '
    + 'past, so any difference between them is yours.'));

  for (const b of timeline.branches) {
    const card = el('div', 'branch-card' + (b.id === timeline.activeId ? ' active' : ''));
    const top = el('div', 'branch-top');
    const swatch = el('span', 'branch-swatch');
    swatch.style.background = b.colour;
    top.appendChild(swatch);
    top.appendChild(el('span', 'branch-label', b.label));
    top.appendChild(el('span', 'branch-year', formatYear(b.world.year)));
    card.appendChild(top);

    const stats = el('div', 'branch-stats');
    const s = b.world.summary();
    stats.textContent = s.temp.toFixed(1) + ' C  ·  ' + s.co2.toFixed(0) + ' ppm CO2  ·  '
      + s.o2.toFixed(1) + '% O2  ·  ' + s.diversity + ' species'
      + (s.tech > 0 ? '  ·  ' + eraName(s.tech) : '');
    card.appendChild(stats);

    const row = el('div', 'branch-actions');
    const activate = el('button', 'small', b.id === timeline.activeId ? 'active' : 'make active');
    activate.disabled = b.id === timeline.activeId;
    activate.addEventListener('click', () => ctx.onActivate(b.id));
    row.appendChild(activate);

    const compare = el('button', 'small',
      timeline.compareId === b.id ? 'stop comparing' : 'compare');
    compare.addEventListener('click', () => ctx.onCompare(b.id));
    row.appendChild(compare);

    if (timeline.branches.length > 1) {
      const drop = el('button', 'small danger', 'discard');
      drop.addEventListener('click', () => ctx.onDiscard(b.id));
      row.appendChild(drop);
    }
    card.appendChild(row);
    container.appendChild(card);
  }
}

// ---------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------

export function renderChallenge(container, world, challenge) {
  container.textContent = '';
  container.appendChild(el('h4', 'group-title', challenge.name));
  container.appendChild(el('p', 'muted', challenge.blurb));
  if (!challenge.objectives.length) {
    container.appendChild(el('p', 'muted',
      'No objective, by design. The run ends when a civilisation leaves the planet '
      + 'or the star burns it away — and not before.'));
    return;
  }
  const result = evaluate(challenge, world);
  for (const row of result.rows) {
    const card = el('div', 'objective' + (row.progress >= 0.999 ? ' done' : ''));
    const top = el('div', 'objective-top');
    top.appendChild(el('span', 'objective-label', row.label));
    top.appendChild(el('span', 'objective-detail', row.detail));
    card.appendChild(top);
    const track = el('div', 'objective-track');
    const fill = el('div', 'objective-fill');
    fill.style.width = Math.round(row.progress * 100) + '%';
    track.appendChild(fill);
    card.appendChild(track);
    container.appendChild(card);
  }
  if (result.complete) {
    container.appendChild(el('div', 'objective-complete', 'Every objective met.'));
  }
}

// ---------------------------------------------------------------
// Cell inspector
// ---------------------------------------------------------------

export function renderCell(container, info) {
  container.textContent = '';
  if (!info) {
    container.appendChild(el('span', 'muted', 'Click the globe to inspect a place.'));
    return;
  }
  const rows = [
    ['position', info.position],
    ['elevation', (info.relative >= 0 ? '+' : '') + info.relative.toFixed(0) + ' m relative to sea'],
    ['surface', info.ocean ? (info.coastal ? 'shallow sea' : 'open ocean') : 'land'],
    ['crust', info.crust.toFixed(1) + ' km, ' + info.crustAge.toFixed(0) + ' Myr old'],
    ['plate', '#' + info.plate + ', strain ' + info.strain.toFixed(1) + ' mm/yr'],
    ['temperature', info.temperature.toFixed(1) + ' C'],
    ['rainfall', info.precipitation.toFixed(2) + ' index'],
    ['ice', (info.ice * 100).toFixed(0) + '%'],
    ['biome', info.biome],
    ['dominant life', info.dominant ? info.dominant + ' (' + info.dominantDesc + ')' : 'none'],
  ];
  for (const [k, v] of rows) {
    const row = el('div', 'cell-row');
    row.appendChild(el('span', 'cell-key', k));
    row.appendChild(el('span', 'cell-value', v));
    container.appendChild(row);
  }
}
