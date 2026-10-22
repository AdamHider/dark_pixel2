// node renderertest.js "gen.js,painter.js,renderer-old.js" "gen.js,painter.js,renderer-new.js"
const vm = require('vm'), fs = require('fs');

function makeEnv() {
    const log = [];
    let canvasId = 0;
    const ser = v => {
        if (v && v.__path) return { path: v.ops };
        if (v && v.__canvas) return 'canvas#' + v.id;
        if (typeof v === 'number') return Math.round(v * 1e6) / 1e6;
        return v;
    };
    class Path2D { constructor() { this.__path = true; this.ops = []; }
        moveTo(...a) { this.ops.push(['m', ...a.map(ser)]); } lineTo(...a) { this.ops.push(['l', ...a.map(ser)]); }
        rect(...a) { this.ops.push(['r', ...a.map(ser)]); } closePath() { this.ops.push(['z']); } }
    const recorder = () => new Proxy({}, {
        get: (t, name) => {
            if (name in t) return t[name];
            return (...args) => { log.push([String(name), ...args.map(ser)]); };
        },
        set: (t, name, value) => { t[name] = value; log.push(['set', String(name), ser(value)]); return true; }
    });
    const makeCanvas = () => {
        const canvas = { __canvas: true, id: canvasId++, width: 0, height: 0 };
        canvas.getContext = () => ({
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
            putImageData: () => {}
        });
        return canvas;
    };
    const handlers = {};
    const mainCanvas = {
        __canvas: true, id: 'main', width: 0, height: 0, clientWidth: 640, clientHeight: 480,
        getContext: () => recorder(),
        addEventListener: (type, fn) => { handlers[type] = fn; },
        setPointerCapture: () => log.push(['capture']),
        classList: { add: c => log.push(['class+', c]), remove: c => log.push(['class-', c]) },
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 640, height: 480 })
    };
    const observers = [];
    const ctx = vm.createContext({
        document: { createElement: () => makeCanvas() },
        Path2D, console,
        ResizeObserver: class { constructor(cb) { observers.push(cb); } observe() {} },
        SpriteRenderer: class { render(config, opts) { log.push(['sprite', config && config.name, JSON.stringify(opts)]); return { canvas: { __canvas: true, id: 'sprite' }, scale: 1, anchorX: 5, anchorY: 10, width: 12, height: 14 }; } },
        SPRITE_EXAMPLES: { army: { name: 'army' } },
        SEASONS: {
            spring: { name: 'spring', tempShift: 0, palette: pal() }, summer: { name: 'summer', tempShift: 0.1, palette: pal() },
            autumn: { name: 'autumn', tempShift: -0.05, palette: pal() }, winter: { name: 'winter', tempShift: -0.28, palette: pal() }
        },
        DARK_SEASONS: {
            spring: { name: 'spring', tempShift: 0, palette: pal() }, summer: { name: 'summer', tempShift: 0.1, palette: pal() },
            autumn: { name: 'autumn', tempShift: -0.05, palette: pal() }, winter: { name: 'winter', tempShift: -0.28, palette: pal() }
        }
    });
    return { ctx, log, mainCanvas, handlers, observers };
}
function pal() {
    return { biome: ['#d8e4ee', '#3f5a3a', '#6f9a45', '#9a9a52', '#cdb87a', '#a8a24a'], water: ['#4a8fc0', '#3f7fb5', '#336fa5', '#2a5f95', '#1a3f68'], ice: ['#cfe6ee', '#b7d3de', '#a0c0cf'],
        rock: '#7a766e', snow: '#f1f5f8', snowShade: '#c6d2dc', trunk: '#5a4030', broadleaf: ['#4f8a3a', '#5c9a40', '#437a35'], conifer: ['#2f5f3a', '#2a5435'],
        snowOnConifers: true, wheatStage: 'growing', wheatStalk: '#c9b04a', wheatTop: '#e5cf6a', deadTreeChance: 0 };
}

