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
    return { index, code, count };
}

function applyHillShading(pixels, { index, code, count }) {
    for (let n = 0; n < count; n++) {
        const k = index[n];
        const c = code[n];
        let color = pixels[k];
        const step = (c & 7) - 2;
        if (step !== 0) color = shadeFast(color, STEP_AMOUNTS[step + 2]);
        if (c & 8) color = shadeFast(color, -78);
        pixels[k] = color;
    }
}

/* ============================================================
   SECTION: PIXEL_BUFFER
   Маленький пиксельный буфер для спрайтов (дома, руды, эфир).
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

/* Неймспейс внутренних помощников painter: в глобальной области остаются прежние имена, новые живут здесь. */
const MapPaint = {
    mixins: [],                                       // слои (painter-*.js) регистрируются здесь, ядро ставит их в MapPainter

    // Порядок слоёв земли в режиме «terrain»: [ключ из options.layers, метод].
    // Билинейная выборка из сетки клеток: четыре клетки (слева/справа в строках rowTop и rowBottom), u, v — доли внутри.
    bilinear(grid, rowTop, rowBottom, left, right, u, v) {
        const a = grid[rowTop + left], b = grid[rowTop + right], c = grid[rowBottom + left], d = grid[rowBottom + right];
        const top = a + (b - a) * u;
        return top + (c + (d - c) * u - top) * v;
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

    DIRECTIONS_4: [[-1, 0], [1, 0], [0, -1], [0, 1]],   // влево, вправо, вверх, вниз

    GROUND_LAYERS: [['hills', 'paintHills'], ['shores', 'paintShores'], ['rivers', 'paintRivers'], ['roads', 'paintRoads'], ['settlements', 'paintSettlementGround']]
};
