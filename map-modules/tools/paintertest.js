// node paintertest.js "gen1.js,painter1.js" "gen2.js,painter2.js"   — сравнивает результаты рисования
const vm = require('vm'), fs = require('fs'), crypto = require('crypto');

const sha = (arr) => crypto.createHash('sha1').update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)).digest('hex').slice(0, 12);
const shaJson = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);

const palette = (over = {}) => ({
    biome: ['#d8e4ee', '#3f5a3a', '#6f9a45', '#9a9a52', '#cdb87a', '#a8a24a'],
    water: ['#4a8fc0', '#3f7fb5', '#336fa5', '#2a5f95', '#1a3f68'],
    ice: ['#cfe6ee', '#b7d3de', '#a0c0cf'],
    rock: '#7a766e', snow: '#f1f5f8', snowShade: '#c6d2dc', trunk: '#5a4030',
    broadleaf: ['#4f8a3a', '#5c9a40', '#437a35'], conifer: ['#2f5f3a', '#2a5435'],
    snowOnConifers: true, wheatStage: 'growing', wheatStalk: '#c9b04a', wheatTop: '#e5cf6a',
    ...over
});
const seasons = (dark) => ({
    spring: { name: 'spring', tempShift: 0, palette: palette({ blossom: '#f2b8d0', groundDetail: ['#e8d84a', '#e86a8a'], wheatStage: 'sprout', deadTreeChance: dark ? 0.3 : 0, fogStrength: dark ? 0.8 : undefined }) },
    summer: { name: 'summer', tempShift: 0.1, palette: palette({ deadTreeChance: dark ? 0.25 : 0, fogStrength: dark ? 1 : undefined }) },
    autumn: { name: 'autumn', tempShift: -0.05, palette: palette({ broadleaf: ['#c9702a', '#b85a22', '#d8a030'], groundDetail: ['#b8742a', '#9a5a22'], wheatStage: 'ripe', deadTreeChance: dark ? 0.3 : 0 }) },
    winter: { name: 'winter', tempShift: -0.28, palette: palette({ bareTrees: true, wheatStage: 'bare', fogStrength: dark ? 0.6 : undefined }) }
});

function makeContext() {
    const canvases = [];
    const document = {
        createElement: () => {
            const canvas = { width: 0, height: 0, id: canvases.length };
            canvas.getContext = () => ({
                createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
                putImageData: image => { canvas.image = image; }
            });
            canvases.push(canvas);
            return canvas;
        }
    };
    return vm.createContext({ document, SEASONS: seasons(false), DARK_SEASONS: seasons(true), console });
}

function load(files) {
    const ctx = makeContext();
    for (const f of files.split(',')) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f });
    return ctx;
}
const run = (ctx, code) => vm.runInContext(code, ctx);

function imageHash(canvas) { return canvas && canvas.image ? sha(new Uint8Array(canvas.image.data.buffer)) : null; }

const SCENARIOS = [
    { map: { size: 44, seed: 3 }, tile: 12, steps: [
        { view: 'terrain', seasonName: 'summer', showBorders: true, mood: 'light' },
        { view: 'terrain', seasonName: 'winter', showBorders: true, mood: 'light' },
        { view: 'terrain', seasonName: 'summer', showBorders: true, mood: 'light' },
        { view: 'terrain', seasonName: 'autumn', showBorders: false, mood: 'dark' },
        { view: 'terrain', seasonName: 'spring', showBorders: true, mood: 'dark' },
        { view: 'regions', seasonName: 'summer', showBorders: true, mood: 'light' },
        { view: 'temperature', seasonName: 'winter', showBorders: true, mood: 'dark' }
    ] },
    { map: { size: 40, seed: 11, waterShare: 0.3, mountainShare: 0.3, riverThresholds: [10, 40, 110] }, tile: 16, steps: [
        { view: 'terrain', seasonName: 'summer', showBorders: true, mood: 'dark' },
        { view: 'terrain', seasonName: 'winter', showBorders: true, mood: 'dark' }
    ] },
    { map: { size: 36, seed: 21, aridity: 0.8 }, tile: 12, options: { shores: false, roads: false, coastSmoothing: 0, regionBorderSmoothing: 0, riverTails: false, spriteOutline: true, mountainLight: 'right', factionRiverBorder: 'always', regionShoreBorder: true }, steps: [
        { view: 'terrain', seasonName: 'summer', showBorders: true, mood: 'light' },
        { view: 'terrain', seasonName: 'autumn', showBorders: true, mood: 'dark' }
    ] },
    { map: { size: 72, seed: 8, riverThresholds: [10, 40, 110] }, tile: 8, steps: [
        { view: 'terrain', seasonName: 'summer', showBorders: true, mood: 'dark' },
        { view: 'terrain', seasonName: 'winter', showBorders: false, mood: 'dark' }
    ] },
    { map: { size: 36, seed: 5, riverThresholds: [10, 40, 110] }, tile: 10, options: { settlements: false, hillStrength: 0, ravineDensity: 0, grade: false, props: false, layers: { relief: false, decorations: true } }, steps: [
        { view: 'terrain', seasonName: 'summer', showBorders: true, mood: 'dark' },
        { view: 'terrain', seasonName: 'spring', showBorders: true, mood: 'light' }
    ] }
];

