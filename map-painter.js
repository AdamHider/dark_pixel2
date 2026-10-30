/* ============================================================
   SECTION: MAP_COLORS
   Цвета, не зависящие от сезона (в виде hex).
   ============================================================ */
   const COLORS = {
    bridgeDeck: '#a39e92',
    bridgeEdge: '#6e6a62',
    stone: '#b9b5ab',
    stoneShadow: '#7d7a72',
    gold: '#f2d15b',
    goldShadow: '#8a6a14',
    goldLight: '#fff2b0',
    riftDark: '#2a1250',
    riftGlow: '#a45cff',
    riftCore: '#e9ccff',
    regionBorder: '#19110a',
    sand: '#dccb96',
    wetSand: '#b5a67c',
    pebbleLight: '#a9a59a',
    pebbleDark: '#6f6c66',
    stoneMid: '#8a877e',
    hay: '#c9b774',
    dirt: '#8a7650',
    dirtLight: '#a89168',
    mud: '#5d4f38',
    plank: '#4a3524',
    wallA: '#dccca4',
    wallB: '#c8b48c',
    thatch: '#b09a5a',
    roofA: '#a24d34',
    roofB: '#7e3a2c',
    roofC: '#8d6238',
    roofD: '#5e5a66',
    outline: '#140e0a',
    window: '#f0b24a',
    fire: '#ffb347',
    fireCore: '#fff0b0',
    chapelStone: '#8d8a85'
};

/* ============================================================
   SECTION: MAP_PACKED_COLORS
   Цвета в виде одного числа (так пиксели быстро записываются в ImageData).
   ============================================================ */
const packRgb = (r, g, b) => 0xFF000000 | (b << 16) | (g << 8) | r; // знаковое 32-битное число, как в Int32Array
const hexToPacked = hex => packRgb(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
const WHITE = packRgb(255, 255, 255);
const BLACK = packRgb(0, 0, 0);

function hslToPacked(hue, saturation, lightness) {
    const s = saturation / 100, l = lightness / 100;
    const k = n => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const channel = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return packRgb(channel(0), channel(8), channel(4));
}

// Смесь двух цветов: t = 0 — цвет a, t = 1 — цвет b. Целочисленная арифметика: функция вызывается миллионы раз.
function mixPacked(a, b, t) {
    const w = Math.round(t * 256);
    const inv = 256 - w;
    const r = ((a & 255) * inv + (b & 255) * w) >> 8;
    const g = (((a >>> 8) & 255) * inv + ((b >>> 8) & 255) * w) >> 8;
    const bl = (((a >>> 16) & 255) * inv + ((b >>> 16) & 255) * w) >> 8;
    return 0xFF000000 | (bl << 16) | (g << 8) | r;
}

// Крапинка: чуть светлее или чуть темнее (на ~13%), целочисленно.
function speckColor(color, lighter) {
    const target = lighter ? 255 : 0;
    const r = (color & 255) + (((target - (color & 255)) * 33) >> 8);
    const g = ((color >>> 8) & 255) + (((target - ((color >>> 8) & 255)) * 33) >> 8);
    const b = ((color >>> 16) & 255) + (((target - ((color >>> 16) & 255)) * 33) >> 8);
    return 0xFF000000 | (b << 16) | (g << 8) | r;
}

// Светлее (amount > 0) или темнее (amount < 0) на amount/256 — целочисленно, без выделения памяти.
function shadeFast(color, amount) {
    const r = color & 255, g = (color >>> 8) & 255, b = (color >>> 16) & 255;
    if (amount < 0) {
        const keep = 256 + amount;
        return 0xFF000000 | (((b * keep) >> 8) << 16) | (((g * keep) >> 8) << 8) | ((r * keep) >> 8);
    }
    return 0xFF000000 | ((b + (((255 - b) * amount) >> 8)) << 16) | ((g + (((255 - g) * amount) >> 8)) << 8) | (r + (((255 - r) * amount) >> 8));
}

// Светлее (amount > 0) или темнее (amount < 0).
const shadePacked = (color, amount) => mixPacked(color, amount > 0 ? WHITE : BLACK, Math.abs(amount));

// Скалы гор (по референсу): от холодной фиолетовой тени к тёплому бежевому свету. Сезон слегка подкрашивает их цветом камня.
const MOUNTAIN_RAMP = Object.freeze(['#463f50', '#554e5b', '#6c677c', '#877466', '#aa9989', '#cbbfae']);

// Палитра выбранного сезона в виде чисел.
const packPalette = palette => ({
    biome: palette.biome.map(hexToPacked),
    waterShades: palette.water.map(hexToPacked),
    ice: palette.ice.map(hexToPacked),
    rock: hexToPacked(palette.rock),
    snow: hexToPacked(palette.snow),
    snowShade: hexToPacked(palette.snowShade),
    trunk: hexToPacked(palette.trunk)
});

/* ============================================================
   SECTION: MAP_CONSTANTS
   Константы.
   ============================================================ */

// Температуры (с учётом сезона), при которых выпадает снег и замерзает вода.
const SNOW_TEMPERATURE = 0.30;       // холоднее — на земле лежит снег
const ICE_TEMPERATURE = 0.16;        // холоднее — у берега замерзает вода
const RIVER_ICE_TEMPERATURE = 0.12;  // холоднее — замерзают реки

// С какой глубины (в клетках от берега) начинается следующий оттенок воды.
const WATER_DEPTH_STEPS = [1, 2, 3, 5, 8];
function waterShadeIndex(depth) {
    let index = 0;
    for (let k = 0; k < WATER_DEPTH_STEPS.length; k++) {
        if (depth >= WATER_DEPTH_STEPS[k]) index = k;
    }
    return index;
}

// Матрица упорядоченного дизеринга 4×4: даёт «пиксельный» градиент вместо плавного размытия.
const STEP_AMOUNTS = Int32Array.from([-30, -15, 0, 15, 28]); // ступени светотени холмов, в долях от 256
const BAYER = Float32Array.from([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], v => (v + 0.5) / 16);

/* ============================================================
   SECTION: MAP_HASH_NOISE
   Детерминированные «случайности»: не меняются при перерисовке.
   ============================================================ */
// Хеш с хорошим перемешиванием битов: простые формулы вида x*a ^ y*b дают заметные узоры (полосы, кирпичи).
function tileHash(x, y, k) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(k, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    h ^= h >>> 16;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 13;
    return h >>> 0;
}
const hashUnit = (x, y, k) => tileHash(x, y, k) / 4294967296;
const smoothstep = t => t * t * (3 - 2 * t);

// Плавный шум с ячейкой cell пикселей. Решётка и сглаженные позиции считаются один раз, потом шум берётся быстро.
class LatticeNoise {
    constructor(width, cell, salt) {
        const count = Math.ceil(width / cell) + 2;
        this.count = count;
        this.lattice = new Float32Array(count * count);
        for (let y = 0; y < count; y++) {
            for (let x = 0; x < count; x++) this.lattice[y * count + x] = hashUnit(x, y, salt);
        }
        this.index = new Int32Array(width);
        this.fraction = new Float32Array(width);
        for (let p = 0; p < width; p++) {
            const f = p / cell;
            const i = Math.floor(f);
            this.index[p] = i;
            this.fraction[p] = smoothstep(f - i);
        }
    }

    // Значение 0..1 в пикселе (gx, gy).
    at(gx, gy) {
        const { lattice, count } = this;
        const k = this.index[gy] * count + this.index[gx];
        const u = this.fraction[gx], v = this.fraction[gy];
        const top = lattice[k] + (lattice[k + 1] - lattice[k]) * u;
        const bottom = lattice[k + count] + (lattice[k + count + 1] - lattice[k + count]) * u;
        return top + (bottom - top) * v;
    }
}

/* ============================================================
   SECTION: MAP_SHADING
   Светотень холмов: считается один раз, потом только применяется.
   ============================================================ */
/* Светотень холмов не зависит от сезона, поэтому считается один раз: для каждого пикселя, который надо изменить,
   запоминаем индекс и «код» (ступень светотени + признак оврага). При каждой перерисовке остаётся только применить список.
   Горячий цикл вынесен в отдельную функцию с простыми аргументами: так движок JavaScript оптимизирует его
   лучше, чем кусок большого метода. Идём строка за строкой — память читается последовательно. */
function computeHillShading({ hills, waterMask, flags, tileOfColumn, width, tile, strength, ravineWidth, valleyNoise, capacity }) {
    const size = width / tile;
    const last = width * width - 1;
    const scale = strength * 1.6;
    const index = new Int32Array(capacity);
    const code = new Uint8Array(capacity);
    let count = 0;

    for (let gy = 0; gy < width; gy++) {
        const rowTiles = Math.floor(gy / tile) * size;
        const bayerRow = (gy & 3) * 4;

        for (let gx = 0; gx < width; gx++) {
            const flag = flags[rowTiles + tileOfColumn[gx]];
            if (flag === 0) continue;

            const k = gy * width + gx;
            if (waterMask[k] === 1) continue;

            const here = hills[k];
            const northWest = k > width + 1 ? hills[k - width - 1] : here;
            const southEast = k < last - width - 1 ? hills[k + width + 1] : here;     // > 0 — склон повёрнут к свету
            const threshold = BAYER[bayerRow + (gx & 3)];
            let step = Math.round(((southEast - northWest) * 0.06 + (here - 128) * 0.01) * scale + (threshold - 0.5) * 0.6);
            step = step < -2 ? -2 : step > 2 ? 2 : step;
            const ravine = flag === 3 && Math.abs(2 * valleyNoise.at(gx, gy) - 1) < ravineWidth;

            if (step !== 0 || ravine) {
                index[count] = k;
                code[count] = (step + 2) | (ravine ? 8 : 0);
                count++;
            }
        }
    }
    return { index: index.slice(0, count), code: code.slice(0, count) };   // по возрастанию номера пикселя (по строкам)
}


/* ============================================================
   SECTION: PIXEL_BUFFER
   Маленький пиксельный буфер для спрайтов (дома, мельницы, руды, эфир).
   ============================================================ */
/* Маленький пиксельный буфер для рисунков (дома, руды, эфир): прозрачный фон, рисование фигур, контур.
   Рисунок готовится один раз, а потом копируется на карту. */
class PixelBuffer {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.data = new Int32Array(width * height); // 0 — прозрачно
    }

    put(x, y, color) {
        if (x >= 0 && y >= 0 && x < this.width && y < this.height) this.data[y * this.width + x] = color;
    }

    rect(x, y, w, h, color) {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.put(xx, yy, color);
    }

    // Эллипс с объёмом: слева сверху светлее, справа снизу темнее.
    ellipse(cx, cy, rx, ry, base, light, dark) {
        for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
            for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
                const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
                if (nx * nx + ny * ny > 1) continue;
                const lean = nx + ny;
                this.put(x, y, lean < -0.45 ? light : lean > 0.5 ? dark : base);
            }
        }
    }

    // Контур вокруг силуэта: прозрачные пиксели, у которых есть закрашенный сосед.
    outline(color) {
        const { width, height, data } = this;
        const edge = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (data[y * width + x] !== 0) continue;
                const touches = (x > 0 && data[y * width + x - 1] !== 0) || (x < width - 1 && data[y * width + x + 1] !== 0)
                    || (y > 0 && data[(y - 1) * width + x] !== 0) || (y < height - 1 && data[(y + 1) * width + x] !== 0);
                if (touches) edge.push(y * width + x);
            }
        }
        for (const index of edge) data[index] = color;
    }
}

/* MapPaint — неймспейс painter'а: слои (MapPaint.Base, MapPaint.Rivers... — по файлу на слой) и общие помощники. В глобальной области остаются
   прежние имена (COLORS, packRgb, PixelBuffer, MapPainter...), всё новое живёт здесь. */
const MapPaint = {
    // Запас вокруг области рисования, в клетках (см. makeRegion). По тестам (tools/chunktest.js) хватает 3: на этих картах при 2 уже
    // появляются расхождения. Взято 4 — клетка про запас. Если добавите слой с большим радиусом (спрайты выше, тени длиннее) — прогоните
    // chunktest (в том числе FUZZ=20), он покажет, не мало ли.
    MARGIN_TILES: 4,

    // Билинейная выборка из сетки клеток: четыре клетки (слева/справа в строках rowTop и rowBottom), u, v — доли внутри.
    bilinear(grid, rowTop, rowBottom, left, right, u, v) {
        const a = grid[rowTop + left], b = grid[rowTop + right], c = grid[rowBottom + left], d = grid[rowBottom + right];
        const top = a + (b - a) * u;
        return top + (c + (d - c) * u - top) * v;
    },

    // Переставляет несколько параллельных массивов так, чтобы keys шёл по возрастанию (для запросов по строкам области).
    sortByKey(keys, ...arrays) {
        const order = Int32Array.from({ length: keys.length }, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
        return [keys, ...arrays].map(source => source.constructor.from(order, i => source[i]));
    },

    // Расстояние между двумя отрезками [x0, y0, x1, y1]: 0, если они пересекаются.
    segmentDistance(a, b) {
        const cross = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
        const sign = v => (v > 0) - (v < 0);
        const crosses = sign(cross(a[0], a[1], a[2], a[3], b[0], b[1])) * sign(cross(a[0], a[1], a[2], a[3], b[2], b[3])) < 0
            && sign(cross(b[0], b[1], b[2], b[3], a[0], a[1])) * sign(cross(b[0], b[1], b[2], b[3], a[2], a[3])) < 0;
        if (crosses) return 0;
        const toSegment = (px, py, s) => {
            const dx = s[2] - s[0], dy = s[3] - s[1];
            const t = Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / (dx * dx + dy * dy || 1)));
            return Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
        };
        return Math.min(toSegment(a[0], a[1], b), toSegment(a[2], a[3], b), toSegment(b[0], b[1], a), toSegment(b[2], b[3], a));
    },

    // Отпечаток содержимого байтового массива (две 32-битные свёртки): по нему кэши узнают, что маска не изменилась.
    fingerprint(bytes) {
        const words = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
        let h1 = 0x811c9dc5 | 0, h2 = 0x01000193 | 0;
        for (let i = 0; i < words.length; i++) {
            h1 = Math.imul(h1 ^ words[i], 0x01000193);
            h2 = Math.imul(h2 + words[i], 0x85ebca6b) ^ (h2 >>> 15);
        }
        for (let i = words.length * 4; i < bytes.length; i++) h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
        return h1 + ':' + h2;
    },

    DIRECTIONS_4: [[-1, 0], [1, 0], [0, -1], [0, 1]]   // влево, вправо, вверх, вниз
};

/* ============================================================
   Tools — инструменты рисования, общие для всех слоёв: размеры, области, пиксели, кэш, геометрия, спрайты

   MapPainter наследует их: слои зовут p.put(...), p.memo(...), p.eachInRegion(...) и т. п. Слой ничего не знает о других слоях,
   кроме того, что лежит в p (данные кадра: p.pixels, p.waterMask, p.riverMask, p.region, ...) и в MapPaint.<Слой>.
   ============================================================ */
MapPaint.Tools = class Tools {
    // «Пиксели для клетки 12×12» -> пиксели текущей клетки; px1 — то же, но не меньше пикселя.
    px(n) {
        return Math.round(n * this.tileSize / 12);
    }

    px1(n) {
        return Math.max(1, this.px(n));
    }

    forEachTile(callback) {
        const { size } = this.dim;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) callback(x, y);
        }
    }

    // То же, но только по клеткам области рисования (this.region): так слои рисуют прямоугольник, а не всю карту.
    forEachRegionTile(callback) {
        const r = this.region;
        for (let y = r.ty0; y < r.ty1; y++) {
            for (let x = r.tx0; x < r.tx1; x++) callback(x, y);
        }
    }

    /* ---------- Области ----------
       Область — прямоугольник, который рисуется за один раз: нужные клетки (inner) и запас вокруг них, чтобы края получились
       такими же, как при отрисовке всей карты (слои заглядывают на соседние клетки, спрайты заходят за границу клетки,
       горы «поднимаются» вверх). Запас рисуется тоже, но после отрисовки возвращается как был: он мог получиться неточным. */
    makeRegion(tiles) {
        const { size, T } = this.dim;
        const margin = MapPaint.MARGIN_TILES;
        const region = {
            tx0: Math.max(0, tiles.tx0 - margin), ty0: Math.max(0, tiles.ty0 - margin),
            tx1: Math.min(size, tiles.tx1 + margin), ty1: Math.min(size, tiles.ty1 + margin),
            inner: { ...tiles, x0: tiles.tx0 * T, y0: tiles.ty0 * T, x1: tiles.tx1 * T, y1: tiles.ty1 * T }
        };
        Object.assign(region, { x0: region.tx0 * T, y0: region.ty0 * T, x1: region.tx1 * T, y1: region.ty1 * T });
        return region;
    }

    // Пиксели запаса (область без inner): пиксели холста и маска спрайтов.
    saveRing(region) {
        const { W } = this.dim;
        const inner = region.inner;
        const ring = [];
        const save = (y, from, to) => {
            if (from >= to) return;
            const at = y * W + from, end = y * W + to;
            ring.push({ at, pixels: this.pixels.slice(at, end), sprites: this.spriteMask.slice(at, end) });
        };
        for (let y = region.y0; y < region.y1; y++) {
            if (y < inner.y0 || y >= inner.y1) save(y, region.x0, region.x1);
            else { save(y, region.x0, inner.x0); save(y, inner.x1, region.x1); }
        }
        return ring;
    }

    restoreRing(ring) {
        for (const { at, pixels, sprites } of ring) {
            this.pixels.set(pixels, at);
            this.spriteMask.set(sprites, at);
        }
    }

    /* Списки пикселей (берег, реки, дороги...) хранятся по возрастанию номера пикселя, то есть по строкам. Поэтому нужные
       области записи находятся двоичным поиском по строкам, а не просмотром всего списка. */
    eachInRegion(sorted, fn) {
        const { W } = this.dim;
        const r = this.region;
        const lowerBound = key => {
            let lo = 0, hi = sorted.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (sorted[mid] < key) lo = mid + 1; else hi = mid;
            }
            return lo;
        };
        const to = lowerBound(r.y1 * W);
        for (let n = lowerBound(r.y0 * W); n < to; n++) {
            const x = sorted[n] % W;
            if (x >= r.x0 && x < r.x1) fn(n);
        }
    }

    // Перед рисованием области маска спрайтов в ней очищается (спрайты нарисуются заново).
    clearRegion(region) {
        const { W } = this.dim;
        for (let y = region.y0; y < region.y1; y++) this.spriteMask.fill(0, y * W + region.x0, y * W + region.x1);
    }

    // Есть ли среди клетки (tx, ty) и её восьми соседей такая, для которой test(индекс клетки) истинно.
    anyAround(tx, ty, test) {
        const { size } = this.dim;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = tx + dx, ny = ty + dy;
                if (nx >= 0 && ny >= 0 && nx < size && ny < size && test(ny * size + nx)) return true;
            }
        }
        return false;
    }

    // Таблицы «строка/столбец пикселей -> клетка»: tileOf(k) тогда — два чтения и сложение вместо двух делений.
    buildTileTable() {
        const { size, T, W } = this.dim;
        const rowBase = new Int32Array(W), column = new Int32Array(W);
        for (let i = 0; i < W; i++) {
            rowBase[i] = Math.floor(i / T) * size;
            column[i] = Math.floor(i / T);
        }
        return { rowBase, column, W };
    }

    // Клетка, в которой лежит пиксель k.
    tileOf(k) {
        const { rowBase, column, W } = this.tileTable;
        const y = (k / W) | 0;
        return rowBase[y] + column[k - y * W];
    }

    // Температура клетки с учётом сезона: зимой холоднее, летом теплее.
    seasonalTemperature(i) {
        return this.map.temperature[i] + this.season.tempShift;
    }

    /* Кэш для вычислений, которые не зависят от сезона: build() вызывается заново, только если изменился хоть один из deps
       (сравниваются по ===: массивы карты, размеры, настройки). slot — имя кэша. */
    memo(slot, deps, build) {
        const cache = this.caches[slot];
        if (cache && cache.deps.every((dep, n) => dep === deps[n])) return cache.value;
        const value = build();
        this.caches[slot] = { deps, value };
        return value;
    }

    /* ---------- Пиксели ---------- */
    // Клетка в области рисования (вместе с запасом)?
    regionHasTile(tile) {
        const { size } = this.dim;
        const r = this.region, x = tile % size, y = (tile - x) / size;
        return x >= r.tx0 && x < r.tx1 && y >= r.ty0 && y < r.ty1;
    }

    // Рисовать можно только внутри области (this.region): так кусок карты не портит соседей. Вся карта — это область во весь холст.
    inRegionPixel(x, y) {
        const r = this.region;
        return x >= r.x0 && y >= r.y0 && x < r.x1 && y < r.y1;
    }

    // То же для номера пикселя.
    regionHas(k) {
        const { W } = this.dim;
        const y = (k / W) | 0;
        return this.inRegionPixel(k - y * W, y);
    }

    put(x, y, color) {
        if (this.inRegionPixel(x, y)) {
            const k = y * this.width + x;
            this.pixels[k] = color;
            if (this.cover) this.spriteMask[k] = 1;
        }
    }

    blend(x, y, color, alpha) {
        if (!this.inRegionPixel(x, y)) return;
        const k = y * this.width + x;
        this.pixels[k] = mixPacked(this.pixels[k], color, alpha);
    }

    rect(x, y, w, h, color) {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) this.put(xx, yy, color);
        }
    }

    // Пиксель земли: не рисуем поверх воды и реки.
    putGround(x, y, color) {
        if (!this.inRegionPixel(x, y)) return;
        const k = y * this.width + x;
        if (this.waterMask[k] || (this.riverMask && this.riverMask[k])) return;
        this.pixels[k] = color;
    }

    // Можно ли красить пиксель k «землёй» (дорога, двор): не вода, не река и не крутой склон горы.
    isFree(k) {
        const relief = this.reliefHeight;
        return !this.waterMask[k] && !(this.riverMask && this.riverMask[k]) && !(relief && relief[k] > 40);
    }

    /* ---------- Геометрия ---------- */
    // Пиксели отрезка (алгоритм Брезенхэма).
    linePoints(x0, y0, x1, y1) {
        const points = [];
        const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let error = dx + dy;
        for (;;) {
            points.push([x0, y0]);
            if (x0 === x1 && y0 === y1) break;
            const doubled = 2 * error;
            if (doubled >= dy) { error += dy; x0 += sx; }
            if (doubled <= dx) { error += dx; y0 += sy; }
        }
        return points;
    }

    // Слегка изогнутая линия между точками: середина отрезка уходит в сторону на bend (число или функция длины отрезка).
    curve(ax, ay, bx, by, bend) {
        const length = Math.hypot(bx - ax, by - ay) || 1;
        const offset = typeof bend === 'function' ? bend(length) : bend;
        const mx = (ax + bx) / 2 - ((by - ay) / length) * offset;
        const my = (ay + by) / 2 + ((bx - ax) / length) * offset;
        return [
            ...this.linePoints(Math.round(ax), Math.round(ay), Math.round(mx), Math.round(my)),
            ...this.linePoints(Math.round(mx), Math.round(my), Math.round(bx), Math.round(by))
        ];
    }

    // Центр клетки в пикселях, слегка сдвинутый хешем (saltX, saltY): так реки, дороги и мосты не идут по линейке.
    tileCenter(x, y, saltX, saltY, wobble) {
        const T = this.tileSize;
        return [x * T + T / 2 + (hashUnit(x, y, saltX) - 0.5) * wobble, y * T + T / 2 + (hashUnit(x, y, saltY) - 0.5) * wobble];
    }

    // Квадрат width×width вокруг (cx, cy): fn(k, x, y) для каждого пикселя, который можно красить (isFree).
    eachFreeInSquare(cx, cy, width, fn) {
        const W = this.width, half = width >> 1;
        for (let oy = 0; oy < width; oy++) {
            for (let ox = 0; ox < width; ox++) {
                const x = cx + ox - half, y = cy + oy - half;
                if (x < 0 || y < 0 || x >= W || y >= W) continue;
                const k = y * W + x;
                if (this.isFree(k)) fn(k, x, y);
            }
        }
    }

    /* Заливка слоями: пиксели из pending по очереди получают в target значение, за которое проголосовало большинство соседей
       (слева, справа, сверху, снизу; при равенстве — первое по порядку). vote(k, j) — значение, которое сосед j отдаёт пикселю k,
       или -1. За maxLayers шагов; возвращает пиксели, до которых заливка не дошла. */
    spreadMajority(pending, maxLayers, target, vote) {
        const W = this.width;
        for (let layer = 0; layer < maxLayers && pending.length > 0; layer++) {
            const taken = [];
            const rest = [];
            for (const k of pending) {
                const x = k % W;
                const a = x > 0 ? vote(k, k - 1) : -1;
                const b = x < W - 1 ? vote(k, k + 1) : -1;
                const c = k >= W ? vote(k, k - W) : -1;
                const d = k < W * (W - 1) ? vote(k, k + W) : -1;
                let best = -1, bestVotes = 0;
                for (const value of [a, b, c, d]) {
                    if (value < 0) continue;
                    const votes = (a === value) + (b === value) + (c === value) + (d === value);
                    if (votes > bestVotes) { best = value; bestVotes = votes; }
                }
                if (best >= 0) taken.push(k, best); else rest.push(k);
            }
            for (let n = 0; n < taken.length; n += 2) target[taken[n]] = taken[n + 1];
            pending = rest;
        }
        return pending;
    }

    /* Спрайт (маленький рисунок: дом, руда, эфир) с кэшем по ключу. draw(buffer) рисует в прозрачный буфер width×height и возвращает
       остальные поля спрайта (точка привязки anchorX/anchorY, окна...). Контур вокруг рисунка — по настройке spriteOutline. */
    sprite(key, width, height, outlineColor, draw) {
        const cache = this.spriteCache || (this.spriteCache = new Map());
        if (cache.has(key)) return cache.get(key);

        const buffer = new PixelBuffer(width, height);
        const extra = draw(buffer);
        if (this.options.spriteOutline) buffer.outline(outlineColor);
        const sprite = { buffer, width, height, ...extra };
        cache.set(key, sprite);
        return sprite;
    }

    // Рисунок из буфера на карту: прозрачные пиксели пропускаем.
    blitSprite(buffer, left, top) {
        for (let y = 0; y < buffer.height; y++) {
            for (let x = 0; x < buffer.width; x++) {
                const color = buffer.data[y * buffer.width + x];
                if (color !== 0) this.put(left + x, top + y, color);
            }
        }
    }

    // Прозрачный слой размером с карту: { pixels, commit() } — рисуем в pixels, commit() возвращает готовый холст.
    createLayer() {
        const W = this.width;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = W;
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(W, W);
        return { pixels: new Int32Array(image.data.buffer), commit() { ctx.putImageData(image, 0, 0); return canvas; } };
    }

    // Доля снега на земле: 0, 1/3, 2/3 или 1 («пиксельные» ступени).
    snowCoverage(i) {
        return Math.round(clamp((SNOW_TEMPERATURE - this.seasonalTemperature(i)) / 0.16) * 3) / 3;
    }

    // Приглушает цвет построек в тёмном стиле.
    moodize(color) {
        return this.mood === 'dark' ? shadePacked(mixPacked(color, packRgb(110, 110, 110), 0.25), -0.12) : color;
    }

    // Источник света: яркий цвет и мягкое свечение вокруг. Рисуется после цветокоррекции.
    drawLight(x, y, color, glowColor, glowRadius) {
        for (let dy = -glowRadius; dy <= glowRadius; dy++) {
            for (let dx = -glowRadius; dx <= glowRadius; dx++) {
                const distance = Math.hypot(dx, dy);
                if (distance <= glowRadius) this.blend(x + dx, y + dy, glowColor, 0.2 * (1 - distance / (glowRadius + 1)));
            }
        }
        this.put(x, y, color);
    }
};

