// The "why?" machinery.
//
// Every number the simulation shows the player has to be explainable, and
// the explanation has to be the same arithmetic the model actually ran —
// not a hand-written caption. Modules post their flows and terms here as
// they compute them; the UI unfolds the result as a tree.
//
// A ledger is rebuilt from scratch on every step, so it never becomes part
// of the simulation state and never affects determinism.

export class Ledger {
  constructor() { this.clear(); }

  clear() {
    /** @type {Map<string, {id:string,label:string,unit:string,value:number,terms:Array}>} */
    this.nodes = new Map();
    this.order = [];
  }

  /**
   * Declare an explainable quantity.
   * @param {string} id stable identifier, e.g. "carbon.volcanism"
   * @param {string} label human label
   * @param {number} value
   * @param {string} unit
   * @param {object} [opts] { of: parent id, note: string }
   */
  post(id, label, value, unit, opts = {}) {
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, label, unit, value: 0, note: '', terms: [], parent: opts.of || null };
      this.nodes.set(id, node);
      this.order.push(id);
    }
    node.value = value;
    node.label = label;
    node.unit = unit;
    if (opts.note) node.note = opts.note;
    if (opts.of) node.parent = opts.of;
    return node;
  }

  /** A contributing term of an already-posted quantity. Terms are the leaves
   *  the player unfolds: "volcanism +0.31, weathering -0.24 ...". */
  term(id, label, value, unit, note = '') {
    const node = this.nodes.get(id);
    if (!node) return;
    node.terms.push({ label, value, unit, note });
  }

  get(id) { return this.nodes.get(id) || null; }

  /** Children of a node, for the unfoldable tree. */
  childrenOf(id) {
    const out = [];
    for (const key of this.order) {
      const n = this.nodes.get(key);
      if (n.parent === id) out.push(n);
    }
    return out;
  }

  roots() { return this.childrenOf(null); }

  /** Flat snapshot, for charts and for the cycle diagram. */
  values() {
    const out = {};
    for (const [id, n] of this.nodes) out[id] = n.value;
    return out;
  }
}