function runScenario(ctx, sc) {
    const out = {};
    const map = run(ctx, `new MapGenerator(${JSON.stringify(sc.map)}).generate(${sc.map.seed})`);
    // экономика: частичный рост и выросшее население — проверяем ступени роста и уровни поселений
    const n = map.size * map.size;
    const growth = new Float32Array(n).map((_, i) => ((i * 7) % 11) / 10);
    const pop = new Uint16Array(n); for (const s of map.settlements) pop[s.tile] = 40 + ((s.tile * 13) % 900);
    map.applyEconomyState({ growth, population: pop });
    // фракции
    const tf = new Int16Array(n).fill(-1);
    const regions = map.regionCount;
    for (let i = 0; i < n; i++) { const r = map.regionId[i]; if (r >= 0 && r % 3 !== 2) tf[i] = r % 2; }
    for (let i = 0; i < n; i += 5) if (map.regionId[i] >= 0 && tf[i] < 0) tf[i] = 1;
    map.applyFactionState({ factions: [{ id: 0, name: 'a', color: '#d94a3a' }, { id: 1, name: 'b', color: '#3a7ad9' }], tileFaction: tf });

    const Painter = run(ctx, 'MapPainter');
    const painter = new Painter(map, { tileSize: sc.tile, ...(sc.options || {}) });
    out.steps = [];
    for (const step of sc.steps) {
        const canvas = painter.paint(step);
        const r = { pixels: sha(painter.pixels), water: sha(painter.waterMask), sprite: sha(painter.spriteMask), river: painter.riverMask ? sha(painter.riverMask) : null, canvas: imageHash(canvas), emissive: painter.emissive.length };
        out.steps.push(r);
    }
    // слои поверх карты
    const last = sc.steps[sc.steps.length - 1];
    painter.paint(last);
    const owner = painter.buildPixelRegions(), cells = painter.buildCellMap();
    out.owner = sha(owner); out.cells = sha(cells);
    out.grid = imageHash(painter.paintGrid());
    out.territoriesMap = shaJson(painter.territoriesFromMap());
    out.territories = imageHash(painter.paintTerritories());
    out.territoriesCustom = imageHash(painter.paintTerritories([
        { id: 'x', color: '#ffd24a', regions: [0, 1, 2], fill: 0.3, border: 3 },
        { id: 'y', color: '#22aa66', tiles: Array.from(map.landTiles).filter((_, k) => k % 7 === 0) }
    ]));
    const loops = [];
    for (let id = 0; id < Math.min(5, regions); id++) loops.push(painter.regionOutline(id, 3));
    loops.push(painter.regionOutline(9999, 2));
    out.regionOutlines = shaJson(loops);
    const cellLoops = [];
    for (const t of [0, map.size + 1, Math.floor(n / 2), n - 1, Math.floor(n / 3)]) cellLoops.push(painter.cellOutline(t, 2, 5), painter.cellOutline(t, 0, 0));
    out.cellOutlines = shaJson(cellLoops);
    const at = [];
    for (let k = 0; k < 20; k++) at.push(painter.cellAt((k * 97) % painter.width + 0.5, (k * 61) % painter.width + 0.5));
    at.push(painter.cellAt(-5, 3), painter.cellAt(1e9, 3));
    out.cellAt = shaJson(at);
    return out;
}

const [, , filesA, filesB] = process.argv;
let bad = 0;
const t0 = Date.now();
for (const [idx, sc] of SCENARIOS.entries()) {
    const a = runScenario(load(filesA), sc), b = runScenario(load(filesB), sc);
    const diffs = [];
    a.steps.forEach((s, k) => { for (const key of Object.keys(s)) if (s[key] !== b.steps[k][key]) diffs.push(`step${k}.${key}`); });
    for (const key of Object.keys(a)) if (key !== 'steps' && a[key] !== b[key]) diffs.push(key);
    if (diffs.length) bad++;
    console.log(diffs.length ? 'FAIL' : 'OK  ', `сценарий ${idx + 1} (size ${sc.map.size}, tile ${sc.tile}, шагов ${sc.steps.length})`, diffs.length ? 'расходится: ' + diffs.join(', ') : '');
}
console.log(bad ? `ИТОГ: РАСХОЖДЕНИЙ ${bad}` : 'ИТОГ: ВСЁ ИДЕНТИЧНО', `(${((Date.now() - t0) / 1000).toFixed(0)} с)`);
process.exit(bad ? 1 : 0);
