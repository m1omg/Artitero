// Atmosphere, ocean and climate.
//
// Nothing here is a lookup table. Temperature comes out of an energy
// balance on every cell; CO2 comes out of a carbon cycle with named flows;
// ice is a state variable that changes the albedo that changed the ice.
// The feedback loops are the point — they are the player's main enemy and
// their main ally — so every flow is posted to the ledger and can be
// unfolded in the UI.

import { IMPORTANCE } from '../core/chronicle.js';

const SIGMA = 5.670374e-8;
const SOLAR_CONSTANT = 1361;        // W/m2 at the present-day luminosity
const OLR_A = 205;                  // W/m2, outgoing longwave intercept for a
                                    // wet atmosphere at the reference CO2
const DRY_PENALTY = 28;             // W/m2 more escapes from a waterless sky
const PRIMORDIAL_FLUX = 70;         // W/m2 of accretionary heat at t=0
const PRIMORDIAL_DECAY = 3.0e8;     // years
const OLR_B = 2.05;                 // W/m2/K, outgoing longwave slope
const LAPSE_RATE = 6.0 / 1000;      // K per metre of elevation
const CO2_REF = 280;                // ppm, the reference for radiative forcing
const GT_C_PER_PPM = 2.13;
const ATMOSPHERE_GT = 5.15e6;       // total atmospheric mass
const O2_GT_AT_21PCT = 1.18e6;

/** Solar luminosity relative to the present Sun, as a function of stellar
 *  age. Young stars are faint; old ones swell and finally sterilise the
 *  system — which is the other way this game ends. */
export function luminosity(ageGyr) {
  const main = 1 / (1 + 0.4 * (1 - ageGyr / 4.57));
  if (ageGyr <= 9.5) return main;
  // Leaving the main sequence: the rise becomes violent.
  const over = ageGyr - 9.5;
  return main * (1 + over * over * 0.9);
}

export class Climate {
  constructor(mesh, rng, params = {}) {
    this.mesh = mesh;
    this.params = Object.assign({
      climateSensitivity: 0.82,   // K per W/m2 of forcing
      heatTransport: 0.58,        // meridional mixing efficiency
      relaxationSweeps: 7,
      iceFormTemp: -8,
      iceMeltTemp: 0,
    }, params);

    const n = mesh.n;
    this.temperature = new Float64Array(n);
    this.precipitation = new Float64Array(n);
    this.albedo = new Float64Array(n);
    this.ice = new Float64Array(n);
    this.oceanDistance = new Float64Array(n);
    this._scratch = new Float64Array(n);

    // Carbon reservoirs, in gigatonnes of carbon.
    // Atmosphere and ocean exchange carbon far faster than anything else in
    // this model, so they are one pool, partitioned each step by how much
    // ocean exists. `buried` is crustal carbonate and organic carbon;
    // `mantle` is the deep reservoir that subduction feeds and volcanoes
    // draw on.
    this.carbon = {
      surface: 20000,       // a thick, hot, CO2-dominated start (~9000 ppm)
      atmosphere: 20000,    // derived: the part of `surface` in the air
      ocean: 0,             // derived: the part dissolved in the sea
      // Crustal carbon is two different things and they behave differently:
      // carbonate is inert until it subducts, organic carbon burns when
      // erosion exposes it to oxygen (and is what a civilisation digs up).
      carbonate: 0,
      organic: 0,
      mantle: 2.0e8,
    };
    // What share of the surface pool is in the air rather than the sea.
    // Recomputed every step from the ocean volume; kept here so that an
    // intervention can repartition the pool without waiting for a step.
    this.fAtm = 1;
    this.o2Gt = 0;
    this.ch4Gt = 9000;      // a reducing, poisonous early atmosphere
    this.toxicityGt = 9000; // sulphur compounds from the young mantle

    this.meanTemp = 0;
    this.co2ppm = this.carbon.atmosphere / GT_C_PER_PPM;
    this.o2Percent = 0;
    this.ch4ppb = 0;
    this.iceFraction = 0;
    this.snowballCounter = 0;
    this.hothouseCounter = 0;
    this.lastFlows = {};
    this.circulation = { zonalOpen: 0, polarIsolation: 0, transport: 0 };
  }

