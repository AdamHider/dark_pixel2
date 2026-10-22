const vm = require('vm'), fs = require('fs'), crypto = require('crypto');

const EXPORTS = '\n;({MapGenerator, Terrain, Biome, Shore, Resource, ResourceInfo, ROAD_DIRECTIONS, growthStage, GROWTH_STAGES, clamp});';
const load = path => {
    const ctx = vm.createContext({});
    for (const file of path.split(',')) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    return vm.runInContext(EXPORTS, ctx);
};

const SKIP = new Set(['noise', 'random', 'options', 'factionListeners', 'turnListeners', 'economyListeners',
    'searchCost', 'searchStamp', 'searchFrom', 'searchRun', 'regionCost', 'nextRegionId', 'cache4', 'cache8', 'work', 'listeners',
    '_n4', '_n8', 'pathScratch', 'turnChannel', 'economyChannel', 'factionChannel']);
const sha = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);

function fingerprint(map) {
    const out = {};
    for (const [key, value] of Object.entries(map)) {
        if (SKIP.has(key) || typeof value === 'function') continue;
        if (ArrayBuffer.isView(value)) out[key] = sha(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        else out[key] = sha(JSON.stringify(value));
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function scenario(lib, options, seed) {
    const map = new lib.MapGenerator(options).generate(seed);
    const fp = fingerprint(map);
    const extra = {};
    extra.tiles = [];
    for (let y = 0; y < map.size; y += 7) for (let x = 0; x < map.size; x += 5) extra.tiles.push(map.getTileInfo(x, y));
    extra.outside = [map.getTileInfo(-1, 0), map.getTileInfo(map.size, 0)];
    extra.regions = [];
    for (let id = -1; id <= map.regionCount; id++) extra.regions.push(map.getRegionInfo(id));
    extra.graph = [...map.regionGraph()].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]);
    extra.misc = [map.landShare, map.regionCount];
    extra.neigh = [map.neighbors(0), map.neighbors(map.size + 1), map.neighbors8(0), map.neighbors8(map.size * map.size - 1)];

    // состояние: ход, экономика, фракции
    const log = [];
    map.onTurnState(s => log.push(['turn', s]));
    const off = map.onEconomyState(s => log.push(['eco', s]));
    map.onFactionState(m => log.push(['fac', m.factions, m.factionVersion]));
    map.applyTurnState({ turn: 3, year: 1, season: 'spring', seasonIndex: 0, turnInSeason: 3 });
    const n = map.size * map.size;
    const growth = new Float32Array(n).map((_, i) => (i % 11) / 10);
    const pop = new Uint16Array(n); for (const s of map.settlements) pop[s.tile] = 40 + (s.tile % 700);
    const changes = [];
    for (let i = 0; i < n && changes.length < 5; i++) if (map.resource[i] === lib.Resource.WOOD) changes.push({ tile: i, resource: lib.Resource.NONE });
    map.applyEconomyState({ growth, population: pop, resourceChanges: changes });
    map.applyEconomyState({ growth });
    try { map.applyEconomyState({ resourceChanges: [{ tile: 0, resource: lib.Resource.GOLD }] }); } catch (e) { log.push(['err', e.message]); }
    try { map.applyEconomyState({ growth: new Float32Array(3) }); } catch (e) { log.push(['err', e.message]); }
    off();
    map.applyEconomyState({ growth });
    const tf = new Int16Array(n).fill(-1); for (let i = 0; i < n; i += 3) tf[i] = i % 4;
    map.applyFactionState({ factions: [{ id: 0, name: 'a', color: '#fff', capitalRegion: 1, capitalTile: 5 }], tileFaction: tf });
    try { map.applyFactionState({ factions: [], tileFaction: new Int16Array(2) }); } catch (e) { log.push(['err', e.message]); }
    extra.log = log;
    extra.after = [fingerprint(map), map.getRegionInfo(0), map.getTileInfo(3, 3)];
    return { fp, extra: sha(JSON.stringify(extra)), extraRaw: extra };
}

const [, , origPath, newPath] = process.argv;
const A = load(origPath), B = load(newPath);
const cases = [
    [{}, 1], [{}, 2], [{}, 42], [{}, 777], [{ size: 300 }, 5], [{ size: 80 }, 9], [{ size: 200, waterShare: 0.6, islandDensity: 0 }, 3],
    [{ roads: false, aridity: 0.7, mountainShare: 0.3 }, 11], [{ size: 120, regionMinSize: 10, regionMaxSize: 30, inlandSeaStrength: 0.8 }, 21],
    [{ waterShare: 0.97 }, 4], [{ waterShare: 0.99, size: 40 }, 6]
];
// Статические вещи
console.log('enums equal:', JSON.stringify([A.Terrain, A.Biome, A.Shore, A.Resource, A.ResourceInfo, A.ROAD_DIRECTIONS, A.GROWTH_STAGES]) ===
    JSON.stringify([B.Terrain, B.Biome, B.Shore, B.Resource, B.ResourceInfo, B.ROAD_DIRECTIONS, B.GROWTH_STAGES]));
console.log('defaults equal:', JSON.stringify(A.MapGenerator.DEFAULTS) === JSON.stringify(B.MapGenerator.DEFAULTS));

let bad = 0;
for (const [opts, seed] of cases) {
    let t0 = Date.now(); let a, b, tA, tB;
    a = scenario(A, opts, seed); tA = Date.now() - t0; t0 = Date.now();
    b = scenario(B, opts, seed); tB = Date.now() - t0;
    const diffs = Object.keys(a.fp).filter(k => a.fp[k] !== b.fp[k]);
    const missing = Object.keys(a.fp).filter(k => !(k in b.fp));
    const ok = !diffs.length && !missing.length && a.extra === b.extra;
    if (!ok) bad++;
    if (a.extra !== b.extra) for (const k of Object.keys(a.extraRaw)) if (JSON.stringify(a.extraRaw[k]) !== JSON.stringify(b.extraRaw[k])) { console.log('   extra part differs:', k); if (k === 'after') for (let q = 0; q < 3; q++) { const x = a.extraRaw.after[q], y = b.extraRaw.after[q]; if (JSON.stringify(x) !== JSON.stringify(y)) { if (q === 0) { for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[f] !== y[f]) console.log('     field', f, x[f], y[f]); } else console.log('     part', q, JSON.stringify(x).slice(0, 300), '\n          ', JSON.stringify(y).slice(0, 300)); } } }
    console.log(ok ? 'OK  ' : 'FAIL', JSON.stringify(opts), 'seed', seed, `orig ${tA}ms new ${tB}ms`, diffs.length ? 'diff: ' + diffs : '', missing.length ? 'missing: ' + missing : '', a.extra !== b.extra ? 'extra differs' : '');
}
console.log(bad ? `FAILED: ${bad}` : 'ALL IDENTICAL');
process.exit(bad ? 1 : 0);
