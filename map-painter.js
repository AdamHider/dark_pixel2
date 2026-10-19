/* ============================================================
   MapPainter — рисует карту целиком в один большой холст, пиксель за пикселем.

   Слои (снизу вверх):
     1. фон — цвет каждой клетки, пиксельно смешанный с соседями (дизеринг);
     2. рельеф гор — тени по карте высот; горы плавно переходят в окружающую землю;
     3. реки — с мягкой кромкой, мостами и бродами;
     4. текстура — крапинки, волны, цветы и листва на лугах;
     5. границы регионов;
     6. декорации (деревья, поля, руда, разломы) — строго снизу вверх, как в перспективе.

   Все рисунки заданы в долях клетки, поэтому размер клетки (tileSize) можно менять.
   Спрайты рассчитаны на 12 пикселей: функция px(n) переводит «пиксели для клетки 12×12» в текущий размер.
   ============================================================ */

/* ============================================================
   SECTION: MAP_COLORS
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
    chapelStone: '#8d8a85',
    bone: '#cfc8b4',
    crow: '#16161a'
};

/* ============================================================
   SECTION: MAP_PACKED_COLORS
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
    riverShades: palette.river.map(hexToPacked),
    ice: palette.ice.map(hexToPacked),
    rock: hexToPacked(palette.rock),
    snow: hexToPacked(palette.snow),
    snowShade: hexToPacked(palette.snowShade),
    trunk: hexToPacked(palette.trunk)
});

/* ============================================================
   SECTION: MAP_CONSTANTS
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

/* ============================================================
   SECTION: MAP_PAINTER
   MapPainter
   ============================================================ */
class MapPainter {
    constructor(map, options = {}) {
        this.map = map;
        this.options = {
            tileSize: 16,
            blendSharpness: 1.5,   // насколько резко смешиваются соседние биомы (больше — резче, 1 — очень мягко)
            coastSharpness: 1.5,   // то же для границы воды и суши — а также для берегов (песок, галька) и краёв рек
            peakSharpness: 0.85,   // 0..1: острота гор (0 — округлые холмы-«губка», 1 — острые пики и гребни)
            mountainLift: 14,      // на сколько пикселей (для клетки 12×12) самые высокие горы поднимаются вверх, к северу
            mountainDetail: 0.3,  // 0..1: мелкие грани и отроги на горах (0 — крупные чистые плоскости, 1 — много мелкого шума)
            mountainRagged: 0.34,  // 0..1: рваность кромки гор у подножия (0 — ровный край по клеткам, больше — «осыпь» и зубцы)
            mountainLight: 'left', // откуда падает свет на горы: 'left' (как у деревьев и холмов) или 'right' (как на референсе)
            hillStrength: 0.6,     // 0..1: заметность холмов и впадин на равнинах (0 — выключить)
            ravineDensity: 0.2,    // 0..1: сколько оврагов в сухих местах (0 — нет)
            grassDensity: 1,       // густота пучков травы (множитель)
            shores: true,          // пляжи, каменистые берега и утёсы
            settlements: true,     // поселения (домики)
            roads: true,           // дороги между поселениями
            settlementMinHouses: 1, // домиков в самом маленьком поселении
            settlementMaxHouses: 3, // домиков в клетке высшего уровня (если они помещаются)
            settlementOverflow: 0.25, // на сколько (доля клетки) основание дома может выйти за границу своей клетки
            coastSmoothing: 7,     // радиус (в пикселях) сглаживания берега: больше — круглее; 0 — не сглаживать
            riverTails: true,      // истончающиеся декоративные концы у истоков рек (река постепенно сходит на нет)
            factionBorder: 2,      // толщина цветной границы фракции в пикселях (для клетки 16×16; масштабируется вместе с клеткой)
            factionBorderOpacity: 0.75,
            factionFill: 0.2,      // лёгкая заливка земель фракции цветом фракции (0 — без заливки)
            factionCoastBorder: true,  // граница фракции идёт и вдоль берега моря и озёр
            factionRiverBorder: 'boundary', // вдоль берегов рек: 'always' — всегда (река в территорию не входит), 'boundary' — только если на том берегу другая территория
            regionShoreBorder: false,   // граница региона идёт и вдоль берега моря, озёр и рек (реки в регионы не входят)
            gridOpacity: 0.15,     // насколько заметна сетка клеток (0..1)
            regionBorderSmoothing: 7, // радиус (в пикселях) сглаживания углов границ регионов: больше — круглее; 0 — не сглаживать
            layers: {},            // режим разработки: { relief: false, hills: false, ... } отключает слои (см. paint)
            spriteOutline: false,  // тёмный контур вокруг построек, руд и эфира (в стиле dark fantasy выключен)
            grade: true,           // в тёмном стиле: цветокоррекция, туман, виньетка
            vignette: 0.35,        // затемнение к краям карты в тёмном стиле (0 — нет)
            props: true,           // в тёмном стиле: кости, вороны, развалины, виселицы
            ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) // undefined не должен затирать значения по умолчанию
        };
        this.tileSize = this.options.tileSize;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');