  // ---------------------------------------------------------------
  // Radiative bookkeeping
  // ---------------------------------------------------------------

  /** Radiative forcing relative to the reference atmosphere, W/m2. */
  forcing() {
    const co2 = Math.max(0.1, this.co2ppm);
    const ch4 = Math.max(1, this.ch4ppb);
    const fCO2 = 5.35 * Math.log(co2 / CO2_REF);
    const fCH4 = 0.036 * (Math.sqrt(ch4) - Math.sqrt(700));
    return { fCO2, fCH4, total: fCO2 + fCH4 };
  }

  /** Mean annual insolation at a latitude, as a fraction of S/4. */
  static insolationFactor(latRad) {
    const x = Math.sin(latRad);
    const p2 = 0.5 * (3 * x * x - 1);
    return 1 - 0.482 * p2;
  }

  step(dtYears, world) {
    const geo = world.geosphere;
    const ledger = world.ledger;

    this._carbonCycle(dtYears, world);
    this._hydrosphere(dtYears, world);
    this._circulation(world);
    this._energyBalance(world);
    this._iceAndPrecipitation(dtYears, world);
    this._diagnose(world);

    const f = this.forcing();
    ledger.post('climate.temp', 'Mean surface temperature', this.meanTemp, 'C', { of: 'climate' });
    ledger.term('climate.temp', 'Solar input', this.diag.absorbed, 'W/m2',
      'Luminosity ' + this.diag.luminosity.toFixed(3) + ' x present Sun, minus what the albedo throws away.');
    ledger.term('climate.temp', 'Planetary albedo', this.diag.albedo, 'fraction',
      'Ice covers ' + (this.iceFraction * 100).toFixed(1) + '% of the surface.');
    ledger.term('climate.temp', 'CO2 forcing', f.fCO2, 'W/m2', this.co2ppm.toFixed(0) + ' ppm against a 280 ppm reference.');
    ledger.term('climate.temp', 'Methane forcing', f.fCH4, 'W/m2', this.ch4ppb.toFixed(0) + ' ppb.');
    ledger.term('climate.temp', 'Heat transport', this.circulation.transport, 'index',
      'Ocean and atmosphere move heat poleward; continents in the way reduce it.');

    ledger.post('climate.co2', 'Atmospheric CO2', this.co2ppm, 'ppm', { of: 'climate' });
    ledger.post('climate.o2', 'Atmospheric O2', this.o2Percent, '%', { of: 'climate' });
    ledger.post('climate.ice', 'Ice cover', this.iceFraction * 100, '%', { of: 'climate' });
    ledger.post('climate.sealevel', 'Ocean volume', world.hydrosphere.waterVolumeKm3 / 1e6, 'M km3', { of: 'climate' });
    ledger.term('climate.sealevel', 'Still in the mantle', world.hydrosphere.mantleWaterKm3 / 1e6, 'M km3',
      'Volcanoes degas water as well as carbon; the ocean is what has come out so far.');
  }

  // ---------------------------------------------------------------
  // Carbon
  // ---------------------------------------------------------------