/* ============================================================
   Chunks — какие части карты уже нарисованы в текущем кадре

   Карта делится на куски (по умолчанию 32×32 клетки). Кадр (begin) начинается с пустого: ничего не нарисовано.
   Дальше рендерер просит нарисовать то, что виднее всего (paint), а остальное дорисовывается в фоне по одному куску (paintNext),
   начиная с ближайших к центру экрана. Нарисованный кусок пиксель в пиксель такой же, как при полной отрисовке (см. paintRect).
   ============================================================ */
MapPaint.Chunks = class Chunks {
    constructor(painter, chunkTiles = 32) {
        this.painter = painter;
        this.chunkTiles = chunkTiles;
        this.build();
    }

    // Новый кадр: всё ещё не нарисовано.
    build() {
        const { size } = this.painter.map;
        this.cols = Math.ceil(size / this.chunkTiles);
        this.painted = new Uint8Array(this.cols * this.cols);
        this.left = this.painted.length;               // сколько кусков осталось нарисовать
    }

    get done() {
        return this.left === 0;
    }

    // Рисует то, чего ещё нет в прямоугольнике клеток tiles = { tx0, ty0, tx1, ty1 }: одним прямоугольником по границам ненарисованных
    // кусков (так запас вокруг области рисуется один раз, а не для каждого куска). true — что-то нарисовано.
    paint(tiles) {
        const { size } = this.painter.map;
        const n = this.chunkTiles;
        const cx0 = Math.max(0, Math.floor(tiles.tx0 / n)), cx1 = Math.min(this.cols, Math.ceil(tiles.tx1 / n));
        const cy0 = Math.max(0, Math.floor(tiles.ty0 / n)), cy1 = Math.min(this.cols, Math.ceil(tiles.ty1 / n));

        let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
        for (let cy = cy0; cy < cy1; cy++) {
            for (let cx = cx0; cx < cx1; cx++) {
                if (this.painted[cy * this.cols + cx]) continue;
                minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
                minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
            }
        }
        if (maxX < 0) return false;
        this.paintChunks(minX, minY, maxX + 1, maxY + 1, size);
        return true;
    }

    // Рисует один ненарисованный кусок, ближайший к клетке near = { tx, ty }. false — рисовать больше нечего.
    paintNext(near) {
        if (this.done) return false;
        const n = this.chunkTiles;
        let best = -1, bestDistance = Infinity;
        for (let cy = 0; cy < this.cols; cy++) {
            for (let cx = 0; cx < this.cols; cx++) {
                if (this.painted[cy * this.cols + cx]) continue;
                const distance = Math.hypot((cx + 0.5) * n - near.tx, (cy + 0.5) * n - near.ty);
                if (distance < bestDistance) { bestDistance = distance; best = [cx, cy]; }
            }
        }
        this.paintChunks(best[0], best[1], best[0] + 1, best[1] + 1, this.painter.map.size);
        return true;
    }

    paintChunks(cx0, cy0, cx1, cy1, size) {
        const n = this.chunkTiles;
        this.painter.paintRect({ tx0: cx0 * n, ty0: cy0 * n, tx1: Math.min(size, cx1 * n), ty1: Math.min(size, cy1 * n) });
        for (let cy = cy0; cy < cy1; cy++) {
            for (let cx = cx0; cx < cx1; cx++) {
                if (!this.painted[cy * this.cols + cx]) { this.painted[cy * this.cols + cx] = 1; this.left--; }
            }
        }
    }
};

/* ============================================================
   Base — фон: цвет каждой клетки и плавные переходы между клетками

   Цвет клетки — по биому, воде, снегу и льду (сезон меняет палитру и снег). Соседние клетки смешиваются дизерингом: какой из четырёх
   цветов получит пиксель, зависит только от его места в клетке и узора, поэтому это считается заранее (blendGrid).
   Попутно фон рисует «сырую» маску воды: по ней строятся берега, реки и сглаживание берега (см. build).
   ============================================================ */
{
    MapPaint.Base = {
        defaults: {
            blendSharpness: 1.5,  // насколько резко смешиваются соседние биомы (больше — резче, 1 — очень мягко)
            coastSharpness: 1.5  // то же для границы воды и суши — а также для берегов (песок, галька) и краёв рек
        },

        enabled: () => true,

        // Готовит то, что нужно всем слоям: таблицы смешивания и маску воды (она не зависит ни от сезона, ни от места на карте).
        build(p) {
            this.buildAxisTables(p);
            const water = this.water(p);
            p.waterMask = water.mask;                      // маска воды после сглаживания берега
            p.baseWater = water.base;                      // «сырая» маска: её пишет фон
            p.waterKey = water.key;                        // по нему кэши форм (берега и др.) узнают, что вода не изменилась
        },

        /* Сглаживание.
           Считаем, что цвет клетки «живёт» в её центре. Любой пиксель лежит внутри квадрата, углы которого — центры
           четырёх ближайших клеток (A B / C D). Вес каждой клетки — как при билинейной интерполяции, но вместо
           смешивания цветов мы выбираем один из четырёх с помощью дизеринга. Получается пиксельный градиент:
           у выпуклого угла («ступеньки») пиксели плавно уходят в цвет соседей, а внутри однотонных областей ничего не меняется. */
        paint(p) {
            const { size, T, W } = p.dim;
            const pixels = p.pixels;
            const { colors, water } = this.buildTileColors(p);
            const smooth = p.view !== 'regions'; // в режиме регионов границы должны быть точными
            const quadOf = this.blendGrid(p).quadOf;

            const quadColors = new Int32Array(16);
            const quadWater = new Uint8Array(16);
            const waterMask = p.baseWater;               // «сырая» маска воды: до сглаживания берега
            const quadSharpness = new Uint8Array(4);
            const clampTile = v => (v < 0 ? 0 : v >= size ? size - 1 : v);

            p.forEachRegionTile((tx, ty) => {
                // Быстрый путь: клетка и все её соседи одного цвета — заливаем целиком.
                const color = colors[ty * size + tx];
                if (!p.anyAround(tx, ty, j => colors[j] !== color)) {
                    for (let oy = 0; oy < T; oy++) {
                        const start = (ty * T + oy) * W + tx * T;
                        pixels.fill(color, start, start + T);
                        waterMask.fill(water[ty * size + tx], start, start + T);
                    }
                    return;
                }

                // Клетка делится на 4 квадранта; у каждого свои четыре ближайшие клетки (A B / C D).
                for (let q = 0; q < 4; q++) {
                    const x0 = clampTile(tx + (q & 1) - 1), x1 = clampTile(tx + (q & 1));
                    const y0 = clampTile(ty + (q >> 1) - 1), y1 = clampTile(ty + (q >> 1));
                    const a = y0 * size + x0, b = y0 * size + x1, c = y1 * size + x0, d = y1 * size + x1;
                    quadColors[q * 4] = colors[a];
                    quadColors[q * 4 + 1] = colors[b];
                    quadColors[q * 4 + 2] = colors[c];
                    quadColors[q * 4 + 3] = colors[d];
                    quadWater[q * 4] = water[a];
                    quadWater[q * 4 + 1] = water[b];
                    quadWater[q * 4 + 2] = water[c];
                    quadWater[q * 4 + 3] = water[d];

                    // Берег (вода рядом с сушей) смешиваем резче, чем биомы между собой.
                    const waterCount = water[a] + water[b] + water[c] + water[d];
                    quadSharpness[q] = !smooth ? 2 : (waterCount > 0 && waterCount < 4 ? 1 : 0);
                }

                const choices = this.blendChoices(p, tx, ty);
                for (let oy = 0; oy < T; oy++) {
                    const row = (ty * T + oy) * W + tx * T;
                    for (let ox = 0; ox < T; ox++) {
                        const pos = oy * T + ox;
                        const q = quadOf[pos];
                        const choice = q * 4 + choices[quadSharpness[q]][pos];
                        pixels[row + ox] = quadColors[choice];
                        waterMask[row + ox] = quadWater[choice];
                    }
                }
            });
        },

        // Маска воды всей карты (и её отпечаток). Не зависит от сезона и места, поэтому считается один раз на карту и вид:
        // это тот же фон, что рисуется потом по областям, только нам нужна именно маска.
        water(p) {
            const { map, options } = p;
            const key = [p.view, p.tileSize, options.coastSmoothing, options.blendSharpness, options.coastSharpness, p.seedSalt].join('|');
            return p.memo('water', [map.terrain, key], () => {
                const { size, W } = p.dim;
                const base = new Uint8Array(W * W);             // то, что нарисовал фон
                p.baseWater = base;
                p.region = p.makeRegion({ tx0: 0, ty0: 0, tx1: size, ty1: size });
                this.paint(p);
                p.region = null;
                p.waterMask = base;
                const shape = MapPaint.Coast.shapeOf(p);               // берег сглаживается: вода и суша «округляются»
                const mask = shape ? shape.mask : base;
                return { mask, base, key: MapPaint.fingerprint(mask) };
            });
        },

        /* Какой из четырёх цветов (A, B, C или D) получит пиксель, зависит только от его положения в клетке и
           от узора дизеринга, а не от самих цветов. Поэтому это считается заранее — по одной таблице на каждую
           «резкость» смешивания и каждый вариант сдвига узора (узор повторяется каждые 4 пикселя). */
        blendGrid(p) {
            return p.memo('blendGrid', [p.tileSize], () => {
                const T = p.tileSize;
                const quadOf = new Uint8Array(T * T);   // квадрант пикселя внутри клетки: 0..3
                const u = new Float32Array(T * T);
                const v = new Float32Array(T * T);
                for (let oy = 0; oy < T; oy++) {
                    for (let ox = 0; ox < T; ox++) {
                        const px = (ox + 0.5) / T - 0.5, py = (oy + 0.5) / T - 0.5;
                        const pos = oy * T + ox;
                        quadOf[pos] = (Math.floor(px) + 1) + 2 * (Math.floor(py) + 1);
                        u[pos] = px - Math.floor(px);
                        v[pos] = py - Math.floor(py);
                    }
                }
                return { quadOf, u, v, cache: {} };
            });
        },

        // Три таблицы выбора (мягкая, береговая, «ближайший сосед») для клетки с данным сдвигом узора дизеринга.
        blendChoices(p, tx, ty) {
            const { T } = p.dim;
            const grid = this.blendGrid(p);
            const offX = (tx * T) & 3, offY = (ty * T) & 3;
            const key = offX + 4 * offY;
            if (grid.cache[key]) return grid.cache[key];

            const sharpness = [p.options.blendSharpness, p.options.coastSharpness];
            const tables = [new Uint8Array(T * T), new Uint8Array(T * T), new Uint8Array(T * T)];
            for (let oy = 0; oy < T; oy++) {
                for (let ox = 0; ox < T; ox++) {
                    const pos = oy * T + ox;
                    const u = grid.u[pos], v = grid.v[pos];
                    const threshold = BAYER[((oy + offY) & 3) * 4 + ((ox + offX) & 3)];

                    for (let s = 0; s < 2; s++) {
                        const uu = clamp((u - 0.5) * sharpness[s] + 0.5);
                        const vv = clamp((v - 0.5) * sharpness[s] + 0.5);
                        const weightA = (1 - uu) * (1 - vv);
                        const weightB = uu * (1 - vv);
                        const weightC = (1 - uu) * vv;
                        tables[s][pos] = threshold < weightA ? 0 : threshold < weightA + weightB ? 1 : threshold < weightA + weightB + weightC ? 2 : 3;
                    }
                    tables[2][pos] = u < 0.5 ? (v < 0.5 ? 0 : 2) : (v < 0.5 ? 1 : 3);
                }
            }
            grid.cache[key] = tables;
            return tables;
        },

        // Для каждого пикселя по одной оси: между центрами каких клеток он лежит и на каком расстоянии от первого.
        buildAxisTables(p) {
            const { size, W } = p.dim;
            const first = new Int32Array(W);
            const second = new Int32Array(W);
            const fraction = new Float32Array(W);
            const smooth = new Float32Array(W);
            for (let x = 0; x < W; x++) {
                const position = (x + 0.5) / p.tileSize - 0.5; // в «клетках»; центр клетки — целое число
                const index = Math.floor(position);
                first[x] = clamp(index, 0, size - 1);
                second[x] = clamp(index + 1, 0, size - 1);
                fraction[x] = position - index;
                smooth[x] = smoothstep(position - index);
            }
            p.axis = { first, second, fraction, smooth };
        },

        // Цвет каждой клетки и признак «вода».
        buildTileColors(p) {
            const count = p.map.size * p.map.size;
            const colors = new Int32Array(count);
            const water = new Uint8Array(count);
            for (let i = 0; i < count; i++) {
                colors[i] = this.tileColor(p, i);
                water[i] = p.map.isLand(i) && !this.isRiverTileInRegionsView(p, i) ? 0 : 1;
            }
            return { colors, water };
        },

        // В режиме регионов реки не рисуются, но клетки рек в регионы не входят (regionId = -1): показываем их как воду.
        isRiverTileInRegionsView(p, i) {
            return p.view === 'regions' && p.map.regionId[i] < 0;
        },

        tileColor(p, i) {
            const map = p.map;
            const terrain = map.terrain[i];
            const isWater = terrain < Terrain.PLAIN;

            if (p.view === 'temperature') {
                const hue = 215 - 215 * map.temperature[i]; // синий (холод) -> красный (жара)
                return hslToPacked(hue, 60, isWater ? 36 : 52);
            }
            if (isWater || this.isRiverTileInRegionsView(p, i)) return this.waterColor(p, i);
            if (p.view === 'regions') return hslToPacked((map.regionId[i] * 137.5) % 360, 45, 58); // «золотой угол»: соседи разного цвета
            if (terrain === Terrain.MOUNTAIN) return p.packed.rock; // под рельефом — камень
            return this.groundColor(p, i);
        },

        // Вода темнее по мере удаления от берега — и в океане, и в озёрах. В холод у берега появляется лёд.
        waterColor(p, i) {
            const depth = p.map.waterDepth[i];
            const temperature = p.seasonalTemperature(i);

            if (p.view === 'terrain' && temperature < ICE_TEMPERATURE) {
                const freezeDepth = Math.round((ICE_TEMPERATURE - temperature) / ICE_TEMPERATURE * 10); // чем холоднее, тем дальше от берега лёд
                if (depth > 0 && depth <= freezeDepth) return p.packed.ice[depth <= 3 ? 0 : depth <= 6 ? 1 : 2];
            }
            return p.packed.waterShades[waterShadeIndex(depth)];
        },

        // Цвет земли: цвет биома в этом сезоне, с поправкой на плодородие, а в холод — с примесью снега.
        groundColor(p, i) {
            const base = p.packed.biome[p.map.biome[i]];
            if (p.view !== 'terrain') return base;

            const tinted = this.fertilityTint(p, i, base);
            const coverage = p.snowCoverage(i);
            return coverage > 0 ? mixPacked(tinted, p.packed.snow, 0.9 * coverage) : tinted;
        },

        // Клетка рядом с рекой (считается один раз на карту).
        nearRiver(p, i) {
            const map = p.map;
            const near = p.memo('nearRiver', [map.river], () => {
                const flags = new Uint8Array(map.river.length);
                for (let k = 0; k < flags.length; k++) {
                    if (map.river[k] > 0) for (const j of map.neighbors8(k)) flags[j] = 1;
                }
                return flags;
            });
            return near[i];
        },

        // Внутри одного биома цвет зависит от плодородия: влажные места гуще и темнее, сухие светлее и желтее.
        fertilityTint(p, i, color) {
            const biome = p.map.biome[i];
            if (biome === Biome.TUNDRA || biome === Biome.DESERT) return color;

            const wet = this.nearRiver(p, i) ? 0.3 : 0;                    // у воды земля влажнее и зеленее
            const moisture = Math.round(Math.min(1, p.map.moisture[i] + wet) * 5) / 5; // 6 ступеней: меньше «грязи» на стыках клеток
            return moisture > 0.5
                ? shadePacked(color, -0.16 * (moisture - 0.5) / 0.5)
                : mixPacked(color, p.colors.hay, 0.32 * (0.5 - moisture) / 0.5);
        }
    };
}

