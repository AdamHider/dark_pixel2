/* ============================================================
   paint-stats.js — измерения графики (для оценки «мусорности» и правок).

   Считает по одной карте:
     - траву: сколько пикселей травы рисуется на клетку и насколько сильно
       стебли отличаются от земли под ними (контраст);
     - деревья: сколько на клетку, габариты кроны в пикселях, площадь;
     - «пестроту»: сколько пикселей текстуры приходится на клетку.

     node tools/paint-stats.js [size] [seed] [view]
   ============================================================ */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['seasons.js', 'map-generator.js', 'map-painter.js'];

function makeCanvas() {
    return function createCanvas() {
        const canvas = { width: 0, height: 0 };
        let last = null;
        const ctx = {
            createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
            putImageData(image) { last = image; },
            getImageData(x, y, w, h) { return last && last.width === w ? last : { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
            fillRect() {}, clearRect() {}, drawImage() {}, save() {}, restore() {}, translate() {}, scale() {},
            beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {}, rect() {}, setTransform() {}
        };
        canvas.getContext = () => ctx;
        return canvas;
    };
}

const size = +(process.argv[2] || 120);
const seed = +(process.argv[3] || 42);
const view = process.argv[4] || 'terrain';

const sandbox = { console, Math, Date, JSON, performance: { now: () => Date.now() }, document: { createElement: makeCanvas() } };
const ctx = vm.createContext(sandbox);
for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });

vm.runInContext(`
    globalThis.STATS = {
        grass: { tiles: 0, pixels: 0, contrast: [], heights: [] },
        trees: { tiles: 0, count: 0, boxes: [] },
        texture: { pixels: 0, tiles: 0 }
    };

    // ---- Трава: перехватываем putGround, считаем пиксели и контраст к земле под стеблем ----
    const origPutGround = MapPaint.Tools.prototype.putGround;
    let inTufts = false;
    MapPaint.Tools.prototype.putGround = function (x, y, color) {
        if (inTufts && x >= 0 && y >= 0 && x < this.width && y < this.width) {
            const k = y * this.width + x;
            const ground = this.pixels[k];
            if ((ground >>> 24) !== 0) {
                const dr = Math.abs((ground & 255) - (color & 255));
                const dg = Math.abs(((ground >>> 8) & 255) - ((color >>> 8) & 255));
                const db = Math.abs(((ground >>> 16) & 255) - ((color >>> 16) & 255));
                STATS.grass.contrast.push((dr + dg + db) / 3);
            }
            STATS.grass.pixels++;
        }
        return origPutGround.call(this, x, y, color);
    };
    const origTufts = MapPaint.Texture.paintTufts;
    MapPaint.Texture.paintTufts = function (p, x, y, i) {
        STATS.grass.tiles++;
        inTufts = true;
        origTufts.call(this, p, x, y, i);
        inTufts = false;
    };

    // ---- Деревья: габариты по вызовам put/rect/blend между collect и отрисовкой ----
    const origPut = MapPaint.Tools.prototype.put;
    const origRect = MapPaint.Tools.prototype.rect;
    const origBlend = MapPaint.Tools.prototype.blend;
    let box = null;
    const mark = (x, y) => {
        if (!box) return;
        if (x < box.minX) box.minX = x; if (x > box.maxX) box.maxX = x;
        if (y < box.minY) box.minY = y; if (y > box.maxY) box.maxY = y;
        box.area++;
    };
    MapPaint.Tools.prototype.put = function (x, y, color) { mark(x, y); return origPut.call(this, x, y, color); };
    MapPaint.Tools.prototype.blend = function (x, y, color, alpha) { mark(x, y); return origBlend.call(this, x, y, color, alpha); };
    MapPaint.Tools.prototype.rect = function (x, y, w, h, color) {
        if (box) for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) mark(x + xx, y + yy);
        return origRect.call(this, x, y, w, h, color);
    };
    const origCollect = MapPaint.Trees.collect;
    MapPaint.Trees.collect = function (p, items, x, y, i) {
        const n0 = items.length;
        origCollect.call(this, p, items, x, y, i);
        const added = items.slice(n0);
        STATS.trees.tiles++;
        STATS.trees.count += added.length;
        for (const item of added) {
            box = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, area: 0 };
            item.draw();
            if (box.area) STATS.trees.boxes.push({ w: box.maxX - box.minX + 1, h: box.maxY - box.minY + 1, area: box.area });
            box = null;
        }
    };
`, ctx, { filename: 'stats-hook' });