  _carbonCycle(dtYears, world) {
    const geo = world.geosphere;
    const bio = world.biosphere;
    const ledger = world.ledger;
    const c = this.carbon;

    // Long steps are integrated in substeps, and each substep's change is
    // capped at a fraction of the reservoir. Without that cap a 250,000
    // year step would swing the carbon cycle wildly instead of letting the
    // silicate thermostat find its balance.
    const sub = Math.max(1, Math.min(12, Math.ceil(dtYears / 20000)));
    const h = dtYears / sub;

    let accVolcanism = 0, accWeathering = 0, accBurial = 0, accOxidation = 0,
      accRespiration = 0, accPhotosynthesis = 0, accSubduction = 0, accAnthropogenic = 0,
      accSeafloor = 0;

    // How much of the surface pool sits in the air rather than the sea.
    // A full ocean holds fifty times as much carbon as the atmosphere above it.
    const oceanCapacity = Math.min(1, world.hydrosphere.waterVolumeKm3 / 1.35e9);
    const fAtm = 1 / (1 + 50 * oceanCapacity);
    this.fAtm = fAtm;

    for (let s = 0; s < sub; s++) {
      c.atmosphere = c.surface * fAtm;
      c.ocean = c.surface - c.atmosphere;
      const ppm = Math.max(0.01, c.atmosphere / GT_C_PER_PPM);
      const T = this.meanTemp;
      const landFrac = geo.stats.landFraction;
      const oceanFrac = 1 - landFrac;
      const hasOcean = world.hydrosphere.waterVolumeKm3 > 1e6;

      // --- sources ---
      // Mantle degassing along arcs and ridges. This is the only thing
      // putting carbon into the system on a dead world.
      const volcanism = 0.085 * geo.stats.volcanicActivity * world.mods.volcanism;

      // Exposed organic carbon oxidising back to CO2 as mountains erode.
      // Only organic carbon does this, and only as fast as there is oxygen
      // to burn it with — which is what lets oxygen accumulate at all.
      // A saturating dependence on oxygen, not a threshold: more oxygen in
      // the air always means faster burning of exposed organic carbon, which
      // is the negative feedback that keeps the atmosphere from running away
      // in either direction.
      const oxidation = 0.018 * (c.organic / 1.0e7) * (1 + geo.stats.mountainFraction * 3)
        * (this.o2Percent / (this.o2Percent + 1.5));

      // --- sinks ---
      // Silicate weathering: the thermostat. It needs land, rain and heat,
      // and it runs faster when fresh rock is being pushed up.
      const tempFactor = Math.exp((T - 15) / 13.7);
      const co2Factor = Math.pow(ppm / CO2_REF, 0.3);
      const reliefFactor = 1 + geo.stats.mountainFraction * 2.5;
      const bioFactor = bio ? 1 + 1.5 * bio.landVegetation : 1;
      const waterFactor = hasOcean ? 1 : 0.05;
      const exposure = (landFrac / 0.29) * waterFactor * (1 - 0.7 * this.iceFraction);
      const kinetic = 0.018 * exposure * tempFactor * co2Factor * reliefFactor
        * bioFactor * world.mods.weathering;
      // Weathering cannot outrun the supply of fresh rock, however hot and
      // wet it gets. Without this ceiling a thick early atmosphere would be
      // stripped in a geological instant instead of over tens of millions
      // of years.
      const supplyLimit = 0.20 * exposure * (1 + geo.stats.mountainFraction * 3);
      const landWeathering = supplyLimit > 1e-9 ? supplyLimit * Math.tanh(kinetic / supplyLimit) : 0;

      // Basalt on the ocean floor reacts with seawater whatever the surface
      // is doing. It is a weaker sink than the continents, but it never
      // switches off — not under ice, not on a world with no land at all —
      // and it is what stops CO2 running to tens of thousands of ppm every
      // time the continents freeze over.
      const seafloor = hasOcean
        ? 0.0055 * ((1 - landFrac) / 0.71) * co2Factor * (0.5 + 0.5 * tempFactor)
        : 0;
      const weathering = landWeathering + seafloor;

      // Life: fixing carbon, breathing most of it back, burying a little.
      const photosynthesis = bio ? bio.productivity * 0.9 : 0;
      const respiration = photosynthesis * (bio ? 1 - bio.burialFraction : 1);
      const burial = photosynthesis - respiration;

      // Carbonate and organic carbon riding a slab back into the mantle.
      // Organic carbon leaves the crust much faster than carbonate does: it
      // sits in young, thin, easily recycled sediment. That difference is
      // what lets oxygen exist at all — every organic carbon atom that goes
      // down a trench instead of burning at the surface leaves its oxygen
      // behind in the air.
      const subCarbonate = 0.05 * (c.carbonate / 4e7) * Math.max(0.1, geo.stats.subductionRate);
      const subOrganic = 0.03 * (c.organic / 4e6) * Math.max(0.1, geo.stats.subductionRate);
      const subduction = subCarbonate + subOrganic;

      const anthropogenic = world.civilisation ? world.civilisation.carbonEmission : 0;

      const dSurface = (volcanism + oxidation + respiration + anthropogenic
        - weathering - photosynthesis) * h;
      const dCarbonate = (weathering - subCarbonate) * h;
      const dOrganic = (burial - oxidation - subOrganic) * h;
      const dMantle = (subduction - volcanism) * h;

      const cap = (reservoir, delta) => {
        const limit = Math.max(1, Math.abs(reservoir) * 0.12);
        return Math.max(-limit, Math.min(limit, delta));
      };
      c.surface = Math.max(0.05, c.surface + cap(c.surface, dSurface));
      c.carbonate = Math.max(0, c.carbonate + cap(Math.max(c.carbonate, 100), dCarbonate));
      c.organic = Math.max(0, c.organic + cap(Math.max(c.organic, 100), dOrganic));
      c.mantle = Math.max(0, c.mantle + dMantle);

      // Oxygen tracks organic burial: every buried carbon atom leaves an
      // O2 molecule behind, and oxidative weathering takes it back.
      const o2Gain = burial * 2.67 * h;
      const o2Loss = (oxidation * 2.67 + this._o2SinkRate(world)) * h;
      // Same treatment as the carbon reservoirs: a single long step must not
      // be allowed to swing the atmosphere from anoxic to oxygen-rich and
      // back, which would kill every aerobe and anaerobe in turn.
      const o2Limit = Math.max(200, this.o2Gt * 0.1);
      const dO2 = Math.max(-o2Limit, Math.min(o2Limit, o2Gain - o2Loss));
      this.o2Gt = Math.max(0, this.o2Gt + dO2);
      this.o2Percent = (this.o2Gt / O2_GT_AT_21PCT) * 21;

      // Methane: made by anaerobes, destroyed by oxygen and sunlight.
      const ch4Source = bio ? bio.methanogenesis * h : 0;
      const ch4Life = this.o2Percent > 1 ? 1.2e4 : 2.0e6;   // years
      this.ch4Gt = Math.max(0, (this.ch4Gt + ch4Source) * Math.exp(-h / ch4Life));
      this.toxicityGt *= Math.exp(-h / 4.0e6);
      if (this.o2Percent > 0.5) this.toxicityGt *= Math.exp(-h / 2.0e5);

      accVolcanism += volcanism / sub; accWeathering += landWeathering / sub;
      accSeafloor += seafloor / sub;
      accBurial += burial / sub; accOxidation += oxidation / sub;
      accRespiration += respiration / sub; accPhotosynthesis += photosynthesis / sub;
      accSubduction += subduction / sub; accAnthropogenic += anthropogenic / sub;

      c.atmosphere = c.surface * fAtm;
      c.ocean = c.surface - c.atmosphere;
      this.co2ppm = c.atmosphere / GT_C_PER_PPM;
      this.o2Percent = (this.o2Gt / O2_GT_AT_21PCT) * 21;
      this.ch4ppb = (this.ch4Gt / ATMOSPHERE_GT) * 1e9 * 1.8;
    }

    this.lastFlows = {
      volcanism: accVolcanism, weathering: accWeathering, burial: accBurial,
      oxidation: accOxidation, respiration: accRespiration,
      photosynthesis: accPhotosynthesis, subduction: accSubduction,
      anthropogenic: accAnthropogenic,
      seafloor: accSeafloor,
      net: accVolcanism + accOxidation + accRespiration + accAnthropogenic
        - accWeathering - accSeafloor - accPhotosynthesis,
    };

    // The carbon cycle is the single most asked-about number in a planet
    // simulator, so it gets the fullest explanation in the ledger.
    ledger.post('carbon.net', 'Net carbon into the air', this.lastFlows.net, 'GtC/yr', {
      of: 'carbon',
      note: 'Sources minus sinks. Positive warms the planet; negative cools it.',
    });
    ledger.term('carbon.net', 'Volcanism', accVolcanism, 'GtC/yr',
      'Arc and ridge degassing, scaled by mantle heat and subduction rate.');
    ledger.term('carbon.net', 'Oxidation of buried carbon', accOxidation, 'GtC/yr',
      'Old organic carbon exposed by erosion and burnt by atmospheric oxygen.');
    ledger.term('carbon.net', 'Respiration and decay', accRespiration, 'GtC/yr');
    if (accAnthropogenic > 0) ledger.term('carbon.net', 'Civilisation', accAnthropogenic, 'GtC/yr',
      'Your creatures, burning the carbon the biosphere spent an aeon burying.');
    ledger.term('carbon.net', 'Silicate weathering', -accWeathering, 'GtC/yr',
      'The thermostat: faster when hot, wet, mountainous and vegetated — but never '
      + 'faster than fresh rock is exposed.');
    ledger.term('carbon.net', 'Seafloor weathering', -accSeafloor, 'GtC/yr',
      'Ocean-floor basalt reacting with seawater. Weaker than the continents, but '
      + 'it never switches off.');
    ledger.term('carbon.net', 'Photosynthesis', -accPhotosynthesis, 'GtC/yr');
    ledger.post('carbon.buried', 'Carbon locked in crust', c.carbonate + c.organic, 'GtC', { of: 'carbon' });
    ledger.term('carbon.buried', 'Carbonate', c.carbonate, 'GtC',
      'The product of silicate weathering. Inert until a plate carries it down.');
    ledger.term('carbon.buried', 'Organic', c.organic, 'GtC',
      'Dead life that never rotted. It burns when erosion exposes it — or when '
      + 'somebody digs it up.');
    ledger.post('carbon.mantle', 'Carbon in mantle', c.mantle / 1e6, 'M GtC', { of: 'carbon' });
  }