async function scenario(files, rendererOptions) {
    const env = makeEnv();
    for (const f of files.split(',')) vm.runInContext(fs.readFileSync(f, 'utf8'), env.ctx, { filename: f });
    const { ctx, log, mainCanvas, handlers, observers } = env;
    const map = vm.runInContext('new MapGenerator({ size: 36, seed: 7, riverThresholds: [10, 40, 110] }).generate(7)', ctx);
    const Renderer = vm.runInContext('MapRenderer', ctx);
    const events = [], out = { events };
    const r = new Renderer(mainCanvas, map, { tileSize: 10, ...rendererOptions });
    r.onSelect = (tile, region) => events.push(['select', tile && [tile.x, tile.y, tile.regionId], region && region.id]);
    r.onHover = tile => events.push(['hover', tile && [tile.x, tile.y]]);
    const snap = tag => events.push([tag, { ...r.camera }, r.selection ? [r.selection.tile.x, r.selection.tile.y, !!r.selection.shape, !!r.selection.cell] : null, r.buffer.width, !!r.gridLayer, !!r.factionLayer]);
    const ev = (type, e) => { handlers[type]({ preventDefault() {}, pointerId: 1, ...e }); };
    const mark = tag => log.push(['---', tag]);

    mark('refresh'); r.refresh(); snap('refresh');
    mark('wheel'); ev('wheel', { clientX: 300, clientY: 200, deltaY: -100 }); ev('wheel', { clientX: 100, clientY: 400, deltaY: 100 }); ev('wheel', { clientX: 330, clientY: 260, deltaY: -1 }); snap('wheel');
    mark('drag'); ev('pointerdown', { clientX: 200, clientY: 200 }); ev('pointermove', { clientX: 230, clientY: 180 }); ev('pointermove', { clientX: 260, clientY: 150 }); ev('pointerup', { clientX: 260, clientY: 150 }); snap('drag');
    mark('hover'); ev('pointermove', { clientX: 320, clientY: 240 }); ev('pointermove', { clientX: 5, clientY: 5 }); ev('pointerleave', {});
    mark('click'); for (const [x, y] of [[320, 240], [200, 300], [500, 100], [20, 30]]) { ev('pointerdown', { clientX: x, clientY: y }); ev('pointerup', { clientX: x + 1, clientY: y }); snap('click'); }
    mark('keys'); for (const key of ['ArrowLeft', 'd', 'w', 's', '+', '=', '-', 'Escape', 'q']) ev('keydown', { key });
    mark('click2'); ev('pointerdown', { clientX: 330, clientY: 250 }); ev('pointerup', { clientX: 330, clientY: 250 });
    mark('view'); r.setView('regions'); r.setView('temperature'); r.setView('terrain'); snap('view');
    mark('season'); r.setSeason('winter'); r.setSeason('nonsense'); r.setMood('light'); r.setMood('dark'); snap('season');
    mark('toggles'); r.setShowGrid(true); r.setShowBorders(false); r.setShowSettlements(false); r.setShowSettlements(true); r.setShowBorders(true); snap('toggles');
    mark('objects');
    r.setObjects([{ id: 'a', config: { name: 'army' }, tile: [10, 12], offset: [1, -1], options: { flags: ['x'] } }, { id: 'b', config: { name: 'army' }, tile: [14, 12] }]);
    r.addObject({ id: 'c', config: { name: 'army' }, tile: [12, 20] }); r.addObject({ id: 'a', config: { name: 'army' }, tile: [11, 11] }); r.removeObject('b');
    r.centerOn(120, 120); r.onObjectClick = o => events.push(['objectClick', o.id]);
    const b = r.objectBox(r.objects[0]); ev('pointerdown', { clientX: b.x + 12, clientY: b.y + 12 }); ev('pointerup', { clientX: b.x + 12, clientY: b.y + 12 });
    out.at = [r.objectAt({ x: b.x + 3, y: b.y + 3 }) && r.objectAt({ x: b.x + 3, y: b.y + 3 }).id, r.objectAt({ x: -50, y: -50 })];
    mark('factions');
    r.setTerritories([{ id: 'x', color: '#ff0000', regions: [0, 1, 2], fill: 0.2, border: 3 }, { id: 'y', color: '#00ff00', tiles: [100, 101, 102, 135] }]);
    r.setShowFactions(false); r.setShowFactions(true); r.refreshFactions(); r.setTerritories(null);
    const n = map.size * map.size, tf = new Int16Array(n).fill(-1); for (let i = 0; i < n; i += 2) if (map.regionId[i] >= 0) tf[i] = map.regionId[i] % 2;
    map.applyFactionState({ factions: [{ id: 0, color: '#d94a3a' }, { id: 1, color: '#3a7ad9' }], tileFaction: tf });
    mark('turns');
    map.applyTurnState({ turn: 1, season: 'autumn' }); map.applyTurnState({ turn: 2, season: 'autumn' }); map.applyTurnState({ turn: 3, season: 'bogus' });
    map.applyEconomyState({ growth: new Float32Array(n).fill(0.5) });
    await Promise.resolve(); await Promise.resolve(); snap('turns');
    mark('turns2'); map.applyTurnState({ turn: 4, season: 'winter' }); r.setView('regions'); await Promise.resolve(); await Promise.resolve();
    mark('resize'); mainCanvas.clientWidth = 500; mainCanvas.clientHeight = 700; observers[0](); snap('resize');
    mark('fit'); r.fitToView(); r.panBy(40, -30); r.zoomAt(100, 100, 3); r.zoomAt(100, 100, 1e-6); snap('fit');
    out.tiles = [r.screenToTile(100, 100), r.screenToWorld(50, 60), r.pickTile(250, 250), r.worldSize];
    out.regionOutline = r.regionOutline(map.getRegionInfo(1)).length;
    mark('destroy'); r.destroy(); map.applyFactionState({ factions: [], tileFaction: new Int16Array(n).fill(-1) });
    out.log = log;
    return out;
}

(async () => {
    const [, , filesA, filesB] = process.argv;
    let bad = 0;
    for (const [name, opts] of [['adaptive (по умолчанию)', {}], ['square + скругление', { selectionShape: 'square', selectionCorner: 0.3 }], ['autoRepaint=season, smoothing', { autoRepaint: 'season', outlineSmoothing: 2, cellSmoothing: 0 }], ['autoRepaint=false', { autoRepaint: false }]]) {
        const a = await scenario(filesA, opts), b = await scenario(filesB, opts);
        const ja = JSON.stringify({ ...a, log: undefined }), jb = JSON.stringify({ ...b, log: undefined });
        let logDiff = '';
        if (a.log.length !== b.log.length) logDiff = `длина журнала ${a.log.length} vs ${b.log.length}`;
        else for (let i = 0; i < a.log.length; i++) if (JSON.stringify(a.log[i]) !== JSON.stringify(b.log[i])) { logDiff = `запись ${i}: ${JSON.stringify(a.log[i])} vs ${JSON.stringify(b.log[i])}`; break; }
        const ok = ja === jb && !logDiff;
        if (!ok) bad++;
        console.log(ok ? 'OK  ' : 'FAIL', name, `(записей ctx: ${a.log.length})`, ja !== jb ? 'состояние различается' : '', logDiff);
    }
    console.log(bad ? `ИТОГ: РАСХОЖДЕНИЙ ${bad}` : 'ИТОГ: ВСЁ ИДЕНТИЧНО');
    process.exit(bad ? 1 : 0);
})();