/* ============================================================
   Coast — сглаживание берега

   Береговая линия из квадратных клеток и дизеринга — ступенчатая и «зашумлённая». Мажоритарный фильтр по маске воды (каждый пиксель
   становится водой или сушей — как большинство пикселей в окне радиуса coastSmoothing) убирает ступеньки и скругляет углы.
   Форма берега от сезона не зависит: считается один раз (shapeOf), потом только копируются цвета.
   ============================================================ */
{
    MapPaint.Coast = {
        defaults: {
            coastSmoothing: 7  // радиус (в пикселях) сглаживания берега: больше — круглее; 0 — не сглаживать
        },

        enabled: () => true,

        build(p) {
            this.shapeOf(p);
        },

        // Пиксели, «перешедшие» с воды на сушу и обратно, берут цвет ближайшего пикселя нужного вида.
        paint(p) {
            const shape = this.shapeOf(p);
            if (!shape) return;
            const { changed, sources } = shape;
            p.eachInRegion(changed, n => { p.pixels[changed[n]] = p.pixels[sources[n]]; });
        },

        /* Скругление берега. Береговая линия из квадратных клеток и дизеринга — ступенчатая и «зашумлённая». Мажоритарный
           фильтр по маске воды (каждый пиксель становится водой или сушей — как большинство пикселей в окне радиуса
           coastSmoothing) убирает ступеньки и скругляет углы; чем больше радиус, тем круглее берег. 0 — выключить.
           Форма берега от сезона не зависит: считается один раз (coastShape), потом только маска воды и копирование цветов. */
        shapeOf(p) {
            const { map, options } = p;
            const radius = options.coastSmoothing;
            if (!radius) return null;
            const key = [p.tileSize, radius, options.blendSharpness, options.coastSharpness, p.seedSalt].join('|');
            return p.memo('coast', [map.terrain, key], () => this.coastShape(p, radius));
        },

        // Новая маска воды и список пикселей, которые «перешли» с воды на сушу или обратно (и с какого пикселя взять их цвет).
        coastShape(p, radius) {
            const map = p.map;
            const { size, T, W } = p.dim;
            const water = p.waterMask;
            const next = Uint8Array.from(water);
            const changed = [];
            const sources = [];

            const coastTiles = [];                          // клетки, рядом с которыми есть и вода, и суша
            p.forEachTile((tx, ty) => {
                if (p.anyAround(tx, ty, j => map.isLand(j)) && p.anyAround(tx, ty, j => !map.isLand(j))) coastTiles.push(ty * size + tx);
            });

            // 1) новая маска: сумма по окну считается через префиксные суммы на кусочке карты вокруг клетки
            const span = T + 2 * radius;
            const stride = span + 1;
            const prefix = new Int32Array(stride * stride);
            const window = 2 * radius + 1;
            const total = window * window;
            for (const tile of coastTiles) {
                const tx = tile % size, ty = Math.floor(tile / size);
                const x0 = tx * T - radius, y0 = ty * T - radius;
                for (let yy = 0; yy < span; yy++) {
                    let row = 0;
                    const gy = Math.min(W - 1, Math.max(0, y0 + yy));
                    for (let xx = 0; xx < span; xx++) {
                        row += water[gy * W + Math.min(W - 1, Math.max(0, x0 + xx))];
                        prefix[(yy + 1) * stride + xx + 1] = prefix[yy * stride + xx + 1] + row;
                    }
                }
                for (let py = 0; py < T; py++) {
                    for (let px = 0; px < T; px++) {
                        const count = prefix[(py + window) * stride + px + window] - prefix[py * stride + px + window]
                            - prefix[(py + window) * stride + px] + prefix[py * stride + px];
                        const k = (ty * T + py) * W + tx * T + px;
                        next[k] = count * 2 > total ? 1 : count * 2 < total ? 0 : water[k];
                    }
                }
            }

            // 2) изменившиеся пиксели берут цвет ближайшего неизменившегося пикселя нужного вида (вода / суша)
            for (const tile of coastTiles) {
                const tx = tile % size, ty = Math.floor(tile / size);
                for (let py = 0; py < T; py++) {
                    for (let px = 0; px < T; px++) {
                        const gx = tx * T + px, gy = ty * T + py;
                        const k = gy * W + gx;
                        if (next[k] === water[k]) continue;
                        search:
                        for (let d = 1; d <= radius + 3; d++) {
                            for (let dy = -d; dy <= d; dy++) {
                                for (let dx = -d; dx <= d; dx++) {
                                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
                                    const sx = gx + dx, sy = gy + dy;
                                    if (sx < 0 || sy < 0 || sx >= W || sy >= W) continue;
                                    const s = sy * W + sx;
                                    if (water[s] === next[k] && next[s] === next[k]) {
                                        changed.push(k);
                                        sources.push(s);
                                        break search;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            const [sortedChanged, sortedSources] = MapPaint.sortByKey(Int32Array.from(changed), Int32Array.from(sources));   // по строкам: см. eachInRegion
        return { mask: next, changed: sortedChanged, sources: sortedSources };
        }
    };
}

/* ============================================================
   Mountains — горы: карта высот, светотень, подъём «вверх»

   Горы рисуются строка за строкой вместе с декорациями (см. Scene): пиксель горы «поднимается» вверх на высоту рельефа, а под ним
   закрашивается склон. Состояние столбца тянется вдоль непрерывной цепочки горных пикселей, поэтому у области (paintRect) проход
   начинается с той строки, где цепочки её столбцов обрываются (reliefStart).
   ============================================================ */
{
    const { bilinear } = MapPaint;

    MapPaint.Mountains = {
        defaults: {
            peakSharpness: 0.85,    // 0..1: острота гор (0 — округлые холмы-«губка», 1 — острые пики и гребни)
            mountainLift: 14,       // на сколько пикселей (для клетки 12×12) самые высокие горы поднимаются вверх, к северу
            mountainDetail: 0.3,    // 0..1: мелкие грани и отроги на горах (0 — крупные чистые плоскости, 1 — много мелкого шума)
            mountainRagged: 0.34,   // 0..1: рваность кромки гор у подножия (0 — ровный край по клеткам, больше — «осыпь» и зубцы)
            mountainLight: 'left'  // откуда падает свет на горы: 'left' (как у деревьев и холмов) или 'right' (как на референсе)
        },

        enabled: p => p.view === 'terrain' && p.layers.relief,

        // Карта высот гор (p.relief) и высота рельефа по пикселям (p.reliefHeight): по ней дороги и дворы обходят крутые склоны.
        build(p) {
            p.relief = this.heights(p);
            p.reliefHeight = p.relief.height;
        },

        // Карта высот гор по пикселям. От сезона не зависит, поэтому кэшируется.
        //
        // Как у настоящих гор на спутниковых снимках: огибающая (высота клеток из генератора) умножается на «складчатый»
        // рельеф — несколько масштабов гребней (|шум − ½|), где мелкие гребни вырастают только на крупных (мультифрактал).
        // Получаются ветвящиеся хребты и долины, а искажение координат (warp) делает их извилистыми, а не «ячеистыми».
        heights(p) {
            const map = p.map;
            const sharp = clamp(p.options.peakSharpness);
            const detail = clamp(p.options.mountainDetail);
            const ragged = clamp(p.options.mountainRagged);
            return p.memo('relief', [map.mountainHeight, p.tileSize, sharp, detail, ragged], () => this.computeRelief(p, sharp, detail, ragged));
        },

        computeRelief(p, sharp, detail, ragged) {
            const { size, T, W } = p.dim;
            const blurred = this.blurMountainHeights(p);
            const footprint = this.mountainFootprint(p);                 // 1 — клетка горы, 0 — всё остальное
            const zone = this.tilesNearRelief(p, footprint);
            const height = new Uint8Array(W * W);
            const { first, second, fraction } = p.axis;
            const edgeNoise = new LatticeNoise(W, Math.max(3, p.px(7)), 540 + p.seedSalt);

            const cells = [44, 22, 11, 5.5].map(cell => Math.max(3, p.px(cell)));      // размеры гребней: от крупных хребтов до мелких отрогов
            const octaves = cells.map((cell, k) => new LatticeNoise(W, cell, 503 + k + p.seedSalt));
            const warp = new LatticeNoise(W, Math.max(6, p.px(52)), 520 + p.seedSalt);
            const warpDistance = p.px(26);
            const power = 1 + 1.4 * sharp;                                                  // чем больше, тем уже и острее гребни
            const powerTable = Float32Array.from({ length: 256 }, (_, n) => Math.pow(n / 255, power));   // x^power без Math.pow в цикле

            for (const tile of zone) {
                const tx = tile % size, ty = Math.floor(tile / size);
                for (let gy = ty * T; gy < (ty + 1) * T; gy++) {
                    const rowTop = first[gy] * size, rowBottom = second[gy] * size, v = fraction[gy];
                    for (let gx = tx * T; gx < (tx + 1) * T; gx++) {
                        const u = fraction[gx];
                        const base = bilinear(blurred, rowTop, rowBottom, first[gx], second[gx], u, v);
                        if (base < 0.01) continue;

                        // Кромка: гора не выходит за свои клетки. Покрытие footprint (1 в горе, 0 вне; 0.5 ровно на границе клеток)
                        // интерполируется до пикселя — углы получаются скруглёнными, а шум делает край рваным.
                        const coverage = bilinear(footprint, rowTop, rowBottom, first[gx], second[gx], u, v);
                        const jitter = ((edgeNoise.at(gx, gy) - 0.5) * 0.8 + (hashUnit(gx, gy, 541) - 0.5) * 0.35) * ragged;
                        const inside = coverage + jitter - 0.5;
                        if (inside <= 0) continue;
                        const envelope = 0.45 + 0.55 * clamp(inside / 0.3);            // у самой кромки гора ниже

                        const shift = Math.round((warp.at(gx, gy) - 0.5) * warpDistance);
                        const wx = Math.min(W - 1, Math.max(0, gx + shift));
                        const wy = Math.min(W - 1, Math.max(0, gy - shift));

                        let sum = 0, norm = 0, amplitude = 1, gate = 1;
                        for (let o = 0; o < 4; o++) {
                            const ridge = powerTable[Math.round((1 - Math.abs(2 * octaves[o].at(wx, wy) - 1)) * 255)];
                            sum += ridge * amplitude * gate;
                            norm += amplitude;
                            gate = Math.min(1, ridge * 2.2);                                // мелкие гребни растут только на крупных
                            amplitude *= 0.3 + 0.35 * detail;
                        }
                        const h = base * (0.28 + 0.95 * (sum / norm)) * envelope;
                        height[gy * W + gx] = Math.round(clamp(h) * 255);
                    }
                }
            }

            // Для подъёма гор «вверх» берём сглаженную высоту: если поднимать каждый пиксель по его резкой высоте, на склонах
            // появляются вертикальные полосы. Освещение же считается по резкой карте — детали остаются.
            const smooth = this.blurHeights(p, height, zone, Math.max(2, p.px(5)));

            return { zone, height, smooth };
        },

        // Размытие карты высот (по строкам, потом по столбцам) только в клетках, где есть горы.
        blurHeights(p, height, zone, radius) {
            const { size, T, W } = p.dim;
            const window = 2 * radius + 1;
            const pass = (source, vertical) => {
                const result = new Uint8Array(W * W);
                for (const tile of zone) {
                    const x0 = (tile % size) * T, y0 = Math.floor(tile / size) * T;
                    for (let y = y0; y < y0 + T; y++) {
                        for (let x = x0; x < x0 + T; x++) {
                            let sum = 0;
                            for (let d = -radius; d <= radius; d++) {
                                const q = (vertical ? y : x) + d;
                                if (q >= 0 && q < W) sum += source[vertical ? q * W + x : y * W + q];
                            }
                            result[y * W + x] = Math.round(sum / window);
                        }
                    }
                }
                return result;
            };
            return pass(pass(height, false), true);
        },

        /* Цвет гор считается по трём вещам: высота (низ — луг, выше — тёмный лес, на самом верху — камень), крутизна
           (крутые склоны голые, пологие — в лесу) и освещённость (свет слева сверху). Снег лежит выше снеговой линии.
           Оттенки квантуются и смешиваются дизерингом — пиксельная графика, но без «ступенек» из 5 серых цветов. */
        prepareReliefRows(p) {
            if (!p.relief) return null;
            const { zone, height, smooth } = p.relief;
            if (zone.length === 0) return null;

            const { size, W } = p.dim;
            const rows = Array.from({ length: size }, () => []);
            for (const tile of zone) rows[Math.floor(tile / size)].push(tile % size);

            const packed = p.packed;
            const ramp = Int32Array.from(MOUNTAIN_RAMP, hex => mixPacked(hexToPacked(hex), packed.rock, 0.12));
            const snowLevels = new Float32Array(size * size);
            for (const tile of zone) snowLevels[tile] = this.snowLevel(p, tile);
            const snow = packed.snow, snowShade = packed.snowShade;

            return {
                rows, height, smooth, snowLevels, ramp,
                snowRamp: Int32Array.from([mixPacked(snowShade, ramp[2], 0.35), snowShade, mixPacked(snow, snowShade, 0.5), snow, snow]),
                scree: ramp[3],
                lightSign: p.options.mountainLight === 'right' ? -1 : 1,
                lift: p.px(p.options.mountainLift),
                proj: new Int32Array(W),                     // для каждого столбца: куда на экране попал предыдущий пиксель
                face: new Int32Array(W),                     // и каким цветом закрасить «склон» под ним
                valid: new Uint8Array(W)
            };
        },

        /* С какой строки начинать проход гор, чтобы область получилась такой же, как при проходе с самого верха карты.
           Горы рисуются строка за строкой, и состояние каждого столбца (куда попал предыдущий пиксель, каким цветом закрасить
           склон под ним) тянется вдоль непрерывной цепочки горных пикселей и обрывается пикселем земли. Поднимаемся вверх от
           области, пока цепочки всех её столбцов не оборвутся (у столбца без гор выше цепочки нет). */
        reliefStart(p, relief) {
            const { T, W } = p.dim;
            const r = p.region;
            const { height } = relief;
            const open = new Uint8Array(r.x1 - r.x0).fill(1);        // столбцы, у которых цепочка ещё не оборвалась
            let left = open.length;
            let start = r.y0;
            for (let gy = r.y0 - 1; gy >= 0 && left > 0; gy--) {
                start = gy;
                for (const tx of relief.rows[Math.floor(gy / T)]) {
                    if (tx < r.tx0 || tx >= r.tx1) continue;
                    for (let gx = tx * T; gx < (tx + 1) * T; gx++) {
                        if (open[gx - r.x0] && !this.reliefHasColor(p, height, gx, gy, W)) { open[gx - r.x0] = 0; left--; }
                    }
                }
            }
            return start;
        },

        // Окрашивает ли проход гор этот пиксель (иначе здесь земля и цепочка столбца обрывается): то же условие, что в paintReliefRow.
        reliefHasColor(p, height, gx, gy, W) {
            const raw = height[gy * W + gx];
            return raw >= 41 || (raw >= 13 && BAYER[(gy & 3) * 4 + (gx & 3)] < (raw / 255 - 0.05) / 0.11);
        },

        // Одна строка карты высот -> экран. Горы поднимаются вверх на lift * высота; пустоты между строками
        // (южные склоны) закрашиваются цветом склона.
        paintRow(p, relief, gy) {
            const { T, W, size } = p.dim;
            const ty = Math.floor(gy / T);
            const { height, smooth, snowLevels, snowRamp, ramp, scree, lightSign, lift, proj, face, valid } = relief;
            const pixels = p.pixels;
            const last = W * W - 1;

            const r = p.region;
            for (const tx of relief.rows[ty]) {
                if (tx < r.tx0 || tx >= r.tx1) continue;              // столбцы друг от друга не зависят: берём только клетки области
                const snowLevel = snowLevels[ty * size + tx];

                for (let gx = tx * T; gx < (tx + 1) * T; gx++) {
                    const k = gy * W + gx;
                    const raw = height[k];
                    const h = raw / 255;
                    const threshold = BAYER[(gy & 3) * 4 + (gx & 3)];
                    let color = 0;
                    let faceColor = 0;

                    if (raw >= 41) {
                        // Наклон по высоте на базе в 2 пикселя (так грани крупнее и чище, чем при 1 пикселе). При свете слева
                        // освещён склон, поднимающийся к юго-востоку (смотрит на северо-запад).
                        const lo = gx >= 2 ? 2 : 0, hi = gx < W - 2 ? 2 : 0;
                        const east = height[k + hi], west = height[k - lo];
                        const south = k + 2 * W <= last ? height[k + 2 * W] : raw, north = k >= 2 * W ? height[k - 2 * W] : raw;
                        const light = (lightSign * (east - west) + (south - north)) / 60;

                        // Ступень светотени -> цвет скал; на стыках ступеней мелкий упорядоченный дизеринг даёт «полосатые» грани.
                        const tone = 2.9 + light * 3.2 + (h - 0.45) * 1.8;
                        const shade = clamp(Math.round(tone + (threshold - 0.5) * 0.6), 0, 5);

                        // Южный склон (его закрашивают столбцами под пикселем) берёт тень по размытой высоте — цвет плавный, без полос.
                        const smoothLight = (lightSign * (smooth[k + hi] - smooth[k - lo]) + (k + 2 * W <= last ? smooth[k + 2 * W] : smooth[k]) - (k >= 2 * W ? smooth[k - 2 * W] : smooth[k])) / 30;
                        const faceShade = clamp(Math.round(1.7 + smoothLight * 3.5 + (h - 0.45)), 0, 3);

                        if (h + (threshold - 0.5) * 0.08 > snowLevel) {
                            const snowTone = clamp(Math.round(2.2 + light * 3 + (threshold - 0.5)), 0, 4);
                            color = snowRamp[snowTone];
                            faceColor = snowRamp[1];
                        } else {
                            color = ramp[shade];
                            faceColor = mixPacked(ramp[clamp(Math.round(tone), 0, 5)], ramp[faceShade], 0.3);
                        }
                    } else if (raw >= 13 && threshold < (h - 0.05) / 0.11) {   // подножие: редкая осыпь на земле
                        color = faceColor = mixPacked(pixels[k], scree, 0.85);
                    }

                    if (color === 0) {                  // здесь земля: закрываем склон, оставшийся над ней
                        if (valid[gx]) {
                            this.fillColumn(p, gx, proj[gx] + 1, gy - 1, face[gx]);
                            valid[gx] = 0;
                        }
                        continue;
                    }

                    const lifted = gy - Math.round(smooth[k] / 255 * lift);
                    if (valid[gx] && lifted - proj[gx] > 1) this.fillColumn(p, gx, proj[gx] + 1, lifted - 1, faceColor);
                    if (lifted >= r.y0) pixels[lifted * W + gx] = color;          // выше области не рисуем: это чужая территория
                    proj[gx] = lifted;
                    face[gx] = faceColor;
                    valid[gx] = 1;
                }
            }
        },

        fillColumn(p, gx, fromY, toY, color) {
            const { W } = p.dim;
            for (let y = Math.max(p.region.y0, fromY); y <= toY; y++) p.pixels[y * W + gx] = color;
        },

        // Высоты клеток, дважды размытые по соседям: горы «набухают» за пределы своих клеток, а разброс высот
        // от клетки к клетке сглаживается (иначе на массиве проступает сетка).
        blurMountainHeights(p) {
            const { size } = p.dim;
            const pass = source => {
                const out = new Float32Array(size * size);
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        let sum = 0;
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                const nx = x + dx, ny = y + dy;
                                if (nx >= 0 && ny >= 0 && nx < size && ny < size) sum += source[ny * size + nx];
                            }
                        }
                        out[y * size + x] = sum / 9;
                    }
                }
                return out;
            };
            const blurred = pass(pass(p.map.mountainHeight));
            for (let i = 0; i < blurred.length; i++) blurred[i] = Math.min(1, blurred[i] * 1.8);
            return blurred;
        },

        // Клетки, занятые горами (1) и остальные (0): от этого зависит, докуда рельеф может доходить.
        mountainFootprint(p) {
            const mountainHeight = p.map.mountainHeight;
            const footprint = new Float32Array(mountainHeight.length);
            for (let i = 0; i < footprint.length; i++) footprint[i] = mountainHeight[i] > 0 ? 1 : 0;
            return footprint;
        },

        // Клетки, на которых может быть рельеф: сами горы и всё, что рядом.
        tilesNearRelief(p, blurred) {
            const { size } = p.dim;
            const zone = [];
            p.forEachTile((x, y) => {
                if (p.anyAround(x, y, j => blurred[j] > 0)) zone.push(y * size + x);
            });
            return zone;
        },

        // С какой относительной высоты лежит снег: чем холоднее (с учётом сезона), тем он ниже.
        snowLevel(p, tile) {
            const fraction = clamp((0.36 - p.seasonalTemperature(tile)) / 0.3);
            return 0.95 - fraction * 0.6;
        },

        // На сколько пикселей поднята поверхность гор в центре клетки (руда и разломы лежат на ней, а не под ней).
        liftAtTile(p, x, y) {
            if (!p.reliefHeight || p.map.terrain[p.map.index(x, y)] !== Terrain.MOUNTAIN) return 0;
            const { T } = p.dim;
            const k = (y * T + (T >> 1)) * p.width + x * T + (T >> 1);
            return Math.round(p.reliefHeight[k] / 255 * p.px(p.options.mountainLift));
        }
    };
}

/* ============================================================
   Hills — холмы и овраги на равнинах

   Лёгкая светотень «карты холмов» (свет слева сверху, как у гор и деревьев) плюс тёмные овраги в сухих местах. Карта холмов — шум
   плюс крупный рельеф суши из генератора; считается один раз на карту.
   ============================================================ */
{
    const { bilinear } = MapPaint;

    MapPaint.Hills = {
        defaults: {
            hillStrength: 0.6,   // 0..1: заметность холмов и впадин на равнинах (0 — выключить)
            ravineDensity: 0.2  // 0..1: сколько оврагов в сухих местах (0 — нет)
        },

        enabled: p => p.view === 'terrain' && p.layers.hills && (p.options.hillStrength > 0 || p.options.ravineDensity > 0),

        build(p) {
            const o = p.options;
            const key = `${p.tileSize}|${o.hillStrength}|${o.ravineDensity}`;
            return p.memo('hillShading', [p.map.elevation, key], () => this.computeHills(p));
        },

        /* На равнинах — лёгкая светотень «карты холмов» (свет слева сверху, как у гор и деревьев) плюс тёмные овраги
           в сухих местах. Карта холмов — шум плюс крупный рельеф суши из генератора; считается один раз на карту. */
        paint(p) {
            const { index, code } = this.build(p);
            const pixels = p.pixels;
            p.eachInRegion(index, n => {
                const k = index[n];
                const c = code[n];
                let color = pixels[k];
                const step = (c & 7) - 2;
                if (step !== 0) color = shadeFast(color, STEP_AMOUNTS[step + 2]);
                if (c & 8) color = shadeFast(color, -78);
                pixels[k] = color;
            });
        },

        computeHills(p) {
            const o = p.options;
            const map = p.map;
            const { size, T, W } = p.dim;
            const dryBiomes = [Biome.STEPPE, Biome.DESERT, Biome.SAVANNA, Biome.TUNDRA];

            // Какие клетки подходят (1) и в каких ещё и овраги (3) — один раз, а не для каждого пикселя.
            const flags = new Uint8Array(size * size);
            let eligible = 0;
            for (let i = 0; i < flags.length; i++) {
                if (!map.isLand(i) || map.terrain[i] === Terrain.MOUNTAIN || map.river[i]) continue;
                flags[i] = o.ravineDensity > 0 && dryBiomes.includes(map.biome[i]) ? 3 : 1;
                eligible++;
            }
            const tileOfColumn = new Int32Array(W);
            for (let x = 0; x < W; x++) tileOfColumn[x] = Math.floor(x / T);

            return computeHillShading({
                hills: this.buildHillHeights(p), waterMask: p.waterMask, flags, tileOfColumn,
                width: W, tile: T, strength: o.hillStrength,
                ravineWidth: 0.012 + 0.03 * o.ravineDensity,
                valleyNoise: new LatticeNoise(W, Math.max(6, p.px(22)), 611 + p.seedSalt),
                capacity: eligible * T * T
            });
        },

        // Карта холмов по пикселям (0..255). От сезона не зависит, поэтому кэшируется.
        buildHillHeights(p) {
            const map = p.map;
            return p.memo('hillHeights', [map.elevation, p.tileSize], () => {
                const { size, T, W } = p.dim;
                const height = new Uint8Array(W * W);
                const { first, second, fraction } = p.axis;
                const broad = new LatticeNoise(W, Math.max(6, p.px(20)), 601 + p.seedSalt);
                const landHeight = new Float32Array(size * size);
                for (let i = 0; i < landHeight.length; i++) landHeight[i] = clamp((map.elevation[i] - map.seaLevel) / 0.5);

                p.forEachTile((tx, ty) => {
                    if (!map.isLand(ty * size + tx)) return;
                    for (let gy = ty * T; gy < (ty + 1) * T; gy++) {
                        const rowTop = first[gy] * size, rowBottom = second[gy] * size, v = fraction[gy];
                        for (let gx = tx * T; gx < (tx + 1) * T; gx++) {
                            const coarse = bilinear(landHeight, rowTop, rowBottom, first[gx], second[gx], fraction[gx], v); // крупный рельеф суши из генератора
                            const value = 0.3 * coarse + 0.7 * broad.at(gx, gy);
                            height[gy * W + gx] = value <= 0 ? 0 : value >= 1 ? 255 : Math.round(value * 255);
                        }
                    }
                });
                return height;
            });
        }
    };
}

/* ============================================================
   Shores — берега: пляжи и каменистые берега

   Тип берега задаёт генератор (map.shore). Расстояние от воды считаем в пикселях: волной от воды вглубь суши.
     пляж       — полоса мокрого, потом сухого песка; в воде у берега белая пена;
     каменистый — галька и камни, пена послабее;
     Утёсы генератора рисуются как каменистый берег (галька без стенок).
   Форма берега (какой пиксель какого вида, где пена) от сезона не зависит и считается один раз (build); при смене сезона остаётся
   только перекраска.
   ============================================================ */
{
    MapPaint.Shores = {
        defaults: {
            shores: true  // пляжи и каменистые берега
        },

        enabled: p => p.view === 'terrain' && p.layers.shores && p.options.shores,

        build(p) {
            const map = p.map;
            const key = [p.tileSize, p.options.coastSharpness, p.waterKey].join('|');
            return p.memo('shores', [map.shore, map.river, map.terrain, key], () => this.computeShoreGeometry(p));
        },

        /* Тип берега задаёт генератор (map.shore). Расстояние от воды считаем в пикселях: волной от воды вглубь суши.
             пляж     — полоса мокрого, потом сухого песка; в воде у берега белая пена;
             каменистый — галька и камни, пена послабее;
             утёс     — рисуется как каменистый берег.
           Форма берега (какой пиксель какого вида, где пена) от сезона не зависит и считается один раз; при смене сезона
           остаётся только перекраска. */
        paint(p) {
            const geometry = this.build(p);
            this.colorShoreLand(p, geometry);
            this.paintFoam(p, geometry);
        },

        computeShoreGeometry(p) {
            const map = p.map;
            const { size, T, W } = p.dim;
            const waterMask = p.waterMask;
            const wet = Math.max(1, p.px(2));            // ширина полосы мокрого песка
            const reach = Math.max(3, Math.ceil(wet + p.tileSize / p.options.coastSharpness)); // на сколько пикселей берег уходит вглубь суши (мягче переход — шире полоса)
            const distance = new Uint8Array(W * W);         // суша: расстояние до воды (1..reach)
            const kind = new Uint8Array(W * W);             // суша: тип берега; вода: метка пены
            const queue = [];
            const around = new Int32Array(4);
            const neighborsOf = k => {
                const x = k % W;
                let n = 0;
                if (x > 0) around[n++] = k - 1;
                if (x < W - 1) around[n++] = k + 1;
                if (k >= W) around[n++] = k - W;
                if (k < W * W - W) around[n++] = k + W;
                return n;
            };

            // 1) семена: каждый пиксель суши прямо у воды. Тип берега задан для клеток, а сглаженная береговая линия заходит
            // в соседние клетки (в том числе в воду, у которой типа нет), поэтому тип берём у самой клетки пикселя, а если у неё
            // его нет — у ближайшей клетки с берегом среди соседей. Тогда полоса идёт по всей береговой линии без обрывов.
            const typedTile = (tx, ty) => {
                if (tx < 0 || ty < 0 || tx >= size || ty >= size) return 0;
                const i = ty * size + tx;
                if (map.river[i] || !map.isLand(i)) return 0;
                return map.shore[i] === Shore.CLIFF ? Shore.ROCKY : map.shore[i];   // утёс — тот же каменистый берег, без стенки
            };
            for (let ty = 0; ty < size; ty++) {
                for (let tx = 0; tx < size; tx++) {
                    if (!p.anyAround(tx, ty, j => typedTile(j % size, Math.floor(j / size)))) continue;
                    const own = typedTile(tx, ty);

                    for (let gy = ty * T; gy < (ty + 1) * T; gy++) {
                        for (let gx = tx * T; gx < (tx + 1) * T; gx++) {
                            const k = gy * W + gx;
                            if (waterMask[k]) continue;
                            const touchesWater = (gx > 0 && waterMask[k - 1]) || (gx < W - 1 && waterMask[k + 1])
                                || (gy > 0 && waterMask[k - W]) || (gy < W - 1 && waterMask[k + W]);
                            if (!touchesWater) continue;

                            let type = own;
                            if (!type) {
                                let best = Infinity;
                                for (let dy = -1; dy <= 1; dy++) {
                                    for (let dx = -1; dx <= 1; dx++) {
                                        const candidate = typedTile(tx + dx, ty + dy);
                                        if (!candidate) continue;
                                        const ex = (tx + dx) * T + T / 2 - gx, ey = (ty + dy) * T + T / 2 - gy;
                                        const distanceSquared = ex * ex + ey * ey;
                                        if (distanceSquared < best) { best = distanceSquared; type = candidate; }
                                    }
                                }
                            }
                            if (!type) continue;
                            distance[k] = 1;
                            kind[k] = type;
                            queue.push(k);
                        }
                    }
                }
            }

            // 2) волна вглубь суши
            for (let head = 0; head < queue.length; head++) {
                const k = queue[head];
                if (distance[k] >= reach) continue;
                const count = neighborsOf(k);
                for (let a = 0; a < count; a++) {
                    const next = around[a];
                    if (waterMask[next] || distance[next]) continue;
                    distance[next] = distance[k] + 1;
                    kind[next] = kind[k];
                    queue.push(next);
                }
            }

            // 4) пена на воде у пляжей и каменистых берегов (если вода не замёрзла)
            const foam = [];
            for (const k of queue) {
                if (distance[k] !== 1 || (kind[k] !== Shore.BEACH && kind[k] !== Shore.ROCKY)) continue;
                const count = neighborsOf(k);
                for (let a = 0; a < count; a++) {
                    const next = around[a];
                    if (waterMask[next] && kind[next] === 0) {
                        kind[next] = 10 + kind[k];
                        foam.push(next);
                    }
                }
            }
            const firstRing = foam.length;
            for (let head = 0; head < firstRing; head++) {
                const count = neighborsOf(foam[head]);
                for (let a = 0; a < count; a++) {
                    const next = around[a];
                    if (waterMask[next] && kind[next] === 0) {
                        kind[next] = 20;
                        foam.push(next);
                    }
                }
            }

            // Для покраски (зависит от сезона только цвет): по каждому пикселю берега — клетка, узор дизеринга и «бросок кубика» по хешу.
            const count = queue.length;
            const tiles = new Int32Array(count), phase = new Uint8Array(count), variant = new Uint8Array(count);
            for (let n = 0; n < count; n++) {
                const k = queue[n];
                const gx = k % W, gy = (k - gx) / W;
                tiles[n] = p.tileOf(k);
                phase[n] = ((gy & 3) << 2) | (gx & 3);
                if (kind[k] === Shore.BEACH) variant[n] = hashUnit(gx, gy, 620) < 0.18 ? 1 : 0;      // 1 — пятно мокрого песка среди сухого
                else if (kind[k] === Shore.ROCKY) {
                    const r = hashUnit(gx, gy, 621);
                    variant[n] = r < 0.3 ? 0 : r < 0.55 ? 1 : 2;                                       // светлая галька / тёмная / камень
                }
            }

            // Вторая полоса пены, чуть дальше от берега: только пиксели, где узор её пропускает.
            const foamPixels = [];
            for (const k of foam) {
                const gx = k % W, gy = (k - gx) / W;
                if (kind[k] >= 20 && BAYER[(gy & 3) * 4 + (gx & 3)] < 0.4) foamPixels.push(k);
            }
            const foamTiles = Int32Array.from(foamPixels, k => p.tileOf(k));

            // Списки идут по строкам (см. eachInRegion): так область берёт из них только своё.
            const [sortedQueue, sortedTiles, sortedPhase, sortedVariant] = MapPaint.sortByKey(Int32Array.from(queue), tiles, phase, variant);
            const [sortedFoam, sortedFoamTiles] = MapPaint.sortByKey(Int32Array.from(foamPixels), foamTiles);
            return { queue: sortedQueue, distance, kind, tiles: sortedTiles, phase: sortedPhase, variant: sortedVariant, wet, reach, foamPixels: sortedFoam, foamTiles: sortedFoamTiles };
        },

        // 3) покраска суши
        colorShoreLand(p, { queue, distance, kind, tiles, phase, variant, wet, reach }) {
            const pixels = p.pixels;
            const c = p.colors;
            const snowColor = p.packed.snow;

            p.eachInRegion(queue, n => {
                const k = queue[n];
                const d = distance[k];
                const type = kind[k];
                const threshold = BAYER[phase[n]];
                let color = 0;

                if (type === Shore.BEACH) {
                    if (d <= wet) color = c.wetSand;
                    else if (threshold < 1 - (d - wet) / (reach - wet + 1)) color = variant[n] ? c.wetSand : c.sand;
                    if (color !== 0) {
                        const snow = p.snowCoverage(tiles[n]);
                        if (snow > 0) color = mixPacked(color, snowColor, 0.9 * snow);
                    }
                } else if (type === Shore.ROCKY) {
                    if (threshold < 1 - (d - 1) / (reach + 1)) {
                        color = variant[n] === 0 ? c.pebbleLight : variant[n] === 1 ? c.pebbleDark : mixPacked(pixels[k], c.stoneMid, 0.6);
                    }
                }
                if (color !== 0) pixels[k] = color;
            });
        },

        // 4) пена на воде у пляжей и каменистых берегов (если вода не замёрзла)
        paintFoam(p, { foamPixels, foamTiles }) {
            const pixels = p.pixels;
            p.eachInRegion(foamPixels, n => {
                if (p.seasonalTemperature(foamTiles[n]) < ICE_TEMPERATURE) return;
                const k = foamPixels[n];
                pixels[k] = mixPacked(pixels[k], WHITE, 0.16);
            });
        }
    };
}

/* ============================================================
   Rivers — реки

   Реки рисуются прямо в пиксели фона. Сначала строится маска (в каждом пикселе — уровень реки 1..3 или 0), потом она красится жёстко,
   без растушёвки: вода доходит ровно до края маски, а снаружи — ровная линия берега. Форма не зависит от сезона (geometry);
   сезон меняет цвет воды и берега (зимой — лёд).
   ============================================================ */
{
    const { DIRECTIONS_4 } = MapPaint;

    MapPaint.Rivers = {
        defaults: {
            riverTails: true  // истончающиеся декоративные концы у истоков рек (река постепенно сходит на нет)
        },

        enabled: p => p.view === 'terrain' && p.layers.rivers,

        // Маска рек без декоративных концов (p.riverMask): по ней считаются дороги, мосты и регионы.
        build(p) {
            p.riverMask = this.geometry(p).riverOnly;
        },

        /* Реки рисуем прямо в пиксели фона (а не поверх готовой картинки).
           Сначала строим маску: в каждом пикселе — уровень реки (1..3) или 0. Потом красим её жёстко, без растушёвки: вода
           доходит ровно до края маски, а снаружи — ровная линия берега. Чёткий контур читается лучше, чем размытая дизерингом кромка. */
        paint(p) {
            const geometry = this.geometry(p);
            if (geometry.riverTiles.length === 0) return;

            const { queue, distance, solid } = geometry;
            const { W } = p.dim;
            const pixels = p.pixels;
            const bankColors = new Map();                              // тёмный цвет берега считаем один раз на каждый цвет земли

            // Все реки — самой мелкой воды, цвета прибрежного мелководья (а не по глубине); зимой — лёд.
            const riverColor = tile => (p.seasonalTemperature(tile) < RIVER_ICE_TEMPERATURE ? p.packed.ice[0] : p.packed.waterShades[0]);

            p.eachInRegion(solid, n => { pixels[solid[n]] = riverColor(p.tileOf(solid[n])); });   // сердцевина реки — сплошной цвет
            p.eachInRegion(queue, n => {                                        // вода до самого края
                const k = queue[n];
                if (distance[k] > 0) pixels[k] = riverColor(p.tileOf(k));
            });

            // Берег: первый пиксель суши — ровная тёмная линия, второй — редкая галька или песок на пляжных и каменистых берегах.
            if (!p.options.shores) return;
            p.eachInRegion(queue, n => {
                const k = queue[n];
                if (distance[k] < 0) this.paintBankPixel(p, k % W, Math.floor(k / W), k, -distance[k], bankColors);
            });
        },

        // Ширина реки в клетке по количеству воды: ручей — 2–3 пикселя, большая река у устья — до 14.
        riverWidthAt(p, i) {
            const flow = p.map.riverFlow[i];
            return Math.max(2, Math.min(p.px(14), Math.round((p.tileSize / 12) * (1 + 0.4 * Math.sqrt(flow)))));
        },

        /* Форма рек не зависит от сезона, поэтому считается один раз: маска (уровень реки в каждом пикселе), список
           пикселей кромки с расстоянием до края и список «сердцевины». Кэш сбрасывается при смене карты или параметров резкости. */
        geometry(p) {
            const o = p.options;
            const key = [p.tileSize, o.coastSharpness, o.blendSharpness, o.coastSmoothing, p.seedSalt, o.riverTails].join('|');
            return p.memo('river', [p.map.river, key], () => this.computeRiverGeometry(p));
        },

        computeRiverGeometry(p) {
            const map = p.map;
            const { size, W } = p.dim;
            const mask = new Uint8Array(W * W);

            const riverTiles = [];
            for (let i = 0; i < map.river.length; i++) {
                if (map.river[i] > 0) riverTiles.push(i);
            }
            if (riverTiles.length === 0) return { riverTiles, riverOnly: mask, queue: new Int32Array(0), distance: null, solid: new Int32Array(0) };

            // Кисть: круглое «перо» шириной width, которое красит в маске только сушу (не воду моря и озёр).
            const wobble = p.px(2);
            const centerOf = tile => p.tileCenter(tile % size, Math.floor(tile / size), 983, 984, wobble);
            const stamp = (cx, cy, width, level) => {
                const radius = width / 2;
                for (let oy = -Math.ceil(radius); oy <= Math.ceil(radius); oy++) {
                    for (let ox = -Math.ceil(radius); ox <= Math.ceil(radius); ox++) {
                        if (ox * ox + oy * oy > radius * radius + 0.25) continue;     // круглое «перо», а не квадрат
                        const x = cx + ox, y = cy + oy;
                        if (x < 0 || y < 0 || x >= W || y >= W) continue;
                        const k = y * W + x;
                        if (!p.waterMask[k] && level > mask[k]) mask[k] = level;
                    }
                }
            };

            this.stampRiverChannels(p, riverTiles, centerOf, stamp);
            const riverOnly = Uint8Array.from(mask);                                   // без декоративных концов
            const tailTiles = p.options.riverTails ? this.stampRiverTails(p, riverTiles, centerOf, stamp) : new Set();
            const { queue, distance, solid } = this.riverEdges(p, mask, [...riverTiles, ...tailTiles]);
            return { riverTiles, riverOnly, queue, distance, solid };
        },

        // 1) форма: каждая клетка реки соединена с клеткой, куда течёт вода (map.riverTo). Отрезок — слегка извилистая полоса,
        //    ширина которой плавно меняется от клетки к клетке по количеству воды (map.riverFlow); у устья река расширяется.
        stampRiverChannels(p, riverTiles, centerOf, stamp) {
            const map = p.map;
            for (const i of riverTiles) {
                const to = map.riverTo[i];
                if (to === -1) continue;
                const [ax, ay] = centerOf(i);
                let [bx, by] = centerOf(to);
                const toWater = !map.isLand(to);
                if (toWater) { bx = (ax + bx) / 2; by = (ay + by) / 2; }              // в море река заканчивается у берега
                const widthFrom = this.riverWidthAt(p, i);
                const widthTo = toWater ? Math.round(widthFrom * 1.4) : (map.river[to] > 0 ? this.riverWidthAt(p, to) : widthFrom);

                const points = p.curve(ax, ay, bx, by, length => (hashUnit(i, to, 985) - 0.5) * Math.min(p.px(5), length * 0.8));
                const level = map.river[i];
                points.forEach(([px, py], k) => stamp(px, py, widthFrom + (widthTo - widthFrom) * (k / Math.max(1, points.length - 1)), level));
            }
        },

        // 1б) истончающиеся концы: за истоком река продолжается в сушу, плавно сужаясь до нуля. Это только украшение: в
        //     riverOnly (по ней считаются дороги, мосты и регионы) концы не входят, в mask — входят (рисуются как река).
        //     Возвращает клетки, по которым прошли концы.
        stampRiverTails(p, riverTiles, centerOf, stamp) {
            const map = p.map;
            const { size, T, W } = p.dim;
            const tailTiles = new Set();
            const fed = new Uint8Array(size * size);                       // клетки, в которые впадает другая клетка реки
            for (const i of riverTiles) {
                const to = map.riverTo[i];
                if (to >= 0 && map.river[to] > 0) fed[to] = 1;
            }
            for (const i of riverTiles) {
                const to = map.riverTo[i];
                if (fed[i] || to === -1) continue;                             // не исток
                const x = i % size, y = Math.floor(i / size);
                const [ax, ay] = centerOf(i);
                const [bx, by] = centerOf(to);
                const heading = Math.atan2(ay - by, ax - bx);                  // против течения, вглубь суши
                const wanted = Math.round(T * (1.8 + 1.4 * hashUnit(x, y, 986)));
                const phase = hashUnit(x, y, 987) * Math.PI * 2, phase2 = hashUnit(x, y, 988) * Math.PI * 2;
                const swing = hashUnit(x, y, 989) < 0.5 ? 1 : -1;

                // Сначала «сухой прогон»: идём, пока не упрёмся в воду, другую реку или горы, — тогда конец сужается до нуля
                // ровно к этому месту, а не обрывается.
                const path = [];
                let px = ax, py = ay;
                for (let n = 0; n < wanted; n++) {
                    const angle = heading + swing * (0.45 * Math.sin(phase + n / (T * 0.9) * Math.PI * 2) + 0.25 * Math.sin(phase2 + n / (T * 1.7) * Math.PI * 2));
                    px += Math.cos(angle);
                    py += Math.sin(angle);
                    const rx = Math.round(px), ry = Math.round(py);
                    if (rx < 0 || ry < 0 || rx >= W || ry >= W) break;
                    const tile = Math.floor(ry / T) * size + Math.floor(rx / T);
                    if (tile !== i && (map.river[tile] > 0 || !map.isLand(tile) || map.terrain[tile] === Terrain.MOUNTAIN)) break;
                    if (p.waterMask[ry * W + rx]) break;
                    path.push([rx, ry, tile]);
                }
                if (path.length < 5) continue;

                const widthStart = this.riverWidthAt(p, i);
                path.forEach(([rx, ry, tile], n) => {
                    const t01 = n / path.length;
                    const width = widthStart * Math.pow(1 - t01, 1.2);
                    // Толстая часть — круглым пером; когда ширина меньше пикселя, остаётся пунктир, всё реже (равномерно, без случайных пятен).
                    if (width >= 1.2 || (width * 0.83) > ((n * 0.6180339887 + hashUnit(x, y, 990)) % 1)) stamp(rx, ry, Math.max(1, width), 1);
                    tailTiles.add(tile);
                });
            }
            return tailTiles;
        },

        // 2) расстояние до края реки: внутри — положительное, снаружи — отрицательное; ширина перехода из coastSharpness.
        //    Возвращает { queue (пиксели у края и волна от него), distance, solid (сердцевина реки) }.
        riverEdges(p, mask, tiles) {
            const map = p.map;
            const { size, T, W } = p.dim;
            const edgeWidth = Math.max(2, T / p.options.coastSharpness);
            const reachPx = Math.ceil(edgeWidth / 2) + 1;
            const distance = new Int8Array(W * W);
            const queue = [];
            const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= W ? 0 : mask[yy * W + xx]);

            // Клетки, где может быть вода реки: сами реки и их соседи. Каждый пиксель — один раз.
            const zone = new Set();
            for (const i of tiles) {
                zone.add(i);
                for (const near of map.neighbors8(i)) zone.add(near);
            }
            const zoneTiles = [...zone];

            for (const i of zoneTiles) {
                const x0 = (i % size) * T;
                const y0 = Math.floor(i / size) * T;
                for (let yy = y0; yy < y0 + T; yy++) {
                    for (let xx = x0; xx < x0 + T; xx++) {
                        const k = yy * W + xx;
                        const around = Math.max(at(xx - 1, yy), at(xx + 1, yy), at(xx, yy - 1), at(xx, yy + 1));
                        if (mask[k] > 0 && (at(xx - 1, yy) === 0 || at(xx + 1, yy) === 0 || at(xx, yy - 1) === 0 || at(xx, yy + 1) === 0)) {
                            distance[k] = 1;                       // последний пиксель реки у края
                            queue.push(k);
                        } else if (mask[k] === 0 && around > 0) {
                            distance[k] = -1;                      // первый пиксель суши у воды
                            queue.push(k);
                        }
                    }
                }
            }
            for (let head = 0; head < queue.length; head++) {          // волна от края внутрь реки и наружу на сушу
                const k = queue[head];
                const d = distance[k];
                const sign = d > 0 ? 1 : -1;
                if (Math.abs(d) >= reachPx) continue;
                const x = k % W, y = (k - x) / W;
                for (const [dx, dy] of DIRECTIONS_4) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
                    const next = ny * W + nx;
                    if (distance[next] !== 0 || (mask[next] > 0) !== (sign > 0)) continue;
                    distance[next] = d + sign;
                    queue.push(next);
                }
            }

            const solid = [];
            for (const i of zoneTiles) {
                const x0 = (i % size) * T, y0 = Math.floor(i / size) * T;
                for (let yy = y0; yy < y0 + T; yy++) {
                    for (let xx = x0; xx < x0 + T; xx++) {
                        const k = yy * W + xx;
                        if (mask[k] > 0 && distance[k] === 0) solid.push(k);
                    }
                }
            }

            return { queue: Int32Array.from(queue).sort(), distance, solid: Int32Array.from(solid).sort() };   // по строкам: см. eachInRegion
        },

        // Берег реки: первый пиксель суши — сплошная линия мокрой земли (одинаковая вдоль всей реки, чтобы контур был строгим),
        // второй — редкая галька у каменистых и песок у пляжных клеток. Дальше берега нет.
        paintBankPixel(p, xx, yy, k, outside, bankColors) {
            if (outside > 2 || p.waterMask[k]) return;
            const pixels = p.pixels;

            if (outside === 1) {
                const ground = pixels[k];
                let bank = bankColors.get(ground);
                if (bank === undefined) {
                    bank = shadePacked(ground, -0.26);
                    bankColors.set(ground, bank);
                }
                pixels[k] = bank;
                return;
            }

            const { T } = p.dim;
            const type = p.map.shore[Math.floor(yy / T) * p.map.size + Math.floor(xx / T)];
            if ((type !== Shore.BEACH && type !== Shore.ROCKY && type !== Shore.CLIFF) || hashUnit(xx, yy, 631) >= 0.4) return;
            const c = p.colors;
            if (type === Shore.BEACH) pixels[k] = c.sand;
            else pixels[k] = hashUnit(xx, yy, 630) < 0.5 ? c.pebbleLight : c.pebbleDark;
        }
    };
}

/* ============================================================
   Crossings — мосты

   Мосты через реки (их ставит генератор, map.crossing — любое ненулевое значение): небольшой горбатый каменный мост.
   Мост всегда прямой и всегда самый короткий из возможных: перебираем направления через центр реки (layout), у каждого меряем
   воду в обе стороны до суши и берём то, где её меньше всего; дорога, идущая почти так же, имеет небольшое преимущество
   (мост продолжает её). Мост стоит ровно посередине реки — концы лежат на суше, над водой он не повисает. Если суши рядом нет
   (устье, озеро), моста нет. Мосты не пересекаются и не касаются: если направление мешает уже поставленному мосту, берём
   следующее по длине.

   Настил слегка выгнут вверх, под его южным краем видна каменная стенка с проёмом арки, на воде лежит тень.
   ============================================================ */
{
    const ANGLES = 16;            // сколько направлений пробуем (на полуокружности)
    const MAX_SPAN = 1.2;         // самый длинный мост, в клетках: длиннее не ставим

    MapPaint.Crossings = {
        enabled: p => p.view === 'terrain' && p.layers.decorations,

        paint(p) {
            const { map } = p;
            const plan = this.plan(p);
            p.forEachRegionTile((x, y) => {
                const crossing = plan.get(map.index(x, y));
                if (crossing) this.paintBridge(p, crossing);
            });
        },

        // Размеры моста: ширина настила (нечётная: мост симметричен), сколько настила лежит на суше за берегом.
        thickness(p) {
            return p.px(4) | 1;
        },

        overhang(p) {
            return Math.max(2, Math.round(p.tileSize * 0.12));
        },

        /* План мостов всей карты: клетка -> { центр, ось, длина воды в обе стороны }. Не зависит от сезона, считается один раз.
           Клетки идут по строкам; из направлений берётся первое по длине, которое не мешает уже поставленным мостам. */
        plan(p) {
            const { map } = p;
            const deps = [map.crossing, map.roadLinks, map.river, map.riverTo, p.tileSize, p.seedSalt, p.waterKey, p.riverMask];
            return p.memo('crossings', deps, () => {
                const { size } = p.dim;
                const plan = new Map();
                for (let i = 0; i < size * size; i++) {
                    if (!map.crossing[i]) continue;
                    const bridge = this.layout(p, i).find(candidate => !this.collides(p, plan, size, candidate));
                    if (bridge) plan.set(i, bridge);
                }
                return plan;
            });
        },

        isWet(p, x, y) {
            const { W } = p.dim;
            if (x < 0 || y < 0 || x >= W || y >= W) return false;
            const k = y * W + x;
            return p.waterMask[k] === 1 || (p.riverMask !== null && p.riverMask[k] > 0);
        },

        // Сколько воды от (cx, cy) в направлении (sx, sy): наибольшее из нескольких параллельных линий по ширине настила (берег бывает косым).
        reachOf(p, i, cx, cy, sx, sy, lateral) {
            if (!p.riverMask) return MapPaint.Rivers.riverWidthAt(p, i) / 2;
            const { T } = p.dim;
            let reach = 0;
            for (let j = -lateral; j <= lateral; j++) {
                let distance = 0;
                while (distance < T && this.isWet(p, Math.round(cx + sx * distance - sy * j), Math.round(cy + sy * distance + sx * j))) distance += 0.5;
                reach = Math.max(reach, distance);
            }
            return reach;
        },

        /* Все подходящие мосты клетки, от лучшего к худшему. Центр — тот же, через который Rivers проводит русло. Для каждого
           направления меряем воду до суши в обе стороны; мост сдвигаем на середину этого отрезка. Оценка — длина воды минус бонус
           за совпадение с дорогой (до px(3) пикселей). Направления без суши с одной из сторон отбрасываем: такой мост висел бы над водой. */
        layout(p, i) {
            const { map } = p;
            const { size, T } = p.dim;
            const x = i % size, y = (i - x) / size;
            const [centerX, centerY] = p.tileCenter(x, y, 983, 984, p.px(2));
            const cx = Math.round(centerX), cy = Math.round(centerY);
            const lateral = (this.thickness(p) - 1) / 2;
            const bonus = p.px(3);

            const roads = [];
            const links = map.roadLinks ? map.roadLinks[i] : 0;
            for (let d = 0; d < 8; d++) {
                if (!(links & (1 << d))) continue;
                const [dx, dy] = ROAD_DIRECTIONS[d];
                const length = Math.hypot(dx, dy);
                roads.push([dx / length, dy / length]);
            }

            const found = [];
            for (let k = 0; k < ANGLES; k++) {
                const angle = Math.PI * k / ANGLES;
                const ux = Math.cos(angle), uy = Math.sin(angle);
                const front = this.reachOf(p, i, cx, cy, ux, uy, lateral), back = this.reachOf(p, i, cx, cy, -ux, -uy, lateral);
                const span = front + back;
                if (front >= T || back >= T || span < 1 || span > MAX_SPAN * T) continue;     // суши нет или мост слишком длинный

                const align = roads.reduce((best, [rx, ry]) => Math.max(best, Math.abs(rx * ux + ry * uy)), 0);
                const shift = (front - back) / 2;                                              // середина воды вдоль оси
                found.push({ tile: i, cx: cx + ux * shift, cy: cy + uy * shift, ux, uy, front: span / 2, back: span / 2, score: span - bonus * align });
            }
            return found.sort((a, b) => a.score - b.score);
        },

        // Отрезок настила вместе с запасом на берегу: [x0, y0, x1, y1].
        segment(p, bridge) {
            const half = bridge.front + this.overhang(p);
            return [bridge.cx - bridge.ux * half, bridge.cy - bridge.uy * half, bridge.cx + bridge.ux * half, bridge.cy + bridge.uy * half];
        },

        // Мешает ли мост уже поставленным (в пределах двух клеток): пересекается с ними или подходит ближе ширины настила.
        collides(p, plan, size, bridge) {
            const x = bridge.tile % size, y = (bridge.tile - x) / size;
            const mine = this.segment(p, bridge);
            const clearance = this.thickness(p) + 1;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const other = x + dx >= 0 && x + dx < size && y + dy >= 0 && y + dy < size ? plan.get((y + dy) * size + x + dx) : null;
                    if (other && MapPaint.segmentDistance(mine, this.segment(p, other)) < clearance) return true;
                }
            }
            return false;
        },

        /* Мост. Настил — полоса вдоль оси от суши до суши (с запасом на берегу), края — парапеты: освещённый (северо-запад) светлее,
           теневой темнее. Настил выгнут дугой: каждый пиксель поднят вверх на lift, у концов 0, посередине — максимум. Под поднятым
           настилом открывается стенка (первый ряд — камень, ниже — тёмный проём арки), а на воде лежит тень, смещённая на юго-восток. */
        paintBridge(p, { cx, cy, ux, uy, front, back, tile }) {
            const { W } = p.dim;
            const c = p.colors;
            const half = (this.thickness(p) - 1) / 2;
            const overhang = this.overhang(p);
            const from = -(back + overhang), to = front + overhang;
            const mid = (from + to) / 2, radius = (to - from) / 2;
            const arch = Math.min(p.px(3), Math.max(1, Math.round(radius * 0.2)));
            const liftAt = s => Math.max(0, Math.round(arch * (1 - ((s - mid) / radius) ** 2)));

            // 1) пиксели настила на земле (ещё без подъёма): сначала края, чтобы их не перебили внутренние отсчёты
            const offsets = [-half, half];
            for (let j = -half + 0.5; j < half; j += 0.5) offsets.push(j);
            const cells = new Map();
            for (let s = from; s <= to; s += 0.5) {
                const lift = liftAt(s);
                for (const j of offsets) {
                    const x = Math.round(cx + ux * s - uy * j), y = Math.round(cy + uy * s + ux * j);
                    if (x < 0 || y < 0 || x >= W || y >= W || cells.has(y * W + x)) continue;
                    const edge = half > 0 && Math.abs(j) === half ? (j * (uy - ux) > 0 ? 1 : 2) : 0;   // 1 — край на свету, 2 — в тени
                    cells.set(y * W + x, { x, y, lift, edge });
                }
            }

            // 2) тень на воде (свет слева сверху — тень вправо и вниз)
            for (const { x, y } of cells.values()) {
                if (this.isWet(p, x + 1, y + 1)) p.blend(x + 1, y + 1, BLACK, 0.3);
            }

            // 3) настил, поднятый вверх; щели в один пиксель (на спуске дуги) закрываем
            const base = p.moodize(c.bridgeDeck);
            const shade = p.moodize(c.bridgeEdge);
            const lit = shadePacked(base, 0.14);
            const worn = shadePacked(base, -0.07);
            const snow = p.snowCoverage(tile);
            const deck = new Map();
            for (const { x, y, lift, edge } of cells.values()) {
                if (y - lift < 0) continue;
                let color = edge === 1 ? lit : edge === 2 ? shade : hashUnit(x, y, 640) < 0.2 ? worn : base;
                if (snow > 0) color = mixPacked(color, p.packed.snow, 0.6 * snow);
                deck.set((y - lift) * W + x, color);
            }
            for (const [key, color] of Array.from(deck)) {
                if (!deck.has(key + W) && deck.has(key + 2 * W)) deck.set(key + W, color);
            }

            // 4) стенка под поднятым настилом (кроме пикселей настила)
            const faceTop = shadePacked(base, -0.3), faceHole = shadePacked(base, -0.55);
            for (const { x, y, lift } of cells.values()) {
                for (let r = 1; r <= lift; r++) {
                    if (!deck.has((y - lift + r) * W + x)) p.put(x, y - lift + r, r === 1 ? faceTop : faceHole);
                }
            }
            for (const [key, color] of deck) p.put(key % W, (key / W) | 0, color);
        }
    };
}