  _o2SinkRate(world) {
    // Reduced volcanic gases and fresh crust mop up free oxygen. Early on
    // this sink swallows everything life can make, which is why oxygen
    // arrives late and suddenly: the sinks have to fill before the
    // atmosphere can start to.
    const geo = world.geosphere;
    const reducedGases = 0.030 * geo.stats.volcanicActivity * Math.min(1, this.o2Gt / 2e3);
    // Past about a fifth of the atmosphere, oxygen starts destroying the
    // biosphere that makes it: fires carry further than anything can regrow,
    // and everything else oxidises too.
    const runaway = 0.55 * Math.pow(Math.max(0, this.o2Percent - 20) / 3, 2);
    return reducedGases + runaway;
  }

  // ---------------------------------------------------------------
  // Water
  // ---------------------------------------------------------------

  _hydrosphere(dtYears, world) {
    const h = world.hydrosphere;
    const geo = world.geosphere;
    // Volcanoes outgas water as well as carbon: an ocean condenses out of
    // the atmosphere once the surface drops below the boiling point.
    const wanted = 2.6 * geo.stats.volcanicActivity * dtYears * world.mods.volcanism;
    const outgas = Math.min(h.mantleWaterKm3, Math.max(0, wanted));
    h.mantleWaterKm3 -= outgas;
    h.waterVolumeKm3 += outgas;
    // A runaway greenhouse boils the ocean and the hydrogen is lost.
    if (this.meanTemp > 75) {
      const loss = Math.min(h.waterVolumeKm3, h.waterVolumeKm3 * (this.meanTemp - 75) * 1e-9 * dtYears);
      h.waterVolumeKm3 -= loss;
      if (loss > 0 && !h.warnedLoss && h.waterVolumeKm3 < 4e8) {
        h.warnedLoss = true;
        world.chronicle.record(world.year, 'climate',
          'The oceans are boiling away; hydrogen is escaping to space.', IMPORTANCE.MAJOR);
      }
    }
    h.waterVolumeKm3 = Math.max(0, h.waterVolumeKm3);
  }

