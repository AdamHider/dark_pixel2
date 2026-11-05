/* ============================================================
   Генератор карты.

   Структура — как в подсистемах старого проекта (MapRivers, MapLandscape...): всё поделено на объекты с одинаковым контуром.
     • MapGenerator (map-generator.js) — ядро: слои данных, сетка, конвейер generate(), публичный интерфейс (getTileInfo...).
     • MapGen.<Имя> — подсистема, один файл на каждую (map-relief.js, map-rivers.js...). Контур у всех один:
           defaults    — её настройки; плоско попадают в MapGenerator.DEFAULTS, документация рядом с кодом;
           build(map)  — единственный вход этапа генерации: шаги по порядку (у Turn / Economy / Factions вход — apply(map, state));
           шаги        — остальные методы: свои — this.шаг(map), чужие — MapGen.Другая.шаг(map).
       Подсистемы ничего не хранят: данные лежат слоями на самой карте (map.terrain, map.river, map.regionId...).
   Порядок этапов — MapGen.PIPELINE (в map-generator.js). Новый этап = файл с MapGen.<Имя> + имя в PIPELINE.

   Глобальные имена: только прежние (Terrain, Biome, Shore, Resource, ResourceInfo, ROAD_DIRECTIONS, clamp, lerp, hash32, createRandom,
   rankNormalize, percentile, GROWTH_STAGES, growthStage, ValueNoise, MinHeap, MapGenerator) и один неймспейс MapGen: файлы
   грузятся обычными <script>, и общее имя легко столкнуть с чужим. Всё новое — внутри MapGen и в блоках { ... }.
   ============================================================ */

/* ---------- Справочники: что может лежать в клетке карты ---------- */
const Terrain = Object.freeze({ DEEP_WATER: 0, SHALLOW_WATER: 1, PLAIN: 2, MOUNTAIN: 3 });
const Biome = Object.freeze({ TUNDRA: 0, TAIGA: 1, GRASSLAND: 2, STEPPE: 3, DESERT: 4, SAVANNA: 5 });
const Shore = Object.freeze({ NONE: 0, BEACH: 1, ROCKY: 2, CLIFF: 3 });
const Resource = Object.freeze({ NONE: 0, WOOD: 1, WHEAT: 2, GOLD: 3, ETHER: 4, IRON: 5, SETTLEMENT: 6 });

// Что даёт каждый ресурс (числа условные — настройте под экономику игры). В клетке бывает только один ресурс.
const ResourceInfo = Object.freeze({
    [Resource.WHEAT]: { name: 'пшеница', produces: { food: 1 } },
    [Resource.WOOD]: { name: 'дерево', produces: { production: 1 } },
    [Resource.IRON]: { name: 'железная руда', produces: { production: 2 } },
    [Resource.GOLD]: { name: 'золотая руда', produces: { gold: 2 } },
    [Resource.ETHER]: { name: 'эфир', produces: { ether: 1 } },
    [Resource.SETTLEMENT]: { name: 'поселение', produces: { population: 1, gold: 1 } } // население — из map.population[клетка]
});