/* ============================================================
   Roads — дороги

   Дороги строит генератор (map.roadLinks: из каждой клетки — в какие из 8 сторон идёт дорога, map.roadLevel — насколько она наезжена).
   Каждый отрезок между центрами соседних клеток рисуется слегка извилистой полосой: центр клетки смещён случайно, середина отрезка тоже.
   Сначала мягкая полоса утоптанной земли, потом сама дорога. Форма не зависит от сезона (build); снег ложится сверху.
   ============================================================ */
{
    MapPaint.Roads = {
        defaults: {
            roads: true  // дороги между поселениями
        },

        enabled: p => p.view === 'terrain' && p.layers.roads && p.options.roads && !!p.map.roadLinks,

        // Пиксели дорог (не зависят от сезона): мягкая полоса утоптанной земли и сама дорога с тремя оттенками.
        build(p) {
            const map = p.map;
            return p.memo('roads', [map.roadLinks, p.tileSize, p.seedSalt, p.riverMask], () => {
                const { size } = p.dim;
                const wobble = p.px(2);
                const halo = new Set();
                const core = new Map();

                const centerOf = (x, y) => p.tileCenter(x, y, 980, 981, wobble);
                const stamp = (cx, cy, width, isHalo) => p.eachFreeInSquare(cx, cy, width, (k, x, y) => {
                    if (isHalo) halo.add(k); else core.set(k, this.dirtKind(p, x, y));
                });

                for (let i = 0; i < size * size; i++) {
                    const links = map.roadLinks[i];
                    if (!links) continue;
                    const x = i % size, y = Math.floor(i / size);
                    const [ax, ay] = centerOf(x, y);
                    let count = 0;

                    for (let d = 0; d < 8; d++) {
                        if (!(links & (1 << d))) continue;
                        count++;
                        const [dx, dy] = ROAD_DIRECTIONS[d];
                        const j = (y + dy) * size + x + dx;
                        if (j < i) continue;                                          // каждый отрезок рисуем один раз

                        const [bx, by] = centerOf(x + dx, y + dy);
                        const points = p.curve(ax, ay, bx, by, (hashUnit(i, j, 982) - 0.5) * wobble * 1.6);   // середина отрезка уходит в сторону
                        const width = this.roadWidth(p, Math.min(map.roadLevel[i], map.roadLevel[j]));
                        for (const [px, py] of points) stamp(px, py, width + 2, true);
                        for (const [px, py] of points) stamp(px, py, width, false);
                    }
                    if (count !== 2) stamp(Math.round(ax), Math.round(ay), this.roadWidth(p, map.roadLevel[i]) + 1, false);   // перекрёсток или конец дороги
                }
                for (const k of core.keys()) halo.delete(k);

                const [sortedCore, sortedKind] = MapPaint.sortByKey(Int32Array.from(core.keys()), Uint8Array.from(core.values()));   // по строкам: см. eachInRegion
                return { halo: Int32Array.from(halo).sort(), core: sortedCore, kind: sortedKind };
            });
        },

        /* Дороги строит генератор (map.roadLinks: из каждой клетки — в какие из 8 сторон идёт дорога, map.roadLevel — насколько
           она наезжена). Здесь каждый отрезок между центрами соседних клеток рисуется слегка извилистой полосой:
           центр клетки смещён случайно, середина отрезка тоже. Сначала мягкая полоса утоптанной земли, потом сама дорога. */
        paint(p) {
            const geometry = this.build(p);
            const kinds = this.dirtShades(p);
            const pixels = p.pixels;

            const { halo, core, kind } = geometry;
            p.eachInRegion(halo, n => { pixels[halo[n]] = mixPacked(pixels[halo[n]], kinds[0], 0.28); });
            p.eachInRegion(core, n => {
                const k = core[n];
                let color = kinds[kind[n]];
                const snow = p.snowCoverage(p.tileOf(k));
                if (snow > 0) color = mixPacked(color, p.packed.snow, 0.75 * snow);
                pixels[k] = color;
            });
        },

        roadWidth(p, level) {
            return Math.max(1, p.px([2, 3, 4][Math.min(3, Math.max(1, level)) - 1]));
        },

        // Цвета грунта (земля, светлая земля, грязь) в текущем стиле.
        dirtShades(p) {
            const c = p.colors;
            return [p.moodize(c.dirt), p.moodize(c.dirtLight), p.moodize(c.mud)];
        },

        // Вид пикселя дороги и двора по хешу: 0 — земля, 1 — светлая, 2 — грязь.
        dirtKind(p, x, y) {
            const r = hashUnit(x, y, 975);
            return r < 0.2 ? 1 : r < 0.45 ? 2 : 0;
        }
    };
}