  // ---------------------------------------------------------------
  // Circulation
  // ---------------------------------------------------------------

  /** Where the continents sit decides how the ocean can move heat. A belt
   *  of open water all the way around a latitude carries heat zonally and
   *  starves the pole; a supercontinent blocks the flow entirely. */
  _circulation(world) {
    const mesh = this.mesh;
    const geo = world.geosphere;
    const bands = 12;
    let openBands = 0;
    let polarOpen = 0;
    const counts = new Array(bands).fill(0);
    const landCounts = new Array(bands).fill(0);
    for (let i = 0; i < mesh.n; i++) {
      const b = Math.min(bands - 1, Math.floor(((Math.sin(mesh.lat[i]) + 1) / 2) * bands));
      counts[b]++;
      if (geo.elevation[i] > geo.seaLevel) landCounts[b]++;
    }
    for (let b = 0; b < bands; b++) {
      if (counts[b] === 0) continue;
      const landFrac = landCounts[b] / counts[b];
      if (landFrac < 0.06) {
        openBands++;
        if (b <= 1 || b >= bands - 2) polarOpen++;
      }
    }
    this.circulation.zonalOpen = openBands / bands;
    this.circulation.polarIsolation = polarOpen / 4;
    const hasOcean = world.hydrosphere.waterVolumeKm3 > 1e7;
    // An open circumpolar current isolates the pole and cools it; blocked
    // ocean basins force heat poleward instead.
    this.circulation.transport = this.params.heatTransport
      * (hasOcean ? 1 : 0.35)
      * (1 - 0.35 * this.circulation.polarIsolation)
      * (1 + 0.25 * (1 - geo.supercontinentIndex))
      * world.mods.heatTransport;
  }