        this.colors = {};
        for (const [name, hex] of Object.entries(COLORS)) this.colors[name] = hexToPacked(hex);
    }

    /* ============================================================
       SECTION: PAINT
       Отрисовка карты: слои снизу вверх.
       ============================================================ */

    // view: 'terrain' | 'temperature' | 'regions'. Возвращает холст с готовой картой.
    paint({ view, seasonName, showBorders, mood }) {
        this.view = view;
        this.mood = mood === 'dark' ? 'dark' : 'light';
        this.season = (this.mood === 'dark' ? DARK_SEASONS : SEASONS)[seasonName];
        this.pal = this.season.palette;
        this.packed = packPalette(this.pal);
        this.seedSalt = ((this.map.seed | 0) * 13) % 100000; // у каждой карты свои узоры шума

        this.width = this.map.size * this.tileSize;
        this.canvas.width = this.width;
        this.canvas.height = this.width;
        const image = this.ctx.createImageData(this.width, this.width);
        this.pixels = new Int32Array(image.data.buffer); // Int32: значения помещаются в «маленькие целые», это заметно быстрее, чем Uint32
        this.waterMask = new Uint8Array(this.width * this.width); // 1 — пиксель воды (заполняется при рисовании фона)
        this.spriteMask = new Uint8Array(this.width * this.width); // 1 — пиксель закрыт деревом, домом, рудой и т. п.: слои фракций и сетки под ними не видны
        this.cover = false;                                       // пока true, всё, что рисует put(), попадает в spriteMask
        this.riverMask = null;
        this.relief = null;
        this.reliefHeight = null;
        this.shadeCache = new Map();
        this.tuftCache = new Map();
        this.emissive = [];   // источники света (окна, костры, эфирные разломы): рисуются после цветокоррекции, чтобы оставаться яркими
        this.buildAxisTables();

        // Слои можно отключать (опция layers) — для быстрой разработки: например, смотреть только горы без леса, дорог и тумана.
        const layers = { relief: true, hills: true, shores: true, rivers: true, roads: true, settlements: true, texture: true,
            borders: true, decorations: true, grading: true, ...this.options.layers };
        this.layers = layers;

        const terrain = view === 'terrain';
        this.paintBase();
        this.smoothCoast();
        if (terrain) {
            if (layers.relief) {
                this.relief = this.buildReliefHeights();
                this.reliefHeight = this.relief.height;
            }
            if (layers.hills) this.paintHills();
            if (layers.shores) this.paintShores();
            if (layers.rivers) this.paintRivers();
            if (layers.roads) this.paintRoads();
            if (layers.settlements) this.paintSettlementGround();
        }
        if (layers.texture) this.paintTexture();
        if (terrain && (layers.decorations || layers.relief)) this.paintScene();
        if (showBorders && layers.borders) this.paintRegionBorders();

        if (terrain && this.mood === 'dark' && this.options.grade && layers.grading) this.applyGrading();
        this.cover = true;                              // светящиеся детали (окна, костры, эфир) — тоже над землёй
        for (const draw of this.emissive) draw();
        this.cover = false;

        this.ctx.putImageData(image, 0, 0);
        return this.canvas;
    }

    /* ============================================================
       SECTION: HELPERS
       ============================================================ */

    // «Пиксели для клетки 12×12» -> пиксели текущей клетки.
    px(n) {
        return Math.round(n * this.tileSize / 12);
    }

    // Индекс клетки по индексу пикселя карты (обе версии записи дают одинаковый результат).
    tileOfPixel(k) {
        const T = this.tileSize, W = this.width;
        return Math.floor(k / W / T) * this.map.size + Math.floor((k % W) / T);
    }

    forEachTile(callback) {
        const size = this.map.size;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) callback(x, y);
        }
    }

    // Температура клетки с учётом сезона: зимой холоднее, летом теплее.
    seasonalTemperature(i) {
        return this.map.temperature[i] + this.season.tempShift;
    }

    put(x, y, color) {
        if (x >= 0 && y >= 0 && x < this.width && y < this.width) {
            const k = y * this.width + x;
            this.pixels[k] = color;
            if (this.cover) this.spriteMask[k] = 1;
        }
    }

    blend(x, y, color, alpha) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.width) return;
        const k = y * this.width + x;
        this.pixels[k] = mixPacked(this.pixels[k], color, alpha);
    }

    rect(x, y, w, h, color) {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) this.put(xx, yy, color);
        }
    }

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

    /* ============================================================
       SECTION: BACKGROUND
       ============================================================ */

    /* Сглаживание.
       Считаем, что цвет клетки «живёт» в её центре. Любой пиксель лежит внутри квадрата, углы которого — центры
       четырёх ближайших клеток (A B / C D). Вес каждой клетки — как при билинейной интерполяции, но вместо
       смешивания цветов мы выбираем один из четырёх с помощью дизеринга. Получается пиксельный градиент:
       у выпуклого угла («ступеньки») пиксели плавно уходят в цвет соседей, а внутри однотонных областей ничего не меняется. */
    paintBase() {
        const size = this.map.size;
        const T = this.tileSize;
        const W = this.width;
        const pixels = this.pixels;
        const { colors, water } = this.buildTileColors();
        const smooth = this.view !== 'regions'; // в режиме регионов границы должны быть точными
        const quadOf = this.blendGrid().quadOf;

        const quadColors = new Int32Array(16);
        const quadWater = new Uint8Array(16);
        const waterMask = this.waterMask;
        const quadSharpness = new Uint8Array(4);
        const clampTile = v => (v < 0 ? 0 : v >= size ? size - 1 : v);

        for (let ty = 0; ty < size; ty++) {
            for (let tx = 0; tx < size; tx++) {
                // Быстрый путь: клетка и все её соседи одного цвета — заливаем целиком.
                const color = colors[ty * size + tx];
                if (this.isUniform(colors, tx, ty, color)) {
                    for (let oy = 0; oy < T; oy++) {
                        const start = (ty * T + oy) * W + tx * T;
                        pixels.fill(color, start, start + T);
                        waterMask.fill(water[ty * size + tx], start, start + T);
                    }
                    continue;
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

                const choices = this.blendChoices(tx, ty);
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
            }
        }
    }

    /* Какой из четырёх цветов (A, B, C или D) получит пиксель, зависит только от его положения в клетке и
       от узора дизеринга, а не от самих цветов. Поэтому это считается заранее — по одной таблице на каждую
       «резкость» смешивания и каждый вариант сдвига узора (узор повторяется каждые 4 пикселя). */
    blendGrid() {
        if (this.grid) return this.grid;
        const T = this.tileSize;
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
        this.grid = { quadOf, u, v, cache: {} };
        return this.grid;
    }

    // Три таблицы выбора (мягкая, береговая, «ближайший сосед») для клетки с данным сдвигом узора дизеринга.
    blendChoices(tx, ty) {
        const T = this.tileSize;
        const grid = this.blendGrid();
        const offX = (tx * T) & 3, offY = (ty * T) & 3;
        const key = offX + 4 * offY;
        if (grid.cache[key]) return grid.cache[key];

        const sharpness = [this.options.blendSharpness, this.options.coastSharpness];
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
    }

    // Для каждого пикселя по одной оси: между центрами каких клеток он лежит и на каком расстоянии от первого.
    buildAxisTables() {
        const size = this.map.size;
        const W = this.width;
        const first = new Int32Array(W);
        const second = new Int32Array(W);
        const fraction = new Float32Array(W);
        const smooth = new Float32Array(W);
        for (let p = 0; p < W; p++) {
            const position = (p + 0.5) / this.tileSize - 0.5; // в «клетках»; центр клетки — целое число
            const index = Math.floor(position);
            first[p] = clamp(index, 0, size - 1);
            second[p] = clamp(index + 1, 0, size - 1);
            fraction[p] = position - index;
            smooth[p] = smoothstep(position - index);
        }
        this.axis = { first, second, fraction, smooth };
    }

    // Клетка и все восемь соседей (или края карты) одного цвета?
    isUniform(colors, tx, ty, color) {
        const size = this.map.size;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = tx + dx, ny = ty + dy;
                if (nx >= 0 && ny >= 0 && nx < size && ny < size && colors[ny * size + nx] !== color) return false;
            }
        }
        return true;
    }

    /* Скругление берега. Береговая линия из квадратных клеток и дизеринга — ступенчатая и «зашумлённая». Мажоритарный
       фильтр по маске воды (каждый пиксель становится водой или сушей — как большинство пикселей в окне радиуса
       coastSmoothing) убирает ступеньки и скругляет углы; чем больше радиус, тем круглее берег. 0 — выключить. */
    smoothCoast() {
        const radius = this.options.coastSmoothing;
        if (!radius) return;

        const key = [this.tileSize, radius, this.options.blendSharpness, this.options.coastSharpness, this.seedSalt].join('|');
        const cache = this.coastCache;
        if (cache && cache.source === this.map.terrain && cache.key === key) {
            // Форма берега от сезона не зависит: повторно только копируем цвета и обновляем маску воды.
            for (let n = 0; n < cache.changed.length; n++) this.pixels[cache.changed[n]] = this.pixels[cache.sources[n]];
            this.waterMask.set(cache.mask);
            return;
        }

        const map = this.map;
        const size = map.size;
        const T = this.tileSize;
        const W = this.width;
        const pixels = this.pixels;
        const water = this.waterMask;
        const next = Uint8Array.from(water);
        const changed = [];
        const sources = [];

        const coastTiles = [];                          // клетки, рядом с которыми есть и вода, и суша
        for (let ty = 0; ty < size; ty++) {
            for (let tx = 0; tx < size; tx++) {
                let land = false, wet = false;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = tx + dx, ny = ty + dy;
                        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                        if (map.isLand(ny * size + nx)) land = true; else wet = true;
                    }
                }
                if (land && wet) coastTiles.push(ty * size + tx);
            }
        }

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

        // 2) перекрашиваем изменившиеся пиксели цветом ближайшего неизменившегося пикселя нужного вида (вода / суша)
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
                                    pixels[k] = pixels[s];
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
        water.set(next);
        this.coastCache = { source: map.terrain, key, mask: next, changed: Int32Array.from(changed), sources: Int32Array.from(sources) };
    }

    // Цвет каждой клетки и признак «вода».
    buildTileColors() {
        const count = this.map.size * this.map.size;
        const colors = new Int32Array(count);
        const water = new Uint8Array(count);
        for (let i = 0; i < count; i++) {
            colors[i] = this.tileColor(i);
            water[i] = this.map.isLand(i) && !this.isRiverTileInRegionsView(i) ? 0 : 1;
        }
        return { colors, water };
    }

    // В режиме регионов реки не рисуются, но клетки рек в регионы не входят (regionId = -1): показываем их как воду.
    isRiverTileInRegionsView(i) {
        return this.view === 'regions' && this.map.regionId[i] < 0;
    }

    tileColor(i) {
        const map = this.map;
        const terrain = map.terrain[i];
        const isWater = terrain < Terrain.PLAIN;

        if (this.view === 'temperature') {
            const hue = 215 - 215 * map.temperature[i]; // синий (холод) -> красный (жара)
            return hslToPacked(hue, 60, isWater ? 36 : 52);
        }
        if (isWater || this.isRiverTileInRegionsView(i)) return this.waterColor(i);
        if (this.view === 'regions') return hslToPacked((map.regionId[i] * 137.5) % 360, 45, 58); // «золотой угол»: соседи разного цвета
        if (terrain === Terrain.MOUNTAIN) return this.packed.rock; // под рельефом — камень
        return this.groundColor(i);
    }

    // Вода темнее по мере удаления от берега — и в океане, и в озёрах. В холод у берега появляется лёд.
    waterColor(i) {
        const depth = this.map.waterDepth[i];
        const temperature = this.seasonalTemperature(i);

        if (this.view === 'terrain' && temperature < ICE_TEMPERATURE) {
            const freezeDepth = Math.round((ICE_TEMPERATURE - temperature) / ICE_TEMPERATURE * 10); // чем холоднее, тем дальше от берега лёд
            if (depth > 0 && depth <= freezeDepth) return this.packed.ice[depth <= 3 ? 0 : depth <= 6 ? 1 : 2];
        }
        return this.packed.waterShades[waterShadeIndex(depth)];
    }

    // Цвет земли: цвет биома в этом сезоне, с поправкой на плодородие, а в холод — с примесью снега.
    groundColor(i) {
        const base = this.packed.biome[this.map.biome[i]];
        if (this.view !== 'terrain') return base;

        const tinted = this.fertilityTint(i, base);
        const coverage = this.snowCoverage(i);
        return coverage > 0 ? mixPacked(tinted, this.packed.snow, 0.9 * coverage) : tinted;
    }

    // Доля снега на земле: 0, 1/3, 2/3 или 1 («пиксельные» ступени).
    snowCoverage(i) {
        return Math.round(clamp((SNOW_TEMPERATURE - this.seasonalTemperature(i)) / 0.16) * 3) / 3;
    }

    // Клетка рядом с рекой (считается один раз на карту).
    nearRiver(i) {
        const map = this.map;
        if (!this.nearRiverCache || this.nearRiverCache.source !== map.river) {
            const near = new Uint8Array(map.river.length);
            for (let k = 0; k < near.length; k++) {
                if (map.river[k] > 0) for (const j of map.neighbors8(k)) near[j] = 1;
            }
            this.nearRiverCache = { source: map.river, near };
        }
        return this.nearRiverCache.near[i];
    }

    // Внутри одного биома цвет зависит от плодородия: влажные места гуще и темнее, сухие светлее и желтее.
    fertilityTint(i, color) {
        const biome = this.map.biome[i];
        if (biome === Biome.TUNDRA || biome === Biome.DESERT) return color;

        const wet = this.nearRiver(i) ? 0.3 : 0;                    // у воды земля влажнее и зеленее
        const moisture = Math.round(Math.min(1, this.map.moisture[i] + wet) * 5) / 5; // 6 ступеней: меньше «грязи» на стыках клеток
        return moisture > 0.5
            ? shadePacked(color, -0.16 * (moisture - 0.5) / 0.5)
            : mixPacked(color, this.colors.hay, 0.32 * (0.5 - moisture) / 0.5);
    }

    // Цвет, осветлённый или затемнённый на step ступеней (-2..2).
    shadeStep(color, step) {
        return shadeFast(color, STEP_AMOUNTS[step + 2]);
    }

    /* ============================================================
       SECTION: HILLS
       ============================================================ */

    /* На равнинах — лёгкая светотень «карты холмов» (свет слева сверху, как у гор и деревьев) плюс тёмные овраги
       в сухих местах. Карта холмов — шум плюс крупный рельеф суши из генератора; считается один раз на карту. */
    paintHills() {
        const o = this.options;
        if (o.hillStrength <= 0 && o.ravineDensity <= 0) return;

        const key = `${this.tileSize}|${o.hillStrength}|${o.ravineDensity}`;
        const cache = this.hillShading;
        if (cache && cache.source === this.map.elevation && cache.key === key) {
            applyHillShading(this.pixels, cache.shading);
            return;
        }

        const map = this.map;
        const size = map.size;
        const T = this.tileSize;
        const W = this.width;
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

        const shading = computeHillShading({
            hills: this.buildHillHeights(), waterMask: this.waterMask, flags, tileOfColumn,
            width: W, tile: T, strength: o.hillStrength,
            ravineWidth: 0.012 + 0.03 * o.ravineDensity,
            valleyNoise: new LatticeNoise(W, Math.max(6, this.px(22)), 611 + this.seedSalt),
            capacity: eligible * T * T
        });
        this.hillShading = { source: map.elevation, key, shading };
        applyHillShading(this.pixels, shading);
    }

    // Карта холмов по пикселям (0..255). От сезона не зависит, поэтому кэшируется.
    buildHillHeights() {
        const map = this.map;
        const cache = this.hillCache;
        if (cache && cache.source === map.elevation && cache.tileSize === this.tileSize) return cache.height;

        const size = map.size;
        const T = this.tileSize;
        const W = this.width;
        const height = new Uint8Array(W * W);
        const { first, second, fraction } = this.axis;
        const broad = new LatticeNoise(W, Math.max(6, this.px(20)), 601 + this.seedSalt);
        const landHeight = new Float32Array(size * size);
        for (let i = 0; i < landHeight.length; i++) landHeight[i] = clamp((map.elevation[i] - map.seaLevel) / 0.5);

        for (let ty = 0; ty < size; ty++) {
            for (let tx = 0; tx < size; tx++) {
                if (!map.isLand(ty * size + tx)) continue;
                for (let gy = ty * T; gy < (ty + 1) * T; gy++) {
                    const rowTop = first[gy] * size, rowBottom = second[gy] * size, v = fraction[gy];
                    for (let gx = tx * T; gx < (tx + 1) * T; gx++) {
                        const u = fraction[gx];
                        const a = landHeight[rowTop + first[gx]], b = landHeight[rowTop + second[gx]];
                        const c = landHeight[rowBottom + first[gx]], d = landHeight[rowBottom + second[gx]];
                        const top = a + (b - a) * u;
                        const coarse = top + (c + (d - c) * u - top) * v; // крупный рельеф суши из генератора
                        const value = 0.3 * coarse + 0.7 * broad.at(gx, gy);
                        height[gy * W + gx] = value <= 0 ? 0 : value >= 1 ? 255 : Math.round(value * 255);
                    }
                }
            }
        }

        this.hillCache = { source: map.elevation, tileSize: T, height };
        return height;
    }

    /* ============================================================
       SECTION: SHORES
       ============================================================ */

    /* Тип берега задаёт генератор (map.shore). Расстояние от воды считаем в пикселях: волной от воды вглубь суши.
         пляж     — полоса мокрого, потом сухого песка; в воде у берега белая пена;
         каменистый — галька и камни, пена послабее;
         утёс     — суша приподнята над водой: под её краем видна каменная стенка (на юге) и тень на воде. */
    paintShores() {
        if (!this.options.shores) return;

        const map = this.map;
        const size = map.size;
        const T = this.tileSize;
        const W = this.width;
        const pixels = this.pixels;
        const waterMask = this.waterMask;
        const c = this.colors;
        const wet = Math.max(1, this.px(2));            // ширина полосы мокрого песка
        const reach = Math.max(3, Math.ceil(wet + this.tileSize / this.options.coastSharpness)); // на сколько пикселей берег уходит вглубь суши (мягче переход — шире полоса)
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
        const tileOf = k => this.tileOfPixel(k);

        // 1) семена: каждый пиксель суши прямо у воды. Тип берега задан для клеток, а сглаженная береговая линия заходит
        // в соседние клетки (в том числе в воду, у которой типа нет), поэтому тип берём у самой клетки пикселя, а если у неё
        // его нет — у ближайшей клетки с берегом среди соседей. Тогда полоса идёт по всей береговой линии без обрывов.
        const typedTile = (tx, ty) => {
            if (tx < 0 || ty < 0 || tx >= size || ty >= size) return 0;
            const i = ty * size + tx;
            return map.river[i] || !map.isLand(i) ? 0 : map.shore[i];
        };
        for (let ty = 0; ty < size; ty++) {
            for (let tx = 0; tx < size; tx++) {
                let near = false;
                for (let dy = -1; dy <= 1 && !near; dy++) {
                    for (let dx = -1; dx <= 1; dx++) if (typedTile(tx + dx, ty + dy)) { near = true; break; }
                }
                if (!near) continue;
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

        // 3) покраска суши
        for (const k of queue) {
            const gx = k % W, gy = (k - gx) / W;
            const d = distance[k];
            const type = kind[k];
            const threshold = BAYER[(gy & 3) * 4 + (gx & 3)];
            const ground = pixels[k];
            let color = 0;

            if (type === Shore.BEACH) {
                if (d <= wet) color = c.wetSand;
                else if (threshold < 1 - (d - wet) / (reach - wet + 1)) color = hashUnit(gx, gy, 620) < 0.18 ? c.wetSand : c.sand;
                if (color !== 0) {
                    const snow = this.snowCoverage(tileOf(k));
                    if (snow > 0) color = mixPacked(color, this.packed.snow, 0.9 * snow);
                }
            } else if (type === Shore.ROCKY) {
                if (threshold < 1 - (d - 1) / (reach + 1)) {
                    const r = hashUnit(gx, gy, 621);
                    color = r < 0.3 ? c.pebbleLight : r < 0.55 ? c.pebbleDark : mixPacked(ground, c.stoneMid, 0.6);
                }
            } else if (type === Shore.CLIFF) {
                if (d <= 3 && threshold < 0.7) color = shadePacked(ground, -0.2);
            }
            if (color !== 0) pixels[k] = color;
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
        for (const k of foam) {
            if (this.seasonalTemperature(tileOf(k)) < ICE_TEMPERATURE) continue;
            const gx = k % W, gy = (k - gx) / W;
            const threshold = BAYER[(gy & 3) * 4 + (gx & 3)];
            const mark = kind[k];
            if (mark >= 20) { if (threshold < 0.4) pixels[k] = mixPacked(pixels[k], WHITE, 0.16); }
            else if (threshold < 0.85) pixels[k] = mixPacked(pixels[k], WHITE, mark === 10 + Shore.BEACH ? 0 : 0.3);
        }

        this.paintCliffs(queue, distance, kind);
    }

    // Утёсы: суша «приподнята» — под её южным краем стенка из камня, под ней тень на воде. Идём по тем же пикселям берега,
    // что и полоса берега (а не по клеткам), поэтому сглаженная береговая линия не рвёт обрыв на куски.
    paintCliffs(queue, distance, kind) {
        const W = this.width;
        const pixels = this.pixels;
        const waterMask = this.waterMask;
        const faceHeight = Math.max(3, this.px(5));
        const rock = this.packed.rock;
        const faceTones = [shadePacked(rock, 0.1), shadePacked(rock, -0.08), shadePacked(rock, -0.24)];

        for (const k of queue) {
            if (distance[k] !== 1 || kind[k] !== Shore.CLIFF) continue;
            const gx = k % W, gy = (k - gx) / W;

            if (k + W < W * W && waterMask[k + W]) {                     // вода под краем: виден обрыв
                pixels[k] = shadePacked(pixels[k], 0.12);                 // светлая кромка
                for (let f = 1; f <= faceHeight; f++) {
                    const below = k + f * W;
                    if (below >= W * W || !waterMask[below]) break;
                    let tone = faceTones[Math.min(2, Math.floor((f - 1) * 3 / faceHeight))];
                    if (hashUnit(gx, gy + f, 622) < 0.2) tone = shadePacked(tone, -0.1);
                    pixels[below] = tone;
                    if (f === faceHeight) {
                        for (let s = 1; s <= 2; s++) {
                            const shadow = below + s * W;
                            if (shadow < W * W && waterMask[shadow]) pixels[shadow] = mixPacked(pixels[shadow], BLACK, s === 1 ? 0.35 : 0.18);
                        }
                    }
                }
            } else if ((gx > 0 && waterMask[k - 1]) || (gx < W - 1 && waterMask[k + 1])) {
                pixels[k] = shadePacked(pixels[k], -0.2);                 // боковая стенка
            }
        }
    }

    /* ============================================================
       SECTION: MOUNTAIN_RELIEF
       ============================================================ */

    /* Горы — «карта высот», раскрашенная светотенью (свет слева сверху), а не спрайты. Высота клетки берётся из
       генератора, размывается по соседям и интерполируется до пикселя; к ней добавляются острые гребни (шум) и
       вершины-«конусы». Затем карта проецируется наклонно: чем выше точка, тем выше (севернее) она рисуется на
       экране — как у деревьев, которые показаны почти в профиль. Южные склоны при этом растягиваются и
       становятся видны «лицом» зрителю.
       Острота гор настраивается параметром peakSharpness (0 — округлые, 1 — острые). */

    // Карта высот гор по пикселям. От сезона не зависит, поэтому кэшируется.
    //
    // Как у настоящих гор на спутниковых снимках: огибающая (высота клеток из генератора) умножается на «складчатый»
    // рельеф — несколько масштабов гребней (|шум − ½|), где мелкие гребни вырастают только на крупных (мультифрактал).
    // Получаются ветвящиеся хребты и долины, а искажение координат (warp) делает их извилистыми, а не «ячеистыми».
    buildReliefHeights() {
        const map = this.map;
        const sharp = clamp(this.options.peakSharpness);
        const detail = clamp(this.options.mountainDetail);
        const ragged = clamp(this.options.mountainRagged);
        const cache = this.reliefCache;
        if (cache && cache.source === map.mountainHeight && cache.tileSize === this.tileSize && cache.sharpness === sharp && cache.detail === detail && cache.ragged === ragged) return cache;

        const size = map.size;
        const T = this.tileSize;
        const W = this.width;
        const blurred = this.blurMountainHeights();
        const footprint = this.mountainFootprint();                 // 1 — клетка горы, 0 — всё остальное
        const zone = this.tilesNearRelief(footprint);
        const height = new Uint8Array(W * W);
        const { first, second, fraction } = this.axis;
        const edgeNoise = new LatticeNoise(W, Math.max(3, this.px(7)), 540 + this.seedSalt);

        const cells = [44, 22, 11, 5.5].map(cell => Math.max(3, this.px(cell)));      // размеры гребней: от крупных хребтов до мелких отрогов
        const octaves = cells.map((cell, k) => new LatticeNoise(W, cell, 503 + k + this.seedSalt));
        const warp = new LatticeNoise(W, Math.max(6, this.px(52)), 520 + this.seedSalt);
        const warpDistance = this.px(26);
        const power = 1 + 1.4 * sharp;                                                  // чем больше, тем уже и острее гребни
        const powerTable = Float32Array.from({ length: 256 }, (_, n) => Math.pow(n / 255, power));   // x^power без Math.pow в цикле

        for (const tile of zone) {
            const tx = tile % size, ty = Math.floor(tile / size);
            for (let gy = ty * T; gy < (ty + 1) * T; gy++) {
                const rowTop = first[gy] * size, rowBottom = second[gy] * size, v = fraction[gy];
                for (let gx = tx * T; gx < (tx + 1) * T; gx++) {
                    const u = fraction[gx];
                    const a = blurred[rowTop + first[gx]], b = blurred[rowTop + second[gx]];
                    const c = blurred[rowBottom + first[gx]], d = blurred[rowBottom + second[gx]];
                    const top = a + (b - a) * u;
                    const base = top + (c + (d - c) * u - top) * v;
                    if (base < 0.01) continue;

                    // Кромка: гора не выходит за свои клетки. Покрытие footprint (1 в горе, 0 вне; 0.5 ровно на границе клеток)
                    // интерполируется до пикселя — углы получаются скруглёнными, а шум делает край рваным.
                    const f0 = footprint[rowTop + first[gx]], f1 = footprint[rowTop + second[gx]];
                    const f2 = footprint[rowBottom + first[gx]], f3 = footprint[rowBottom + second[gx]];
                    const ftop = f0 + (f1 - f0) * u;
                    const coverage = ftop + (f2 + (f3 - f2) * u - ftop) * v;
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
        const smooth = this.blurHeights(height, zone, Math.max(2, this.px(5)));

        this.reliefCache = { source: map.mountainHeight, tileSize: T, sharpness: sharp, detail, ragged, zone, height, smooth };
        return this.reliefCache;
    }

    // Размытие карты высот (по строкам, потом по столбцам) только в клетках, где есть горы.
    blurHeights(height, zone, radius) {
        const size = this.map.size;
        const T = this.tileSize;
        const W = this.width;
        const horizontal = new Uint8Array(W * W);
        const result = new Uint8Array(W * W);
        const window = 2 * radius + 1;

        for (const tile of zone) {
            const x0 = (tile % size) * T, y0 = Math.floor(tile / size) * T;
            for (let y = y0; y < y0 + T; y++) {
                for (let x = x0; x < x0 + T; x++) {
                    let sum = 0;
                    for (let d = -radius; d <= radius; d++) {
                        const xx = x + d;
                        if (xx >= 0 && xx < W) sum += height[y * W + xx];
                    }
                    horizontal[y * W + x] = Math.round(sum / window);
                }
            }
        }
        for (const tile of zone) {
            const x0 = (tile % size) * T, y0 = Math.floor(tile / size) * T;
            for (let y = y0; y < y0 + T; y++) {
                for (let x = x0; x < x0 + T; x++) {
                    let sum = 0;
                    for (let d = -radius; d <= radius; d++) {
                        const yy = y + d;
                        if (yy >= 0 && yy < W) sum += horizontal[yy * W + x];
                    }
                    result[y * W + x] = Math.round(sum / window);
                }
            }
        }
        return result;
    }

    /* Цвет гор считается по трём вещам: высота (низ — луг, выше — тёмный лес, на самом верху — камень), крутизна
       (крутые склоны голые, пологие — в лесу) и освещённость (свет слева сверху). Снег лежит выше снеговой линии.
       Оттенки квантуются и смешиваются дизерингом — пиксельная графика, но без «ступенек» из 5 серых цветов. */
    prepareReliefRows() {
        if (!this.relief) return null;
        const { zone, height, smooth } = this.relief;
        if (zone.length === 0) return null;

        const size = this.map.size;
        const W = this.width;
        const rows = Array.from({ length: size }, () => []);
        for (const tile of zone) rows[Math.floor(tile / size)].push(tile % size);

        const packed = this.packed;
        const ramp = Int32Array.from(MOUNTAIN_RAMP, hex => mixPacked(hexToPacked(hex), packed.rock, 0.12));
        const snowLevels = new Float32Array(size * size);
        for (const tile of zone) snowLevels[tile] = this.snowLevel(tile);
        const snow = packed.snow, snowShade = packed.snowShade;

        return {
            rows, height, smooth, snowLevels, ramp,
            snowRamp: Int32Array.from([mixPacked(snowShade, ramp[2], 0.35), snowShade, mixPacked(snow, snowShade, 0.5), snow, snow]),
            scree: ramp[3],
            lightSign: this.options.mountainLight === 'right' ? -1 : 1,
            lift: this.px(this.options.mountainLift),
            proj: new Int32Array(W),                     // для каждого столбца: куда на экране попал предыдущий пиксель
            face: new Int32Array(W),                     // и каким цветом закрасить «склон» под ним
            valid: new Uint8Array(W)
        };
    }

    // Одна строка карты высот -> экран. Горы поднимаются вверх на lift * высота; пустоты между строками
    // (южные склоны) закрашиваются цветом склона.
    paintReliefRow(relief, gy) {
        const T = this.tileSize;
        const W = this.width;
        const size = this.map.size;
        const ty = Math.floor(gy / T);
        const { height, smooth, snowLevels, snowRamp, ramp, scree, lightSign, lift, proj, face, valid } = relief;
        const pixels = this.pixels;
        const last = W * W - 1;

        for (const tx of relief.rows[ty]) {
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
                        this.fillColumn(gx, proj[gx] + 1, gy - 1, face[gx]);
                        valid[gx] = 0;
                    }
                    continue;
                }

                const lifted = gy - Math.round(smooth[k] / 255 * lift);
                if (valid[gx] && lifted - proj[gx] > 1) this.fillColumn(gx, proj[gx] + 1, lifted - 1, faceColor);
                if (lifted >= 0) pixels[lifted * W + gx] = color;
                proj[gx] = lifted;
                face[gx] = faceColor;
                valid[gx] = 1;
            }
        }
    }

    fillColumn(gx, fromY, toY, color) {
        const W = this.width;
        for (let y = Math.max(0, fromY); y <= toY; y++) this.pixels[y * W + gx] = color;
    }

    // Высоты клеток, дважды размытые по соседям: горы «набухают» за пределы своих клеток, а разброс высот
    // от клетки к клетке сглаживается (иначе на массиве проступает сетка).
    blurMountainHeights() {
        const size = this.map.size;
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
        const blurred = pass(pass(this.map.mountainHeight));
        for (let i = 0; i < blurred.length; i++) blurred[i] = Math.min(1, blurred[i] * 1.8);
        return blurred;
    }

    // Клетки, занятые горами (1) и остальные (0): от этого зависит, докуда рельеф может доходить.
    mountainFootprint() {
        const mountainHeight = this.map.mountainHeight;
        const footprint = new Float32Array(mountainHeight.length);
        for (let i = 0; i < footprint.length; i++) footprint[i] = mountainHeight[i] > 0 ? 1 : 0;
        return footprint;
    }

    // Клетки, на которых может быть рельеф: сами горы и всё, что рядом.
    tilesNearRelief(blurred) {
        const size = this.map.size;
        const zone = [];
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                let near = false;
                for (let dy = -1; dy <= 1 && !near; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = x + dx, ny = y + dy;
                        if (nx >= 0 && ny >= 0 && nx < size && ny < size && blurred[ny * size + nx] > 0) { near = true; break; }
                    }
                }
                if (near) zone.push(y * size + x);
            }
        }
        return zone;
    }

    // С какой относительной высоты лежит снег: чем холоднее (с учётом сезона), тем он ниже.
    snowLevel(tile) {
        const fraction = clamp((0.36 - this.seasonalTemperature(tile)) / 0.3);
        return 0.95 - fraction * 0.6;
    }

    /* ============================================================
       SECTION: RIVERS
       ============================================================ */

    // Ширина реки в пикселях по её уровню (глубине).
    // Ширина реки в клетке по количеству воды: ручей — 2–3 пикселя, большая река у устья — до 14.
    riverWidthAt(i) {
        const flow = this.map.riverFlow[i];
        return Math.max(2, Math.min(this.px(14), Math.round((this.tileSize / 12) * (1 + 0.4 * Math.sqrt(flow)))));
    }

    riverWidth(level) {
        return Math.max(level + 1, this.px([4, 6, 8][level - 1]));
    }

    // Смещение полосы толщиной thickness, чтобы она лежала по центру клетки.
    band(thickness) {
        return Math.round((this.tileSize - thickness) / 2);
    }

    /* Реки рисуем прямо в пиксели фона (а не поверх готовой картинки).
       Сначала строим маску: в каждом пикселе — уровень реки (1..3) или 0. Потом красим её жёстко, без растушёвки: вода
       доходит ровно до края маски, по внутреннему краю идёт светлый контур в один пиксель (у тонких ручьёв его нет), а
       снаружи — ровная линия берега. Чёткий контур читается лучше, чем размытая дизерингом кромка. */
    paintRivers() {
        const geometry = this.buildRiverGeometry();
        this.riverMask = geometry.riverOnly;                       // без декоративных концов: по ней считаются дороги, мосты и регионы
        if (geometry.riverTiles.length === 0) return;

        const { mask, queue, distance, levelNear, solid } = geometry;
        const T = this.tileSize;
        const W = this.width;
        const size = this.map.size;
        const pixels = this.pixels;
        const tileOf = k => this.tileOfPixel(k);
        const iceRiver = tile => this.seasonalTemperature(tile) < RIVER_ICE_TEMPERATURE;
        const bankColors = new Map();                              // тёмный цвет берега считаем один раз на каждый цвет земли

        // Все реки — самой мелкой воды, цвета прибрежного мелководья (а не по глубине); зимой — лёд.
        const riverColor = tile => (iceRiver(tile) ? this.packed.ice[0] : this.packed.waterShades[0]);

        for (const k of solid) pixels[k] = riverColor(tileOf(k));   // сердцевина реки — сплошной цвет

        // Вода до самого края; внутренний край — светлее, если за ним есть ещё вода (то есть река шире двух пикселей).
        for (const k of queue) {
            const d = distance[k];
            if (d <= 0) continue;
            const xx = k % W, yy = (k - xx) / W;
            const color = riverColor(tileOf(k));
            const deep = d === 1 && ((xx > 0 && mask[k - 1] > 0 && distance[k - 1] !== 1) || (xx < W - 1 && mask[k + 1] > 0 && distance[k + 1] !== 1)
                || (yy > 0 && mask[k - W] > 0 && distance[k - W] !== 1) || (yy < W - 1 && mask[k + W] > 0 && distance[k + W] !== 1));
            pixels[k] = deep ? mixPacked(color, WHITE, 0) : color;
        }

        // Берег: первый пиксель суши — ровная тёмная линия, второй — редкая галька или песок на пляжных и каменистых берегах.
        if (!this.options.shores) return;
        for (const k of queue) {
            const d = distance[k];
            if (d >= 0) continue;
            this.paintBankPixel(k % W, Math.floor(k / W), k, -d, bankColors);
        }
    }

    /* Форма рек не зависит от сезона, поэтому считается один раз: маска (уровень реки в каждом пикселе), список
       пикселей кромки с расстоянием до края и список «сердцевины». Кэш сбрасывается при смене карты или параметров резкости. */
    buildRiverGeometry() {
        const map = this.map;
        const key = [this.tileSize, this.options.coastSharpness, this.options.blendSharpness, this.options.coastSmoothing, this.seedSalt, this.options.riverTails].join('|');
        const cache = this.riverCache;
        if (cache && cache.source === map.river && cache.key === key) return cache;

        const size = map.size;
        const T = this.tileSize;
        const W = this.width;
        const mask = new Uint8Array(W * W);

        const riverTiles = [];
        for (let i = 0; i < map.river.length; i++) {
            if (map.river[i] > 0) riverTiles.push(i);
        }
        const empty = { source: map.river, key, riverTiles, mask, riverOnly: mask, queue: new Int32Array(0), distance: null, levelNear: null, solid: new Int32Array(0) };
        if (riverTiles.length === 0) {
            this.riverCache = empty;
            return empty;
        }

        // 1) форма: каждая клетка реки соединена с клеткой, куда течёт вода (map.riverTo). Отрезок — слегка извилистая полоса,
        //    ширина которой плавно меняется от клетки к клетке по количеству воды (map.riverFlow); у устья река расширяется.
        const wobble = this.px(2);
        const centerOf = tile => {
            const x = tile % size, y = Math.floor(tile / size);
            return [x * T + T / 2 + (hashUnit(x, y, 983) - 0.5) * wobble, y * T + T / 2 + (hashUnit(x, y, 984) - 0.5) * wobble];
        };
        const stamp = (cx, cy, width, level) => {
            const radius = width / 2;
            for (let oy = -Math.ceil(radius); oy <= Math.ceil(radius); oy++) {
                for (let ox = -Math.ceil(radius); ox <= Math.ceil(radius); ox++) {
                    if (ox * ox + oy * oy > radius * radius + 0.25) continue;     // круглое «перо», а не квадрат
                    const x = cx + ox, y = cy + oy;
                    if (x < 0 || y < 0 || x >= W || y >= W) continue;
                    const k = y * W + x;
                    if (!this.waterMask[k] && level > mask[k]) mask[k] = level;
                }
            }
        };

        for (const i of riverTiles) {
            const to = map.riverTo[i];
            if (to === -1) continue;
            const [ax, ay] = centerOf(i);
            let [bx, by] = centerOf(to);
            const toWater = !map.isLand(to);
            if (toWater) { bx = (ax + bx) / 2; by = (ay + by) / 2; }              // в море река заканчивается у берега
            const widthFrom = this.riverWidthAt(i);
            const widthTo = toWater ? Math.round(widthFrom * 1.4) : (map.river[to] > 0 ? this.riverWidthAt(to) : widthFrom);

            const length = Math.hypot(bx - ax, by - ay) || 1;
            const bend = (hashUnit(i, to, 985) - 0.5) * Math.min(this.px(5), length * 0.8);
            const mx = (ax + bx) / 2 - ((by - ay) / length) * bend;
            const my = (ay + by) / 2 + ((bx - ax) / length) * bend;
            const points = [
                ...this.linePoints(Math.round(ax), Math.round(ay), Math.round(mx), Math.round(my)),
                ...this.linePoints(Math.round(mx), Math.round(my), Math.round(bx), Math.round(by))
            ];
            const level = map.river[i];
            points.forEach(([px, py], k) => stamp(px, py, widthFrom + (widthTo - widthFrom) * (k / Math.max(1, points.length - 1)), level));
        }

        // 1б) истончающиеся концы: за истоком река продолжается в сушу, плавно сужаясь до нуля. Это только украшение: в
        //     riverOnly (по ней считаются дороги, мосты и регионы) концы не входят, в mask — входят (рисуются как река).
        const riverOnly = Uint8Array.from(mask);
        const tailTiles = new Set();
        if (this.options.riverTails) {
            const fed = new Uint8Array(size * size);                           // клетки, в которые впадает другая клетка реки
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
                    if (this.waterMask[ry * W + rx]) break;
                    path.push([rx, ry, tile]);
                }
                if (path.length < 5) continue;

                const widthStart = this.riverWidthAt(i);
                path.forEach(([rx, ry, tile], n) => {
                    const t01 = n / path.length;
                    const width = widthStart * Math.pow(1 - t01, 1.2);
                    // Толстая часть — круглым пером; когда ширина меньше пикселя, остаётся пунктир, всё реже (равномерно, без случайных пятен).
                    if (width >= 1.2 || (width * 0.83) > ((n * 0.6180339887 + hashUnit(x, y, 990)) % 1)) stamp(rx, ry, Math.max(1, width), 1);
                    tailTiles.add(tile);
                });
            }
        }

        // 2) расстояние до края реки: внутри — положительное, снаружи — отрицательное; ширина перехода из coastSharpness
        const edgeWidth = Math.max(2, T / this.options.coastSharpness);
        const reachPx = Math.ceil(edgeWidth / 2) + 1;
        const distance = new Int8Array(W * W);
        const levelNear = new Uint8Array(W * W);
        const queue = [];
        const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= W ? 0 : mask[yy * W + xx]);

        // Клетки, где может быть вода реки: сами реки и их соседи. Каждый пиксель — один раз.
        const zone = new Set();
        for (const i of [...riverTiles, ...tailTiles]) {
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
                        levelNear[k] = mask[k];
                        queue.push(k);
                    } else if (mask[k] === 0 && around > 0) {
                        distance[k] = -1;                      // первый пиксель суши у воды
                        levelNear[k] = around;
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
            for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
                const next = ny * W + nx;
                if (distance[next] !== 0 || (mask[next] > 0) !== (sign > 0)) continue;
                distance[next] = d + sign;
                levelNear[next] = levelNear[k];
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

        this.riverCache = { source: map.river, key, riverTiles, mask, riverOnly, queue: Int32Array.from(queue), distance, levelNear, solid: Int32Array.from(solid) };
        return this.riverCache;
    }

    // Берег реки: первый пиксель суши — сплошная линия мокрой земли (одинаковая вдоль всей реки, чтобы контур был строгим),
    // второй — редкая галька у каменистых и песок у пляжных клеток. Дальше берега нет.
    paintBankPixel(xx, yy, k, outside, bankColors) {
        if (outside > 2 || this.waterMask[k]) return;
        const pixels = this.pixels;

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

        const T = this.tileSize;
        const type = this.map.shore[Math.floor(yy / T) * this.map.size + Math.floor(xx / T)];
        if ((type !== Shore.BEACH && type !== Shore.ROCKY && type !== Shore.CLIFF) || hashUnit(xx, yy, 631) >= 0.4) return;
        const c = this.colors;
        if (type === Shore.BEACH) pixels[k] = c.sand;
        else pixels[k] = hashUnit(xx, yy, 630) < 0.5 ? c.pebbleLight : c.pebbleDark;
    }

    /* ============================================================
       SECTION: TEXTURE
       ============================================================ */

    paintTexture() {
        const map = this.map;
        const T = this.tileSize;
        const speckCount = Math.round(T * T / 16);
        const specks = this.speckLayout(speckCount);

        this.forEachTile((x, y) => {
            const i = map.index(x, y);
            const isLand = map.isLand(i);

            // Едва заметные светлые и тёмные точки — чтобы поверхность не выглядела плоской заливкой.
            if (map.terrain[i] !== Terrain.MOUNTAIN) {
                const base = i * speckCount;
                for (let k = 0; k < speckCount; k++) {
                    const code = specks[base + k];                 // пиксель в клетке и «светлее/темнее» — посчитаны заранее
                    const at = (y * T + (code >> 9)) * this.width + x * T + ((code >> 1) & 255);
                    this.pixels[at] = speckColor(this.pixels[at], code & 1);
                }
            }

            if (!isLand) {
                if (tileHash(x, y, 9) % 6 === 0) {
                    for (let dx = 0; dx < this.px(3); dx++) this.blend(x * T + this.px(3) + dx, y * T + this.px(5), WHITE, 0.25);
                }
            } else if (this.view === 'terrain') {
                this.paintGroundDetail(x, y, i);
                this.paintTufts(x, y, i);
            }
        });
    }

    // Расположение крапинок: одинаково при любом сезоне и виде, поэтому считается один раз на карту.
    speckLayout(speckCount) {
        const size = this.map.size;
        const T = this.tileSize;
        const cache = this.speckCache;
        if (cache && cache.size === size && cache.tileSize === T && cache.seed === this.seedSalt) return cache.layout;

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
        this.speckCache = { size, tileSize: T, seed: this.seedSalt, layout };
        return layout;
    }

    // Сезонные мелочи на лугах: весной цветы, осенью опавшая листва.
    paintGroundDetail(x, y, i) {
        const colors = this.pal.groundDetail;
        const map = this.map;
        if (!colors || map.terrain[i] !== Terrain.PLAIN || map.biome[i] !== Biome.GRASSLAND || map.river[i] || map.resource[i] === Resource.SETTLEMENT || map.roadLevel[i] > 0) return;
        if (tileHash(x, y, 100) % 3 !== 0) return;

        const T = this.tileSize;
        for (let k = 0; k < 3; k++) {
            const h = tileHash(x, y, 101 + k);
            this.put(x * T + (h % T), y * T + ((h >>> 8) % T), hexToPacked(colors[h % colors.length]));
        }
    }

    // Трава: пучки стебельков. Чем плодороднее и влажнее место, тем их больше; цвет — оттенки земли под ними.
    paintTufts(x, y, i) {
        const map = this.map;
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
        count = Math.round(count * this.options.grassDensity * (map.resource[i] === Resource.WOOD ? 0.6 : 1));

        const T = this.tileSize;
        const W = this.width;
        for (let n = 0; n < count; n++) {
            const h = tileHash(x, y, 400 + n);
            const bx = x * T + (h % T);
            const by = y * T + ((h >>> 8) % T);
            const ground = this.pixels[Math.min(by, W - 1) * W + Math.min(bx, W - 1)];
            const dark = shadeFast(ground, -56);
            const light = shadeFast(ground, 46);
            const blades = 2 + ((h >>> 16) % 2);
            const lean = ((h >>> 18) % 3) - 1;

            for (let b = 0; b < blades; b++) {
                const bladeHeight = this.px(2) + 1 + ((h >>> (20 + b)) & 1);
                for (let step = 0; step < bladeHeight; step++) {
                    this.putGround(bx + b + (step >= 2 ? lean : 0), by - step, step === bladeHeight - 1 ? light : dark);
                }
            }
        }
    }

    // Пиксель земли: не рисуем поверх воды и реки.
    putGround(x, y, color) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.width) return;
        const k = y * this.width + x;
        if (this.waterMask[k] || (this.riverMask && this.riverMask[k])) return;
        this.pixels[k] = color;
    }

    /* ============================================================
       SECTION: DARK_STYLE
       ============================================================ */

    // Приглушает цвет построек в тёмном стиле.
    moodize(color) {
        return this.mood === 'dark' ? shadePacked(mixPacked(color, packRgb(110, 110, 110), 0.25), -0.12) : color;
    }

    /* Финальная обработка всей картинки: тёмные средние тона, холодные тени, туман над водой и низинами, виньетка.
       Яркими остаются только «источники света» (эфирные разломы, окна, костры) — они рисуются уже после. */
    applyGrading() {
        const W = this.width;
        const pixels = this.pixels;
        const fog = this.buildFog();
        const fogScale = Math.min(255, Math.round((this.pal.fogStrength === undefined ? 1 : this.pal.fogStrength) * 255));
        const [lutR, lutG, lutB] = [0.95, 0.98, 1.04].map(gain =>
            Uint8Array.from({ length: 256 }, (_, v) => Math.min(255, Math.round(255 * Math.pow(v / 255, 1.14) * gain))));
        const [fogR, fogG, fogB] = [150, 162, 170];

        const vignette = this.options.vignette;
        const falloff = length => Float32Array.from({ length }, (_, p) => {
            const edge = Math.min(1, Math.min(p, length - 1 - p) / (length * 0.3));
            return Math.round(256 * (1 - vignette * (1 - smoothstep(edge))));
        });
        const vx = falloff(W), vy = falloff(W);

        for (let y = 0; y < W; y++) {
            const rowShade = vy[y];
            for (let x = 0; x < W; x++) {
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
    }

    // Густота тумана по пикселям (0..255): клочья шума, над водой плотнее. Считается один раз на карту.
    buildFog() {
        const map = this.map;
        const cache = this.fogCache;
        if (cache && cache.source === map.elevation && cache.tileSize === this.tileSize && cache.salt === this.seedSalt) return cache.fog;

        const W = this.width;
        const step = 4;                                   // туман плавный: шум считаем в четверть разрешения и растягиваем
        const lowWidth = Math.ceil(W / step) + 2;
        const low = new Uint8Array(lowWidth * lowWidth);
        const broad = new LatticeNoise(W, Math.max(8, this.px(80)), 901 + this.seedSalt);
        const fine = new LatticeNoise(W, Math.max(4, this.px(34)), 902 + this.seedSalt);
        const curve = Uint8Array.from({ length: 256 }, (_, n) => Math.round(Math.pow(n / 255, 1.3) * 0.3 * 255));

        for (let ly = 0; ly < lowWidth; ly++) {
            const y = Math.min(W - 1, ly * step);
            for (let lx = 0; lx < lowWidth; lx++) {
                const x = Math.min(W - 1, lx * step);
                const noise = 0.65 * broad.at(x, y) + 0.35 * fine.at(x, y);
                const base = noise <= 0.5 ? 0 : Math.min(1, (noise - 0.5) / 0.3);
                low[ly * lowWidth + lx] = Math.min(255, Math.round(curve[Math.round(base * 255)] * (this.waterMask[y * W + x] ? 1.15 : 1)));
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
        this.fogCache = { source: map.elevation, tileSize: this.tileSize, salt: this.seedSalt, fog };
        return fog;
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

    /* ============================================================
       SECTION: DARK_PROPS
       ============================================================ */

    // Кости в сухих местах, вороны, развалины, виселицы — редко и поодиночке.
    collectProps(items) {
        const map = this.map;
        const T = this.tileSize;

        this.forEachTile((x, y) => {
            const i = map.index(x, y);
            if (map.terrain[i] !== Terrain.PLAIN || map.river[i] || map.resource[i] !== Resource.NONE || map.roadLevel[i] > 0) return;
            if (map.shore[i] === Shore.BEACH) return;

            const roll = hashUnit(x, y, 950 + this.seedSalt);
            const cx = x * T + Math.round(hashUnit(x, y, 951) * (T - 2)) + 1;
            const base = y * T + Math.round(hashUnit(x, y, 952) * (T - 4)) + 3;
            const dry = [Biome.STEPPE, Biome.DESERT, Biome.TUNDRA, Biome.SAVANNA].includes(map.biome[i]);

            if (dry && roll < 0.014) items.push({ y: base, x: cx, cover: true, draw: () => this.drawBones(cx, base) });
            else if (!dry && roll < 0.006) items.push({ y: base, x: cx, cover: true, draw: () => this.drawCrow(cx, base) });
            else if (roll > 0.994 && roll <= 0.9985) items.push({ y: base, x: cx, cover: true, draw: () => this.drawRuin(cx, base, x, y) });
            else if (roll > 0.9985) items.push({ y: base, x: cx, cover: true, draw: () => this.drawGibbet(cx, base) });
        });
    }

    drawBones(cx, base) {
        const bone = this.colors.bone;
        this.rect(cx - 2, base - 1, 5, 1, bone);
        this.put(cx - 1, base - 2, bone);
        this.put(cx + 1, base - 2, bone);
        this.rect(cx + 3, base - 2, 2, 2, bone);          // череп
        this.put(cx + 4, base - 2, this.colors.crow);      // глазница
    }

    drawCrow(cx, base) {
        const dark = this.colors.crow;
        this.rect(cx, base - 2, 3, 2, dark);
        this.put(cx - 1, base - 2, dark);
        this.put(cx + 1, base - 3, dark);
        this.put(cx - 2, base - 2, this.colors.stoneMid);  // клюв
    }

    // Обломки каменной стены и колонна.
    drawRuin(cx, base, tileX, tileY) {
        const stone = this.moodize(this.colors.chapelStone);
        const dark = shadePacked(stone, -0.25);
        const width = this.px(8);
        for (let dx = 0; dx < width; dx++) {
            const height = 1 + Math.floor(hashUnit(tileX * 7 + dx, tileY, 953) * this.px(4));   // рваный верх стены
            this.rect(cx - (width >> 1) + dx, base - height, 1, height, dx % 3 === 0 ? dark : stone);
        }
        this.rect(cx + (width >> 1), base - this.px(6), 2, this.px(6), stone);                   // колонна
        this.rect(cx + (width >> 1), base - this.px(6), 1, this.px(6), shadePacked(stone, 0.15));
        this.drawShadow(cx, base, width);
    }

    drawGibbet(cx, base) {
        const wood = this.packed.trunk;
        const height = this.px(10);
        this.drawShadow(cx, base, this.px(4));
        this.rect(cx, base - height, 1, height, wood);
        this.rect(cx, base - height, this.px(5), 1, wood);
        this.put(cx + this.px(4), base - height + 1, this.colors.stoneMid);                       // верёвка
        this.rect(cx + this.px(4) - 1, base - height + 2, 2, this.px(3), this.colors.crow);       // силуэт
    }

    /* ============================================================
       SECTION: ROADS
       ============================================================ */

    roadWidth(level) {
        return Math.max(1, this.px([2, 3, 4][Math.min(3, Math.max(1, level)) - 1]));
    }

    /* Дороги строит генератор (map.roadLinks: из каждой клетки — в какие из 8 сторон идёт дорога, map.roadLevel — насколько
       она наезжена). Здесь каждый отрезок между центрами соседних клеток рисуется слегка извилистой полосой:
       центр клетки смещён случайно, середина отрезка тоже. Сначала мягкая полоса утоптанной земли, потом сама дорога. */
    paintRoads() {
        const map = this.map;
        if (!this.options.roads || !map.roadLinks) return;

        const geometry = this.buildRoadGeometry();
        const c = this.colors;
        const dirt = this.moodize(c.dirt), light = this.moodize(c.dirtLight), mud = this.moodize(c.mud);
        const kinds = [dirt, light, mud];
        const W = this.width;
        const size = map.size;
        const T = this.tileSize;
        const pixels = this.pixels;
        const tileOf = k => this.tileOfPixel(k);

        for (const k of geometry.halo) pixels[k] = mixPacked(pixels[k], dirt, 0.28);
        for (let n = 0; n < geometry.core.length; n++) {
            const k = geometry.core[n];
            let color = kinds[geometry.kind[n]];
            const snow = this.snowCoverage(tileOf(k));
            if (snow > 0) color = mixPacked(color, this.packed.snow, 0.75 * snow);
            pixels[k] = color;
        }
    }

    // Пиксели дорог (не зависят от сезона): мягкая полоса утоптанной земли и сама дорога с тремя оттенками.
    buildRoadGeometry() {
        const map = this.map;
        const key = [this.tileSize, this.seedSalt].join('|');
        const cache = this.roadCache;
        if (cache && cache.source === map.roadLinks && cache.key === key && cache.riverMask === this.riverMask) return cache;

        const size = map.size;
        const T = this.tileSize;
        const W = this.width;
        const relief = this.reliefHeight;
        const wobble = this.px(2);
        const halo = new Set();
        const core = new Map();

        const centerOf = (x, y) => [
            x * T + T / 2 + (hashUnit(x, y, 980) - 0.5) * wobble,
            y * T + T / 2 + (hashUnit(x, y, 981) - 0.5) * wobble
        ];
        const stamp = (cx, cy, width, isHalo) => {
            for (let oy = 0; oy < width; oy++) {
                for (let ox = 0; ox < width; ox++) {
                    const x = cx + ox - (width >> 1), y = cy + oy - (width >> 1);
                    if (x < 0 || y < 0 || x >= W || y >= W) continue;
                    const k = y * W + x;
                    if (this.waterMask[k] || (this.riverMask && this.riverMask[k]) || (relief && relief[k] > 40)) continue;
                    if (isHalo) { halo.add(k); continue; }
                    const r = hashUnit(x, y, 975);
                    core.set(k, r < 0.2 ? 1 : r < 0.45 ? 2 : 0);
                }
            }
        };

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
                const bend = (hashUnit(i, j, 982) - 0.5) * wobble * 1.6;       // середина отрезка уходит в сторону
                const length = Math.hypot(bx - ax, by - ay) || 1;
                const mx = (ax + bx) / 2 - ((by - ay) / length) * bend;
                const my = (ay + by) / 2 + ((bx - ax) / length) * bend;
                const width = this.roadWidth(Math.min(map.roadLevel[i], map.roadLevel[j]));
                const points = [
                    ...this.linePoints(Math.round(ax), Math.round(ay), Math.round(mx), Math.round(my)),
                    ...this.linePoints(Math.round(mx), Math.round(my), Math.round(bx), Math.round(by))
                ];
                for (const [px, py] of points) stamp(px, py, width + 2, true);
                for (const [px, py] of points) stamp(px, py, width, false);
            }
            if (count !== 2) stamp(Math.round(ax), Math.round(ay), this.roadWidth(map.roadLevel[i]) + 1, false);   // перекрёсток или конец дороги
        }
        for (const k of core.keys()) halo.delete(k);

        this.roadCache = { source: map.roadLinks, key, riverMask: this.riverMask, halo: Int32Array.from(halo), core: Int32Array.from(core.keys()), kind: Uint8Array.from(core.values()) };
        return this.roadCache;
    }

    /* ============================================================
       SECTION: SETTLEMENTS
       ============================================================ */

    /* Поселение — ресурс клетки. Каждая клетка с поселением рисуется 1–4 домиками (число зависит от её уровня) и
       не выходит за свои границы (допуск settlementOverflow, по умолчанию 25%): так по рисунку всегда понятно, в какой
       клетке поселение. Крупные населённые пункты получаются из групп соседних клеток (их ставит генератор): у каждой
       свой уровень, между ними идут дорожки, а в центре самого большого города стоит каменная часовня.
       Раскладка не зависит от сезона и считается один раз. */
    settlementLayout(x, y, i) {
        const map = this.map;
        const cache = this.settlementLayoutCache;
        // Экономика меняет население и уровни на месте, поэтому раскладка зависит ещё и от версии видимых изменений карты.
        if (!cache || cache.source !== map.population || cache.tileSize !== this.tileSize || cache.salt !== this.seedSalt || cache.visual !== map.visualVersion) {
            this.settlementLayoutCache = { source: map.population, tileSize: this.tileSize, salt: this.seedSalt, visual: map.visualVersion, layouts: new Map() };
        }
        const layouts = this.settlementLayoutCache.layouts;
        if (!layouts.has(i)) layouts.set(i, this.layoutSettlement(x, y, i));
        return layouts.get(i);
    }

    layoutSettlement(x, y, i) {
        const map = this.map;
        const o = this.options;
        const T = this.tileSize;
        const W = this.width;
        const level = map.settlementLevel[i] || 1;
        const maxLevel = (map.options && map.options.settlementMaxLevel) || 4;
        const rnd = n => hashUnit(x, y, 1000 + n);
        const n = value => Math.max(1, this.px(value));

        // Сколько домиков: от settlementMinHouses (уровень 1) до settlementMaxHouses (высший уровень).
        const share = (level - 1) / Math.max(1, maxLevel - 1);
        const count = clamp(Math.round(o.settlementMinHouses + share * (o.settlementMaxHouses - o.settlementMinHouses)),
            o.settlementMinHouses, o.settlementMaxHouses);

        const left = x * T, top = y * T;
        const slack = Math.round(T * o.settlementOverflow);       // насколько основание дома может выйти за клетку
        const usable = (px, py) => {
            if (px < 0 || py < 0 || px >= W || py >= W) return false;
            const k = py * W + px;
            return !this.waterMask[k] && !(this.riverMask && this.riverMask[k]) && !(this.reliefHeight && this.reliefHeight[k] > 40);
        };
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
    }

    // Утоптанная земля вокруг домов и улица между ними (на земле, до деревьев и границ).
    paintSettlementGround() {
        const map = this.map;
        if (!this.options.settlements || map.settlements.length === 0) return;

        const size = map.size;
        const W = this.width;
        const T = this.tileSize;
        const c = this.colors;
        const dirt = this.moodize(c.dirt), light = this.moodize(c.dirtLight), mud = this.moodize(c.mud);
        const streetColors = [dirt, light, mud];
        const pixels = this.pixels;

        for (const settlement of map.settlements) {
            const tile = settlement.tile;
            const ground = this.settlementGround(this.settlementLayout(tile % size, Math.floor(tile / size), tile));
            const snow = this.snowCoverage(tile);
            const snowMix = color => (snow > 0 ? mixPacked(color, this.packed.snow, 0.7 * snow) : color);

            for (let n = 0; n < ground.blobIndex.length; n++) {            // мягкие пятна утоптанной земли
                const k = ground.blobIndex[n];
                pixels[k] = mixPacked(pixels[k], snowMix(ground.blobMud[n] ? mud : dirt), ground.blobStrength[n] / 255);
            }
            for (let n = 0; n < ground.streetIndex.length; n++) {          // улица
                pixels[ground.streetIndex[n]] = snowMix(streetColors[ground.streetKind[n]]);
            }
        }
    }

    // Пиксели земли поселения (не зависят от сезона): пятна вокруг домов и улица. Считаются один раз для поселения.
    settlementGround(layout) {
        if (layout.ground) return layout.ground;

        const W = this.width;
        const relief = this.reliefHeight;
        const usable = k => !this.waterMask[k] && !(this.riverMask && this.riverMask[k]) && !(relief && relief[k] > 40);
        const strengths = new Map();
        const mudPixels = new Set();

        for (const [bx, by, radius] of layout.blobs) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const distance = Math.hypot(dx, dy);
                    const px = Math.round(bx + dx), py = Math.round(by + dy);
                    if (distance > radius || px < 0 || py < 0 || px >= W || py >= W) continue;
                    const k = py * W + px;
                    if (!usable(k) || hashUnit(px, py, 977) < 0.12) continue;
                    const strength = Math.round(255 * 0.55 * Math.pow(1 - distance / radius, 0.7));
                    if (strength > (strengths.get(k) || 0)) strengths.set(k, strength);
                    if (hashUnit(px, py, 978) < 0.3) mudPixels.add(k);
                }
            }
        }

        const street = new Map();
        const [[ax, ay], [bx, by]] = layout.street;
        const width = Math.max(1, this.px(2));
        for (const [px, py] of this.linePoints(Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by))) {
            for (let oy = 0; oy < width; oy++) {
                for (let ox = 0; ox < width; ox++) {
                    const x = px + ox - (width >> 1), y = py + oy - (width >> 1);
                    if (x < 0 || y < 0 || x >= W || y >= W || !usable(y * W + x)) continue;
                    const r = hashUnit(x, y, 975);
                    street.set(y * W + x, r < 0.2 ? 1 : r < 0.45 ? 2 : 0);
                }
            }
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
    }

    collectSettlement(items, x, y, i) {
        const layout = this.settlementLayout(x, y, i);
        const snow = this.snowCoverage(i);
        for (const part of layout.houses) {
            const sprite = this.houseSprite(part, part.roll, snow);
            items.push({ y: part.base, x: part.x, cover: true, draw: () => this.drawHouse(sprite, part.x, part.base, part, layout.level) });
        }
    }

    // Лёгкое приглушение цвета построек в тёмном стиле: они должны оставаться светлее фона.
    houseColor(color) {
        return this.mood === 'dark' ? shadePacked(mixPacked(color, packRgb(128, 128, 128), 0.1), -0.06) : color;
    }

    // Рисунок здания (кэшируется): стены, крыша, дверь, контур.
    houseSprite(part, roll, snow) {
        if (!this.spriteCache) this.spriteCache = new Map();
        const key = [part.kind, part.w, part.bodyH, part.roofH, Math.floor(roll * 4), Math.round(snow * 3), this.mood, this.season.name].join('|');
        const cached = this.spriteCache.get(key);
        if (cached) return cached;

        const c = this.colors;
        const tower = part.kind === 'tower';
        const wall = this.houseColor(tower ? c.chapelStone : [c.wallA, c.wallB][Math.floor(roll * 2) % 2]);
        let roof = this.houseColor(part.kind === 'hut' ? c.thatch : tower ? c.roofD : [c.roofA, c.roofB, c.roofC, c.roofD][Math.floor(roll * 4) % 4]);
        if (snow > 0) roof = mixPacked(roof, this.packed.snow, 0.85 * snow);

        const pad = 1;
        const overhang = tower ? 0 : 1;
        const width = part.w + 2 * overhang + 2 * pad;
        const height = part.roofH + part.bodyH + 2 * pad;
        const buffer = new PixelBuffer(width, height);
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
        if (this.options.spriteOutline) buffer.outline(c.outline);

        const sprite = {
            buffer, width, height,
            anchorX: Math.round(centerX),
            anchorY: height - pad - 1,
            windows: part.bodyH >= 3 ? [[left + (tower ? 1 : 1), top + 1]] : [],
            chimney: !tower && part.kind === 'house' && roll > 0.4 ? [Math.round(centerX) + 1, pad - 1] : null
        };
        this.spriteCache.set(key, sprite);
        return sprite;
    }

    drawHouse(sprite, x, base, part, level) {
        const c = this.colors;
        const left = x - sprite.anchorX;
        const top = base - sprite.anchorY;

        this.drawBuildingShadow(x, base, part.w, part.bodyH + part.roofH);
        this.blitSprite(sprite.buffer, left, top);

        for (const [wx, wy] of sprite.windows) {
            const lightX = left + wx, lightY = top + wy;
            this.emissive.push(() => this.drawLight(lightX, lightY, c.window, c.fire, this.mood === 'dark' ? 2 : 1));
        }
        if (sprite.chimney && level >= 3) {
            const smokeX = left + sprite.chimney[0], smokeY = top + sprite.chimney[1];
            for (let s = 1; s <= 3; s++) this.blend(smokeX + (s % 2), smokeY - s * 2, packRgb(175, 175, 180), 0.45 - 0.1 * s);
        }
    }

    // Тень здания: пятно под ним и тень, падающая вправо-вниз (свет слева сверху, как у деревьев и гор).
    drawBuildingShadow(x, base, width, height) {
        const half = Math.ceil(width / 2) + 1;
        const length = Math.max(2, Math.round(height * 0.55));
        for (let dx = -half; dx <= half + length; dx++) {
            const edge = dx > half ? 1 - (dx - half) / (length + 1) : 1;
            this.blend(x + dx, base + 1, BLACK, 0.5 * edge);
            this.blend(x + dx, base + 2, BLACK, 0.3 * edge);
            if (dx > -half + 1 && dx < half + length - 1) this.blend(x + dx, base, BLACK, 0.2 * edge);
        }
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

    /* ============================================================
       SECTION: ORE
       ============================================================ */

    // Каменный выступ с вкраплениями руды. kind: 'gold' (золото — яркое, с блёстками) или 'iron' (железо — тёмное, ржавое).
    oreSprite(kind, variant) {
        if (!this.spriteCache) this.spriteCache = new Map();
        const key = 'ore|' + kind + '|' + variant;
        const cached = this.spriteCache.get(key);
        if (cached) return cached;

        const n = value => Math.max(1, this.px(value));
        const gold = kind === 'gold';
        const stone = gold ? [packRgb(150, 146, 150), packRgb(114, 110, 116), packRgb(78, 74, 82)] : [packRgb(120, 132, 146), packRgb(86, 96, 108), packRgb(54, 62, 74)];
        const oreLight = gold ? packRgb(255, 243, 168) : packRgb(207, 218, 228);
        const ore = gold ? packRgb(247, 212, 74) : packRgb(176, 92, 54);
        const oreDark = gold ? packRgb(168, 122, 20) : packRgb(98, 48, 30);

        const width = n(14), height = n(11);
        const buffer = new PixelBuffer(width, height);
        const mid = width >> 1, floor = height - 2;

        // два-три камня разного размера
        const rocks = [[mid - n(3), floor - n(2), n(4), n(3)], [mid + n(2), floor - n(2) - (variant % 2), n(4), n(4)], [mid - 1, floor - n(4), n(3), n(3)]];
        for (const [cx, cy, rx, ry] of rocks) buffer.ellipse(cx, cy, rx, ry, stone[1], stone[0], stone[2]);

        // вкрапления руды: самородки на камнях (золото — крупные и яркие, железо — ржавые жилы с блеском стали)
        const spots = gold
            ? [[mid - n(3), floor - n(3)], [mid + n(3), floor - n(3)], [mid, floor - n(5)], [mid + 1, floor - 1]]
            : [[mid - n(3), floor - n(2)], [mid + n(2), floor - n(3)], [mid, floor - n(4)], [mid - 1, floor - 1], [mid + n(4), floor - 1]];
        spots.forEach(([sx, sy], k) => {
            const size = gold ? (k === 2 ? n(3) : n(2)) : n(2);
            buffer.rect(sx, sy, size, size, ore);
            buffer.rect(sx + 1, sy + size, size, 1, oreDark);
            buffer.rect(sx + size, sy + 1, 1, size, oreDark);
            buffer.put(sx, sy, oreLight);
            if (!gold && k % 2 === 0) buffer.put(sx + size - 1, sy, oreLight);
        });
        if (this.options.spriteOutline) buffer.outline(this.colors.outline);

        const sprite = { buffer, width, height, anchorX: mid, anchorY: floor + 1, sparkles: gold ? [[mid - n(3), floor - n(4)], [mid + n(3), floor - n(4)], [mid, floor - n(6)]] : [] };
        this.spriteCache.set(key, sprite);
        return sprite;
    }

    drawOreTile(x, y, kind) {
        const T = this.tileSize;
        const sprite = this.oreSprite(kind, tileHash(x, y, 80) % 3);
        const cx = x * T + Math.round(T / 2) + Math.round((hashUnit(x, y, 80) - 0.5) * 0.2 * T);
        const base = y * T + Math.round(T * 0.8) + Math.round((hashUnit(x, y, 81) - 0.5) * 0.2 * T) - this.liftAtTile(x, y);

        this.drawBuildingShadow(cx, base, this.px(7), this.px(5));
        this.blitSprite(sprite.buffer, cx - sprite.anchorX, base - sprite.anchorY);

        // блёстки золота — в тёмном стиле светятся (рисуются после цветокоррекции)
        for (const [sx, sy] of sprite.sparkles) {
            const px = cx - sprite.anchorX + sx, py = base - sprite.anchorY + sy;
            this.emissive.push(() => {
                this.put(px, py, packRgb(255, 255, 230));
                for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) this.blend(px + dx, py + dy, packRgb(255, 240, 160), 0.7);
            });
        }
    }

    /* ============================================================
       SECTION: ETHER
       ============================================================ */

    etherSprite(variant) {
        if (!this.spriteCache) this.spriteCache = new Map();
        const key = 'ether|' + variant;
        const cached = this.spriteCache.get(key);
        if (cached) return cached;

        const n = value => Math.max(1, this.px(value));
        const light = packRgb(214, 170, 255), mid = packRgb(160, 90, 240), dark = packRgb(91, 42, 158), tip = packRgb(248, 232, 255);
        const width = n(16), height = n(16);
        const buffer = new PixelBuffer(width, height);
        const floor = height - 2;
        const middle = width >> 1;

        if (variant === 2) {
            // гигантские грибы: светлая ножка, купол с тёмной «изнанкой» и светящимися пятнами
            const mushroom = (cx, stem, capW, capH) => {
                buffer.rect(cx - 1, floor - stem, 2, stem, packRgb(222, 206, 244));
                buffer.rect(cx, floor - stem, 1, stem, packRgb(176, 156, 214));
                const capY = floor - stem - capH + 1;
                buffer.ellipse(cx, capY + capH - 1, capW, capH, mid, light, dark);
                buffer.rect(cx - capW + 1, capY + capH - 1, capW * 2 - 1, 1, dark);   // изнанка шляпки
                buffer.put(cx - 1, capY + 1, tip);
                buffer.put(cx + 2, capY + 2, tip);
                buffer.put(cx - capW + 2, capY + capH - 2, tip);
            };
            mushroom(middle - n(3), n(5), n(4), n(3));
            mushroom(middle + n(3), n(7), n(5), n(4));
            mushroom(middle, n(3), n(3), n(2));
        } else {
            // кристаллы: три остроконечные призмы разной высоты (левая грань светлая, правая тёмная)
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
            crystal(middle - n(3), n(3), n(8));
            crystal(middle + n(2), n(4), n(12));
            crystal(middle + n(5), n(2), n(6));
            buffer.ellipse(middle, floor, n(6), 1, dark, mid, dark);
        }
        if (this.options.spriteOutline) buffer.outline(packRgb(34, 14, 66));

        const sprite = { buffer, width, height, anchorX: middle, anchorY: floor + 1 };
        this.spriteCache.set(key, sprite);
        return sprite;
    }

    drawEther(x, y) {
        const T = this.tileSize;
        const c = this.colors;
        const variant = tileHash(x, y, 90) % 3 === 2 ? 2 : tileHash(x, y, 90) % 2;
        const sprite = this.etherSprite(variant);
        const cx = x * T + Math.round(T / 2) + Math.round((hashUnit(x, y, 91) - 0.5) * 0.2 * T);
        const base = y * T + Math.round(T * 0.82) - this.liftAtTile(x, y);

        // сначала свечение (синхронно с землёй), потом сам рисунок
        this.drawLight(cx, base - this.px(5), c.riftCore, c.riftGlow, this.px(6));
        this.blitSprite(sprite.buffer, cx - sprite.anchorX, base - sprite.anchorY);
        this.drawLight(cx, base - this.px(8), c.riftCore, c.riftGlow, this.px(3));
    }

    /* ============================================================
       SECTION: REGION_BORDERS
       ============================================================ */

    // Чей пиксель: номер региона для каждого пикселя карты или -1 (вода, река, ничья земля).
    // Пиксель наследует регион своей клетки, но береговая линия скруглена и русла рек уже клетки, поэтому:
    //  - пиксели воды и реки не принадлежат никому (граница на них не рисуется);
    //  - клочки суши в клетках без региона (берег реки, выступ суши за краем клетки у моря) достаются ближайшему региону,
    //    чтобы граница дошла до самой воды и шла вдоль берега, а не обрывалась на краю клетки.
    buildPixelRegions() {
        // Результат не зависит от сезона — при смене сезона пересчитывать не нужно.
        const key = [this.view, this.tileSize, this.options.coastSmoothing, this.options.regionBorderSmoothing].join('|');
        const cache = this.regionPixelCache;
        if (cache && cache.source === this.map.regionId && cache.terrain === this.map.terrain && cache.key === key && cache.riverMask === this.riverMask) {
            return cache.owner;
        }
        const owner = this.computePixelRegions();
        this.regionPixelCache = { source: this.map.regionId, terrain: this.map.terrain, key, riverMask: this.riverMask, owner };
        return owner;
    }

    computePixelRegions() {
        const { size, regionId } = this.map;
        const T = this.tileSize;
        const W = this.width;
        const water = this.waterMask;
        const river = this.riverMask;
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
        let pending = [];
        for (let ty = 0; ty < size; ty++) {
            for (let tx = 0; tx < size; tx++) {
                if (regionId[ty * size + tx] >= 0) continue;
                let nearRegion = false;
                for (let dy = -1; dy <= 1 && !nearRegion; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = tx + dx, ny = ty + dy;
                        if (nx >= 0 && ny >= 0 && nx < size && ny < size && regionId[ny * size + nx] >= 0) { nearRegion = true; break; }
                    }
                }
                if (!nearRegion) continue;
                for (let oy = 0; oy < T; oy++) {
                    const row = (ty * T + oy) * W + tx * T;
                    for (let ox = 0; ox < T; ox++) {
                        const k = row + ox;
                        if (!water[k] && !(river && river[k])) pending.push(k);
                    }
                }
            }
        }

        // Заливка слоями: за шаг пиксель получает регион большинства уже занятых соседей.
        for (let layer = 0; layer < T && pending.length > 0; layer++) {
            const taken = [];
            const rest = [];
            for (const k of pending) {
                const x = k % W;
                const a = x > 0 ? owner[k - 1] : -1;
                const b = x < W - 1 ? owner[k + 1] : -1;
                const c = k >= W ? owner[k - W] : -1;
                const d = k < W * (W - 1) ? owner[k + W] : -1;
                let best = -1, bestVotes = 0;
                for (const id of [a, b, c, d]) {
                    if (id < 0) continue;
                    const votes = (a === id) + (b === id) + (c === id) + (d === id);
                    if (votes > bestVotes) { best = id; bestVotes = votes; }
                }
                if (best >= 0) taken.push(k, best); else rest.push(k);
            }
            for (let n = 0; n < taken.length; n += 2) owner[taken[n]] = taken[n + 1];
            pending = rest;
        }
        return this.smoothPixelRegions(owner);
    }

    /* Скругление границ регионов — тот же приём, что и у берега: мажоритарный фильтр. Каждый пиксель суши получает
       регион, которому принадлежит большинство пикселей суши в круге радиуса regionBorderSmoothing (при равенстве
       остаётся как был). Ступеньки по клеткам и прямые углы превращаются в плавные изгибы. Вода и реки не голосуют и
       не меняются, поэтому границы по-прежнему упираются в берег. Работаем только вблизи границ. */
    smoothPixelRegions(owner) {
        const radius = this.options.regionBorderSmoothing;
        if (!radius) return owner;
        const W = this.width;
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

    // Тонкая линия там, где соседние пиксели принадлежат разным регионам. Воды и рек в регионах нет, поэтому граница
    // доходит до берега и дальше не идёт; в горах делаем её бледнее.
    paintRegionBorders() {
        const W = this.width;
        const relief = this.reliefHeight;
        const color = this.colors.regionBorder;
        const owner = this.buildPixelRegions();
        const last = W * (W - 1);
        const shore = this.options.regionShoreBorder;
        const water = this.waterMask, river = this.riverMask;
        const isWet = j => water[j] === 1 || (river !== null && river[j] > 0);

        for (let k = 0; k < owner.length; k++) {
            const id = owner[k];
            if (id < 0) continue;
            const x = k % W;
            const right = x < W - 1 ? owner[k + 1] : -1;
            const below = k < last ? owner[k + W] : -1;
            let border = (right >= 0 && right !== id) || (below >= 0 && below !== id);
            // Береговая линия: пиксель суши рядом с морем, озером или рекой тоже граница региона (реки в регионы не входят).
            if (!border && shore) {
                border = (x > 0 && owner[k - 1] < 0 && isWet(k - 1)) || (x < W - 1 && owner[k + 1] < 0 && isWet(k + 1))
                    || (k >= W && owner[k - W] < 0 && isWet(k - W)) || (k < W * (W - 1) && owner[k + W] < 0 && isWet(k + W));
            }
            if (!border) continue;

            const alpha = relief ? 0.5 - 0.4 * Math.min(1, relief[k] / 110) : 0.6; // в горах границы почти растворяются
            this.pixels[k] = mixPacked(this.pixels[k], color, alpha);
        }
    }

    /* ============================================================
       SECTION: OUTLINES_GRID
       ============================================================ */

    /* Контур области пикселей: замкнутые ломаные в пикселях карты (координаты — углы пикселей). inside(x, y) говорит,
       входит ли пиксель в область; ищем её только в рамке x0..x1, y0..y1. Обход по часовой стрелке, внутри — справа.
       Потом углы скругляются срезанием углов Чайкина (smoothing раз). Если keepCorners > 0, вершины, примыкающие к прямому
       отрезку длиннее keepCorners пикселей, остаются острыми: прямые линии (например, линии сетки) и их углы не округляются,
       сглаживаются только мелкие ступеньки. Контуров несколько, если у области есть отдельные куски или дыры. */
    traceOutline(inside, x0, y0, x1, y1, smoothing, keepCorners = 0) {
        const W = this.width;
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
            let points = raw.filter((p, n) => {
                const a = raw[(n + raw.length - 1) % raw.length], b = raw[(n + 1) % raw.length];
                return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]);
            });
            if (points.length < 4) continue;
            let area = 0;
            for (let n = 0; n < points.length; n++) {
                const a = points[n], b = points[(n + 1) % points.length];
                area += a[0] * b[1] - b[0] * a[1];
            }
            if (Math.abs(area) / 2 < 6) continue;                    // случайные одиночные пиксели
            let sharp = points.map((p, n) => {
                if (keepCorners <= 0) return false;
                const a = points[(n + points.length - 1) % points.length], b = points[(n + 1) % points.length];
                return Math.hypot(p[0] - a[0], p[1] - a[1]) >= keepCorners || Math.hypot(b[0] - p[0], b[1] - p[1]) >= keepCorners;
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
    }

    /* Контур региона для выделения по клику: из той же скруглённой попиксельной карты регионов, на которой стоят границы
       (buildPixelRegions), поэтому обводка в точности повторяет видимую форму региона, а не его клетки.
       Вызывать после paint(). Если карта ещё не нарисована, возвращает null. */
    regionOutline(regionId, smoothing = 3) {
        if (!this.waterMask) return null;
        const owner = this.buildPixelRegions();
        const { size, regionId: ids } = this.map;
        const T = this.tileSize, W = this.width;

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
        return this.traceOutline(inside, x0, y0, x1, y1, smoothing);
    }

    /* Ячейки: на какую клетку карты «работает» каждый пиксель (Int32Array, индекс клетки или -1).
       Внутри региона ячейка — обычный квадрат клетки. У берега, рек и границ регионов она подгоняется под форму региона:
       пиксель принадлежит ячейке своей клетки, только если клетка того же региона; пиксели, которые сглаженная граница
       или берег реки увели в чужую клетку (или в воду), достаются ближайшей ячейке того же региона. Вода и реки делятся на
       обычные квадраты своих клеток. Так регион (и вся карта) разбиты на непересекающиеся ячейки, а по логике это всё те
       же клетки. */
    buildCellMap() {
        const owner = this.buildPixelRegions();
        const cache = this.cellCache;
        if (cache && cache.owner === owner) return cache.cellOf;

        const { size, regionId } = this.map;
        const T = this.tileSize, W = this.width;
        const cellOf = new Int32Array(W * W).fill(-1);
        let pending = [];
        for (let ty = 0; ty < size; ty++) {
            for (let tx = 0; tx < size; tx++) {
                const tile = ty * size + tx, own = regionId[tile];
                for (let oy = 0; oy < T; oy++) {
                    const row = (ty * T + oy) * W + tx * T;
                    for (let ox = 0; ox < T; ox++) {
                        const k = row + ox, id = owner[k];
                        if (id >= 0 ? id === own : own < 0) cellOf[k] = tile;   // пиксель на «своём» месте
                        else pending.push(k);
                    }
                }
            }
        }

        // Чужие пиксели заливаем слоями от своих: берём ячейку большинства соседей с тем же регионом (или водой).
        for (let layer = 0; layer < 2 * T && pending.length > 0; layer++) {
            const taken = [];
            const rest = [];
            for (const k of pending) {
                const id = owner[k], x = k % W;
                const a = x > 0 && owner[k - 1] === id ? cellOf[k - 1] : -1;
                const b = x < W - 1 && owner[k + 1] === id ? cellOf[k + 1] : -1;
                const c = k >= W && owner[k - W] === id ? cellOf[k - W] : -1;
                const d = k < W * (W - 1) && owner[k + W] === id ? cellOf[k + W] : -1;
                let best = -1, bestVotes = 0;
                for (const cell of [a, b, c, d]) {
                    if (cell < 0) continue;
                    const votes = (a === cell) + (b === cell) + (c === cell) + (d === cell);
                    if (votes > bestVotes) { best = cell; bestVotes = votes; }
                }
                if (best >= 0) taken.push(k, best); else rest.push(k);
            }
            for (let n = 0; n < taken.length; n += 2) cellOf[taken[n]] = taken[n + 1];
            pending = rest;
        }
        for (const k of pending) cellOf[k] = Math.floor(Math.floor(k / W) / T) * size + Math.floor((k % W) / T);   // запасной вариант

        this.cellCache = { owner, cellOf };
        return cellOf;
    }

    // Ячейка в точке мира (пиксели карты): индекс клетки или -1. После paint().
    cellAt(worldX, worldY) {
        if (!this.waterMask) return -1;
        const W = this.width;
        const x = Math.floor(worldX), y = Math.floor(worldY);
        if (x < 0 || y < 0 || x >= W || y >= W) return -1;
        return this.buildCellMap()[y * W + x];
    }

    /* Контур ячейки клетки tile (индекс): замкнутые ломаные в пикселях карты или null, если карта не нарисована.
       Прямые участки (линии сетки длиннее keepCorners пикселей) и их углы остаются строго прямыми, а ступеньки вдоль воды и
       границ сглаживаются. keepCorners = 0 — скруглять всё, smoothing = 0 — точная форма по пикселям. */
    cellOutline(tile, smoothing = 2, keepCorners = 5) {
        if (!this.waterMask) return null;
        const cellOf = this.buildCellMap();
        const { size } = this.map;
        const T = this.tileSize, W = this.width;
        const tx = tile % size, ty = Math.floor(tile / size);
        const x0 = Math.max(0, (tx - 1) * T), y0 = Math.max(0, (ty - 1) * T);
        const x1 = Math.min(W, (tx + 2) * T), y1 = Math.min(W, (ty + 2) * T);
        const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < W && cellOf[y * W + x] === tile;
        return this.traceOutline(inside, x0, y0, x1, y1, smoothing, keepCorners);
    }

    /* Сетка клеток: прозрачный холст с линиями между соседними ячейками одного региона (и внутри воды). Границы между
       регионами не дублируем — они уже нарисованы на карте. Цвет линии подбирается по тому, что под ней: светлая линия на тёмном,
       тёмная на светлом. Рисуется отдельным слоем, поэтому включать и выключать сетку можно без перерисовки карты.
       Вызывать после paint(). */
    paintGrid() {
        const owner = this.buildPixelRegions();
        const cellOf = this.buildCellMap();
        const W = this.width;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = W;
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(W, W);
        const lines = new Int32Array(image.data.buffer);
        const base = this.pixels;
        const alpha = Math.round(255 * this.options.gridOpacity);
        const light = (0 << 16 | 0 << 8 | 0) | (alpha << 24);   // RGBA в порядке байтов r, g, b, a (little-endian)
        const dark = alpha << 24;

        const covered = this.spriteMask;                         // сетка тоже идёт по земле: под деревьями и домами её не видно
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
        ctx.putImageData(image, 0, 0);
        return canvas;
    }

    /* ============================================================
       SECTION: FACTIONS
       ============================================================ */

    // Территории фракций по состоянию, которое faction manager передал в карту (map.factions и map.tileFaction), в формате для paintTerritories: [{ id, color, tiles }].
    territoriesFromMap() {
        const map = this.map;
        if (!map.factions || map.factions.length === 0) return [];
        const tiles = map.factions.map(() => []);
        for (let i = 0; i < map.tileFaction.length; i++) {
            const owner = map.tileFaction[i];
            if (owner >= 0 && tiles[owner]) tiles[owner].push(i);
        }
        return map.factions.map(f => ({ id: f.id, color: f.color, tiles: tiles[f.id] }));
    }

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
    paintTerritories(territories = this.territoriesFromMap()) {
        const map = this.map;
        const size = map.size;
        const T = this.tileSize, W = this.width;
        const owner = this.buildPixelRegions();
        const cellOf = this.buildCellMap();

        // клетка -> номер территории
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

        // пиксель -> номер территории (только земля; воду и реки не красим)
        const pixelTerritory = new Int16Array(W * W).fill(-1);
        for (let k = 0; k < pixelTerritory.length; k++) {
            if (owner[k] >= 0 && cellOf[k] >= 0) pixelTerritory[k] = tileTerritory[cellOf[k]];
        }

        const widths = territories.map(t => Math.max(1, Math.round((t.border ?? this.options.factionBorder) * T / 16)));
        const maxWidth = Math.max(1, ...widths);

        // Граница: пиксели территории, рядом с которыми (по стороне) земля другой территории или ничья. У реки смотрим через русло
        // на противоположный берег: граница есть, только если там уже другая территория (река внутри территории её не режет).
        const river = this.riverMask, water = this.waterMask;
        const coast = this.options.factionCoastBorder;
        const riverAlways = this.options.factionRiverBorder !== 'boundary';
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

        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = W;
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(W, W);
        const pixels = new Int32Array(image.data.buffer);
        const rgb = territories.map(t => {
            const c = hexToPacked(t.color || '#999999');
            return (c & 255) | (((c >> 8) & 255) << 8) | (((c >> 16) & 255) << 16);
        });
        const borderAlpha = Math.round(255 * this.options.factionBorderOpacity);
        const fillAlpha = territories.map(t => Math.round(255 * clamp(t.fill ?? this.options.factionFill)));

        const covered = this.spriteMask;                         // под деревьями, домами и рудами слой не рисуем: граница идёт «по земле»
        for (let k = 0; k < pixelTerritory.length; k++) {
            const t = pixelTerritory[k];
            if (t < 0 || covered[k] === 1) continue;
            const alpha = depth[k] > 0 && depth[k] <= widths[t] ? borderAlpha : fillAlpha[t];
            if (alpha > 0) pixels[k] = rgb[t] | (alpha << 24);
        }
        ctx.putImageData(image, 0, 0);
        return canvas;
    }

    /* ============================================================
       SECTION: DECORATIONS
       ============================================================ */

    /* Все декорации собираем в один список и рисуем по возрастанию «основания» (нижней точки):
       то, что стоит ниже на карте, перекрывает то, что выше, — как в перспективе. Деревья могут свободно
       выходить за границы своей клетки: порядок всё равно будет правильным. */
    // Рисует горы и декорации вместе, строка за строкой сверху вниз: так то, что южнее (ближе к зрителю),
    // перекрывает то, что севернее, — деревья и горы перекрывают друг друга правильно.
    paintScene() {
        const items = this.layers.decorations ? this.collectDecorations() : [];
        const relief = this.layers.relief ? this.prepareReliefRows() : null;
        let next = 0;
        for (let gy = 0; gy < this.width; gy++) {
            if (relief) this.paintReliefRow(relief, gy);
            while (next < items.length && items[next].y <= gy) {
                const item = items[next++];
                this.cover = item.cover === true;      // деревья, дома, руды и т. п. закрывают границы и сетку; травинки и поля — нет
                item.draw();
                this.cover = false;
            }
        }
    }

    // Список декораций, отсортированный по «основанию» (нижней точке).
    collectDecorations() {
        const map = this.map;
        const T = this.tileSize;
        const items = [];

        this.forEachTile((x, y) => {
            const i = map.index(x, y);
            if (map.crossing[i]) this.paintCrossing(x, y, i);

            // На дорогах нет ни леса, ни полей, ни руд (кроме клеток поселений) — даже если карта сгенерирована старой версией.
            if (map.roadLevel[i] > 0 && map.resource[i] !== Resource.SETTLEMENT) return;

            switch (map.resource[i]) {
                case Resource.WOOD: this.collectTrees(items, x, y, i); break;
                case Resource.WHEAT: items.push({ y: y * T + Math.round(T * 0.6), x: x * T, draw: () => this.drawWheat(x, y) }); break;
                case Resource.GOLD: items.push({ y: y * T + Math.round(T * 0.8), x: x * T, cover: true, draw: () => this.drawOreTile(x, y, 'gold') }); break;
                case Resource.IRON: items.push({ y: y * T + Math.round(T * 0.8), x: x * T, cover: true, draw: () => this.drawOreTile(x, y, 'iron') }); break;
                case Resource.ETHER:
                    if (this.mood === 'dark') this.emissive.push(() => this.drawEther(x, y));   // самый яркий элемент мира: после цветокоррекции
                    else items.push({ y: y * T + Math.round(T * 0.8), x: x * T, cover: true, draw: () => this.drawEther(x, y) });
                    break;
                case Resource.SETTLEMENT: this.collectSettlement(items, x, y, i); break;
            }
        });

        if (this.mood === 'dark' && this.options.props) this.collectProps(items);

        items.sort((a, b) => a.y - b.y || a.x - b.x);
        return items;
    }

    // Два-три дерева на клетку, в случайных местах. Вид зависит от климата: в холодных краях ели, в тёплых лиственные.
    collectTrees(items, x, y, i) {
        const map = this.map;
        const T = this.tileSize;
        const conifer = map.biome[i] === Biome.TAIGA || map.biome[i] === Biome.TUNDRA || map.temperature[i] < 0.45;
        const withSnow = conifer && this.pal.snowOnConifers && this.seasonalTemperature(i) < SNOW_TEMPERATURE;

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
                draw: () => (conifer ? this.drawConifer(cx, base, pick, withSnow) : this.drawBroadleaf(cx, base, pick))
            });
        }
    }

    // Овальная тень под деревом.
    drawShadow(cx, base, width) {
        const half = Math.floor(width / 2);
        for (let dx = -half; dx <= half; dx++) this.blend(cx + dx, base, BLACK, 0.22);
        for (let dx = -half + 1; dx <= half - 1; dx++) this.blend(cx + dx, base + 1, BLACK, 0.12);
    }

    // Лиственное дерево: округлая крона со светом сверху-слева, летом зелёное, весной в цвету, осенью рыже-золотое.
    drawBroadleaf(cx, base, pick) {
        const pal = this.pal;
        if (pal.bareTrees || hashUnit(cx, base, 79) < (pal.deadTreeChance || 0)) {   // зимой все голые; в тёмном стиле часть мертва и летом
            this.drawBareTree(cx, base, pick);
            return;
        }

        const width = this.px(7) + (pick % 2);
        const height = width;
        const trunkHeight = this.px(2) + 1;
        const trunkWidth = width >= 7 ? 2 : 1;
        const color = hexToPacked(pal.broadleaf[pick % pal.broadleaf.length]);
        const light = shadePacked(color, 0.22);
        const dark = shadePacked(color, -0.28);
        const top = base - trunkHeight - height + 2;

        this.drawShadow(cx, base, width);
        this.rect(cx - (trunkWidth >> 1), base - trunkHeight, trunkWidth, trunkHeight, this.packed.trunk);

        for (let row = 0; row < height; row++) {
            const t = ((row + 0.5) / height) * 2 - 1;
            const half = (width / 2) * Math.sqrt(1 - t * t);
            const x0 = Math.round(cx - half);
            const x1 = Math.round(cx + half) - 1;
            for (let x = x0; x <= x1; x++) {
                const lean = (x - cx) + (row - height / 2);  // < 0 — верх-лево (освещено), > 0 — низ-право (тень)
                let shade = lean < -width * 0.2 ? light : lean > width * 0.28 ? dark : color;
                if (hashUnit(x, top + row, 77) < 0.12) shade = shade === dark ? color : dark; // листва «шуршит»
                this.put(x, top + row, shade);
            }
        }

        if (pal.blossom && pick % 3 === 0) {
            const blossom = hexToPacked(pal.blossom);
            this.put(cx - 2, top + 2, blossom);
            this.put(cx + 1, top + 3, blossom);
            this.put(cx - 1, top + 5, blossom);
        }
    }

    // Голое дерево (зима): ствол и несколько веток.
    drawBareTree(cx, base, pick) {
        const trunk = this.packed.trunk;
        const height = this.px(8);
        this.drawShadow(cx, base, this.px(5));
        this.rect(cx, base - height, 1, height, trunk);

        const side = pick % 2 ? 1 : -1;
        for (let k = 1; k <= this.px(3); k++) {
            this.put(cx - k, base - height + k + 1, trunk);
            this.put(cx + k, base - height + k + 1 + (side > 0 ? 1 : 0), trunk);
        }
        this.put(cx + side, base - height - 1, trunk);
        if (this.mood === 'dark') {                                // кривые, корявые ветки
            this.put(cx + side * 2, base - height + 2, trunk);
            this.put(cx - side * 2, base - height + 4, trunk);
            this.put(cx + side, base - height + 5, trunk);
        }
    }

    // Ель: ярусы всё шире книзу; круглый год зелёная, зимой со снегом на лапах.
    drawConifer(cx, base, pick, withSnow) {
        const pal = this.pal;
        const color = hexToPacked(pal.conifer[pick % pal.conifer.length]);
        const light = shadePacked(color, 0.2);
        const dark = shadePacked(color, -0.3);
        const height = this.px(10) + (pick % 2);
        const maxHalf = Math.max(2, Math.round(this.px(6) / 2));
        const trunkHeight = this.px(2);
        const top = base - trunkHeight - height + 1;

        this.drawShadow(cx, base, this.px(6));
        this.rect(cx, base - trunkHeight, 1, trunkHeight, this.packed.trunk);

        for (let row = 0; row < height; row++) {
            const tierRow = row % 3;
            const half = Math.min(maxHalf, Math.floor(row * 0.34 + tierRow * 0.3 + 0.4));
            for (let dx = -half; dx <= half; dx++) {
                let shade = dx < 0 ? light : dx > 0 ? dark : color;
                if (withSnow && tierRow === 0) shade = dx > 0 ? this.packed.snowShade : this.packed.snow; // снежная кромка яруса
                this.put(cx + dx, top + row, shade);
            }
        }
    }

    // Поле: весной ростки, летом растёт, осенью спелые колосья, зимой стерня.
    drawWheat(x, y) {
        const pal = this.pal;
        const T = this.tileSize;
        const stalk = hexToPacked(pal.wheatStalk);
        const head = hexToPacked(pal.wheatTop);
        // Густота поля: полное — 8 стеблей, неполное (экономика ещё не вырастила или уже убрала) — меньше.
        const stage = this.map.growth ? growthStage(this.map.growth[this.map.index(x, y)]) : GROWTH_STAGES;
        const stalks = Math.round(8 * stage / GROWTH_STAGES);

        for (let k = 0; k < stalks; k++) {
            const h = tileHash(x, y, 300 + k);
            const sx = x * T + (h % T);
            const sy = y * T + this.px(4) + ((h >>> 8) % (T - this.px(4)));  // основание стебля
            const variation = (h >>> 16) % 2;

            if (pal.wheatStage === 'bare') {
                this.rect(sx, sy - 2, 1, 2, stalk);
                continue;
            }
            const stalkHeight = (pal.wheatStage === 'sprout' ? this.px(2) : pal.wheatStage === 'growing' ? this.px(4) : this.px(5)) + variation;
            this.rect(sx, sy - stalkHeight, 1, stalkHeight, stalk);
            this.put(sx, sy - stalkHeight, head);
            if (pal.wheatStage === 'ripe') this.put(sx, sy - stalkHeight - 1, head);
        }
    }

    // На сколько пикселей поднята поверхность гор в центре клетки (руда и разломы лежат на ней, а не под ней).
    liftAtTile(x, y) {
        if (!this.reliefHeight || this.map.terrain[this.map.index(x, y)] !== Terrain.MOUNTAIN) return 0;
        const T = this.tileSize;
        const k = (y * T + (T >> 1)) * this.width + x * T + (T >> 1);
        return Math.round(this.reliefHeight[k] / 255 * this.px(this.options.mountainLift));
    }

    /* Переправа: каменный мост (река глубже 1) или брод из камней (ручей).
       Мост состоит из «плеч»: от центра клетки к берегу в каждую сторону, куда идёт дорога. Прямая дорога даёт прямой мост,
       диагональная — диагональный, поворот — мост с изгибом. Если дороги нет (случайная переправа), мост кладётся поперёк
       течения — тоже по диагонали, если река течёт по диагонали. Длину плеча не угадываем по ширине реки, а меряем по
       самой нарисованной реке: идём от центра, пока пиксели воды или реки не кончатся, и добавляем немного суши за берегом,
       так что мост всегда опирается на землю с обеих сторон. */
    paintCrossing(x, y, i) {
        const map = this.map;
        const T = this.tileSize;
        const c = this.colors;
        const W = this.width;

        // Центр реки в этой клетке — тот же, через который paintRivers проводит русло.
        const wobble = this.px(2);
        const cx = Math.round(x * T + T / 2 + (hashUnit(x, y, 983) - 0.5) * wobble);
        const cy = Math.round(y * T + T / 2 + (hashUnit(x, y, 984) - 0.5) * wobble);

        const dirs = this.crossingDirections(x, y, i);
        const thickness = this.px(5) | 1;                       // нечётная ширина: мост симметричен относительно центра
        const half = (thickness - 1) / 2;
        const overhang = Math.max(2, Math.round(T * 0.2));       // сколько моста лежит на суше за берегом
        const cap = T;                                           // дальше одной клетки от центра не ищем берег

        const riverMask = this.riverMask;
        const wet = (px, py) => {
            if (px < 0 || py < 0 || px >= W || py >= W) return false;
            const k = py * W + px;
            return this.waterMask[k] === 1 || (riverMask !== null && riverMask[k] > 0);
        };
        // Расстояние от центра до суши в направлении (ux, uy): наибольшее из нескольких параллельных линий по ширине моста,
        // чтобы суши достигали и края настила, а не только его середина (берег бывает косым).
        const reachOf = (ux, uy, lateral) => {
            if (!riverMask) return this.riverWidthAt(i) / 2;
            let reach = 0;
            for (let j = -lateral; j <= lateral; j++) {
                let distance = 0;
                while (distance < cap && wet(Math.round(cx + ux * distance - uy * j), Math.round(cy + uy * distance + ux * j))) distance += 0.5;
                reach = Math.max(reach, distance);
            }
            return reach;
        };

        if (map.crossing[i] === 2) {
            const deck = new Set();
            const edge = new Set();
            for (const [ux, uy] of dirs) {
                const reach = reachOf(ux, uy, half) + overhang;
                const radius = Math.ceil(reach + half) + 1;
                for (let oy = -radius; oy <= radius; oy++) {
                    for (let ox = -radius; ox <= radius; ox++) {
                        const along = ox * ux + oy * uy;
                        const side = Math.abs(-ox * uy + oy * ux);
                        if (along < -half || along > reach || side > half + 0.01) continue;
                        const px = cx + ox, py = cy + oy;
                        if (px < 0 || py < 0 || px >= W || py >= W) continue;
                        (side >= half - 0.5 && half > 0 ? edge : deck).add(py * W + px);
                    }
                }
            }
            for (const k of edge) if (!deck.has(k)) this.pixels[k] = c.bridgeEdge;
            for (const k of deck) this.pixels[k] = c.bridgeDeck;
        } else {
            for (const [ux, uy] of dirs) {
                const reach = reachOf(ux, uy, 0) + 1;
                for (let distance = 0; distance <= reach; distance += 3) {
                    const px = Math.round(cx + ux * distance), py = Math.round(cy + uy * distance);
                    this.rect(px - 1, py - 1, 2, 2, c.stone);
                    this.put(px, py, c.stoneShadow);
                }
            }
        }
    }

    // В какие стороны идёт переправа от центра клетки (единичные векторы): по дороге, а без дороги — поперёк течения.
    crossingDirections(x, y, i) {
        const map = this.map;
        const size = map.size;

        const roads = [];
        for (let d = 0; d < 8; d++) {
            if (!(map.roadLinks[i] & (1 << d))) continue;
            const [dx, dy] = ROAD_DIRECTIONS[d];
            const length = Math.hypot(dx, dy);
            roads.push([dx / length, dy / length]);
        }

        const to = map.riverTo[i];
        let fx, fy;
        if (to !== -1) {
            fx = (to % size) - x;
            fy = Math.floor(to / size) - y;
        } else if (x > 0 && x < size - 1 && map.river[i - 1] > 0 && map.river[i + 1] > 0) {
            fx = 1;
            fy = 0;
        } else {
            fx = 0;
            fy = 1;
        }
        const flow = Math.hypot(fx, fy) || 1;
        fx /= flow;
        fy /= flow;

        if (roads.length >= 2) return roads;
        if (roads.length === 1) {                                 // дорога заканчивается на реке: мост продолжает её на другой берег
            const [rx, ry] = roads[0];
            if (Math.abs(rx * fx + ry * fy) < 0.8) return [[rx, ry], [-rx, -ry]];
        }
        return [[-fy, fx], [fy, -fx]];                            // поперёк течения (для диагонального течения — по диагонали)
    }
}