/* ============================================================
   Settlements — поселения: двор и дома

   Раскладка домов (layoutSettlement) и двор с улочками (settlementGround) не зависят от сезона и считаются один раз на поселение.
   Земля двора рисуется слоем (paint), а дома — декорациями сцены (collect): они сортируются по основанию вместе с деревьями и рудой.
   ============================================================ */
{
    MapPaint.Settlements = {
        defaults: {
            settlements: true,         // поселения (домики)
            settlementMinHouses: 1,    // домиков в самом маленьком поселении
            settlementMaxHouses: 3,    // домиков в клетке высшего уровня (если они помещаются)
            settlementOverflow: 0.25  // на сколько (доля клетки) основание дома может выйти за границу своей клетки
        },

        enabled: p => p.view === 'terrain' && p.layers.settlements,

        // Утоптанная земля вокруг домов и улица между ними (на земле, до деревьев и границ).
        paint(p) {
            const map = p.map;
            if (!p.options.settlements || map.settlements.length === 0) return;

            const { size } = p.dim;
            const streetColors = MapPaint.Roads.dirtShades(p);
            const [dirt, , mud] = streetColors;
            const pixels = p.pixels;

            for (const settlement of map.settlements) {
                const tile = settlement.tile;
                if (!p.regionHasTile(tile)) continue;
                const ground = this.settlementGround(p, this.settlementLayout(p, tile % size, Math.floor(tile / size), tile));
                const snow = p.snowCoverage(tile);
                const snowMix = color => (snow > 0 ? mixPacked(color, p.packed.snow, 0.7 * snow) : color);

                for (let n = 0; n < ground.blobIndex.length; n++) {            // мягкие пятна утоптанной земли
                    const k = ground.blobIndex[n];
                    if (!p.regionHas(k)) continue;
                    pixels[k] = mixPacked(pixels[k], snowMix(ground.blobMud[n] ? mud : dirt), ground.blobStrength[n] / 255);
                }
                for (let n = 0; n < ground.streetIndex.length; n++) {          // улица
                    if (p.regionHas(ground.streetIndex[n])) pixels[ground.streetIndex[n]] = snowMix(streetColors[ground.streetKind[n]]);
                }
            }
        },

        collect(p, items, x, y, i) {
            const layout = this.settlementLayout(p, x, y, i);
            const snow = p.snowCoverage(i);
            for (const part of layout.houses) {
                const sprite = this.houseSprite(p, part, part.roll, snow);
                items.push({ y: part.base, x: part.x, cover: true, draw: () => this.drawHouse(p, sprite, part.x, part.base, part, layout.level) });
            }
        },

        // Раскладка не зависит от сезона и считается один раз. Экономика меняет население и уровни на месте, поэтому раскладка
        // зависит ещё и от версии видимых изменений карты.
        settlementLayout(p, x, y, i) {
            const map = p.map;
            const layouts = p.memo('settlements', [map.population, p.tileSize, p.seedSalt, map.visualVersion], () => new Map());
            if (!layouts.has(i)) layouts.set(i, this.layoutSettlement(p, x, y, i));
            return layouts.get(i);
        },

        layoutSettlement(p, x, y, i) {
            const map = p.map;
            const o = p.options;
            const { T, W } = p.dim;
            const level = map.settlementLevel[i] || 1;
            const maxLevel = (map.options && map.options.settlementMaxLevel) || 4;
            const rnd = n => hashUnit(x, y, 1000 + n);
            const n = value => p.px1(value);

            // Сколько домиков: от settlementMinHouses (уровень 1) до settlementMaxHouses (высший уровень).
            const share = (level - 1) / Math.max(1, maxLevel - 1);
            const count = clamp(Math.round(o.settlementMinHouses + share * (o.settlementMaxHouses - o.settlementMinHouses)),
                o.settlementMinHouses, o.settlementMaxHouses);

            const left = x * T, top = y * T;
            const slack = Math.round(T * o.settlementOverflow);       // насколько основание дома может выйти за клетку
            const usable = (px, py) => px >= 0 && py >= 0 && px < W && py < W && p.isFree(py * W + px);
            const occupied = new Set();
            const houses = [];
            const tryPlace = (centerX, baseY, w, bodyH, roofH, kind) => {
                const houseLeft = Math.round(centerX - w / 2);
                const base = Math.round(baseY);
                const bodyTop = base - bodyH;
                // Основание (стены) остаётся в клетке с допуском; крыша может уходить вверх — это перспектива, а не площадь.
                if (houseLeft < left - slack || houseLeft + w > left + T + slack || base > top + T + slack || bodyTop < top - slack) return false;
                for (let yy = bodyTop - roofH; yy <= base; yy++) {            // точный след дома, без полей: в клетке надо уместить до 4 домов
                    for (let xx = houseLeft; xx < houseLeft + w; xx++) {
                        if (!usable(xx, yy) || occupied.has(yy * W + xx)) return false;
                    }
                }
                for (let yy = bodyTop - roofH; yy <= base; yy++) {
                    for (let xx = houseLeft; xx < houseLeft + w; xx++) occupied.add(yy * W + xx);
                }
                houses.push({ x: houseLeft + (w >> 1), base, w, bodyH, roofH, kind, roll: rnd(10 + houses.length) });
                return true;
            };

            // Дома стоят в случайных местах клетки (не рядами): для каждого пробуем до 40 случайных точек, пока не найдётся свободная.
            const group = map.settlementGroups[map.settlementGroup[i]];
            const isCenter = group && group.tile === i;
            for (let k = 0; k < count; k++) {
                const chapel = k === 0 && level === maxLevel && isCenter && count >= 3;   // в центре города — каменная часовня
                const kind = chapel ? 'tower' : (level === 1 && rnd(30 + k) < 0.4 ? 'hut' : 'house');
                const scale = count === 1 ? 1.2 : 1;
                const w = chapel ? n(4) : Math.max(3, Math.round(n(5) * scale) + Math.floor(rnd(50 + k) * 3) - 1 - (kind === 'hut' ? 1 : 0));
                const bodyH = chapel ? n(5) : Math.max(2, n(3) + (rnd(60 + k) < 0.4 ? 1 : 0) - (kind === 'hut' ? 1 : 0));
                const roofH = chapel ? n(5) : Math.max(2, n(count >= 3 ? 2 : 3) - (kind === 'hut' ? 1 : 0));
                for (let attempt = 0; attempt < 40; attempt++) {
                    const centerX = left + (0.14 + 0.72 * rnd(100 + k * 50 + attempt)) * T;
                    const baseY = top + (0.42 + 0.56 * rnd(300 + k * 50 + attempt)) * T;
                    if (tryPlace(centerX, baseY, w, bodyH, roofH, kind)) break;
                }
            }
            for (let attempt = 0; houses.length === 0 && attempt < 16; attempt++) {  // запасной вариант: хоть один дом в клетке
                tryPlace(left + T / 2 + (rnd(70 + attempt) - 0.5) * n(6), top + T * 0.8 + (rnd(90 + attempt) - 0.5) * n(4), n(5), n(3), n(3), 'house');
            }

            // Утоптанная земля и улица-заготовка в сторону дороги (дороги между клетками рисует paintRoads).
            const cx = left + T / 2;
            const cy = top + T * 0.65;
            let street = [[cx, cy], [cx, cy]];
            const links = map.roadLinks[i];
            for (let d = 0; d < 8 && links; d++) {
                if (links & (1 << d)) {
                    const [dx, dy] = ROAD_DIRECTIONS[d];
                    street = [[cx, cy], [cx + dx * T / 2, cy + dy * T / 2]];
                    break;
                }
            }
            const blobs = [[cx, cy, n(7)]];
            for (const house of houses) blobs.push([house.x, house.base - house.bodyH / 2, n(4)]);
            return { level, houses, blobs, street };
        },

        // Пиксели земли поселения (не зависят от сезона): пятна вокруг домов и улица. Считаются один раз для поселения.
        settlementGround(p, layout) {
            if (layout.ground) return layout.ground;

            const { W } = p.dim;
            const strengths = new Map();
            const mudPixels = new Set();

            for (const [bx, by, radius] of layout.blobs) {
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const distance = Math.hypot(dx, dy);
                        const px = Math.round(bx + dx), py = Math.round(by + dy);
                        if (distance > radius || px < 0 || py < 0 || px >= W || py >= W) continue;
                        const k = py * W + px;
                        if (!p.isFree(k) || hashUnit(px, py, 977) < 0.12) continue;
                        const strength = Math.round(255 * 0.55 * Math.pow(1 - distance / radius, 0.7));
                        if (strength > (strengths.get(k) || 0)) strengths.set(k, strength);
                        if (hashUnit(px, py, 978) < 0.3) mudPixels.add(k);
                    }
                }
            }

            const street = new Map();
            const [[ax, ay], [bx, by]] = layout.street;
            const width = p.px1(2);
            for (const [px, py] of p.linePoints(Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by))) {
                p.eachFreeInSquare(px, py, width, (k, x, y) => street.set(k, MapPaint.Roads.dirtKind(p, x, y)));
            }

            const blobKeys = [...strengths.keys()];
            layout.ground = {
                blobIndex: Int32Array.from(blobKeys),
                blobStrength: Uint8Array.from(blobKeys, k => strengths.get(k)),
                blobMud: Uint8Array.from(blobKeys, k => (mudPixels.has(k) ? 1 : 0)),
                streetIndex: Int32Array.from(street.keys()),
                streetKind: Uint8Array.from(street.values())
            };
            return layout.ground;
        },

        // Лёгкое приглушение цвета построек в тёмном стиле: они должны оставаться светлее фона.
        houseColor(p, color) {
            return p.mood === 'dark' ? shadePacked(mixPacked(color, packRgb(128, 128, 128), 0.1), -0.06) : color;
        },

        // Рисунок здания (кэшируется): стены, крыша, дверь, контур.
        houseSprite(p, part, roll, snow) {
            const key = [part.kind, part.w, part.bodyH, part.roofH, Math.floor(roll * 4), roll > 0.4, Math.round(snow * 3), p.mood, p.season.name].join('|');   // roll > 0.4 — есть ли труба: без этого рисунок зависел бы от того, какой дом создал спрайт первым
            const c = p.colors;
            const tower = part.kind === 'tower';
            const pad = 1;
            const overhang = tower ? 0 : 1;
            const width = part.w + 2 * overhang + 2 * pad;
            const height = part.roofH + part.bodyH + 2 * pad;

            return p.sprite(key, width, height, c.outline, buffer => {
                const wall = this.houseColor(p, tower ? c.chapelStone : [c.wallA, c.wallB][Math.floor(roll * 2) % 2]);
                let roof = this.houseColor(p, part.kind === 'hut' ? c.thatch : tower ? c.roofD : [c.roofA, c.roofB, c.roofC, c.roofD][Math.floor(roll * 4) % 4]);
                if (snow > 0) roof = mixPacked(roof, p.packed.snow, 0.85 * snow);

                const left = pad + overhang;
                const top = pad + part.roofH;
                const centerX = (width - 1) / 2;

                buffer.rect(left, top, part.w, part.bodyH, wall);
                buffer.rect(left, top, 1, part.bodyH, shadePacked(wall, 0.14));                     // освещённая левая стена
                buffer.rect(left + part.w - 1, top, 1, part.bodyH, shadePacked(wall, -0.22));       // правая — в тени
                buffer.rect(left, top + part.bodyH - 1, part.w, 1, shadePacked(wall, -0.18));
                if (tower) {
                    for (let y = top + 1; y < top + part.bodyH - 1; y += 2) buffer.rect(left + 1, y, part.w - 2, 1, shadePacked(wall, -0.1));   // кладка
                }

                for (let row = 0; row < part.roofH; row++) {                                        // крыша: ряды всё шире книзу
                    const half = ((part.w + 2 * overhang) / 2) * (row + 1) / part.roofH;
                    const y = pad + row;
                    for (let x = Math.round(centerX - half + 0.5); x <= Math.round(centerX + half - 0.5); x++) {
                        buffer.put(x, y, x < centerX ? shadePacked(roof, 0.14) : shadePacked(roof, -0.2));
                    }
                }
                buffer.rect(left + (part.w >> 1), top + part.bodyH - Math.min(2, part.bodyH - 1), 1, Math.min(2, part.bodyH - 1), c.plank);   // дверь

                return {
                    anchorX: Math.round(centerX),
                    anchorY: height - pad - 1,
                    windows: part.bodyH >= 3 ? [[left + 1, top + 1]] : [],
                    chimney: !tower && part.kind === 'house' && roll > 0.4 ? [Math.round(centerX) + 1, pad - 1] : null
                };
            });
        },

        drawHouse(p, sprite, x, base, part, level) {
            const c = p.colors;
            const left = x - sprite.anchorX;
            const top = base - sprite.anchorY;

            this.drawBuildingShadow(p, x, base, part.w, part.bodyH + part.roofH);
            p.blitSprite(sprite.buffer, left, top);

            for (const [wx, wy] of sprite.windows) {
                const lightX = left + wx, lightY = top + wy;
                p.emissive.push(() => p.drawLight(lightX, lightY, c.window, c.fire, p.mood === 'dark' ? 2 : 1));
            }
            if (sprite.chimney && level >= 3) {
                const smokeX = left + sprite.chimney[0], smokeY = top + sprite.chimney[1];
                for (let s = 1; s <= 3; s++) p.blend(smokeX + (s % 2), smokeY - s * 2, packRgb(175, 175, 180), 0.45 - 0.1 * s);
            }
        },

        // Тень здания: пятно под ним и тень, падающая вправо-вниз (свет слева сверху, как у деревьев и гор).
        drawBuildingShadow(p, x, base, width, height) {
            const half = Math.ceil(width / 2) + 1;
            const length = Math.max(2, Math.round(height * 0.55));
            for (let dx = -half; dx <= half + length; dx++) {
                const edge = dx > half ? 1 - (dx - half) / (length + 1) : 1;
                p.blend(x + dx, base + 1, BLACK, 0.5 * edge);
                p.blend(x + dx, base + 2, BLACK, 0.3 * edge);
                if (dx > -half + 1 && dx < half + length - 1) p.blend(x + dx, base, BLACK, 0.2 * edge);
            }
        }
    };
}

/* ============================================================
   Texture — текстура земли: крапинки, детали, трава

   Раскладка крапинок (speckLayout) от сезона не зависит и считается один раз; трава и детали сезона (цветы, листья) — каждый раз.
   ============================================================ */
{
    MapPaint.Texture = {
        defaults: {
            grassDensity: 1  // густота пучков травы (множитель)
        },

        enabled: p => p.layers.texture,

        paint(p) {
            const map = p.map;
            const { T } = p.dim;
            const speckCount = Math.round(T * T / 16);
            const specks = this.speckLayout(p, speckCount);

            p.forEachRegionTile((x, y) => {
                const i = map.index(x, y);
                const isLand = map.isLand(i);

                // Едва заметные светлые и тёмные точки — чтобы поверхность не выглядела плоской заливкой.
                if (map.terrain[i] !== Terrain.MOUNTAIN) {
                    const base = i * speckCount;
                    for (let k = 0; k < speckCount; k++) {
                        const code = specks[base + k];                 // пиксель в клетке и «светлее/темнее» — посчитаны заранее
                        const at = (y * T + (code >> 9)) * p.width + x * T + ((code >> 1) & 255);
                        p.pixels[at] = speckColor(p.pixels[at], code & 1);
                    }
                }

                if (!isLand) {
                    if (tileHash(x, y, 9) % 6 === 0) {
                        for (let dx = 0; dx < p.px(3); dx++) p.blend(x * T + p.px(3) + dx, y * T + p.px(5), WHITE, 0.25);
                    }
                } else if (p.view === 'terrain') {
                    this.paintGroundDetail(p, x, y, i);
                    this.paintTufts(p, x, y, i);
                }
            });
        },

        // Расположение крапинок: одинаково при любом сезоне и виде, поэтому считается один раз на карту.
        speckLayout(p, speckCount) {
            const { size, T } = p.dim;
            return p.memo('specks', [size, T, p.seedSalt], () => {
                const layout = new Int32Array(size * size * speckCount);
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        let h = tileHash(x, y, 200) | 1;
                        for (let k = 0; k < speckCount; k++) {
                            h ^= h << 13; h ^= h >>> 17; h ^= h << 5;   // xorshift: дёшево получаем следующие «случайные» числа
                            const r = h >>> 0;
                            layout[(y * size + x) * speckCount + k] = ((((r >>> 8) % T) << 9) | ((r % T) << 1) | ((r >>> 20) & 1));
                        }
                    }
                }

                return layout;
            });
        },

        // Сезонные мелочи на лугах: весной цветы, осенью опавшая листва.
        paintGroundDetail(p, x, y, i) {
            const colors = p.pal.groundDetail;
            const map = p.map;
            if (!colors || map.terrain[i] !== Terrain.PLAIN || map.biome[i] !== Biome.GRASSLAND || map.river[i] || map.resource[i] === Resource.SETTLEMENT || map.roadLevel[i] > 0) return;
            if (tileHash(x, y, 100) % 3 !== 0) return;

            const { T } = p.dim;
            for (let k = 0; k < 3; k++) {
                const h = tileHash(x, y, 101 + k);
                p.put(x * T + (h % T), y * T + ((h >>> 8) % T), hexToPacked(colors[h % colors.length]));
            }
        },

        // Трава: пучки стебельков. Чем плодороднее и влажнее место, тем их больше; цвет — оттенки земли под ними.
        paintTufts(p, x, y, i) {
            const map = p.map;
            if (map.terrain[i] !== Terrain.PLAIN || map.river[i] || map.shore[i] === Shore.BEACH || map.resource[i] === Resource.SETTLEMENT || map.roadLevel[i] > 0) return;

            const moisture = map.moisture[i];
            let count;
            switch (map.biome[i]) {
                case Biome.GRASSLAND: count = 1 + 7 * Math.pow(moisture, 1.3); break;
                case Biome.TAIGA: count = 1 + 3 * moisture; break;
                case Biome.SAVANNA: count = 2 + 3 * moisture; break;
                case Biome.STEPPE: count = 1 + 2 * moisture; break;
                case Biome.TUNDRA: count = 0.4 + 1.2 * moisture; break;
                default: return;
            }
            count = Math.round(count * p.options.grassDensity * (map.resource[i] === Resource.WOOD ? 0.6 : 1));

            const { T, W } = p.dim;
            for (let n = 0; n < count; n++) {
                const h = tileHash(x, y, 400 + n);
                const bx = x * T + (h % T);
                const by = y * T + ((h >>> 8) % T);
                const ground = p.pixels[Math.min(by, W - 1) * W + Math.min(bx, W - 1)];
                const dark = shadeFast(ground, -56);
                const light = shadeFast(ground, 46);
                const blades = 2 + ((h >>> 16) % 2);
                const lean = ((h >>> 18) % 3) - 1;

                for (let b = 0; b < blades; b++) {
                    const bladeHeight = p.px(2) + 1 + ((h >>> (20 + b)) & 1);
                    for (let step = 0; step < bladeHeight; step++) {
                        p.putGround(bx + b + (step >= 2 ? lean : 0), by - step, step === bladeHeight - 1 ? light : dark);
                    }
                }
            }
        }
    };
}