  // ---------------------------------------------------------------
  // Energy balance
  // ---------------------------------------------------------------

  _energyBalance(world) {
    const mesh = this.mesh;
    const geo = world.geosphere;
    const n = mesh.n;
    const lum = luminosity(world.starAgeGyr());
    const S = SOLAR_CONSTANT * lum * world.mods.insolation;
    const f = this.forcing();
    const bio = world.biosphere;

    // Effective outgoing-longwave intercept: greenhouse gases lower the
    // altitude the planet radiates from.
    // Water vapour is not carried as a gas: it is a fast feedback slaved to
    // temperature, and it is already inside the reference intercept. A world
    // with no ocean to evaporate from loses that greenhouse entirely.
    const wet = world.hydrosphere.waterVolumeKm3 > 1e7;
    const A = OLR_A + (wet ? 0 : DRY_PENALTY) - f.total;
    // The heat of formation, still leaking out of a young, half-molten body.
    const primordial = PRIMORDIAL_FLUX * Math.exp(-world.year / PRIMORDIAL_DECAY)
      * world.mods.mantleHeat;

    // Albedo per cell.
    let planetary = 0;
    for (let i = 0; i < n; i++) {
      const isOcean = geo.elevation[i] <= geo.seaLevel;
      let a;
      if (this.ice[i] > 0.05) a = 0.16 + 0.40 * this.ice[i];
      else if (isOcean) a = 0.08;
      else {
        const veg = bio ? bio.landCover[i] : 0;
        const dry = 1 - Math.min(1, this.precipitation[i] * 2);
        a = 0.22 + 0.14 * dry - 0.09 * veg;
      }
      a *= world.mods.albedo;
      this.albedo[i] = Math.max(0.02, Math.min(0.92, a));
      planetary += this.albedo[i];
    }
    planetary /= n;

    // Relax the temperature field to the steady state of
    //   absorbed = A' + B*T - transport, transport = D * (Tbar_neighbours - T)
    // Steps are centuries or longer, so equilibrium is the right answer.
    const D = this.circulation.transport * OLR_B * 3.0;
    const T = this.temperature;
    const next = this._scratch;
    const oceanHeat = world.hydrosphere.waterVolumeKm3 > 1e7;
    for (let sweep = 0; sweep < this.params.relaxationSweeps; sweep++) {
      for (let i = 0; i < n; i++) {
        const q = (S / 4) * Climate.insolationFactor(mesh.lat[i]) * (1 - this.albedo[i])
          + primordial;
        const nb = mesh.neighboursOf(i);
        let sum = 0;
        for (let s = 0; s < nb.length; s++) sum += T[nb[s]];
        const tbar = sum / nb.length;
        // Ocean cells share heat far more readily than continental interiors.
        const local = oceanHeat && geo.elevation[i] <= geo.seaLevel ? D * 1.9 : D;
        next[i] = (q - A + local * tbar) / (OLR_B + local);
      }
      T.set(next);
    }

    // Elevation is a cooling term applied on top of the balance: the free
    // atmosphere gets colder with height.
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const above = Math.max(0, geo.elevation[i] - geo.seaLevel);
      T[i] -= above * LAPSE_RATE;
      mean += T[i];
    }
    this.meanTemp = mean / n;

