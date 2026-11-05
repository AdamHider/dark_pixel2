/* ============================================================
   baseline.js — страховочный харнесс рефакторинга.

   Считает те же хеши, что map-test.html (функции MAP_TEST берутся из
   самого файла, а не переписываются), и сравнивает с сохранённым
   эталоном в tools/baseline.json.

     node tools/baseline.js save     записать эталон (до рефакторинга)
     node tools/baseline.js check    сверить текущий код с эталоном
   ============================================================ */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'baseline.json');

/* ---------- Загрузка браузерных скриптов в один vm-контекст ---------- */

// Холст-заглушка: createImageData/putImageData/getImageData. putImageData
// запоминает картинку, getImageData её отдаёт — этого хватает и MapPainter,
// и SpriteRenderer (см. map-test.html).
function makeCanvas() {
    return function createCanvas() {
        const canvas = { width: 0, height: 0 };
        let last = null;
        const ctx = {
            createImageData(w, h) {
                return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
            },
            putImageData(image) {
                last = image;
                canvas.width = image.width;
                canvas.height = image.height;
            },
            getImageData(x, y, w, h) {
                if (last && last.width === w && last.height === h) return last;
                return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
            },
            fillRect() {}, clearRect() {}, drawImage() {},
            save() {}, restore() {}, translate() {}, scale() {},
            beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
            stroke() {}, fill() {}, arc() {}, rect() {}, setTransform() {}
        };
        canvas.getContext = () => ctx;
        return canvas;
    };
}

const SCRIPTS = ['seasons.js', 'map-generator.js', 'map-painter.js', 'sprite-renderer.js', 'sprite-examples.js'];

function loadContext() {
    const sandbox = { console, Math, Date, JSON, performance: { now: () => Date.now() }, document: { createElement: makeCanvas() } };
    const ctx = vm.createContext(sandbox);
    for (const file of SCRIPTS) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
    }
    // MAP_TEST вырезаем из map-test.html как есть — единый источник правды по хешам.
    const html = fs.readFileSync(path.join(__dirname, 'map-test.html'), 'utf8');
    const start = html.indexOf('const MAP_TEST = (() => {');
    if (start < 0) throw new Error('не нашёл MAP_TEST в map-test.html');
    const end = html.indexOf('\n})();', start);
    if (end < 0) throw new Error('не нашёл конец MAP_TEST в map-test.html');
    const source = html.slice(start, end + '\n})();'.length);
    vm.runInContext(source + '\n;globalThis.MAP_TEST = MAP_TEST;', ctx, { filename: 'map-test.html#MAP_TEST' });
    return { ctx, MAP_TEST: ctx.MAP_TEST };
}

/* ---------- Список случаев ---------- */

const SETTINGS = {
    size: 120, tileSize: 12, seeds: [1, 42, 777],
    views: ['terrain', 'temperature', 'regions', 'factions'],
    seasons: ['spring', 'summer', 'autumn', 'winter'],
    moods: ['light', 'dark'],
    borders: true, noBorders: true,
    sprites: true, spriteSeasons: ['spring', 'summer', 'autumn', 'winter'],
    repeats: 1
};

function run() {
    const { MAP_TEST } = loadContext();
    const cases = MAP_TEST.planCases(SETTINGS);
    const out = {};
    for (const item of cases) out[item.name] = MAP_TEST.combineParts(item.run());
    return out;
}

/* ---------- CLI ---------- */

function save() {
    const cases = run();
    fs.writeFileSync(BASELINE, JSON.stringify({ version: 1, cases }, null, 1) + '\n');
    console.log(`эталон записан: ${Object.keys(cases).length} случаев -> ${path.relative(ROOT, BASELINE)}`);
}

function check() {
    if (!fs.existsSync(BASELINE)) { console.error('нет эталона — сначала node tools/baseline.js save'); process.exit(2); }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).cases;
    const cases = run();
    const changed = [], missing = [], added = [];
    for (const [name, hash] of Object.entries(baseline)) {
        if (!(name in cases)) missing.push(name);
        else if (cases[name] !== hash) changed.push(name);
    }
    for (const name of Object.keys(cases)) if (!(name in baseline)) added.push(name);
    if (!changed.length && !missing.length && !added.length) {
        console.log(`OK: ${Object.keys(cases).length} случаев совпали с эталоном`);
        return;
    }
    if (changed.length) console.log('ИЗМЕНИЛОСЬ:\n  ' + changed.join('\n  '));
    if (missing.length) console.log('ПРОПАЛО:\n  ' + missing.join('\n  '));
    if (added.length) console.log('ДОБАВИЛОСЬ:\n  ' + added.join('\n  '));
    process.exit(1);
}

const mode = process.argv[2] || 'check';
if (mode === 'save') save();
else if (mode === 'check') check();
else { console.error('использование: node tools/baseline.js [save|check]'); process.exit(2); }
