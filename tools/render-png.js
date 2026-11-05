/* ============================================================
   render-png.js — рендер карты и спрайтов в PNG (для визуальной проверки).

   Без зависимостей: браузерные скрипты грузятся в vm-контекст, холст-заглушка
   копит ImageData, PNG кодируется через zlib.

     node tools/render-png.js map   [view] [season] [mood] [size] [seed] [out]
     node tools/render-png.js sprite <name> [season] [out]
     node tools/render-png.js all                    все виды × сезоны в /tmp/maps
   ============================================================ */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['seasons.js', 'map-generator.js', 'map-painter.js', 'sprite-renderer.js', 'sprite-examples.js', 'sprite-bitmaps.js'];

/* ---------- Холст-заглушка: хранит последний ImageData ---------- */

function makeCanvas() {
    return function createCanvas() {
        const canvas = { width: 0, height: 0 };
        let last = null;
        const ctx = {
            createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
            putImageData(image) { last = image; canvas.width = image.width; canvas.height = image.height; },
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

function loadContext() {
    const sandbox = { console, Math, Date, JSON, performance: { now: () => Date.now() }, document: { createElement: makeCanvas() } };
    const ctx = vm.createContext(sandbox);
    for (const file of SCRIPTS) {
        vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
    }
    // const-объявления классических скриптов не попадают в sandbox — выносим их мостом.
    vm.runInContext('globalThis.API = { MapGenerator, MapPainter, SpriteRenderer, SPRITE_EXAMPLES, SPRITE_BITMAPS };', ctx, { filename: 'bridge' });
    return ctx.API;
}

/* ---------- PNG ---------- */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
}

// image: { width, height, data } — RGBA. Возвращает Buffer PNG.
function encodePng(image) {
    const { width, height, data } = image;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 4 + 1)] = 0;                                       // filter: none
        Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;     // 8 бит, RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// Packed ARGB (Int32Array) -> RGBA-байты для PNG.
function pixelsToRgba(pixels, width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const value = pixels[i];
        data[i * 4] = value & 255;
        data[i * 4 + 1] = (value >>> 8) & 255;
        data[i * 4 + 2] = (value >>> 16) & 255;
        data[i * 4 + 3] = (value >>> 24) & 255;
    }
    return { width, height, data };
}

/* ---------- Сцена ---------- */

function renderMap(ctx, { view, season, mood, size, seed, tileSize }) {
    const { MapGenerator, MapPainter } = ctx;
    const map = new MapGenerator({ size }).generate(seed);
    const painter = new MapPainter(map, { tileSize });
    painter.paint({ view, seasonName: season, mood, showBorders: true });
    return { pixels: painter.pixels, width: painter.width, height: painter.width };
}

function renderSprite(ctx, { name, season, colors }) {
    const { SPRITE_EXAMPLES, SPRITE_BITMAPS, SpriteRenderer } = ctx;
    const config = SPRITE_EXAMPLES[name] || SPRITE_BITMAPS[name];
    if (!config) throw new Error('Нет спрайта: ' + name);
    const sprite = new SpriteRenderer().render(config, { season, colors });
    const image = sprite.canvas.getContext('2d').getImageData(0, 0, sprite.canvas.width, sprite.canvas.height);
    return { pixels: new Int32Array(image.data.buffer), width: sprite.canvas.width, height: sprite.canvas.height };
}

function savePng(scene, out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, encodePng(pixelsToRgba(scene.pixels, scene.width, scene.height)));
    console.log(`${out} (${scene.width}×${scene.height})`);
}

/* ---------- CLI ---------- */

const ctx = loadContext();
const [mode, ...rest] = process.argv.slice(2);

if (mode === 'map') {
    const [view = 'terrain', season = 'summer', mood = 'light', size = '120', seed = '42', out = '/tmp/maps/map.png'] = rest;
    savePng(renderMap(ctx, { view, season, mood, size: +size, seed: +seed, tileSize: 12 }), out);
} else if (mode === 'sprite') {
    const [name, season = 'summer', out = `/tmp/maps/sprite-${name}.png`] = rest;
    savePng(renderSprite(ctx, { name, season, colors: { team: '#c0392b' } }), out);
} else if (mode === 'all') {
    const views = ['terrain', 'temperature', 'regions', 'factions'];
    const seasons = ['spring', 'summer', 'autumn', 'winter'];
    for (const view of views) for (const season of seasons) {
        savePng(renderMap(ctx, { view, season, mood: 'light', size: 100, seed: 42, tileSize: 12 }), `/tmp/maps/${view}-${season}.png`);
    }
    for (const name of Object.keys(ctx.SPRITE_EXAMPLES)) savePng(renderSprite(ctx, { name, season: 'summer', colors: { team: '#c0392b' } }), `/tmp/maps/sprite-${name}.png`);
} else {
    console.log('usage: node tools/render-png.js map|sprite|all [args...]');
    process.exit(1);
}