const result = vm.runInContext(`
    (() => {
        const map = new MapGenerator({ size: ${size} }).generate(${seed});
        const painter = new MapPainter(map, { tileSize: 12 });
        painter.paint({ view: '${view}', seasonName: 'summer', mood: 'light', showBorders: true });

        // «Мусорность»: плотность контуров (резкие перепады цвета между соседями) и число цветов на клетку.
        const T = 12, W = painter.width, px = painter.pixels;
        let edges = 0, tiles = 0, colorsTotal = 0;
        const lum = v => (v & 255) * 0.3 + ((v >>> 8) & 255) * 0.6 + ((v >>> 16) & 255) * 0.1;
        for (let ty = 0; ty < map.size; ty++) for (let tx = 0; tx < map.size; tx++) {
            const i = map.index(tx, ty);
            if (!map.isLand(i)) continue;
            tiles++;
            const seen = new Set();
            for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
                const gx = tx * T + x, gy = ty * T + y, k = gy * W + gx;
                seen.add(px[k]);
                if (x + 1 < T && Math.abs(lum(px[k]) - lum(px[k + 1])) > 18) edges++;
                if (y + 1 < T && Math.abs(lum(px[k]) - lum(px[k + W])) > 18) edges++;
            }
            colorsTotal += seen.size;
        }
        return { stats: STATS, clutter: { edges, tiles, colorsPerTile: colorsTotal / tiles },
                 land: map.landTiles.length, wood: map.resource.filter(r => r === Resource.WOOD).length };
    })()
`, ctx);

const s = result.stats;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const pct = (a, q) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };

console.log(`карта ${size}×${size}, seed ${seed}, вид ${view}; суши ${result.land}, леса ${result.wood} клеток`);
console.log('');
console.log('ТРАВА');
console.log(`  клеток с травой         : ${s.grass.tiles}`);
console.log(`  пикселей травы на клетку: ${(s.grass.pixels / s.grass.tiles).toFixed(1)} (${(s.grass.pixels / s.grass.tiles / 144 * 100).toFixed(1)}% клетки)`);
console.log(`  контраст к земле        : сред ${avg(s.grass.contrast).toFixed(1)}, медиана ${pct(s.grass.contrast, 0.5).toFixed(1)}, p90 ${pct(s.grass.contrast, 0.9).toFixed(1)}`);
console.log('');
console.log('ДЕРЕВЬЯ');
console.log(`  клеток с лесом          : ${s.trees.tiles}`);
console.log(`  деревьев на клетку      : ${(s.trees.count / s.trees.tiles).toFixed(2)}`);
console.log(`  ширина кроны (px)       : сред ${avg(s.trees.boxes.map(b => b.w)).toFixed(1)}, макс ${Math.max(...s.trees.boxes.map(b => b.w))}`);
console.log(`  высота дерева (px)      : сред ${avg(s.trees.boxes.map(b => b.h)).toFixed(1)}, макс ${Math.max(...s.trees.boxes.map(b => b.h))}`);
console.log(`  площадь дерева (px)     : сред ${avg(s.trees.boxes.map(b => b.area)).toFixed(1)}, макс ${Math.max(...s.trees.boxes.map(b => b.area))}`);
console.log(`  площадь деревьев/клетка : ${(s.trees.boxes.reduce((a, b) => a + b.area, 0) / s.trees.tiles).toFixed(1)} px (клетка 144 px)`);
console.log('');
console.log('МУСОРНОСТЬ (меньше — спокойнее)');
console.log(`  контуров на клетку      : ${(result.clutter.edges / result.clutter.tiles).toFixed(1)}`);
console.log(`  цветов на клетку        : ${result.clutter.colorsPerTile.toFixed(1)}`);
