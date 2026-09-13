// The planet writes its own history.
//
// Every module that notices something significant records it here. At the
// end of a run the player is left holding a chronicle of a world, not a
// graph: "340 million years ago, mosses conquered the land and cut CO2 by
// 60%."

export const IMPORTANCE = {
  MINOR: 1,     // a nudge: a species appears, a mountain range starts rising
  NOTABLE: 2,   // a biome flips, a crisis begins
  MAJOR: 3,     // a mass extinction, an ice age, a civilisation
  EPOCHAL: 4,   // life begins, oxygen, spaceflight, death of the world
};

export class Chronicle {
  constructor() {
    this.entries = [];
    this.nextId = 1;
  }

  /**
   * @param {number} year simulated years since planetary formation
   * @param {string} category geosphere|climate|biosphere|civilisation|player
   * @param {string} text
   * @param {number} importance see IMPORTANCE
   * @param {object} [data] numbers worth keeping for the retrospective
   */
  record(year, category, text, importance = IMPORTANCE.MINOR, data = null) {
    const entry = { id: this.nextId++, year, category, text, importance, data };
    this.entries.push(entry);
    return entry;
  }

  /** Entries in reverse chronological order, optionally filtered. */
  recent(limit = 40, minImportance = 1, category = null) {
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (e.importance < minImportance) continue;
      if (category && e.category !== category) continue;
      out.push(e);
    }
    return out;
  }

  save() { return { entries: this.entries, nextId: this.nextId }; }

  static load(s) {
    const c = new Chronicle();
    // Entries are immutable once written, so sharing them between a branch
    // and its parent would be safe — but a copy keeps branch histories
    // independently editable and costs nothing at these sizes.
    c.entries = s.entries.map((e) => ({ ...e }));
    c.nextId = s.nextId;
    return c;
  }
}

/** Deep time reads badly in bare years. */
export function formatYear(year) {
  const ago = year;
  if (ago >= 1e9) return (ago / 1e9).toFixed(3) + ' Gyr';
  if (ago >= 1e6) return (ago / 1e6).toFixed(2) + ' Myr';
  if (ago >= 1e3) return (ago / 1e3).toFixed(1) + ' kyr';
  return Math.round(ago) + ' yr';
}

/** "340 million years ago" style, relative to the current moment. */
export function formatAgo(year, now) {
  const d = Math.max(0, now - year);
  if (d < 1) return 'just now';
  if (d >= 1e9) return (d / 1e9).toFixed(2) + ' billion years ago';
  if (d >= 1e6) return (d / 1e6).toFixed(0) + ' million years ago';
  if (d >= 1e3) return (d / 1e3).toFixed(0) + ' thousand years ago';
  return Math.round(d) + ' years ago';
}