// Направления «строка за строкой». Индекс d и 7 - d — противоположные (по ним хранятся связи дорог в roadLinks).
const ROAD_DIRECTIONS = Object.freeze([[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]);

/* ---------- Утилиты ---------- */
// Ограничить value отрезком [min, max]. Без Math.max/Math.min: функцию зовут миллионы раз (по несколько раз на каждый пиксель гор).
// «+ 0» превращает -0 в +0, как это делал Math.max(0, -0); NaN остаётся NaN.
const clamp = (value, min = 0, max = 1) => (value < min ? min : value > max ? max : value + 0);
const lerp = (a, b, t) => a + (b - a) * t;

// Степень роста клетки (леса, поля) — число от 0 до 1. На карте её видно ступенями: число деревьев в клетке, густота стеблей.
// Перерисовывать карту нужно, только когда клетка перешла на другую ступень, поэтому ступени одни и для карты, и для отрисовки.
const GROWTH_STAGES = 4;
const growthStage = growth => Math.round(clamp(growth) * GROWTH_STAGES);

// Хорошо перемешанный хеш числа (0..2^32): соседние номера клеток дают несвязанные значения. Простое умножение давало
// «решётчатые» узоры — реки бежали параллельными диагональными полосами.
function hash32(n) {
    n = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
    return (n ^ (n >>> 16)) >>> 0;
}

// Генератор псевдослучайных чисел (mulberry32): один и тот же seed даёт одну и ту же последовательность.
function createRandom(seed) {
    let state = seed | 0;
    return function random() {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Выравнивает значения до равномерных 0..1 по рангу: самое малое станет 0, самое большое 1.
// Тогда порог 0.4 честно означает «нижние 40%», независимо от того, как шум «слипается» вокруг 0.5.
function rankNormalize(values) {
    const order = Array.from(values.keys()).sort((a, b) => values[a] - values[b]);
    const result = new Float32Array(values.length);
    order.forEach((index, rank) => { result[index] = rank / (values.length - 1); });
    return result;
}

// Значение на заданной доле отсортированного списка (0.5 — медиана).
function percentile(values, share) {
    const sorted = Float32Array.from(values).sort();
    return sorted[Math.floor(sorted.length * share)];
}

/* ---------- Плавный шум: значения 0..1, соседние точки похожи друг на друга ---------- */
const ValueNoise = (() => {
    const smoothstep = t => t * t * (3 - 2 * t);

    return class ValueNoise {
        constructor(seed) {
            const random = createRandom(seed);
            this.lattice = new Float64Array(65 * 65);
            for (let i = 0; i < this.lattice.length; i++) this.lattice[i] = random();
        }

        latticeValue(ix, iy) {
            return this.lattice[(iy & 63) * 65 + (ix & 63)];
        }

        // Одна «октава»: интерполяция между четырьмя ближайшими узлами решётки.
        sample(x, y) {
            const ix = Math.floor(x), iy = Math.floor(y);
            const u = smoothstep(x - ix), v = smoothstep(y - iy);
            const top = lerp(this.latticeValue(ix, iy), this.latticeValue(ix + 1, iy), u);
            const bottom = lerp(this.latticeValue(ix, iy + 1), this.latticeValue(ix + 1, iy + 1), u);
            return lerp(top, bottom, v);
        }

        // Несколько октав: крупные формы + всё более мелкие детали.
        fractal(x, y, octaves) {
            let sum = 0, amplitude = 1, total = 0, frequency = 1;
            for (let i = 0; i < octaves; i++) {
                sum += amplitude * this.sample(x * frequency, y * frequency);
                total += amplitude;
                amplitude /= 2;
                frequency *= 2;
            }
            return sum / total;
        }

    };
})();

/* ---------- Очередь с приоритетом (двоичная куча): достаёт самый «дешёвый» элемент ---------- */
class MinHeap {
    constructor() {
        this.items = [];   // [цена, клетка, метка]
    }

    get size() {
        return this.items.length;
    }

    push(cost, tile, tag) {
        const items = this.items;
        items.push([cost, tile, tag]);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (items[parent][0] <= items[i][0]) break;
            [items[parent], items[i]] = [items[i], items[parent]];
            i = parent;
        }
    }

    pop() {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (items.length > 0) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const left = 2 * i + 1, right = left + 1;
                let smallest = i;
                if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
                if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
                if (smallest === i) break;
                [items[smallest], items[i]] = [items[i], items[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

/* ---------- MapGen: неймспейс внутренних помощников (в глобальной области — только он) ---------- */
const MapGen = {
    DIRECTIONS_8: ROAD_DIRECTIONS,
    DIRECTIONS_4: Object.freeze([[-1, 0], [1, 0], [0, -1], [0, 1]]),   // влево, вправо, вверх, вниз
    RARE_RESOURCES: new Set([Resource.GOLD, Resource.IRON, Resource.ETHER]),   // руды и эфир: их не трогаем ни дорогами, ни поселениями
    smoothstep: t => t * t * (3 - 2 * t),
    hash01: n => hash32(n) / 4294967296,             // хеш 0..1
    isGrowing: resource => resource === Resource.WOOD || resource === Resource.WHEAT,
    tally: (counts, key, n = 1) => counts.set(key, (counts.get(key) || 0) + n),   // counts: Map ключ -> счётчик

    // Ключ Map с наибольшим счётчиком (-1, если пусто). При равенстве остаётся первый, а если задан isBetter(a, b) — тот, кто «лучше».
    topKey(counts, isBetter) {
        let best = -1, bestCount = 0;
        for (const [key, n] of counts) {
            if (n > bestCount || (best !== -1 && n === bestCount && isBetter && isBetter(key, best))) {
                best = key;
                bestCount = n;
            }
        }
        return best;
    }
};