/* ============================================================
   PixelRegions — чей пиксель: регион каждого пикселя карты

   Пиксель наследует регион своей клетки, но береговая линия скруглена и русла рек уже клетки, поэтому: пиксели воды и реки не
   принадлежат никому, а клочки суши в клетках без региона достаются ближайшему региону — граница доходит до самой воды. Потом границы
   сглаживаются (скользящее окно, см. smoothPixelRegions). Результат не зависит от сезона.
   ============================================================ */
{
    MapPaint.PixelRegions = {
        defaults: {
            regionBorderSmoothing: 7  // радиус (в пикселях) сглаживания углов границ регионов: больше — круглее; 0 — не сглаживать
        },

        // Чей пиксель: номер региона для каждого пикселя карты или -1 (вода, река, ничья земля).
        // Пиксель наследует регион своей клетки, но береговая линия скруглена и русла рек уже клетки, поэтому:
        //  - пиксели воды и реки не принадлежат никому (граница на них не рисуется);
        //  - клочки суши в клетках без региона (берег реки, выступ суши за краем клетки у моря) достаются ближайшему региону,
        //    чтобы граница дошла до самой воды и шла вдоль берега, а не обрывалась на краю клетки.
        // Результат не зависит от сезона — при смене сезона пересчитывать не нужно.
        build(p) {
            const { map, options } = p;
            const key = [p.view, p.tileSize, options.coastSmoothing, options.regionBorderSmoothing].join('|');
            return p.memo('pixelRegions', [map.regionId, map.terrain, key, p.riverMask], () => this.computePixelRegions(p));
        },

        computePixelRegions(p) {
            const { size, regionId } = p.map;
            const { T, W } = p.dim;
            const water = p.waterMask;
            const river = p.riverMask;
            const owner = new Int16Array(W * W).fill(-1);

            for (let ty = 0; ty < size; ty++) {
                for (let tx = 0; tx < size; tx++) {
                    const id = regionId[ty * size + tx];
                    if (id < 0) continue;
                    for (let oy = 0; oy < T; oy++) {
                        const start = (ty * T + oy) * W + tx * T;
                        owner.fill(id, start, start + T);
                    }
                }
            }
            for (let k = 0; k < owner.length; k++) {
                if (water[k] || (river && river[k])) owner[k] = -1;
            }

            // Свободная суша есть только в клетках без региона рядом с регионами — собираем её пиксели.
            const pending = [];
            p.forEachTile((tx, ty) => {
                if (regionId[ty * size + tx] >= 0 || !p.anyAround(tx, ty, j => regionId[j] >= 0)) return;
                for (let oy = 0; oy < T; oy++) {
                    const row = (ty * T + oy) * W + tx * T;
                    for (let ox = 0; ox < T; ox++) {
                        const k = row + ox;
                        if (!water[k] && !(river && river[k])) pending.push(k);
                    }
                }
            });

            // Заливка слоями: за шаг пиксель получает регион большинства уже занятых соседей.
            p.spreadMajority(pending, T, owner, (k, j) => owner[j]);
            return this.smoothPixelRegions(p, owner);
        },

        /* Скругление границ регионов — тот же приём, что и у берега: мажоритарный фильтр. Каждый пиксель суши получает
           регион, которому принадлежит большинство пикселей суши в круге радиуса regionBorderSmoothing (при равенстве
           остаётся как был). Ступеньки по клеткам и прямые углы превращаются в плавные изгибы. Вода и реки не голосуют и
           не меняются, поэтому границы по-прежнему упираются в берег. Работаем только вблизи границ. */
        /* Сглаживание границ: каждый пиксель рядом с границей (в радиусе radius) переходит к региону, за который «голосует»
           большинство пикселей круга радиуса radius вокруг него (при равенстве остаётся свой, потом — кто встретился первым).
           Голосование идёт по снимку, чтобы результат не зависел от порядка обхода.
           Круг не пересчитывается заново для каждого пикселя: идя по строке, мы сдвигаем окно на пиксель (в каждой из строк круга
           одна точка добавляется, одна убирается). Результат тот же, что у прямого перебора (smoothPixelRegionsDirect), только в разы быстрее. */
        smoothPixelRegions(p, owner) {
            const radius = p.options.regionBorderSmoothing;
            if (!radius) return owner;
            const { W } = p.dim;
            const total = W * W;

            // круг: в строке dy точки от -half[dy] до +half[dy]
            const half = new Int32Array(2 * radius + 1);
            for (let dy = -radius; dy <= radius; dy++) {
                let h = 0;
                while ((h + 1) * (h + 1) + dy * dy <= radius * radius + 0.25) h++;
                half[dy + radius] = h;
            }

            // 1) пиксели рядом с границей (в радиусе radius)
            const near = new Uint8Array(total);
            const stamp = (cx, cy) => {
                for (let dy = -radius; dy <= radius; dy++) {
                    const y = cy + dy;
                    if (y < 0 || y >= W) continue;
                    const h = half[dy + radius];
                    near.fill(1, y * W + Math.max(0, cx - h), y * W + Math.min(W - 1, cx + h) + 1);   // пиксели вне регионов отсеем при голосовании
                }
            };
            for (let k = 0; k < total; k++) {
                const id = owner[k];
                if (id < 0) continue;
                const x = k % W;
                const right = x < W - 1 ? owner[k + 1] : -1;
                const below = k < total - W ? owner[k + W] : -1;
                if ((right >= 0 && right !== id) || (below >= 0 && below !== id)) stamp(x, (k - x) / W);
            }

            // 2) голосование: окно (какие регионы и сколько пикселей каждого в круге)
            const result = Int16Array.from(owner);
            const MAX_DISTINCT = 16;                       // у прямого перебора больше 16 разных регионов в круге не учитываются
            let maxId = 0;
            for (let k = 0; k < total; k++) if (owner[k] > maxId) maxId = owner[k];
            const count = new Int32Array(maxId + 1);       // сколько пикселей региона в окне
            const active = new Int16Array((2 * radius + 1) * (2 * radius + 1) + 1);   // регионы, которые сейчас в окне
            let distinct = 0;
            const add = id => {
                if (count[id]++ === 0) active[distinct++] = id;
            };
            const remove = id => {
                if (--count[id] !== 0) return;
                for (let s = 0; s < distinct; s++) {         // регион ушёл из окна: на его место — последний
                    if (active[s] === id) { active[s] = active[--distinct]; return; }
                }
            };
            const fill = (x, y) => {                       // окно с нуля
                for (let s = 0; s < distinct; s++) count[active[s]] = 0;
                distinct = 0;
                for (let dy = -radius; dy <= radius; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= W) continue;
                    const h = half[dy + radius];
                    for (let nx = Math.max(0, x - h); nx <= Math.min(W - 1, x + h); nx++) {
                        const id = owner[ny * W + nx];
                        if (id >= 0) add(id);
                    }
                }
            };

            for (let y = 0; y < W; y++) {
                let inRun = false;
                for (let x = 0; x < W; x++) {
                    const k = y * W + x;
                    if (!near[k] || owner[k] < 0) { inRun = false; continue; }

                    if (!inRun) {
                        fill(x, y);
                        inRun = true;
                    } else {                               // окно сдвинулось с (x - 1) на x
                        for (let dy = -radius; dy <= radius; dy++) {
                            const ny = y + dy;
                            if (ny < 0 || ny >= W) continue;
                            const h = half[dy + radius];
                            const gone = x - 1 - h, came = x + h;
                            const left = gone >= 0 ? owner[ny * W + gone] : -1;
                            const right = came < W ? owner[ny * W + came] : -1;
                            if (left === right) continue;    // ушёл и пришёл один регион (или оба «пустые»): окно не изменилось
                            if (left >= 0) remove(left);
                            if (right >= 0) add(right);
                        }
                    }

                    // победитель: регион с наибольшим числом пикселей (строго больше, чем у своего)
                    const own = owner[k];
                    const ownVotes = count[own];
                    let top = 0, topId = 0, leaders = 0;
                    for (let s = 0; s < distinct; s++) {
                        const votes = count[active[s]];
                        if (votes > top) { top = votes; topId = active[s]; leaders = 1; } else if (votes === top) leaders++;
                    }
                    if (distinct > MAX_DISTINCT || (top > ownVotes && leaders > 1)) {
                        // редкие случаи (много регионов или ничья): порядок «кто встретился первым» знает только прямой перебор
                        result[k] = this.voteDirect(p, owner, x, y, radius, half);
                    } else {
                        result[k] = top > ownVotes ? topId : own;
                    }
                }
            }
            return result;
        },

        // Прямое голосование по кругу для одного пикселя: так считает smoothPixelRegionsDirect. Нужно для ничьих и «толпы» регионов.
        voteDirect(p, owner, x, y, radius, half) {
            const { W } = p.dim;
            const ids = new Int16Array(16), votes = new Int32Array(16);
            const own = owner[y * W + x];
            let distinct = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= W) continue;
                const h = half[dy + radius];
                for (let dx = -h; dx <= h; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= W) continue;
                    const id = owner[ny * W + nx];
                    if (id < 0) continue;
                    let slot = 0;
                    while (slot < distinct && ids[slot] !== id) slot++;
                    if (slot === distinct) {
                        if (distinct === 16) continue;
                        ids[distinct] = id;
                        votes[distinct] = 0;
                        distinct++;
                    }
                    votes[slot]++;
                }
            }
            let ownVotes = 0;
            for (let s = 0; s < distinct; s++) if (ids[s] === own) ownVotes = votes[s];
            let best = own, bestVotes = ownVotes;
            for (let s = 0; s < distinct; s++) {
                if (votes[s] > bestVotes) { best = ids[s]; bestVotes = votes[s]; }
            }
            return best;
        },

        smoothPixelRegionsDirect(p, owner) {
            const radius = p.options.regionBorderSmoothing;
            if (!radius) return owner;
            const { W } = p.dim;
            const total = W * W;

            // круг радиуса radius в виде списка смещений
            const dxs = [], dys = [];
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    if (dx * dx + dy * dy <= radius * radius + 0.25) { dxs.push(dx); dys.push(dy); }
                }
            }

            // 1) пиксели рядом с границей (в радиусе radius)
            const near = new Uint8Array(total);
            const list = [];
            const stamp = (cx, cy) => {
                for (let n = 0; n < dxs.length; n++) {
                    const x = cx + dxs[n], y = cy + dys[n];
                    if (x < 0 || y < 0 || x >= W || y >= W) continue;
                    const k = y * W + x;
                    if (!near[k] && owner[k] >= 0) { near[k] = 1; list.push(k); }
                }
            };
            for (let k = 0; k < total; k++) {
                const id = owner[k];
                if (id < 0) continue;
                const x = k % W;
                const right = x < W - 1 ? owner[k + 1] : -1;
                const below = k < total - W ? owner[k + W] : -1;
                if ((right >= 0 && right !== id) || (below >= 0 && below !== id)) stamp(x, (k - x) / W);
            }

            // 2) голосование по снимку (чтобы результат не зависел от порядка обхода)
            const result = Int16Array.from(owner);
            const ids = new Int16Array(16);
            const votes = new Int32Array(16);
            for (const k of list) {
                const x = k % W, y = (k - x) / W;
                const own = owner[k];
                let distinct = 0;
                for (let n = 0; n < dxs.length; n++) {
                    const nx = x + dxs[n], ny = y + dys[n];
                    if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
                    const id = owner[ny * W + nx];
                    if (id < 0) continue;
                    let slot = 0;
                    while (slot < distinct && ids[slot] !== id) slot++;
                    if (slot === distinct) {
                        if (distinct === 16) continue;
                        ids[distinct] = id;
                        votes[distinct] = 0;
                        distinct++;
                    }
                    votes[slot]++;
                }
                let ownVotes = 0;
                for (let s = 0; s < distinct; s++) if (ids[s] === own) ownVotes = votes[s];
                let best = own, bestVotes = ownVotes;
                for (let s = 0; s < distinct; s++) {
                    if (votes[s] > bestVotes) { best = ids[s]; bestVotes = votes[s]; }
                }
                result[k] = best;
            }
            return result;
        }
    };
}

/* ============================================================
   Borders — границы регионов

   Линия между регионами по реальной (сглаженной) форме; вдоль берега и рек — по настройке regionShoreBorder.
   ============================================================ */
{
    MapPaint.Borders = {
        defaults: {
            regionShoreBorder: false  // граница региона идёт и вдоль берега моря, озёр и рек (реки в регионы не входят)
        },

        enabled: p => p.showBorders && p.layers.borders,

        build(p) {
            MapPaint.PixelRegions.build(p);
        },

        // Тонкая линия там, где соседние пиксели принадлежат разным регионам. Воды и рек в регионах нет, поэтому граница
        // доходит до берега и дальше не идёт; в горах делаем её бледнее.
        paint(p) {
            const { W } = p.dim;
            const relief = p.reliefHeight;
            const color = p.colors.regionBorder;
            const owner = MapPaint.PixelRegions.build(p);
            const last = W * (W - 1);
            const shore = p.options.regionShoreBorder;
            const water = p.waterMask, river = p.riverMask;
            const isWet = j => water[j] === 1 || (river !== null && river[j] > 0);

            const r = p.region;
            for (let y = r.y0; y < r.y1; y++) {
                for (let x = r.x0; x < r.x1; x++) {
                    const k = y * W + x;
                    const id = owner[k];
                    if (id < 0) continue;
                    const right = x < W - 1 ? owner[k + 1] : -1;
                    const below = k < last ? owner[k + W] : -1;
                    let border = (right >= 0 && right !== id) || (below >= 0 && below !== id);
                    // Береговая линия: пиксель суши рядом с морем, озером или рекой тоже граница региона (реки в регионы не входят).
                    if (!border && shore) {
                        border = (x > 0 && owner[k - 1] < 0 && isWet(k - 1)) || (x < W - 1 && owner[k + 1] < 0 && isWet(k + 1))
                            || (k >= W && owner[k - W] < 0 && isWet(k - W)) || (k < W * (W - 1) && owner[k + W] < 0 && isWet(k + W));
                    }
                    if (!border) continue;

                    const alpha = relief ? 0.6 - 0.5 * Math.min(1, relief[k] / 110) : 0.6; // в горах границы почти растворяются
                    p.pixels[k] = mixPacked(p.pixels[k], color, alpha);
                }
            }
        }
    };
}

/* ============================================================
   Cells — ячейки карты и контуры для выделения

   На какую клетку «работает» каждый пиксель. Внутри региона ячейка — обычный квадрат клетки; у берега, рек и границ регионов она
   подгоняется под форму региона. По ячейкам строятся контуры выделения клетки и региона (outline, regionOutline).
   ============================================================ */
{
    MapPaint.Cells = {
        /* Ячейки: на какую клетку карты «работает» каждый пиксель (Int32Array, индекс клетки или -1).
           Внутри региона ячейка — обычный квадрат клетки. У берега, рек и границ регионов она подгоняется под форму региона:
           пиксель принадлежит ячейке своей клетки, только если клетка того же региона; пиксели, которые сглаженная граница
           или берег реки увели в чужую клетку (или в воду), достаются ближайшей ячейке того же региона. Вода и реки делятся на
           обычные квадраты своих клеток. Так регион (и вся карта) разбиты на непересекающиеся ячейки, а по логике это всё те
           же клетки. */
        build(p) {
            const owner = MapPaint.PixelRegions.build(p);
            return p.memo('cellMap', [owner], () => {
                const { size, regionId } = p.map;
                const { T, W } = p.dim;
                const cellOf = new Int32Array(W * W).fill(-1);
                const pending = [];
                p.forEachTile((tx, ty) => {
                    const tile = ty * size + tx, own = regionId[tile];
                    for (let oy = 0; oy < T; oy++) {
                        const row = (ty * T + oy) * W + tx * T;
                        for (let ox = 0; ox < T; ox++) {
                            const k = row + ox, id = owner[k];
                            if (id >= 0 ? id === own : own < 0) cellOf[k] = tile;   // пиксель на «своём» месте
                            else pending.push(k);
                        }
                    }
                });

                // Чужие пиксели заливаем слоями от своих: берём ячейку большинства соседей с тем же регионом (или водой).
                const rest = p.spreadMajority(pending, 2 * T, cellOf, (k, j) => (owner[j] === owner[k] ? cellOf[j] : -1));
                for (const k of rest) cellOf[k] = p.tileOf(k);   // запасной вариант
                return cellOf;
            });
        },

        /* Контур области пикселей: замкнутые ломаные в пикселях карты (координаты — углы пикселей). inside(x, y) говорит,
           входит ли пиксель в область; ищем её только в рамке x0..x1, y0..y1. Обход по часовой стрелке, внутри — справа.
           Потом углы скругляются срезанием углов Чайкина (smoothing раз). Если keepCorners > 0, вершины, примыкающие к прямому
           отрезку длиннее keepCorners пикселей, остаются острыми: прямые линии (например, линии сетки) и их углы не округляются,
           сглаживаются только мелкие ступеньки. Контуров несколько, если у области есть отдельные куски или дыры. */
        trace(p, inside, x0, y0, x1, y1, smoothing, keepCorners = 0) {
            const { W } = p.dim;
            const stride = W + 1;
            const outgoing = new Map();                                   // вершина (y * stride + x) -> рёбра, выходящие из неё
            const addEdge = (x, y, direction) => {                        // 0 — на восток, 1 — на юг, 2 — на запад, 3 — на север
                const key = y * stride + x;
                const list = outgoing.get(key);
                if (list) list.push(direction); else outgoing.set(key, [direction]);
            };
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    if (!inside(x, y)) continue;
                    if (!inside(x, y - 1)) addEdge(x, y, 0);             // верхняя сторона пикселя
                    if (!inside(x + 1, y)) addEdge(x + 1, y, 1);         // правая
                    if (!inside(x, y + 1)) addEdge(x + 1, y + 1, 2);     // нижняя
                    if (!inside(x - 1, y)) addEdge(x, y + 1, 3);         // левая
                }
            }

            const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
            const loops = [];
            for (const [startKey, startList] of outgoing) {
                const startX = startKey % stride, startY = Math.floor(startKey / stride);
                while (startList.length > 0) {
                    // Идём по рёбрам, пока не вернёмся в начальную вершину. В развилке (два пикселя касаются углами) поворачиваем направо.
                    let direction = startList.pop();
                    let x = startX, y = startY;
                    const points = [];
                    for (;;) {
                        points.push([x, y]);
                        x += DX[direction];
                        y += DY[direction];
                        if (x === startX && y === startY) break;
                        const list = outgoing.get(y * stride + x);
                        if (!list || list.length === 0) break;
                        let pick = -1;
                        for (const turn of [1, 0, 3]) {                  // направо, прямо, налево
                            const candidate = (direction + turn) % 4;
                            if (list.includes(candidate)) { pick = candidate; break; }
                        }
                        if (pick < 0) break;
                        list.splice(list.indexOf(pick), 1);
                        direction = pick;
                    }
                    loops.push(points);
                }
            }

            const result = [];
            for (const raw of loops) {
                // убираем лишние вершины на прямых отрезках
                let points = raw.filter((pt, n) => {
                    const a = raw[(n + raw.length - 1) % raw.length], b = raw[(n + 1) % raw.length];
                    return (pt[0] - a[0]) * (b[1] - pt[1]) !== (pt[1] - a[1]) * (b[0] - pt[0]);
                });
                if (points.length < 4) continue;
                let area = 0;
                for (let n = 0; n < points.length; n++) {
                    const a = points[n], b = points[(n + 1) % points.length];
                    area += a[0] * b[1] - b[0] * a[1];
                }
                if (Math.abs(area) / 2 < 6) continue;                    // случайные одиночные пиксели
                let sharp = points.map((pt, n) => {
                    if (keepCorners <= 0) return false;
                    const a = points[(n + points.length - 1) % points.length], b = points[(n + 1) % points.length];
                    return Math.hypot(pt[0] - a[0], pt[1] - a[1]) >= keepCorners || Math.hypot(b[0] - pt[0], b[1] - pt[1]) >= keepCorners;
                });
                for (let pass = 0; pass < smoothing; pass++) {
                    const next = [], nextSharp = [];
                    const add = (point, isSharp) => {
                        const last = next[next.length - 1];
                        if (last && last[0] === point[0] && last[1] === point[1]) { nextSharp[nextSharp.length - 1] = nextSharp[nextSharp.length - 1] || isSharp; return; }
                        next.push(point);
                        nextSharp.push(isSharp);
                    };
                    for (let n = 0; n < points.length; n++) {
                        const m = (n + 1) % points.length;
                        const a = points[n], b = points[m];
                        add(sharp[n] ? a : [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], sharp[n]);
                        add(sharp[m] ? b : [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]], sharp[m]);
                    }
                    if (next.length > 1 && next[0][0] === next[next.length - 1][0] && next[0][1] === next[next.length - 1][1]) {
                        nextSharp[0] = nextSharp[0] || nextSharp[next.length - 1];   // шов: последняя точка совпала с первой
                        next.pop();
                        nextSharp.pop();
                    }
                    points = next;
                    sharp = nextSharp;
                }
                result.push(points);
            }
            return result;
        },

        /* Контур региона для выделения по клику: из той же скруглённой попиксельной карты регионов, на которой стоят границы
           (buildPixelRegions), поэтому обводка в точности повторяет видимую форму региона, а не его клетки.
           Вызывать после paint(). Если карта ещё не нарисована, возвращает null. */
        regionOutline(p, regionId, smoothing = 3) {
            if (!p.waterMask) return null;
            const owner = MapPaint.PixelRegions.build(p);
            const { size, regionId: ids } = p.map;
            const { T, W } = p.dim;

            // рамка региона (в клетках, с запасом на заливку берега: пиксели у реки могут лежать в соседних клетках)
            let left = size, top = size, right = -1, bottom = -1;
            for (let i = 0; i < ids.length; i++) {
                if (ids[i] !== regionId) continue;
                const x = i % size, y = (i - x) / size;
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < top) top = y;
                if (y > bottom) bottom = y;
            }
            if (right < 0) return [];
            const x0 = Math.max(0, (left - 1) * T), y0 = Math.max(0, (top - 1) * T);
            const x1 = Math.min(W, (right + 2) * T), y1 = Math.min(W, (bottom + 2) * T);
            const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < W && owner[y * W + x] === regionId;
            return this.trace(p, inside, x0, y0, x1, y1, smoothing);
        },

        // Ячейка в точке мира (пиксели карты): индекс клетки или -1. После paint().
        at(p, worldX, worldY) {
            if (!p.waterMask) return -1;
            const { W } = p.dim;
            const x = Math.floor(worldX), y = Math.floor(worldY);
            if (x < 0 || y < 0 || x >= W || y >= W) return -1;
            return this.build(p)[y * W + x];
        },

        /* Контур ячейки клетки tile (индекс): замкнутые ломаные в пикселях карты или null, если карта не нарисована.
           Прямые участки (линии сетки длиннее keepCorners пикселей) и их углы остаются строго прямыми, а ступеньки вдоль воды и
           границ сглаживаются. keepCorners = 0 — скруглять всё, smoothing = 0 — точная форма по пикселям. */
        outline(p, tile, smoothing = 2, keepCorners = 5) {
            if (!p.waterMask) return null;
            const cellOf = this.build(p);
            const { size } = p.map;
            const { T, W } = p.dim;
            const tx = tile % size, ty = Math.floor(tile / size);
            const x0 = Math.max(0, (tx - 1) * T), y0 = Math.max(0, (ty - 1) * T);
            const x1 = Math.min(W, (tx + 2) * T), y1 = Math.min(W, (ty + 2) * T);
            const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < W && cellOf[y * W + x] === tile;
            return this.trace(p, inside, x0, y0, x1, y1, smoothing, keepCorners);
        }
    };
}

/* ============================================================
   Grid — сетка клеток

   Прозрачный слой с линиями клеток (по ячейкам Cells). Рисуется отдельно от карты, поэтому включение сетки не перерисовывает карту;
   под спрайтами (деревья, дома) линий нет.
   ============================================================ */
{
    MapPaint.Grid = {
        defaults: {
            gridOpacity: 0.15  // насколько заметна сетка клеток (0..1)
        },

        /* Сетка клеток: прозрачный холст с линиями между соседними ячейками одного региона (и внутри воды). Границы между
           регионами не дублируем — они уже нарисованы на карте. Цвет линии подбирается по тому, что под ней: светлая линия на тёмном,
           тёмная на светлом. Рисуется отдельным слоем, поэтому включать и выключать сетку можно без перерисовки карты.
           Вызывать после paint(). */
        paint(p) {
            const owner = MapPaint.PixelRegions.build(p);
            const cellOf = MapPaint.Cells.build(p);
            const { W } = p.dim;
            const layer = p.createLayer();
            const lines = layer.pixels;
            const base = p.pixels;
            const alpha = Math.round(255 * p.options.gridOpacity);
            const light = (255 << 16 | 255 << 8 | 255) | (alpha << 24);   // RGBA в порядке байтов r, g, b, a (little-endian)
            const dark = alpha << 24;

            const covered = p.spriteMask;                         // сетка тоже идёт по земле: под деревьями и домами её не видно
            for (let k = 0; k < cellOf.length; k++) {
                const cell = cellOf[k];
                if (cell < 0 || covered[k] === 1) continue;
                const x = k % W, id = owner[k];
                const right = x < W - 1 && owner[k + 1] === id && cellOf[k + 1] !== cell;
                const below = k < W * (W - 1) && owner[k + W] === id && cellOf[k + W] !== cell;
                if (!right && !below) continue;
                const color = base[k];
                const luminance = ((color & 255) * 299 + ((color >> 8) & 255) * 587 + ((color >> 16) & 255) * 114) / 1000;
                lines[k] = luminance > 120 ? dark : light;
            }
            return layer.commit();
        }
    };
}