    this.diag = {
      luminosity: lum,
      albedo: planetary,
      absorbed: (S / 4) * (1 - planetary) + primordial,
      primordial,
      forcing: f.total,
      olrIntercept: A,
    };
  }

  // ---------------------------------------------------------------
  // Ice and rain
  // ---------------------------------------------------------------

  _iceAndPrecipitation(dtYears, world) {
    const mesh = this.mesh;
    const geo = world.geosphere;
    const n = mesh.n;
    const hasWater = world.hydrosphere.waterVolumeKm3 > 1e7;
    const rate = Math.min(1, dtYears / 5000);
    let iceCells = 0;

    for (let i = 0; i < n; i++) {
      if (!hasWater) { this.ice[i] = 0; continue; }
      const t = this.temperature[i];
      let target;
      if (t < this.params.iceFormTemp) target = Math.min(1, (this.params.iceFormTemp - t) / 10);
      else if (t > this.params.iceMeltTemp) target = 0;
      else target = this.ice[i] * 0.6;
      this.ice[i] += (target - this.ice[i]) * rate;
      if (this.ice[i] > 0.5) iceCells++;
    }
    this.iceFraction = iceCells / n;

    // Distance to open water, in cells: the crude but effective way to get
    // continental interiors dry and coasts wet.
    this._oceanDistance(world);
    for (let i = 0; i < n; i++) {
      if (!hasWater) { this.precipitation[i] = 0; continue; }
      const t = this.temperature[i];
      // Evaporation rises steeply with temperature (Clausius-Clapeyron).
      const evap = Math.max(0, Math.min(1.6, Math.exp((t - 12) / 18)));
      const continental = Math.exp(-this.oceanDistance[i] / 3.2);
      // The Hadley cell: wet equator, dry subtropics, wet mid-latitudes.
      const l = Math.abs(mesh.lat[i]) * 180 / Math.PI;
      const belt = 0.55 + 0.55 * Math.cos((l / 30) * Math.PI) * (l < 45 ? 1 : 0.4)
        + (l > 40 && l < 65 ? 0.3 : 0);
      // Orography: rising over a mountain wrings the air out.
      const relief = 1 + Math.max(0, geo.elevation[i] - geo.seaLevel) / 4000;
      const p = evap * (0.25 + 0.75 * continental) * Math.max(0.1, belt) * relief
        * (1 - 0.8 * this.ice[i]);
      this.precipitation[i] = Math.max(0, Math.min(3, p));
    }
  }

  _oceanDistance(world) {
    const mesh = this.mesh;
    const geo = world.geosphere;
    const n = mesh.n;
    const dist = this.oceanDistance;
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      if (geo.elevation[i] <= geo.seaLevel) { dist[i] = 0; queue[tail++] = i; }
      else dist[i] = 1e9;
    }
    if (tail === 0) { for (let i = 0; i < n; i++) dist[i] = 12; return; }
    while (head < tail) {
      const i = queue[head++];
      const nb = mesh.neighboursOf(i);
      for (let s = 0; s < nb.length; s++) {
        const j = nb[s];
        if (dist[j] > dist[i] + 1) { dist[j] = dist[i] + 1; queue[tail++] = j; }
      }
    }
  }

  // ---------------------------------------------------------------

  _diagnose(world) {
    // Runaway states worth telling the player about, once each.
    if (this.iceFraction > 0.92) {
      this.snowballCounter++;
      if (this.snowballCounter === 1) {
        world.chronicle.record(world.year, 'climate',
          'Ice reached the equator. The planet is a snowball: its own whiteness '
          + 'now keeps it frozen, and only volcanic CO2 can undo it.',
          IMPORTANCE.MAJOR, { co2: this.co2ppm, temp: this.meanTemp });
      }
    } else if (this.snowballCounter > 0 && this.iceFraction < 0.5) {
      world.chronicle.record(world.year, 'climate',
        'The snowball broke. Volcanic CO2 built up under the ice until the '
        + 'greenhouse overwhelmed the albedo.', IMPORTANCE.MAJOR);
      this.snowballCounter = 0;
    }
    if (this.meanTemp > 55) {
      this.hothouseCounter++;
      if (this.hothouseCounter === 1) {
        world.chronicle.record(world.year, 'climate',
          'A hothouse: the tropics are lethal and the water cycle is out of control.',
          IMPORTANCE.MAJOR, { temp: this.meanTemp, co2: this.co2ppm });
      }
    } else this.hothouseCounter = 0;
  }

  // --- interventions -------------------------------------------------

  nudgeAlbedo(delta, world) { world.mods.albedo = Math.max(0.5, Math.min(1.6, world.mods.albedo + delta)); }

  /** Add (or remove) carbon from the surface pool and repartition it
   *  immediately, so that CO2 reflects the change before the next step. */
  injectCarbon(gt) {
    const c = this.carbon;
    c.surface = Math.max(0.05, c.surface + gt);
    c.atmosphere = c.surface * this.fAtm;
    c.ocean = c.surface - c.atmosphere;
    this.co2ppm = c.atmosphere / GT_C_PER_PPM;
  }

  deliverWater(world, km3) { world.hydrosphere.waterVolumeKm3 += km3; }

  save() {
    return {
      temperature: Array.from(this.temperature),
      ice: Array.from(this.ice),
      precipitation: Array.from(this.precipitation),
      carbon: { ...this.carbon },
      o2Gt: this.o2Gt, ch4Gt: this.ch4Gt, toxicityGt: this.toxicityGt, fAtm: this.fAtm,
      meanTemp: this.meanTemp, co2ppm: this.co2ppm, o2Percent: this.o2Percent,
      ch4ppb: this.ch4ppb, iceFraction: this.iceFraction,
      snowballCounter: this.snowballCounter, hothouseCounter: this.hothouseCounter,
      lastFlows: { ...this.lastFlows },
      params: { ...this.params },
    };
  }

  load(s) {
    this.temperature.set(s.temperature);
    this.ice.set(s.ice);
    this.precipitation.set(s.precipitation);
    this.carbon = { ...s.carbon };
    this.o2Gt = s.o2Gt; this.ch4Gt = s.ch4Gt; this.toxicityGt = s.toxicityGt;
    this.fAtm = s.fAtm !== undefined ? s.fAtm : 1;
    this.meanTemp = s.meanTemp; this.co2ppm = s.co2ppm; this.o2Percent = s.o2Percent;
    this.ch4ppb = s.ch4ppb; this.iceFraction = s.iceFraction;
    this.snowballCounter = s.snowballCounter; this.hothouseCounter = s.hothouseCounter;
    this.lastFlows = { ...(s.lastFlows || {}) };
    this.params = { ...s.params };
  }
}

export const CLIMATE_CONSTANTS = { SIGMA, SOLAR_CONSTANT, OLR_A, OLR_B, GT_C_PER_PPM, ATMOSPHERE_GT, O2_GT_AT_21PCT };