/* ============================================================
   Territories — территории фракций

   Прозрачный слой с цветной границей и лёгкой заливкой земель каждой территории (см. paint). Рисуется отдельно, как сетка,
   поэтому смена владения не перерисовывает карту.
   ============================================================ */
{
    MapPaint.Territories = {
        defaults: {
            factionBorder: 2,                // толщина цветной границы фракции в пикселях (для клетки 16×16; масштабируется вместе с клеткой)
            factionBorderOpacity: 0.75,
            factionFill: 0.2,                // лёгкая заливка земель фракции цветом фракции (0 — без заливки)
            factionCoastBorder: true,        // граница фракции идёт и вдоль берега моря и озёр
            factionRiverBorder: 'boundary'  // вдоль берегов рек: 'always' — всегда (река в территорию не входит), 'boundary' — только если на том берегу другая территория
        },

        /* Слой территорий: прозрачный холст (в пикселях карты) с цветной границей и лёгкой заливкой земель каждой территории.
           Граница идёт по реальной форме территории — по скруглённым границам регионов, а внутри региона по линиям сетки,
           если территория занимает его не целиком. Вдоль берега и рек её нет: они и так видны, а реки внутри территории не
           разрезают её на куски. Рисуется отдельным слоем (как сетка), поэтому смена владения не перерисовывает карту.

           territories — то, что нужно показать (его может передавать и faction manager):
             { id, color: '#d94a3a',
               tiles: [индексы клеток],  regions: [id регионов],       // что именно подсвечиваем (можно и то и другое)
               fill: 0.1,                                              // заливка (по умолчанию factionFill)
               border: 2 }                                             // толщина границы (по умолчанию factionBorder)
           Более поздняя территория перекрывает более раннюю там, где они пересекаются. Вызывать после paint(). */
        paint(p, territories = this.fromMap(p)) {
            const { T, W } = p.dim;
            const owner = MapPaint.PixelRegions.build(p);
            const cellOf = MapPaint.Cells.build(p);
            const tileTerritory = this.tileTerritories(p, territories);

            // пиксель -> номер территории (только земля; воду и реки не красим)
            const pixelTerritory = new Int16Array(W * W).fill(-1);
            for (let k = 0; k < pixelTerritory.length; k++) {
                if (owner[k] >= 0 && cellOf[k] >= 0) pixelTerritory[k] = tileTerritory[cellOf[k]];
            }

            const widths = territories.map(t => Math.max(1, Math.round((t.border ?? p.options.factionBorder) * T / 16)));
            const depth = this.territoryBorderDepth(p, pixelTerritory, owner, Math.max(1, ...widths));

            const layer = p.createLayer();
            const pixels = layer.pixels;
            const rgb = territories.map(t => {
                const c = hexToPacked(t.color || '#999999');
                return (c & 255) | (((c >> 8) & 255) << 8) | (((c >> 16) & 255) << 16);
            });
            const borderAlpha = Math.round(255 * p.options.factionBorderOpacity);
            const fillAlpha = territories.map(t => Math.round(255 * clamp(t.fill ?? p.options.factionFill)));

            const covered = p.spriteMask;                         // под деревьями, домами и рудами слой не рисуем: граница идёт «по земле»
            for (let k = 0; k < pixelTerritory.length; k++) {
                const t = pixelTerritory[k];
                if (t < 0 || covered[k] === 1) continue;
                const alpha = depth[k] > 0 && depth[k] <= widths[t] ? borderAlpha : fillAlpha[t];
                if (alpha > 0) pixels[k] = rgb[t] | (alpha << 24);
            }
            return layer.commit();
        },

        // Территории фракций по состоянию, которое faction manager передал в карту (map.factions и map.tileFaction), в формате для paintTerritories: [{ id, color, tiles }].
        fromMap(p) {
            const map = p.map;
            if (!map.factions || map.factions.length === 0) return [];
            const tiles = map.factions.map(() => []);
            for (let i = 0; i < map.tileFaction.length; i++) {
                const owner = map.tileFaction[i];
                if (owner >= 0 && tiles[owner]) tiles[owner].push(i);
            }
            return map.factions.map(f => ({ id: f.id, color: f.color, tiles: tiles[f.id] }));
        },

        // Клетка -> номер территории в списке (-1 — ничья). Территория задаётся клетками (tiles) и/или регионами (regions).
        tileTerritories(p, territories) {
            const map = p.map;
            const { size } = p.dim;
            const tileTerritory = new Int16Array(size * size).fill(-1);
            let regionTiles = null;
            territories.forEach((territory, n) => {
                for (const tile of territory.tiles || []) if (tile >= 0 && tile < tileTerritory.length) tileTerritory[tile] = n;
                if (territory.regions && territory.regions.length > 0) {
                    if (!regionTiles) {
                        regionTiles = new Map();
                        for (const i of map.landTiles) {
                            const id = map.regionId[i];
                            if (id < 0) continue;
                            const list = regionTiles.get(id);
                            if (list) list.push(i); else regionTiles.set(id, [i]);
                        }
                    }
                    for (const id of territory.regions) for (const tile of regionTiles.get(id) || []) tileTerritory[tile] = n;
                }
            });
            return tileTerritory;
        },

        /* Толщина границы по пикселям территории: 1 — самый край, дальше внутрь до maxWidth. Граница — пиксели территории, рядом с
           которыми (по стороне) земля другой территории или ничья. У реки смотрим через русло на противоположный берег: граница
           есть, только если там уже другая территория (река внутри территории её не режет). */
        territoryBorderDepth(p, pixelTerritory, owner, maxWidth) {
            const { W } = p.dim;
            const river = p.riverMask, water = p.waterMask;
            const coast = p.options.factionCoastBorder;
            const riverAlways = p.options.factionRiverBorder !== 'boundary';
            const total = pixelTerritory.length;
            const DX = [-1, 1, 0, 0], DY = [0, 0, -1, 1];
            const depth = new Uint8Array(W * W);
            let frontier = [];
            for (let k = 0; k < total; k++) {
                const t = pixelTerritory[k];
                if (t < 0) continue;
                const x = k % W, y = (k - x) / W;
                let edge = false;
                for (let d = 0; d < 4 && !edge; d++) {
                    let nx = x + DX[d], ny = y + DY[d];
                    if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
                    const j = ny * W + nx;
                    if (owner[j] >= 0) {                                   // земля: граница, если там другая территория или ничья
                        edge = pixelTerritory[j] !== t;
                    } else if (water[j]) {
                        edge = coast;
                    } else if (river && river[j] > 0) {
                        if (riverAlways) { edge = true; continue; }       // граница вдоль любого берега реки
                        for (let n = 0; n < 40; n++) {                     // иначе идём поперёк до противоположного берега
                            nx += DX[d];
                            ny += DY[d];
                            if (nx < 0 || ny < 0 || nx >= W || ny >= W) break;
                            const m = ny * W + nx;
                            if (owner[m] >= 0) { edge = pixelTerritory[m] !== t; break; }
                            if (!(river[m] > 0)) break;                    // река кончилась (озеро, море): берега напротив нет
                        }
                    }
                }
                if (edge) {
                    depth[k] = 1;
                    frontier.push(k);
                }
            }
            for (let layer = 2; layer <= maxWidth; layer++) {
                const next = [];
                for (const k of frontier) {
                    const t = pixelTerritory[k], x = k % W;
                    for (const j of [x > 0 ? k - 1 : -1, x < W - 1 ? k + 1 : -1, k - W, k + W]) {
                        if (j < 0 || j >= pixelTerritory.length || depth[j] !== 0 || pixelTerritory[j] !== t) continue;
                        depth[j] = layer;
                        next.push(j);
                    }
                }
                frontier = next;
            }
            return depth;
        }
    };
}

/* ============================================================
   Scene — сцена: горы и декорации рисуются вместе, строка за строкой сверху вниз

   Декорации (деревья, дома, фермы, руды, эфир) собираются в список (collect: у каждого вида свой collect(p, items, ...))
   и рисуются в порядке «основания»: тот, что южнее, рисуется позже и перекрывает северных. Горы идут теми же строками.
   ============================================================ */
{
    MapPaint.Scene = {
        enabled: p => p.view === 'terrain' && (p.layers.decorations || p.layers.relief),

        /* Все декорации собираем в один список и рисуем по возрастанию «основания» (нижней точки):
           то, что стоит ниже на карте, перекрывает то, что выше, — как в перспективе. Деревья могут свободно
           выходить за границы своей клетки: порядок всё равно будет правильным. */
        // Рисует горы и декорации вместе, строка за строкой сверху вниз: так то, что южнее (ближе к зрителю),
        // перекрывает то, что севернее, — деревья и горы перекрывают друг друга правильно.
        paint(p) {
            const r = p.region;
            const items = p.layers.decorations ? this.collect(p) : [];
            const relief = p.layers.relief ? MapPaint.Mountains.prepareReliefRows(p) : null;
            const draw = item => {
                p.cover = item.cover === true;      // деревья, дома, руды и т. п. закрывают границы и сетку; травинки и поля — нет
                item.draw();
                p.cover = false;
            };

            // Горы идут строка за строкой с той строки, с которой область не отличается от полной отрисовки; всё, что стоит выше неё,
            // рисуется первым (как и при полной отрисовке: оно рисуется до этой строки).
            const from = relief ? MapPaint.Mountains.reliefStart(p, relief) : r.y0;
            let next = 0;
            while (next < items.length && items[next].y < from) draw(items[next++]);
            for (let gy = from; gy < r.y1; gy++) {
                if (relief) MapPaint.Mountains.paintRow(p, relief, gy);
                while (next < items.length && items[next].y <= gy) draw(items[next++]);
            }
        },

        // Список декораций региона, отсортированный по «основанию» (нижней точке). Каждый вид декораций добавляет свои в collect().
        collect(p) {
            const { map } = p;
            const items = [];
            const collectors = {                           // что рисовать для ресурса клетки
                [Resource.WOOD]: MapPaint.Trees, [Resource.SETTLEMENT]: MapPaint.Settlements, [Resource.WHEAT]: MapPaint.Farms,
                [Resource.GOLD]: MapPaint.Ores, [Resource.IRON]: MapPaint.Ores, [Resource.ETHER]: MapPaint.Ether
            };

            p.forEachRegionTile((x, y) => {
                const i = map.index(x, y);
                // На дорогах нет ни леса, ни полей, ни руд (кроме клеток поселений) — даже если карта сгенерирована старой версией.
                if (map.roadLevel[i] > 0 && map.resource[i] !== Resource.SETTLEMENT) return;
                const collector = collectors[map.resource[i]];
                if (collector) collector.collect(p, items, x, y, i);
            });

            items.sort((a, b) => a.y - b.y || a.x - b.x);
            return items;
        }
    };
}

/* ============================================================
   Trees — деревья: лиственные, хвойные, голые, пальмы и кактусы

   Вид, размер и посадка зависят от биома, температуры и сезона; зимой — голые деревья и снег на хвое. В жарких сухих биомах
   (саванна, пустыня) вместо обычных деревьев растут пальмы и кактусы: в саванне чаще пальмы, в пустыне — кактусы.
   ============================================================ */
{
    // Жаркие сухие биомы: процент пальм среди деревьев (остальное — кактусы). У прочих биомов деревья обычные.
    const PALM_SHARE = { [Biome.SAVANNA]: 65, [Biome.DESERT]: 30 };

    MapPaint.Trees = {
        // Два-три дерева на клетку, в случайных местах. Вид зависит от климата: в холодных краях ели, в тёплых лиственные.
        collect(p, items, x, y, i) {
            const map = p.map;
            const { T } = p.dim;
            const conifer = map.biome[i] === Biome.TAIGA || map.biome[i] === Biome.TUNDRA || map.temperature[i] < 0.45;
            const withSnow = conifer && p.pal.snowOnConifers && p.seasonalTemperature(i) < SNOW_TEMPERATURE;
            const palmShare = PALM_SHARE[map.biome[i]];            // доля пальм среди деревьев жаркого биома; у остальных биомов её нет

            const slots = [[0.26, 0.52], [0.74, 0.46], [0.5, 0.96]];
            const start = tileHash(x, y, 30) % slots.length;
            // Сколько деревьев растёт в клетке: полный лес — 2–3, молодой (экономика ещё не вырастила) — меньше, вплоть до одного.
            const full = 2 + (tileHash(x, y, 31) % 3 === 0 ? 1 : 0);
            const stage = map.growth ? growthStage(map.growth[i]) : GROWTH_STAGES;
            const count = stage === 0 ? 0 : Math.max(1, Math.round(full * stage / GROWTH_STAGES));

            for (let k = 0; k < count; k++) {
                const [fx, fy] = slots[(start + k) % slots.length];
                const cx = Math.round(x * T + fx * T + (hashUnit(x, y, 40 + k) - 0.5) * 0.25 * T);
                const base = Math.round(y * T + fy * T + (hashUnit(x, y, 50 + k) - 0.5) * 0.25 * T);
                const pick = tileHash(x, y, 60 + k);

                items.push({
                    y: base,
                    x: cx,
                    cover: true,
                    draw: () => {
                        if (palmShare !== undefined) this.drawHotTree(p, cx, base, pick, palmShare);
                        else if (conifer) this.drawConifer(p, cx, base, pick, withSnow);
                        else this.drawBroadleaf(p, cx, base, pick);
                    }
                });
            }
        },

        // Дерево жаркого биома: пальма или кактус (palmShare — процент пальм). Часть деревьев в тёмном стиле мертва, как и у лиственных.
        drawHotTree(p, cx, base, pick, palmShare) {
            const dead = hashUnit(cx, base, 79) < (p.pal.deadTreeChance || 0);
            if (pick % 100 < palmShare) this.drawPalm(p, cx, base, pick, dead);
            else this.drawCactus(p, cx, base, pick, dead);
        },

        // Пальма: слегка наклонный ствол с кольцами и крона из дугообразных листьев, свисающих вниз; свет сверху-слева.
        drawPalm(p, cx, base, pick, dead) {
            const pal = p.pal;
            const lean = (pick >>> 4) % 2 ? 1 : -1;                 // в какую сторону изгибается ствол
            const height = p.px(9) + (pick % 2);
            const trunk = shadePacked(p.packed.trunk, 0.12);
            const ring = shadePacked(p.packed.trunk, -0.22);
            let frond = hexToPacked(pal.broadleaf[pick % pal.broadleaf.length]);
            if (dead) frond = mixPacked(frond, p.packed.trunk, 0.7); // мёртвая пальма: бурые, высохшие листья
            const light = shadePacked(frond, 0.25);
            const dark = shadePacked(frond, -0.3);

            this.drawShadow(p, cx, base, p.px(5));
            let x = cx;                                              // ствол: вверх, на двух третях высоты сдвигается на пиксель
            for (let h = 0; h < height; h++) {
                if (h === Math.floor(height * 0.65)) x += lean;
                p.put(x, base - 1 - h, h % 2 ? ring : trunk);
            }

            const crownY = base - height;
            const reach = Math.max(2, p.px(4));
            for (const side of [-1, 1]) {                            // листья в стороны: чем дальше от ствола, тем ниже
                for (let k = 1; k <= reach; k++) {
                    const droop = Math.floor((k * k) / (reach + 1)) + (dead ? 1 : 0);
                    p.put(x + side * k, crownY - 1 + droop, side < 0 ? light : frond);
                    if (k >= 2) p.put(x + side * k, crownY + droop, side < 0 ? frond : dark);   // толщина листа
                }
                p.put(x + side, crownY - 2, side < 0 ? light : frond);                          // листья вверх по диагонали
            }
            p.put(x, crownY - 2, light);                                                         // центр кроны
            p.put(x, crownY - 1, frond);
            if (!dead && hashUnit(cx, base, 78) < 0.5) {                                         // кокосы под кроной
                p.put(x - 1, crownY + 1, p.packed.trunk);
                p.put(x + 1, crownY + 1, p.packed.trunk);
            }
        },

        // Кактус (сагуаро): ребристый ствол и одна-две «руки»; свет слева, в весеннем цвету — цветок на макушке.
        drawCactus(p, cx, base, pick, dead) {
            const pal = p.pal;
            let body = mixPacked(hexToPacked(pal.conifer[pick % pal.conifer.length]), packRgb(112, 158, 106), 0.55);   // серо-зелёный
            if (dead) body = mixPacked(body, p.packed.trunk, 0.65);  // мёртвый кактус: бурый
            const light = shadePacked(body, 0.22);
            const dark = shadePacked(body, -0.3);
            const wide = p.px(2) >= 2 ? 2 : 1;                       // ствол в 2 пикселя шириной (в 1 — на мелких клетках)
            const height = p.px(8) + (pick % 3);
            const left = cx - (wide >> 1);

            this.drawShadow(p, cx, base, p.px(4));
            for (let h = 0; h < height; h++) {
                const y = base - 1 - h;
                for (let w = 0; w < wide; w++) {
                    if (h === height - 1 && wide > 1 && w === 1) continue;              // скруглённая макушка
                    let shade = wide === 1 ? body : (w === 0 ? light : dark);
                    if (hashUnit(left + w, y, 78) < 0.14) shade = shade === dark ? body : light;   // иглы и рёбра
                    p.put(left + w, y, shade);
                }
            }

            // «руки»: вбок от ствола на высоте около середины, потом вверх
            const armY = base - 1 - Math.round(height * 0.45);
            const arms = pick % 4 === 0 ? [-1, 1] : [(pick >>> 3) % 2 ? 1 : -1];
            const reach = Math.max(1, p.px(2));
            const rise = Math.max(2, p.px(3));
            for (const side of arms) {
                const edge = side < 0 ? left - 1 : left + wide;
                for (let k = 0; k < reach; k++) p.put(edge + side * k, armY, side < 0 ? light : body);
                const armX = edge + side * (reach - 1) + side;
                for (let h = 0; h < rise; h++) p.put(armX, armY - h, side < 0 ? light : dark);
            }

            if (!dead && pal.blossom && pick % 3 === 0) p.put(left, base - height - 1, hexToPacked(pal.blossom));
        },

        // Овальная тень под деревом.
        drawShadow(p, cx, base, width) {
            const half = Math.floor(width / 2);
            for (let dx = -half; dx <= half; dx++) p.blend(cx + dx, base, BLACK, 0.22);
            for (let dx = -half + 1; dx <= half - 1; dx++) p.blend(cx + dx, base + 1, BLACK, 0.12);
        },

        // Лиственное дерево: округлая крона со светом сверху-слева, летом зелёное, весной в цвету, осенью рыже-золотое.
        drawBroadleaf(p, cx, base, pick) {
            const pal = p.pal;
            if (pal.bareTrees || hashUnit(cx, base, 79) < (pal.deadTreeChance || 0)) {   // зимой все голые; в тёмном стиле часть мертва и летом
                this.drawBareTree(p, cx, base, pick);
                return;
            }

            const width = p.px(7) + (pick % 2);
            const height = width;
            const trunkHeight = p.px(2) + 1;
            const trunkWidth = width >= 7 ? 2 : 1;
            const color = hexToPacked(pal.broadleaf[pick % pal.broadleaf.length]);
            const light = shadePacked(color, 0.22);
            const dark = shadePacked(color, -0.28);
            const top = base - trunkHeight - height + 2;

            this.drawShadow(p, cx, base, width);
            p.rect(cx - (trunkWidth >> 1), base - trunkHeight, trunkWidth, trunkHeight, p.packed.trunk);

            for (let row = 0; row < height; row++) {
                const t = ((row + 0.5) / height) * 2 - 1;
                const half = (width / 2) * Math.sqrt(1 - t * t);
                const x0 = Math.round(cx - half);
                const x1 = Math.round(cx + half) - 1;
                for (let x = x0; x <= x1; x++) {
                    const lean = (x - cx) + (row - height / 2);  // < 0 — верх-лево (освещено), > 0 — низ-право (тень)
                    let shade = lean < -width * 0.2 ? light : lean > width * 0.28 ? dark : color;
                    if (hashUnit(x, top + row, 77) < 0.12) shade = shade === dark ? color : dark; // листва «шуршит»
                    p.put(x, top + row, shade);
                }
            }

            if (pal.blossom && pick % 3 === 0) {
                const blossom = hexToPacked(pal.blossom);
                p.put(cx - 2, top + 2, blossom);
                p.put(cx + 1, top + 3, blossom);
                p.put(cx - 1, top + 5, blossom);
            }
        },

        // Голое дерево (зима): ствол и несколько веток.
        drawBareTree(p, cx, base, pick) {
            const trunk = p.packed.trunk;
            const height = p.px(8);
            this.drawShadow(p, cx, base, p.px(5));
            p.rect(cx, base - height, 1, height, trunk);

            const side = pick % 2 ? 1 : -1;
            for (let k = 1; k <= p.px(3); k++) {
                p.put(cx - k, base - height + k + 1, trunk);
                p.put(cx + k, base - height + k + 1 + (side > 0 ? 1 : 0), trunk);
            }
            p.put(cx + side, base - height - 1, trunk);
            if (p.mood === 'dark') {                                // кривые, корявые ветки
                p.put(cx + side * 2, base - height + 2, trunk);
                p.put(cx - side * 2, base - height + 4, trunk);
                p.put(cx + side, base - height + 5, trunk);
            }
        },

        // Ель: ярусы всё шире книзу; круглый год зелёная, зимой со снегом на лапах.
        drawConifer(p, cx, base, pick, withSnow) {
            const pal = p.pal;
            const color = hexToPacked(pal.conifer[pick % pal.conifer.length]);
            const light = shadePacked(color, 0.2);
            const dark = shadePacked(color, -0.3);
            const height = p.px(10) + (pick % 2);
            const maxHalf = Math.max(2, Math.round(p.px(6) / 2));
            const trunkHeight = p.px(2);
            const top = base - trunkHeight - height + 1;

            this.drawShadow(p, cx, base, p.px(6));
            p.rect(cx, base - trunkHeight, 1, trunkHeight, p.packed.trunk);

            for (let row = 0; row < height; row++) {
                const tierRow = row % 3;
                const half = Math.min(maxHalf, Math.floor(row * 0.34 + tierRow * 0.3 + 0.4));
                for (let dx = -half; dx <= half; dx++) {
                    let shade = dx < 0 ? light : dx > 0 ? dark : color;
                    if (withSnow && tierRow === 0) shade = dx > 0 ? p.packed.snowShade : p.packed.snow; // снежная кромка яруса
                    p.put(cx + dx, top + row, shade);
                }
            }
        }
    };
}

/* ============================================================
   Farms — фермерские угодья: пашни с пшеницей, амбары и мельницы

   Клетка с ресурсом «пшеница» — одна-две крупные пашни с неровными краями, разбросанные по клетке так же, как деревья.
   Пашня намеренно простая: ровная земля с лёгкой пятнистостью, без грядок. Поверх растёт пшеница — тонкие стебли с колосом,
   как раньше. Сколько пашен — зависит от кучности: чем больше соседних клеток с фермами, тем их больше. Край пашни
   растворяется в местной траве (полупрозрачные пиксели), поэтому она ложится в биом, а не лежит поверх него. В плотных
   угодьях стоит амбар, а в самых плотных — небольшая мельница; рядом друг с другом они не ставятся.
   Густота пшеницы — из map.growth (ступени, см. growthStage), вид — из сезона: весной ростки, летом зелёные стебли, осенью
   спелые колосья, зимой стерня.
   ============================================================ */
{
    const OPEN_SLOTS = [[0.4, 0.5], [0.76, 0.34], [0.3, 0.86]];                       // где в клетке лежат пашни (доли клетки)
    const BUILDING_SLOTS = [[0.24, 0.34], [0.78, 0.4], [0.28, 0.9]];                  // в клетке со зданием: по углам, середина свободна
    const NEIGHBORS_8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    const EARLIER_NEIGHBORS = [[-1, 0], [-1, -1], [0, -1], [1, -1]];                 // клетки, обработанные раньше: рядом с ними здание не ставим
    const STALK_DENSITY = 0.15;                                                      // стеблей на пиксель пашни при полной густоте

    MapPaint.Farms = {
        // Одна-две крупные пашни в клетке (в самых плотных угодьях иногда три) и, если угодья плотные, здание.
        collect(p, items, x, y) {
            const { T } = p.dim;
            const neighbors = this.neighborCount(p, x, y);
            const building = this.buildingAt(p, x, y);
            const slots = building ? BUILDING_SLOTS : OPEN_SLOTS;
            const count = Math.min(slots.length, neighbors <= 1 ? 1 : neighbors >= 6 && hashUnit(x, y, 324) < 0.4 ? 3 : 2);
            const start = tileHash(x, y, 320) % slots.length;

            for (let k = 0; k < count; k++) {
                const [fx, fy] = slots[(start + k) % slots.length];
                const cx = Math.round(x * T + fx * T + (hashUnit(x, y, 330 + k) - 0.5) * 0.3 * T);
                const cy = Math.round(y * T + fy * T + (hashUnit(x, y, 340 + k) - 0.5) * 0.3 * T);
                const rx = Math.max(3, p.px(4) + (tileHash(x, y, 350 + k) % 2));
                const ry = Math.max(2, p.px(3) + (tileHash(x, y, 360 + k) % 2));
                items.push({ y: cy - ry, x: cx, cover: false, draw: () => this.drawPlot(p, x, y, cx, cy, rx, ry, k) });
            }

            if (building) {
                const bx = Math.round(x * T + 0.5 * T + (hashUnit(x, y, 322) - 0.5) * 0.2 * T);
                const base = Math.round(y * T + 0.64 * T + (hashUnit(x, y, 323) - 0.5) * 0.1 * T);
                items.push({ y: base, x: bx, cover: true, draw: () => this.drawBuilding(p, x, y, building, bx, base) });
            }
        },

        isFarm(p, x, y) {
            const { size } = p.dim;
            return x >= 0 && y >= 0 && x < size && y < size && p.map.resource[y * size + x] === Resource.WHEAT;
        },

        // Сколько из восьми соседних клеток тоже фермы: это «кучность» угодий.
        neighborCount(p, x, y) {
            return NEIGHBORS_8.reduce((sum, [dx, dy]) => sum + (this.isFarm(p, x + dx, y + dy) ? 1 : 0), 0);
        },

        // Какое здание «хочет» стоять в клетке (по кучности и хешу): амбар, мельница или ничего.
        wantedBuilding(p, x, y) {
            if (!this.isFarm(p, x, y)) return null;
            const neighbors = this.neighborCount(p, x, y);
            const roll = hashUnit(x, y, 310);
            if (neighbors >= 6 && roll < 0.14) return 'mill';
            if (neighbors >= 4 && roll < 0.4) return 'barn';
            return null;
        },

        // Здание, которое действительно стоит: если раньше по порядку рядом уже есть другое, этой клетке оно не достаётся.
        buildingAt(p, x, y) {
            const kind = this.wantedBuilding(p, x, y);
            return kind && !EARLIER_NEIGHBORS.some(([dx, dy]) => this.wantedBuilding(p, x + dx, y + dy)) ? kind : null;
        },

        /* Одна пашня: эллипс с рваным краем, внутри ровная земля с лёгкой пятнистостью. Край полупрозрачный: земля смешивается
           с травой под ней. Воду, реку и крутые склоны гор пашня обходит. Поверх земли растёт пшеница (drawWheat). */
        drawPlot(p, x, y, cx, cy, rx, ry, k) {
            const { W } = p.dim;
            const i = p.map.index(x, y);
            const snow = p.snowCoverage(i);
            const soil = mixPacked(p.moodize(p.colors.dirt), p.moodize(p.colors.mud), 0.45);
            const base = snow > 0 ? mixPacked(soil, p.packed.snow, 0.65 * snow) : soil;
            const dark = shadePacked(base, -0.09), light = shadePacked(base, 0.07);

            for (let dy = -ry - 1; dy <= ry + 1; dy++) {
                for (let dx = -rx - 1; dx <= rx + 1; dx++) {
                    const px = cx + dx, py = cy + dy;
                    if (!p.inRegionPixel(px, py) || !p.isFree(py * W + px)) continue;
                    const edge = Math.hypot(dx / (rx + 0.5), dy / (ry + 0.5)) + (hashUnit(px, py, 319) - 0.5) * 0.5;   // 0 — центр, 1 — край
                    if (edge >= 1) continue;

                    const roll = hashUnit(px, py, 312);
                    p.blend(px, py, roll < 0.25 ? dark : roll > 0.9 ? light : base, edge < 0.55 ? 0.92 : edge < 0.8 ? 0.75 : 0.5);
                }
            }

            this.drawWheat(p, i, cx, cy, rx, ry);
            if (k === 0 && hashUnit(x, y, 314) < 0.22) this.drawHaystack(p, cx + rx, cy + ry, snow);   // стог у края первой пашни
        },

        /* Пшеница: тонкие стебли с колосом в глубине пашни (края остаются голой землёй). Густота — от стадии роста, высота и вид —
           от сезона: ростки, зелёные стебли, спелые колосья с двойным колосом, зимой низкая стерня. */
        drawWheat(p, i, cx, cy, rx, ry) {
            const { W } = p.dim;
            const pal = p.pal;
            const stalk = hexToPacked(pal.wheatStalk), head = hexToPacked(pal.wheatTop);
            const stage = (p.map.growth ? growthStage(p.map.growth[i]) : GROWTH_STAGES) / GROWTH_STAGES;
            const stalks = Math.round(Math.PI * rx * ry * STALK_DENSITY * stage);

            for (let attempt = 0, placed = 0; placed < stalks && attempt < stalks * 4; attempt++) {
                const h = tileHash(cx, cy, 380 + attempt);
                const dx = (h % (2 * rx + 1)) - rx, dy = ((h >>> 8) % (2 * ry + 1)) - ry;
                if ((dx / (rx + 0.5)) ** 2 + (dy / (ry + 0.5)) ** 2 > 0.6) continue;           // подальше от края пашни
                const sx = cx + dx, sy = cy + dy + 1;                                            // основание стебля
                if (!p.inRegionPixel(sx, sy) || !p.isFree(sy * W + sx)) continue;
                placed++;

                if (pal.wheatStage === 'bare') {
                    p.rect(sx, sy - 2, 1, 2, stalk);
                    continue;
                }
                const height = (pal.wheatStage === 'sprout' ? p.px(1.5) : pal.wheatStage === 'growing' ? p.px(3) : p.px(4)) + ((h >>> 16) % 2);
                p.rect(sx, sy - height, 1, height, stalk);
                p.put(sx, sy - height, head);
                if (pal.wheatStage === 'ripe') p.put(sx, sy - height - 1, head);
            }
        },

        // Стог сена: небольшой холмик с тенью справа.
        drawHaystack(p, cx, base, snow) {
            const hay = p.moodize(p.colors.hay);
            const top = snow > 0 ? mixPacked(shadePacked(hay, 0.15), p.packed.snow, 0.8 * snow) : shadePacked(hay, 0.15);
            p.rect(cx - 1, base - 1, 3, 2, hay);
            p.put(cx, base - 2, top);
            p.put(cx - 1, base - 1, top);
            p.put(cx + 1, base, shadePacked(hay, -0.3));
            p.blend(cx + 2, base, BLACK, 0.3);
            p.blend(cx + 1, base + 1, BLACK, 0.2);
        },

        // Здание фермы с тенью и пятачком утоптанной земли.
        drawBuilding(p, x, y, kind, cx, base) {
            const sprite = kind === 'mill' ? this.millSprite(p, Math.round(p.snowCoverage(p.map.index(x, y)) * 3)) : this.barnSprite(p, Math.round(p.snowCoverage(p.map.index(x, y)) * 3));
            p.rect(cx - p.px(2), base - 1, p.px(4) + 1, 2, mixPacked(p.moodize(p.colors.dirt), p.moodize(p.colors.mud), 0.3));
            MapPaint.Settlements.drawBuildingShadow(p, cx, base, p.px(4), p.px(4));
            p.blitSprite(sprite.buffer, cx - sprite.anchorX, base - sprite.anchorY);
        },

        // Амбар: дощатые стены, высокая соломенная крыша, широкие ворота.
        barnSprite(p, snowLevel) {
            const n = value => p.px1(value);
            const c = p.colors;
            const key = ['barn', snowLevel, p.mood, p.season.name, p.tileSize].join('|');
            const bodyW = n(6), bodyH = n(3), roofH = n(3);
            const width = bodyW + 4, height = bodyH + roofH + 2;

            return p.sprite(key, width, height, c.outline, buffer => {
                const wall = mixPacked(p.moodize(c.roofB), p.moodize(c.plank), 0.25);   // тёмно-красные доски
                let roof = p.moodize(c.thatch);
                if (snowLevel > 0) roof = mixPacked(roof, p.packed.snow, 0.85 * snowLevel / 3);
                const left = 2, top = 1 + roofH, mid = (width - 1) / 2;

                buffer.rect(left, top, bodyW, bodyH, wall);
                buffer.rect(left, top, 1, bodyH, shadePacked(wall, 0.14));
                buffer.rect(left + bodyW - 1, top, 1, bodyH, shadePacked(wall, -0.22));
                buffer.rect(left, top + bodyH - 1, bodyW, 1, shadePacked(wall, -0.18));
                buffer.rect(Math.round(mid) - 1, top + bodyH - Math.min(2, bodyH - 1), 2, Math.min(2, bodyH - 1), p.moodize(c.plank));   // ворота

                for (let row = 0; row < roofH; row++) {                                              // крыша: ряды всё шире книзу
                    const half = ((bodyW + 2) / 2) * (row + 1) / roofH;
                    for (let px = Math.round(mid - half + 0.5); px <= Math.round(mid + half - 0.5); px++) {
                        buffer.put(px, 1 + row, px < mid ? shadePacked(roof, 0.14) : shadePacked(roof, -0.2));
                    }
                }
                return { anchorX: Math.round(mid), anchorY: height - 2 };
            });
        },

        // Небольшая ветряная мельница: каменная башня, конус крыши и четыре крыла по диагоналям.
        millSprite(p, snowLevel) {
            const n = value => p.px1(value);
            const c = p.colors;
            const key = ['mill', snowLevel, p.mood, p.season.name, p.tileSize].join('|');
            const reach = Math.max(2, n(3));
            const width = 2 * reach + 1;
            const towerHeight = n(4), capHeight = Math.max(2, n(2));
            const towerTop = reach + 1, floor = towerTop + towerHeight - 1;
            const height = floor + 2;

            return p.sprite(key, width, height, c.outline, buffer => {
                const mid = width >> 1;
                const wall = p.moodize(c.wallA);
                let roof = p.moodize(c.roofB);
                if (snowLevel > 0) roof = mixPacked(roof, p.packed.snow, 0.85 * snowLevel / 3);
                const sail = packRgb(226, 216, 184), spar = p.moodize(c.plank);

                // башня сужается кверху: левая сторона на свету, правая в тени
                const bottomHalf = Math.max(1, n(3) >> 1), topHalf = Math.max(1, bottomHalf - (towerHeight > 3 ? 1 : 0));
                for (let row = 0; row < towerHeight; row++) {
                    const half = Math.round(topHalf + (bottomHalf - topHalf) * row / Math.max(1, towerHeight - 1));
                    for (let dx = -half; dx <= half; dx++) {
                        buffer.put(mid + dx, towerTop + row, shadePacked(wall, dx === -half ? 0.1 : dx === half ? -0.2 : 0));
                    }
                }
                buffer.put(mid, floor, spar);                                                       // дверь

                for (let row = 0; row < capHeight; row++) {                                          // крыша-конус
                    const half = Math.min(topHalf + 1, Math.round((row + 1) * (topHalf + 1) / capHeight));
                    buffer.rect(mid - half, towerTop - capHeight + 1 + row, half * 2 + 1, 1, row === 0 ? roof : shadePacked(roof, -0.18));
                }

                const hubY = towerTop + 1;                                                           // крылья: полотно с одной стороны
                for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
                    for (let step = 1; step <= reach; step++) {
                        buffer.put(mid + sx * step, hubY + sy * step, spar);
                        if (step >= 2) buffer.put(mid + sx * step - sx, hubY + sy * step, sail);
                    }
                }
                buffer.put(mid, hubY, spar);
                return { anchorX: mid, anchorY: floor + 1 };
            });
        }
    };
}

/* ============================================================
   Ores — золотая и железная руда

   Небольшой каменный выступ с вкраплениями руды: золото яркое и с блёстками, железо тёмное и ржавое.
   Стоит почти на месте клетки: гора поднимает его лишь на часть высоты рельефа.
   ============================================================ */
{
    const LIFT_SHARE = 0.4;   // какая часть подъёма горы под клеткой достаётся руде

    MapPaint.Ores = {
        collect(p, items, x, y, i) {
            const T = p.tileSize;
            const kind = p.map.resource[i] === Resource.GOLD ? 'gold' : 'iron';
            items.push({ y: y * T + Math.round(T * 0.72), x: x * T, cover: true, draw: () => this.draw(p, x, y, kind) });
        },

        // Два камня с самородками. kind: 'gold' (золото — яркое, с блёстками) или 'iron' (железо — тёмное, ржавое).
        sprite(p, kind, variant) {
            const n = value => p.px1(value);
            const gold = kind === 'gold';
            const width = n(9), height = n(7);

            return p.sprite('ore|' + kind + '|' + variant, width, height, p.colors.outline, buffer => {
                const stone = gold ? [packRgb(150, 146, 150), packRgb(114, 110, 116), packRgb(78, 74, 82)] : [packRgb(120, 132, 146), packRgb(86, 96, 108), packRgb(54, 62, 74)];
                const oreLight = gold ? packRgb(255, 243, 168) : packRgb(207, 218, 228);
                const ore = gold ? packRgb(247, 212, 74) : packRgb(176, 92, 54);
                const oreDark = gold ? packRgb(168, 122, 20) : packRgb(98, 48, 30);
                const mid = width >> 1, floor = height - 2;

                buffer.ellipse(mid - 1, floor - n(1), n(3), n(2), stone[1], stone[0], stone[2]);                    // большой камень
                buffer.ellipse(mid + n(2), floor, n(2), n(1.5), stone[1], stone[0], stone[2]);                      // маленький рядом

                // самородки: один крупнее, остальные по пикселю
                [[mid - n(2), floor - n(1), 1], [mid, floor - n(2), n(2)], [mid + n(2), floor - 1, 1]].forEach(([sx, sy, size]) => {
                    buffer.rect(sx, sy, size, size, ore);
                    if (size > 1) {
                        buffer.rect(sx + 1, sy + size, size, 1, oreDark);
                        buffer.rect(sx + size, sy + 1, 1, size, oreDark);
                    }
                    buffer.put(sx, sy, oreLight);
                });

                return { anchorX: mid, anchorY: floor + 1, sparkles: gold ? [[mid, floor - n(3)]] : [] };
            });
        },

        draw(p, x, y, kind) {
            const { T } = p.dim;
            const sprite = this.sprite(p, kind, tileHash(x, y, 80) % 3);
            const cx = x * T + Math.round(T / 2) + Math.round((hashUnit(x, y, 80) - 0.5) * 0.2 * T);
            const base = y * T + Math.round(T * 0.72) - Math.round(MapPaint.Mountains.liftAtTile(p, x, y) * LIFT_SHARE);

            MapPaint.Settlements.drawBuildingShadow(p, cx, base, p.px(4), p.px(3));
            p.blitSprite(sprite.buffer, cx - sprite.anchorX, base - sprite.anchorY);

            // блёстки золота — в тёмном стиле светятся (рисуются после цветокоррекции)
            for (const [sx, sy] of sprite.sparkles) {
                const px = cx - sprite.anchorX + sx, py = base - sprite.anchorY + sy;
                p.emissive.push(() => {
                    p.put(px, py, packRgb(255, 255, 230));
                    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) p.blend(px + dx, py + dy, packRgb(255, 240, 160), 0.7);
                });
            }
        }
    };
}

/* ============================================================
   Ether — эфир: кристалл

   Приглушённый фиолетовый кристалл без свечения: рисуется как обычная декорация и в светлом, и в тёмном стиле.
   ============================================================ */
{
    MapPaint.Ether = {
        collect(p, items, x, y) {
            const T = p.tileSize;
            items.push({ y: y * T + Math.round(T * 0.8), x: x * T, cover: true, draw: () => this.draw(p, x, y) });
        },

        // Главный кристалл и два малых рядом: острые призмы, левая грань светлая, правая тёмная.
        sprite(p) {
            const n = value => p.px1(value);
            const width = n(11), height = n(10);

            return p.sprite('ether|crystal', width, height, packRgb(46, 36, 66), buffer => {
                const light = packRgb(178, 160, 210), mid = packRgb(138, 116, 182), dark = packRgb(94, 76, 132), tip = packRgb(214, 204, 232);
                const floor = height - 2, middle = width >> 1;

                const crystal = (cx, crystalWidth, crystalHeight) => {
                    for (let row = 0; row < crystalHeight; row++) {
                        const half = Math.max(0, Math.round((crystalWidth / 2) * Math.min(1, (row + 1) / (crystalHeight * 0.7))));
                        const y = floor - crystalHeight + 1 + row;
                        buffer.rect(cx - half, y, half + 1, 1, light);
                        buffer.rect(cx + 1, y, half, 1, dark);
                        buffer.put(cx, y, mid);
                    }
                    buffer.put(cx, floor - crystalHeight + 1, tip);
                };
                crystal(middle, n(2), n(8));
                crystal(middle - n(4), n(2), n(4));
                crystal(middle + n(4), n(2), n(5));
                return { anchorX: middle, anchorY: floor + 1 };
            });
        },

        draw(p, x, y) {
            const { T } = p.dim;
            const sprite = this.sprite(p);
            const cx = x * T + Math.round(T / 2) + Math.round((hashUnit(x, y, 91) - 0.5) * 0.2 * T);
            const base = y * T + Math.round(T * 0.8) - Math.round(MapPaint.Mountains.liftAtTile(p, x, y) * 0.4);

            MapPaint.Settlements.drawBuildingShadow(p, cx, base, p.px(4), p.px(3));
            p.blitSprite(sprite.buffer, cx - sprite.anchorX, base - sprite.anchorY);
        }
    };
}

/* ============================================================
   Grade — тёмный стиль: цветокоррекция, туман, виньетка

   Рисуется последним: затемняет и подкрашивает уже нарисованное. Туман от сезона не зависит (build).
   ============================================================ */
{
    MapPaint.Grade = {
        defaults: {
            grade: true,     // в тёмном стиле: цветокоррекция, туман, виньетка
            vignette: 0.35  // затемнение к краям карты в тёмном стиле (0 — нет)
        },

        enabled: p => p.view === 'terrain' && p.mood === 'dark' && p.options.grade && p.layers.grading,

        // Густота тумана по пикселям (0..255): клочья шума, над водой плотнее. Считается один раз на карту.
        build(p) {
            return p.memo('fog', [p.map.elevation, p.tileSize, p.seedSalt], () => this.computeFog(p));
        },

        /* Финальная обработка всей картинки: тёмные средние тона, холодные тени, туман над водой и низинами, виньетка.
           Яркими остаются только «источники света» (эфирные разломы, окна, костры) — они рисуются уже после. */
        paint(p) {
            const { W } = p.dim;
            const pixels = p.pixels;
            const fog = this.build(p);
            const fogScale = Math.min(255, Math.round((p.pal.fogStrength === undefined ? 1 : p.pal.fogStrength) * 255));
            const [lutR, lutG, lutB] = [0.95, 0.98, 1.04].map(gain =>
                Uint8Array.from({ length: 256 }, (_, v) => Math.min(255, Math.round(255 * Math.pow(v / 255, 1.14) * gain))));
            const [fogR, fogG, fogB] = [150, 162, 170];

            const vignette = p.options.vignette;
            const falloff = length => Float32Array.from({ length }, (_, pos) => {
                const edge = Math.min(1, Math.min(pos, length - 1 - pos) / (length * 0.3));
                return Math.round(256 * (1 - vignette * (1 - smoothstep(edge))));
            });
            const vx = falloff(W), vy = falloff(W);

            const r = p.region;
            for (let y = r.y0; y < r.y1; y++) {
                const rowShade = vy[y];
                for (let x = r.x0; x < r.x1; x++) {
                    const k = y * W + x;
                    const color = pixels[k];
                    let r = lutR[color & 255], g = lutG[(color >>> 8) & 255], b = lutB[(color >>> 16) & 255];

                    const a = (fog[k] * fogScale) >> 8;
                    if (a > 0) {
                        r += ((fogR - r) * a) >> 8;
                        g += ((fogG - g) * a) >> 8;
                        b += ((fogB - b) * a) >> 8;
                    }
                    const shade = (vx[x] * rowShade) >> 8;
                    pixels[k] = 0xFF000000 | (((b * shade) >> 8) << 16) | (((g * shade) >> 8) << 8) | ((r * shade) >> 8);
                }
            }
        },

        computeFog(p) {
            const { W } = p.dim;
            const step = 4;                                   // туман плавный: шум считаем в четверть разрешения и растягиваем
            const lowWidth = Math.ceil(W / step) + 2;
            const low = new Uint8Array(lowWidth * lowWidth);
            const broad = new LatticeNoise(W, Math.max(8, p.px(80)), 901 + p.seedSalt);
            const fine = new LatticeNoise(W, Math.max(4, p.px(34)), 902 + p.seedSalt);
            const curve = Uint8Array.from({ length: 256 }, (_, n) => Math.round(Math.pow(n / 255, 1.3) * 0.3 * 255));

            for (let ly = 0; ly < lowWidth; ly++) {
                const y = Math.min(W - 1, ly * step);
                for (let lx = 0; lx < lowWidth; lx++) {
                    const x = Math.min(W - 1, lx * step);
                    const noise = 0.65 * broad.at(x, y) + 0.35 * fine.at(x, y);
                    const base = noise <= 0.5 ? 0 : Math.min(1, (noise - 0.5) / 0.3);
                    low[ly * lowWidth + lx] = Math.min(255, Math.round(curve[Math.round(base * 255)] * (p.waterMask[y * W + x] ? 1.15 : 1)));
                }
            }

            const fog = new Uint8Array(W * W);
            const weight = 256 / step;
            for (let y = 0; y < W; y++) {
                const rowA = ((y / step) | 0) * lowWidth, rowB = rowA + lowWidth, wy = (y % step) * weight;
                for (let x = 0; x < W; x++) {
                    const lx = (x / step) | 0, wx = (x % step) * weight;
                    const top = low[rowA + lx] * (256 - wx) + low[rowA + lx + 1] * wx;
                    const bottom = low[rowB + lx] * (256 - wx) + low[rowB + lx + 1] * wx;
                    fog[y * W + x] = (top * (256 - wy) + bottom * wy) >> 16;
                }
            }
            return fog;
        }
    };
}

/* ============================================================
   MapPainter — ядро: настройки, кадр, области, публичный интерфейс.

   Структура — как в генераторе: всё поделено на подсистемы MapPaint.<Слой> (один файл на слой, painter-<слой>.js) с одним контуром:
       defaults     — настройки слоя; плоско собираются в MapPainter.DEFAULTS;
       enabled(p)   — рисуется ли слой в этом кадре (вид, настройки, options.layers);
       build(p)     — то, что не зависит от сезона и места на карте: кэши форм (считается один раз) и данные кадра для других слоёв
                      (Base — маска воды, Mountains — рельеф, Rivers — маска рек);
       paint(p)     — рисует область p.region (collect(p, items, ...) у декораций — добавляет рисунки в список сцены);
       шаги         — остальные методы: свои — this.шаг(p), чужие — MapPaint.Другой.шаг(p).
   Общие инструменты рисования (p.put, p.memo, p.eachInRegion...) — на самом painter'е (MapPaint.Tools, painter-tools.js).
   Порядок слоёв — MapPaint.PIPELINE; новый слой = файл с MapPaint.<Имя> + имя в PIPELINE.
   ============================================================ */

// Слои по порядку: build() всех включённых слоёв вызывается в begin(), paint() — в paintRect() для каждой области.
// Порядок важен: поздние слои читают то, что нарисовали ранние (цвет земли, маски воды и рек).
MapPaint.PIPELINE = ['Base', 'Coast', 'Mountains', 'Hills', 'Shores', 'Rivers', 'Roads', 'Settlements', 'Texture', 'Borders', 'Crossings', 'Scene', 'Grade'];

class MapPainter extends MapPaint.Tools {
    // Настройки слоёв лежат рядом с их кодом (MapPaint.<Слой>.defaults); здесь собираются в один плоский объект.
    static get DEFAULTS() {
        const options = {
            tileSize: 16,
            layers: {},  // режим разработки: { relief: false, hills: false, ... } отключает слои (см. paint)
            spriteOutline: false  // тёмный контур вокруг построек, руд и эфира (в стиле dark fantasy выключен)
        };
        for (const part of Object.values(MapPaint)) {
            if (part && part.defaults) Object.assign(options, part.defaults);
        }
        return options;
    }

    constructor(map, options = {}) {
        super();
        this.map = map;
        // undefined не должен затирать значения по умолчанию
        this.options = { ...MapPainter.DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) };
        this.tileSize = this.options.tileSize;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');

        this.caches = {};                                         // кэши, не зависящие от сезона (см. memo)
        this.colors = {};
        for (const [name, hex] of Object.entries(COLORS)) this.colors[name] = hexToPacked(hex);
    }

    /* ============================================================
       Кадр и области

       Кадр — это сезон, стиль, вид и набор слоёв: всё, что нарисовано одним кадром, согласовано между собой. Начало кадра
       (begin) готовит буферы и build() включённых слоёв. Рисовать можно всю карту сразу (paint) или по частям: прямоугольник
       клеток (paintRect). Часть, нарисованная отдельно, пиксель в пиксель такая же, как при полной отрисовке.
       ============================================================ */

    // view: 'terrain' | 'temperature' | 'regions'. Рисует всю карту и возвращает холст.
    paint(frame) {
        this.begin(frame);
        this.paintRect({ tx0: 0, ty0: 0, tx1: this.map.size, ty1: this.map.size });
        return this.canvas;
    }

    begin({ view, seasonName, showBorders, mood }) {
        this.view = view;
        this.showBorders = showBorders;
        this.mood = mood === 'dark' ? 'dark' : 'light';
        this.season = (this.mood === 'dark' ? DARK_SEASONS : SEASONS)[seasonName];
        this.pal = this.season.palette;
        this.packed = packPalette(this.pal);
        this.seedSalt = ((this.map.seed | 0) * 13) % 100000; // у каждой карты свои узоры шума

        this.width = this.map.size * this.tileSize;
        this.dim = { size: this.map.size, T: this.tileSize, W: this.width };   // сторона карты в клетках, клетка и карта в пикселях
        this.tileTable = this.memo('tileTable', [this.map.size, this.tileSize], () => this.buildTileTable());   // пиксель -> клетка без делений
        this.prepareBuffers();

        // Слои можно отключать (опция layers) — для быстрой разработки: например, смотреть только горы без леса, дорог и тумана.
        this.layers = { relief: true, hills: true, shores: true, rivers: true, roads: true, settlements: true, texture: true,
            borders: true, decorations: true, grading: true, ...this.options.layers };

        // Данные кадра для слоёв: их выставляют build() тех слоёв, которые включены (у остальных — пусто).
        this.riverMask = null;
        this.relief = null;
        this.reliefHeight = null;
        this.eachLayer(layer => layer.build && layer.build(this));
    }

    // Холст и буферы создаются один раз на размер карты и переиспользуются: перерисованное остаётся на холсте, пока не перерисуют поверх.
    prepareBuffers() {
        const W = this.width;
        if (this.image && this.image.width === W) return;
        this.canvas.width = W;
        this.canvas.height = W;
        this.image = this.ctx.createImageData(W, W);
        this.pixels = new Int32Array(this.image.data.buffer); // Int32: значения помещаются в «маленькие целые», это заметно быстрее, чем Uint32
        this.spriteMask = new Uint8Array(W * W);              // 1 — пиксель закрыт деревом, домом, рудой и т. п.: слои фракций и сетки под ними не видны
    }

    // fn(слой) для включённых в этом кадре слоёв по порядку.
    eachLayer(fn) {
        for (const name of MapPaint.PIPELINE) {
            const layer = MapPaint[name];
            if (layer.enabled(this)) fn(layer);
        }
    }

    // Рисует прямоугольник клеток кадра { tx0, ty0, tx1, ty1 } (правые границы не включаются).
    paintRect(tiles) {
        const region = this.makeRegion(tiles);
        const ring = this.saveRing(region);

        this.region = region;
        this.clearRegion(region);
        this.cover = false;                                       // пока true, всё, что рисует put(), попадает в spriteMask
        this.emissive = [];   // источники света (окна, костры, эфирные разломы): рисуются после цветокоррекции, чтобы оставаться яркими

        this.eachLayer(layer => layer.paint && layer.paint(this));

        this.cover = true;                              // светящиеся детали (окна, костры, эфир) — тоже над землёй
        for (const draw of this.emissive) draw();
        this.cover = false;

        this.restoreRing(ring);
        const { T } = this.dim;
        this.ctx.putImageData(this.image, 0, 0, tiles.tx0 * T, tiles.ty0 * T, (tiles.tx1 - tiles.tx0) * T, (tiles.ty1 - tiles.ty0) * T);
        this.region = null;
        return this.canvas;
    }

    /* ---------- Публичный интерфейс: то, чем пользуется рендерер. Логика — в слоях ---------- */

    buildPixelRegions() { return MapPaint.PixelRegions.build(this); }
    buildCellMap() { return MapPaint.Cells.build(this); }
    cellAt(worldX, worldY) { return MapPaint.Cells.at(this, worldX, worldY); }
    cellOutline(tile, smoothing = 2, keepCorners = 5) { return MapPaint.Cells.outline(this, tile, smoothing, keepCorners); }
    regionOutline(regionId, smoothing = 3) { return MapPaint.Cells.regionOutline(this, regionId, smoothing); }
    paintGrid() { return MapPaint.Grid.paint(this); }
    territoriesFromMap() { return MapPaint.Territories.fromMap(this); }
    paintTerritories(territories) { return MapPaint.Territories.paint(this, territories); }
}