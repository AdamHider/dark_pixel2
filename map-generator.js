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

/* ============================================================
   Relief — рельеф: высота, острова, горы, суша и вода

   Из шума получается высота (спад к краям, хребты, внутренние моря), по долям воды и гор — суша, вода и горы; мелкие горы
   и островки убираем. Дальше все этапы работают со списком клеток суши (map.landTiles). Пороги считаем по долям, а не по
   абсолютным числам: так соотношение воды и гор не зависит от настроек шума.
   ============================================================ */
{
    MapGen.Relief = {
        defaults: {
            waterShare: 0.45,         // какая доля клеток станет водой
            mountainShare: 0.16,      // какая доля суши станет горами
            elevationScale: 9,        // масштаб шума высоты (больше — мельче материки)
            elevationOctaves: 5,
            baseElevation: 0.25,      // общий «подъём» рельефа
            islandFalloff: 0.5,       // насколько сильно рельеф падает к краям (мир окружён водой)
            falloffPower: 2.5,        // форма спада к краям (2 — плавно, 4 — «плато» с обрывом у краёв)
            shapeVariety: 0.8,        // 0..1: насколько изрезана форма континента (заливы, полуострова, острова)
            shapeScale: 8,            // размер деталей формы (больше — мельче)
            inlandSeaStrength: 0.35,  // 0 — внутренних морей нет; больше — крупнее и чаще
            inlandSeaScale: 3.0,      // размер внутренних морей (больше — мельче и чаще)
            islandDensity: 0.4,       // 0..1: сколько островков разбросано вокруг материка (0 — только материк)
            islandScale: 10,          // размер островков (больше — мельче)
            ridgeScale: 4,            // масштаб горных хребтов
            ridgeStrength: 0.4,       // насколько хребты поднимают рельеф
            mountainClustering: 0.5,  // 0..1: 0 — тонкие цепи хребтов, 1 — сплошные массивы; посередине — массивы с ущельями
            massifScale: 22,          // размер горных массивов (больше — мельче и чаще)
            ridgeSharpness: 1,        // больше — тоньше и резче хребты
            warpScale: 3.0,           // масштаб «скручивания» координат (делает берега и хребты извилистыми)
            warpStrength: 0.25,       // сила скручивания; 0 — выключить
            minMountainSize: 10,      // горные массивы меньше этого размера (в клетках) превращаются в равнину
            minIslandSize: 12        // клочки суши меньше этого размера (в клетках) превращаются в воду
        },

        // Шаги по порядку.
        build(map) {
            this.generateElevation(map);       // высота: шум + спад к краям + хребты
            this.scatterIslands(map);          // острова вокруг материка
            this.classifyTerrain(map);         // вода / равнина / горы по долям
            this.removeSmallMountains(map);
            this.removeSmallIslands(map);
            this.collectLandTiles(map);        // map.landTiles
        },

        // Шум + падение к краям (вода вокруг) + хребты.
        generateElevation(map) {
            const { noise, options: o } = map;
            let wx, wy;
            const sample = (name, scale, octaves) => noise[name].fractal(wx * scale, wy * scale, octaves);

            map.eachTile((i, nx, ny) => {
                // Квадрат расстояния от центра карты: 0 в центре, 1 на середине края.
                const dx = (nx - 0.5) * 2, dy = (ny - 0.5) * 2;
                const distanceSq = dx * dx + dy * dy;

                // «Скручиваем» координаты: берега и хребты становятся извилистыми, а не расплывчатыми пятнами.
                wx = nx + (noise.warpX.fractal(nx * o.warpScale, ny * o.warpScale, 2) - 0.5) * o.warpStrength;
                wy = ny + (noise.warpY.fractal(nx * o.warpScale, ny * o.warpScale, 2) - 0.5) * o.warpStrength;

                // Спад к краям: чем больше falloffPower, тем ровнее «плато» внутри и тем резче обрыв у краёв.
                const falloff = Math.pow(Math.sqrt(distanceSq), o.falloffPower) * o.islandFalloff;
                let height = sample('elevation', o.elevationScale, o.elevationOctaves) * 0.9 + o.baseElevation - falloff;

                // Регулятор формы: среднемасштабный шум ломает береговую линию — заливы, полуострова и острова вдали от материка.
                height += (sample('shape', o.shapeScale, 3) - 0.5) * o.shapeVariety * 2.4;

                // Внутренние моря: крупные впадины, вырезанные во внутренних областях.
                height -= Math.max(0, sample('basin', o.inlandSeaScale, 2) - 0.5) * 4 * o.inlandSeaStrength * clamp(1.3 - distanceSq);

                // Хребты: линии, где шум близок к 0.5, поднимаем вверх. Возле краёв карты хребты слабее.
                const ridgeNoise = sample('ridge', o.ridgeScale, 4);
                const ridge = Math.pow(1 - Math.abs(2 * ridgeNoise - 1), o.ridgeSharpness);
                height += ridge * o.ridgeStrength * clamp(1.2 - distanceSq);

                map.elevation[i] = height;
                map.ridge[i] = ridge;
                map.massif[i] = sample('massif', o.massifScale, 3);
            });
        },

        // Острова: в полосе мелководья вокруг материка отдельные «горбы» шума поднимаем над уровнем моря.
        scatterIslands(map) {
            const o = map.options;
            if (o.islandDensity <= 0) return;

            const estimatedSea = percentile(map.elevation, o.waterShare);
            const threshold = 0.72 - 0.16 * o.islandDensity; // выше плотность — ниже порог — больше островов
            map.eachTile((i, nx, ny) => {
                const belowSea = estimatedSea - map.elevation[i];
                if (belowSea <= 0 || belowSea > 0.15) return; // только полоса моря недалеко от «почти суши»

                const bump = map.noise.islands.fractal(nx * o.islandScale, ny * o.islandScale, 2);
                if (bump > threshold) map.elevation[i] = estimatedSea + 0.01 + (bump - threshold) * 0.5;
            });
        },

        // Пороги считаем по долям, а не по абсолютным числам: так соотношение воды и гор не зависит от настроек шума.
        classifyTerrain(map) {
            const { waterShare, mountainShare, mountainClustering: clustering } = map.options;
            map.seaLevel = percentile(map.elevation, waterShare);

            // Горы = «хребтовость» (тонкие линии) + «массивность» (крупные пятна) + чуть высоты.
            // Одни хребты дают тонкие змейки; массивы собирают их в кучи, а между грядами остаются ущелья.
            const landIndices = [];
            for (let i = 0; i < map.elevation.length; i++) {
                if (map.elevation[i] > map.seaLevel) landIndices.push(i);
            }
            const rankOnLand = values => rankNormalize(Float32Array.from(landIndices, i => values[i]));
            const ridgeRank = rankOnLand(map.ridge), massifRank = rankOnLand(map.massif), heightRank = rankOnLand(map.elevation);

            const scores = landIndices.map((_, k) =>
                0.85 * ((1 - clustering) * ridgeRank[k] + clustering * massifRank[k]) + 0.15 * heightRank[k]);
            map.mountainLevel = percentile(scores, 1 - mountainShare);
            const maxScore = scores.reduce((a, b) => Math.max(a, b), map.mountainLevel);

            map.terrain.fill(Terrain.DEEP_WATER);
            landIndices.forEach((i, k) => {
                const isMountain = scores[k] > map.mountainLevel;
                map.terrain[i] = isMountain ? Terrain.MOUNTAIN : Terrain.PLAIN;
                // Высота горы растёт к «хребтовым» и «массивным» клеткам: по ней рисуется рельеф (хребты выше, края ниже).
                if (isMountain) map.mountainHeight[i] = 0.3 + 0.7 * (scores[k] - map.mountainLevel) / (maxScore - map.mountainLevel);
            });
        },

        // Одиночная «гора» на равнине выглядит нелепо: горы должны занимать не меньше minMountainSize клеток.
        removeSmallMountains(map) {
            const isMountain = i => map.terrain[i] === Terrain.MOUNTAIN;
            for (const mountain of map.components(isMountain)) {
                if (mountain.length >= map.options.minMountainSize) continue;
                for (const i of mountain) {
                    map.terrain[i] = Terrain.PLAIN;
                    map.mountainHeight[i] = 0;
                }
            }
        },

        // Шум порождает одиночные клетки и крошечные островки, особенно посреди озёр. Убираем всё, что меньше minIslandSize.
        removeSmallIslands(map) {
            for (const island of map.components(i => map.isLand(i))) {
                if (island.length >= map.options.minIslandSize) continue;
                for (const i of island) {
                    map.terrain[i] = Terrain.DEEP_WATER;
                    map.elevation[i] = Math.min(map.elevation[i], map.seaLevel);
                    map.mountainHeight[i] = 0;
                }
            }
        },

        collectLandTiles(map) {
            map.landTiles = [];
            for (let i = 0; i < map.terrain.length; i++) {
                if (map.isLand(i)) map.landTiles.push(i);
            }
        },

        // 1 для гор и для суши не дальше distance клеток от гор (предгорья).
        tilesNearMountains(map, distance) {
            const mountains = map.landTiles.filter(i => map.terrain[i] === Terrain.MOUNTAIN);
            const reach = map.distanceFrom(mountains, { accept: i => map.isLand(i), maxDistance: distance });
            return Uint8Array.from(reach, d => (d >= 0 ? 1 : 0));
        }
    };
}

/* ============================================================
   Drainage — сток воды: заливка впадин, озёра, глубина воды

   Реки — часть рельефа, а не линии, нарисованные поверх: вода стекает по высотам.
   «Заливка впадин» (priority-flood): из моря и краёв карты затопляем сушу от низких мест к высоким; так у каждой клетки
   появляется сток (map.flowTo) к морю, а впадины, которые не имеют стока, становятся озёрами. Потом считаем глубину воды.
   ============================================================ */
{
    const { hash01 } = MapGen;

    MapGen.Drainage = {
        defaults: {
            shallowWaterDistance: 2,  // вода не дальше N клеток от суши считается мелководьем
            riverMeander: 0.010,      // насколько русла отклоняются от «кратчайшего» пути (больше — извилистее)
            lakeDepth: 0.02,          // впадина глубже этого становится озером
            lakeMinSize: 4           // озёра меньше этого (в клетках) не создаём
        },

        build(map) {
            this.fillDepressions(map);         // сток к морю (map.flowTo) и озёра
            this.computeWaterDepth(map);       // мелководье и глубокая вода
        },

        // Глубина воды = расстояние до ближайшей суши (в клетках). Работает и для океана, и для озёр:
        // у берега мелко, к середине водоёма всё глубже. Мелководье — узкая полоса у берега, остальное — глубокая вода.
        computeWaterDepth(map) {
            const distance = map.distanceFrom(map.landTiles, { accept: i => !map.isLand(i), diagonal: true });
            for (let i = 0; i < map.terrain.length; i++) {
                if (map.isLand(i)) continue;
                const depth = Math.min(255, Math.max(0, distance[i]));
                map.waterDepth[i] = depth;
                map.terrain[i] = depth > 0 && depth <= map.options.shallowWaterDistance ? Terrain.SHALLOW_WATER : Terrain.DEEP_WATER;
            }
        },

        fillDepressions(map) {
            const { size, options: o } = map;
            const count = size * size;
            const filled = new Float32Array(count);
            const flowTo = new Int32Array(count).fill(-1);
            const done = new Uint8Array(count);
            const heap = new MinHeap();
            const jitter = i => hash01(i) * o.riverMeander;  // чтобы русла петляли, а не шли по линейке

            // Затопление начинается с моря (клетки у берега) и с суши на краю карты.
            for (let i = 0; i < count; i++) {
                const x = i % size, y = Math.floor(i / size);
                const onEdge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
                if (!map.isLand(i)) {
                    done[i] = 1;
                    filled[i] = map.seaLevel;
                    if (map.neighbors8(i).some(j => map.isLand(j))) heap.push(map.seaLevel, i, 0);
                } else if (onEdge) {
                    done[i] = 1;
                    filled[i] = map.elevation[i] + jitter(i);
                    heap.push(filled[i], i, 0);
                }
            }
            while (heap.size > 0) {
                const [level, current] = heap.pop();
                for (const next of map.neighbors8(current)) {
                    if (done[next]) continue;
                    done[next] = 1;
                    flowTo[next] = current;
                    // Шаг заливки случайный (и длиннее по диагонали): на плоских местах русла петляют, а не бегут параллельными прямыми.
                    const step = 2e-4 * (0.3 + 2 * hash01(next + 7919)) * (map.isDiagonal(current, next) ? 1.4 : 1);
                    filled[next] = Math.max(map.elevation[next] + jitter(next), level + step);
                    heap.push(filled[next], next, 0);
                }
            }
            map.filled = filled;
            map.flowTo = flowTo;

            // Озёра: впадины достаточной глубины и размера.
            const deep = new Uint8Array(count);
            for (const i of map.landTiles) {
                if (map.terrain[i] === Terrain.PLAIN && filled[i] - map.elevation[i] > o.lakeDepth) deep[i] = 1;
            }
            for (const lake of map.components(i => deep[i], map.landTiles)) {
                if (lake.length < o.lakeMinSize) continue;
                for (const i of lake) {
                    map.terrain[i] = Terrain.DEEP_WATER;
                    map.mountainHeight[i] = 0;
                }
            }
            MapGen.Relief.collectLandTiles(map);
        }
    };
}

/* ============================================================
   Climate — климат: влажность, температура, биомы

   Север (y = 0) холодный, юг жаркий; шум добавляет разнообразия, высота охлаждает. Биом клетки — по температуре и влажности.
   ============================================================ */
{
    MapGen.Climate = {
        defaults: {
            temperatureScale: 4,
            temperatureNoise: 0.55,  // разброс температуры вокруг «север холодно, юг жарко»
            altitudeCooling: 0.1,    // насколько высота охлаждает
            moistureScale: 5,
            aridity: 0.45           // 0..1: доля сухих клеток, где вместо луга степь/пустыня (меньше — меньше степей)
        },

        build(map) {
            this.generateMoisture(map);
            this.generateTemperature(map);
            this.assignBiomes(map);
        },

        // Выравниваем до равномерных 0..1: порог 0.4 в биомах честно значит «самые сухие 40%».
        generateMoisture(map) {
            map.moisture = map.densityLayer(map.noise.moisture, map.options.moistureScale, 4);
        },

        // Север (y = 0) холодный, юг (y = size) жаркий; шум добавляет разнообразия, высота охлаждает.
        generateTemperature(map) {
            const o = map.options;
            map.eachTile((i, nx, latitude) => {
                const noise = map.noise.temperature.fractal(nx * o.temperatureScale, latitude * o.temperatureScale, 3);
                const altitude = Math.max(0, map.elevation[i] - map.seaLevel);
                map.temperature[i] = clamp(latitude * 0.9 + 0.05 + (noise - 0.5) * o.temperatureNoise - altitude * o.altitudeCooling);
            });
        },

        assignBiomes(map) {
            for (const i of map.landTiles) {
                if (map.terrain[i] === Terrain.PLAIN) map.biome[i] = this.pickBiome(map, map.temperature[i], map.moisture[i]);
            }
        },

        pickBiome(map, temperature, moisture) {
            const dry = map.options.aridity; // клетки суше этого порога — степь или пустыня
            if (temperature < 0.1) return Biome.TUNDRA;

            if (temperature < 0.42) {                 // холодный пояс
                if (moisture > 0.55) return Biome.TAIGA;
                return moisture > dry * 0.8 ? Biome.GRASSLAND : Biome.STEPPE;
            }
            if (temperature < 0.7) {                  // умеренный пояс
                if (moisture < dry) return Biome.STEPPE;
                return moisture > 0.8 ? Biome.TAIGA : Biome.GRASSLAND;
            }
            // жаркий пояс
            if (moisture < dry) return Biome.DESERT;
            return moisture < 0.6 ? Biome.SAVANNA : Biome.GRASSLAND;
        }
    };
}

/* ============================================================
   Flora — лес и поля

   Крупные массивы плюс мелкие рощи, только на равнине и в подходящем климате.
   ============================================================ */
{
    MapGen.Flora = {
        defaults: {
            forestScale: 15,         // масштаб крупных лесных массивов (больше — мельче)
            forestShare: 0.70,       // доля карты под крупными лесными массивами
            forestClumpShare: 0.14,  // ...и ещё столько же мелких разрозненных рощ
            woodChance: 0.9,         // шанс дерева в клетке внутри леса
            wheatScale: 15,
            wheatShare: 0.5,         // то же для полей
            wheatClumpShare: 0.14,
            wheatChance: 0.85,
            clumpScale: 16          // размер мелких рощ и полей (больше — мельче)
        },

        // Лес и поля: крупные массивы + мелкие рощи, только на равнине и в подходящем климате.
        build(map) {
            const o = map.options;
            const forest = this.createPatchLayer(map, map.noise.forest, o.forestScale, o.forestShare, map.noise.forestClumps, o.clumpScale, o.forestClumpShare);
            const fields = this.createPatchLayer(map, map.noise.fertility, o.wheatScale, o.wheatShare, map.noise.fertilityClumps, o.clumpScale, o.wheatClumpShare);

            for (const i of map.landTiles) {
                if (map.terrain[i] !== Terrain.PLAIN) continue;

                const t = map.temperature[i], m = map.moisture[i];
                const roll = map.random();
                const goodForWood = forest[i] && m > 0.3 && t > 0.12 && t < 0.8;
                const goodForWheat = fields[i] && m > 0.1 && m < 0.9 && t > 0.18 && t < 0.85;

                if (goodForWood && roll < o.woodChance) map.resource[i] = Resource.WOOD;
                else if (goodForWheat && roll < o.wheatChance) map.resource[i] = Resource.WHEAT;
            }
        },

        // «Пятна» ресурса: крупные скопления плюс мелкие разрозненные кучки. Вместе дают хаотичное, но не пустое распределение.
        createPatchLayer(map, bigNoise, bigScale, bigShare, smallNoise, smallScale, smallShare) {
            const big = map.densityLayer(bigNoise, bigScale);
            const small = map.densityLayer(smallNoise, smallScale);
            return Uint8Array.from(big, (value, i) => (value > 1 - bigShare || small[i] > 1 - smallShare ? 1 : 0));
        }
    };
}

/* ============================================================
   Rivers — реки

   Подсчёт стока: дождь выпадает на каждую клетку (во влажных местах больше) и стекает вниз по map.flowTo (его строит Drainage);
   в каждой клетке накапливается вода всех клеток выше по течению. Где её много — там река; чем больше воды, тем река шире.
   Получаются притоки, слияния, бассейны — как в природе, а не 16 одиноких ручьёв.
   ============================================================ */
{
    MapGen.Rivers = {
        defaults: {
            rainfall: 0.5,                    // сколько воды даёт клетка (во влажных местах больше); больше — больше и шире реки
            riverThresholds: [60, 180, 480]  // сколько воды надо, чтобы появился ручей / река / большая река
        },

        build(map) {
            const o = map.options;
            const count = map.size * map.size;

            // Дождь на каждую клетку суши; воду собираем сверху вниз (от высоких клеток к низким), в том числе через озёра.
            const flow = new Float32Array(count);
            const order = [];
            for (let i = 0; i < count; i++) {
                if (map.flowTo[i] !== -1) order.push(i);
                if (map.isLand(i)) flow[i] = o.rainfall * (0.4 + 1.6 * map.moisture[i]) * (map.terrain[i] === Terrain.MOUNTAIN ? 1.3 : 1);
            }
            order.sort((a, b) => map.filled[b] - map.filled[a]);
            for (const i of order) flow[map.flowTo[i]] += flow[i];

            const area = (map.size / 300) ** 2;                      // пороги заданы для карты 300×300: на меньшей карте воды набирается меньше
            const [first, second, third] = o.riverThresholds.map(t => t * area);
            for (const i of map.landTiles) {
                if (map.terrain[i] !== Terrain.PLAIN || flow[i] < first) continue;
                map.river[i] = flow[i] >= third ? 3 : flow[i] >= second ? 2 : 1;
                map.riverFlow[i] = Math.min(65535, Math.round(flow[i]));
                map.riverTo[i] = map.flowTo[i];
                map.resource[i] = Resource.NONE;                        // на реке ресурсов нет
            }
        }
    };
}

/* ============================================================
   Shores — типы берегов

   Тип берега для суши рядом с морем, озером или рекой: пляж, каменистый берег или утёс.
   ============================================================ */
{
    MapGen.Shores = {
        defaults: {
            shoreScale: 12,    // размер участков одного типа берега (больше — мельче)
            beachShare: 0.55,  // доля подходящих (низких, тёплых) берегов, которые станут пляжами
            cliffShare: 0.25  // доля самых высоких берегов, которые станут утёсами (горы у воды — всегда утёсы)
        },

        // Тип берега для суши рядом с морем, озером или рекой: пляж, каменистый берег или утёс.
        // Горы у воды — всегда утёсы; низкие тёплые берега — пляжи (пятнами); остальное — камни.
        build(map) {
            const o = map.options;
            const coastal = map.landTiles.filter(i =>
                map.river[i] > 0
                || map.neighbors8(i).some(j => !map.isLand(j))
                || map.neighbors(i).some(j => map.river[j] > 0));
            if (coastal.length === 0) return;

            const heightRank = rankNormalize(Float32Array.from(coastal, i => map.elevation[i] - map.seaLevel));
            const clusters = map.densityLayer(map.noise.shore, o.shoreScale);
            const nearMountains = MapGen.Relief.tilesNearMountains(map, 2);

            coastal.forEach((i, k) => {
                const warmEnough = map.temperature[i] > 0.2;
                if (nearMountains[i] || heightRank[k] > 1 - o.cliffShare) map.shore[i] = Shore.CLIFF;
                else if (warmEnough && heightRank[k] < 0.65 && clusters[i] > 1 - o.beachShare) map.shore[i] = Shore.BEACH;
                else map.shore[i] = Shore.ROCKY;
            });
        }
    };
}

/* ============================================================
   Deposits — редкие ресурсы: золото, железо, эфир

   Золото и железо — в горах и предгорьях (не на реках), эфир — вдоль «линий разлома». Все три кладутся одним и тем же способом (placeVein).
   ============================================================ */
{
    MapGen.Deposits = {
        defaults: {
            foothillDistance: 2,  // руда встречается в горах и на равнине не дальше N клеток от них
            goldScale: 6,
            goldShare: 0.45,      // доля карты, где вообще возможно золото (скопления)
            goldChance: 0.05,     // шанс золота в такой клетке (в предгорьях вдвое меньше)
            ironScale: 5,
            ironShare: 0.5,       // то же для железной руды
            ironChance: 0.16,     // железо встречается заметно чаще золота
            faultScale: 5,        // масштаб «линий разлома», вдоль которых растёт эфир
            etherShare: 0.06,     // доля карты вдоль линий разлома
            etherChance: 0.35    // шанс эфира на такой клетке
        },

        build(map) {
            const o = map.options;
            const foothills = MapGen.Relief.tilesNearMountains(map, o.foothillDistance);
            const inFoothills = i => foothills[i] && !map.river[i];                 // руда — в горах и предгорьях, не на реках
            const oreChance = chance => i => (map.terrain[i] === Terrain.MOUNTAIN ? chance : chance * 0.5);   // в предгорьях вдвое реже

            // Золото — редкое, скоплениями; перекрывает лес и поля.
            this.placeVein(map, Resource.GOLD, map.densityLayer(map.noise.ore, o.goldScale), o.goldShare, oreChance(o.goldChance),
                { eligible: inFoothills });
            // Железо — там же, но другие скопления и заметно чаще; золото не вытесняет.
            this.placeVein(map, Resource.IRON, map.densityLayer(map.noise.iron, o.ironScale), o.ironShare, oreChance(o.ironChance),
                { eligible: inFoothills, canReplace: current => current !== Resource.GOLD });
            // Эфир (гигантские фиолетовые кристаллы и грибы) растёт вдоль «линий разлома» — тонких извилистых полос шума, с разрывами.
            // Линии: максимум там, где шум пересекает 0.5.
            const faults = map.densityLayer(map.noise.fault, o.faultScale, 3, n => 1 - Math.abs(2 * n - 1));
            this.placeVein(map, Resource.ETHER, faults, o.etherShare, () => o.etherChance,
                { eligible: i => !map.river[i], canReplace: current => current === Resource.NONE });
        },

        // Кладёт ресурс в клетки, где слой density попал в верхнюю долю share, с шансом chanceOf(клетка).
        // eligible(клетка) — можно ли вообще; canReplace(текущий ресурс) — можно ли вытеснить то, что уже лежит.
        placeVein(map, resource, density, share, chanceOf, { eligible = () => true, canReplace = () => true } = {}) {
            for (const i of map.landTiles) {
                if (!eligible(i) || !canReplace(map.resource[i])) continue;
                if (density[i] > 1 - share && map.random() < chanceOf(i)) map.resource[i] = resource;
            }
        }
    };
}

/* ============================================================
   Crossings — переправы через реки

   На прямых участках рек (вода входит и выходит в одном направлении) изредка ставим мост или брод.
   ============================================================ */
{
    MapGen.Crossings = {
        defaults: {
            riverCrossingChance: 0.2  // доля подходящих прямых участков рек, где ставится мост или брод
        },

        // Переправы: на прямых участках рек (вода входит и выходит в одном направлении) изредка ставим мост или брод.
        build(map) {
            const upstream = new Map();                                  // клетка -> реки, впадающие в неё
            for (const i of map.landTiles) {
                const to = map.riverTo[i];
                if (map.river[i] > 0 && to !== -1 && map.river[to] > 0) {
                    if (!upstream.has(to)) upstream.set(to, []);
                    upstream.get(to).push(i);
                }
            }

            for (const i of map.landTiles) {
                if (map.river[i] === 0 || map.riverTo[i] === -1 || map.crossing[i]) continue;
                const sources = upstream.get(i) || [];
                if (sources.length !== 1) continue;                       // начало реки или слияние — не место для моста
                const [ax, ay] = map.delta(sources[0], i), [bx, by] = map.delta(i, map.riverTo[i]);
                if (ax !== bx || ay !== by) continue;                    // поворот
                if (map.random() > map.options.riverCrossingChance) continue;
                if (map.neighbors8(i).some(j => map.crossing[j])) continue;
                map.crossing[i] = this.crossingFor(map, i);
            }
        },

        // Тип переправы для клетки реки: брод (1) или каменный мост (2, если река глубже 1).
        crossingFor(map, i) {
            return map.river[i] >= 2 ? 2 : 1;
        }
    };
}

/* ============================================================
   Regions — регионы

   Регион — связный кусок суши БЕЗ рек (как и без моря с озёрами). Реки при этом остаются границами: регион не может
   перешагнуть русло, в том числе по диагонали.

   Как строим: (1) раскладываем «семена» по каждому массиву суши пропорционально его площади; (2) делим землю между
   семенами по «стоимости пути» (горы дороже, шум чуть искажает границы); (3) несколько раз двигаем каждое семя в центр
   своего региона и делим заново (релаксация Ллойда) — именно она превращает случайные клочки в ровные, почти
   шестиугольные области; (4) чиним обрывки, вливаем мелочь, выравниваем размеры и сглаживаем границы.
   ============================================================ */
{
    const { tally, topKey, hash01 } = MapGen;

    MapGen.Regions = {
        defaults: {
            regionMinSize: 18,
            regionMaxSize: 22,
            regionMergeBelow: 10,     // регионы меньше этого размера вливаются в самого маленького соседа
            regionIrregularity: 0.6,  // 0 — почти круглые регионы, больше — причудливее границы
            regionBarrierCost: 3,     // насколько горы «мешают» росту региона (границы ложатся по хребтам); реки всегда граница и в регион не входят
            regionBalancePasses: 12,  // сколько раз выравнивать размеры регионов (0 — не выравнивать)
            regionRelaxPasses: 8,     // сколько раз «центровать» регионы вокруг семян: больше — ровнее и круглее формы
            regionSmoothPasses: 3    // сколько раз сглаживать границы (убирает зубцы и отростки; 0 — не сглаживать)
        },

        build(map) {
            const o = map.options;

            map.regionId.fill(-1);
            map.regionMask = new Uint8Array(map.size * map.size); // 1 — клетка может входить в регион (суша без реки)
            map.regionTiles = [];
            for (const i of map.landTiles) {
                if (map.river[i]) continue;
                map.regionMask[i] = 1;
                map.regionTiles.push(i);
            }
            map.regionSizes = {};
            if (map.regionTiles.length === 0) return;

            map.regionCost = this.buildRegionCosts(map);
            const averageSize = (o.regionMinSize + o.regionMaxSize) / 2;

            let seeds = [];
            for (const area of map.components(i => map.regionMask[i], map.regionTiles)) {
                // Остров, который одним регионом вышел бы заметно больше максимума, делим на несколько (соседям такой остров не отдашь).
                const seedCount = Math.max(1, Math.round(area.length / averageSize), Math.ceil(area.length / (o.regionMaxSize * 1.2)));
                seeds.push(...this.pickRegionSeeds(map, area, seedCount));
            }
            map.nextRegionId = seeds.length;

            for (let pass = 0; pass < o.regionRelaxPasses; pass++) {
                this.assignRegions(map, seeds);
                seeds = this.relaxRegionSeeds(map, seeds);
            }
            this.assignRegions(map, seeds);

            this.repairRegionConnectivity(map);
            this.repairRegionConnectivity(map);
            this.countRegionSizes(map);
            this.mergeSmallRegions(map);
            this.balanceRegionSizes(map);            // выравниваем размеры (излишек перетекает к мелким соседям)
            this.smoothRegionBorders(map);           // убираем зубцы и отростки, почти не выходя за [min, max]
            this.balanceRegionSizes(map);            // подтягиваем размеры после сглаживания
            this.smoothRegionBorders(map);
            this.renumberRegions(map);
        },

        // Сколько стоит «зайти» в клетку при росте региона: единица, шум (неправильность границ) и горы (преграда).
        buildRegionCosts(map) {
            const o = map.options;
            const noiseLayer = map.densityLayer(map.noise.regionShape, 10);
            const cost = new Float32Array(map.size * map.size);
            for (const i of map.regionTiles) {
                cost[i] = 1 + noiseLayer[i] * 2 * o.regionIrregularity;
                if (map.terrain[i] === Terrain.MOUNTAIN) cost[i] += o.regionBarrierCost;
            }
            return cost;
        },

        // Соседи для роста региона: 4 стороны и диагонали (чтобы формы были круглее, а не «ромбами»). Диагональ разрешена,
        // только если обе клетки «за углом» тоже годятся: так регион не просачивается сквозь диагональный изгиб реки или берега.
        regionNeighbors(map, i) {
            const { size, regionMask: mask } = map;
            const x = i % size;
            const result = [], around = map.neighbors8(i);
            for (let k = 0; k < around.length; k++) {
                const j = around[k];
                if (!mask[j]) continue;
                const dx = (j % size) - x;
                const diagonal = dx !== 0 && j - i !== dx;
                if (diagonal && !(mask[i + dx] && mask[j - dx])) continue;   // клетки «за углом»: по горизонтали и по вертикали от i
                result.push(j, diagonal ? Math.SQRT2 : 1);
            }
            return result; // плоский список: [клетка, длина шага, клетка, длина шага, ...]
        },

        // Семена берём случайно, но не вплотную друг к другу (сначала с большим зазором, потом с меньшим), равнинам отдаём предпочтение.
        pickRegionSeeds(map, area, count) {
            const isFlat = i => map.terrain[i] !== Terrain.MOUNTAIN;
            const order = map.shuffled(area.filter(isFlat)).concat(map.shuffled(area.filter(i => !isFlat(i))));
            count = Math.min(count, order.length);

            const averageSize = (map.options.regionMinSize + map.options.regionMaxSize) / 2;
            const spacing = Math.max(1, Math.round(Math.sqrt(averageSize) * 0.7));
            const blocked = new Uint8Array(map.terrain.length);
            const seeds = [];

            for (let radius = spacing; radius >= 0 && seeds.length < count; radius--) {
                blocked.fill(0);
                for (const seed of seeds) map.markSquare(blocked, seed, radius);
                for (const i of order) {
                    if (seeds.length >= count) break;
                    if (blocked[i] || seeds.includes(i)) continue;
                    seeds.push(i);
                    map.markSquare(blocked, i, radius);
                }
            }
            return seeds;
        },

        // Делим землю между семенами: каждая клетка достаётся тому, до кого «дешевле» дойти (Дейкстра от всех семян сразу).
        assignRegions(map, seeds) {
            map.regionId.fill(-1);
            const dist = new Float32Array(map.size * map.size).fill(Infinity);
            const heap = new MinHeap();
            seeds.forEach((tile, id) => {
                dist[tile] = 0;
                heap.push(0, tile, id);
            });

            while (heap.size > 0) {
                const [cost, tile, id] = heap.pop();
                if (map.regionId[tile] !== -1) continue;
                map.regionId[tile] = id;

                const steps = this.regionNeighbors(map, tile);
                for (let k = 0; k < steps.length; k += 2) {
                    const neighbor = steps[k];
                    if (map.regionId[neighbor] !== -1) continue;
                    const next = cost + steps[k + 1] * map.regionCost[neighbor];
                    if (next < dist[neighbor]) {
                        dist[neighbor] = next;
                        heap.push(next, neighbor, id);
                    }
                }
            }
        },

        // Новое семя — клетка региона, ближайшая к его «центру тяжести» (лёгкий штраф за горы).
        relaxRegionSeeds(map, seeds) {
            const size = map.size;
            const tilesByRegion = seeds.map(() => []);
            for (const i of map.regionTiles) {
                const id = map.regionId[i];
                if (id >= 0) tilesByRegion[id].push(i);
            }
            return seeds.map((seed, id) => {
                const tiles = tilesByRegion[id];
                if (tiles.length === 0) return seed;
                let cx = 0, cy = 0;
                for (const i of tiles) {
                    cx += i % size;
                    cy += Math.floor(i / size);
                }
                cx /= tiles.length;
                cy /= tiles.length;

                let best = seed, bestDistance = Infinity;
                for (const i of tiles) {
                    const dx = (i % size) - cx, dy = Math.floor(i / size) - cy;
                    const distance = dx * dx + dy * dy + (map.terrain[i] === Terrain.MOUNTAIN ? 4 : 0);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = i;
                    }
                }
                return best;
            });
        },

        // Регион должен быть цельным (по 4 соседям). Обрывки, отрезанные от основной части, отдаём соседу с самой длинной общей границей.
        repairRegionConnectivity(map) {
            const sameRegion = (j, start) => map.regionId[j] === map.regionId[start];
            const componentsByRegion = {};
            for (const component of map.components(sameRegion, map.regionTiles)) {
                (componentsByRegion[map.regionId[component[0]]] ||= []).push(component);
            }

            for (const components of Object.values(componentsByRegion)) {
                if (components.length < 2) continue;
                components.sort((a, b) => b.length - a.length);
                for (const fragment of components.slice(1)) {
                    const target = this.bestNeighborRegion(map, fragment, map.regionId[fragment[0]]);
                    const newId = target !== -1 ? target : map.nextRegionId++;
                    for (const i of fragment) map.regionId[i] = newId;
                }
            }
        },

        // Сосед с самой длинной общей границей (при равенстве — меньший).
        bestNeighborRegion(map, tiles, ownId) {
            const contacts = new Map();
            for (const i of tiles) {
                for (const j of map.neighbors(i)) {
                    const other = map.regionId[j];
                    if (other !== -1 && other !== ownId) tally(contacts, other);
                }
            }
            return topKey(contacts, (a, b) => (map.regionSizes[a] ?? 0) < (map.regionSizes[b] ?? 0));
        },

        // Клочок суши, отрезанный рекой от всего остального, лучше присоединить к региону на другом берегу, чем делать из него
        // отдельный «регион» в пару клеток (река при этом по-прежнему в регион не входит).
        regionAcrossRiver(map, tiles, ownId) {
            const contacts = new Map();
            for (const i of tiles) {
                for (const river of map.neighbors(i)) {
                    if (!map.river[river]) continue;
                    for (const j of map.neighbors8(river)) {
                        const other = map.regionId[j];
                        if (other !== -1 && other !== ownId) tally(contacts, other);
                    }
                }
            }
            return topKey(contacts);
        },

        countRegionSizes(map) {
            map.regionSizes = {};
            for (const i of map.regionTiles) {
                const id = map.regionId[i];
                if (id >= 0) map.regionSizes[id] = (map.regionSizes[id] || 0) + 1;
            }
        },

        // Переводит клетку в другой регион и поддерживает счётчики размеров.
        moveTile(map, tile, from, to) {
            map.regionId[tile] = to;
            map.regionSizes[from]--;
            map.regionSizes[to]++;
        },

        // Обрывки меньше regionMergeBelow вливаем в соседа (с самой длинной общей границей), начиная с самых мелких.
        mergeSmallRegions(map) {
            const tilesByRegion = {};
            for (const i of map.regionTiles) (tilesByRegion[map.regionId[i]] ||= []).push(i);

            const ids = Object.keys(map.regionSizes).map(Number).sort((a, b) => map.regionSizes[a] - map.regionSizes[b]);
            for (const id of ids) {
                const tiles = tilesByRegion[id];
                if (!tiles || tiles.length >= map.options.regionMergeBelow) continue;

                let target = this.bestNeighborRegion(map, tiles, id);
                if (target === -1) target = this.regionAcrossRiver(map, tiles, id);
                if (target === -1) continue; // обрывок суши, до которого не добраться даже через реку, — оставляем как есть

                for (const i of tiles) map.regionId[i] = target;
                tilesByRegion[target].push(...tiles);
                map.regionSizes[target] += tiles.length;
                delete map.regionSizes[id];
                delete tilesByRegion[id];
            }
        },

        // Сколько из 8 соседей клетки принадлежит региону id.
        regionContacts(map, tile, id) {
            let n = 0;
            for (const neighbor of map.neighbors8(tile)) if (map.regionId[neighbor] === id) n++;
            return n;
        },

        // Выравниваем размеры: граничные клетки переходят от слишком больших регионов к слишком маленьким. Сначала идут клетки,
        // которые «и так почти внутри» получателя (так граница не обрастает отростками); клетку не отдаём, если донор развалится.
        balanceRegionSizes(map) {
            const { regionMinSize, regionMaxSize, regionBalancePasses } = map.options;
            // Излишек перетекает «по цепочке» к более мелким соседям: слишком большой регион отдаёт клетки любому соседу, который
            // меньше него хотя бы на 2, а слишком маленький берёт у любого соседа, который больше него хотя бы на 2.
            const needed = (donor, receiver) => {
                const donorSize = map.regionSizes[donor], receiverSize = map.regionSizes[receiver];
                return (donorSize > regionMaxSize && receiverSize < donorSize - 1) || (receiverSize < regionMinSize && donorSize > receiverSize + 1);
            };

            for (let pass = 0; pass < regionBalancePasses; pass++) {
                const moves = [];
                for (const tile of map.regionTiles) {
                    const donor = map.regionId[tile];
                    let best = -1, bestScore = -Infinity;
                    for (const neighbor of map.neighbors(tile)) {
                        const receiver = map.regionId[neighbor];
                        if (receiver === -1 || receiver === donor || !needed(donor, receiver)) continue;
                        const toReceiver = this.regionContacts(map, tile, receiver);
                        if (toReceiver < 2) continue;
                        const score = toReceiver - this.regionContacts(map, tile, donor) + hash01(tile) * 0.01;
                        if (score > bestScore) {
                            bestScore = score;
                            best = receiver;
                        }
                    }
                    if (best !== -1) moves.push([bestScore, tile, best]);
                }
                moves.sort((a, b) => b[0] - a[0]);

                let moved = 0;
                for (const [, tile, receiver] of moves) {
                    const donor = map.regionId[tile];
                    if (donor === receiver || !needed(donor, receiver)) continue;
                    if (!map.neighbors(tile).some(n => map.regionId[n] === receiver)) continue;
                    if (this.regionContacts(map, tile, receiver) < 2) continue;
                    if (!this.staysConnectedWithout(map, tile, donor)) continue;

                    this.moveTile(map, tile, donor, receiver);
                    moved++;
                }
                if (moved === 0) break;
            }
        },

        // Сглаживание: клетка, у которой среди 8 соседей больше «чужих» одного региона, чем «своих», переходит к нему.
        // Убирает зубцы и узкие отростки, границы становятся плавными. Размеры при этом могут чуть выйти за [min, max] — потом их подтягивает выравнивание.
        smoothRegionBorders(map) {
            const { regionMinSize, regionMaxSize, regionSmoothPasses } = map.options;
            const floor = regionMinSize - 1, ceiling = regionMaxSize + 1;   // допуск по размеру: регион не уменьшаем меньше floor и не увеличиваем больше ceiling

            for (let pass = 0; pass < regionSmoothPasses; pass++) {
                let moved = 0;
                for (const tile of map.shuffled(map.regionTiles)) {
                    const own = map.regionId[tile];
                    const counts = new Map();
                    for (const neighbor of map.neighbors8(tile)) {
                        const id = map.regionId[neighbor];
                        if (id !== -1) tally(counts, id);
                    }

                    let best = -1, bestCount = counts.get(own) || 0;
                    for (const [id, n] of counts) {
                        if (id !== own && n > bestCount && map.neighbors(tile).some(j => map.regionId[j] === id)) {
                            best = id;
                            bestCount = n;
                        }
                    }
                    if (best === -1) continue;
                    if (map.regionSizes[own] - 1 < floor || map.regionSizes[best] + 1 > ceiling) continue;
                    if (!this.staysConnectedWithout(map, tile, own)) continue;

                    this.moveTile(map, tile, own, best);
                    moved++;
                }
                if (moved === 0) break;
            }
        },

        // Не расколется ли регион, если убрать из него клетку removed: все её соседи по региону должны остаться связанными между собой.
        // (Регион с карманом за рекой уже состоит из двух кусков — для него проверяем только тот кусок, где лежит клетка.)
        staysConnectedWithout(map, removed, id) {
            const own = map.neighbors(removed).filter(n => map.regionId[n] === id);
            if (own.length <= 1) return true;

            const seen = new Set([removed, own[0]]);
            const queue = [own[0]];
            let reached = 1;
            for (let head = 0; head < queue.length && reached < own.length; head++) {
                for (const neighbor of map.neighbors(queue[head])) {
                    if (map.regionId[neighbor] !== id || seen.has(neighbor)) continue;
                    seen.add(neighbor);
                    queue.push(neighbor);
                    if (own.includes(neighbor)) reached++;
                }
            }
            return reached === own.length;
        },

        // Номера регионов подряд: 0, 1, 2, ... (после слияний в нумерации остаются дыры).
        renumberRegions(map) {
            const mapping = new Map();
            for (const i of map.regionTiles) {
                const id = map.regionId[i];
                if (id === -1) continue;
                if (!mapping.has(id)) mapping.set(id, mapping.size);
                map.regionId[i] = mapping.get(id);
            }
            this.countRegionSizes(map);
        }
    };
}

/* ============================================================
   Settlements — поселения: места, группы, уровни

   Поселение — ресурс клетки (как пшеница или руда): в клетке либо оно, либо другой ресурс. Оно даёт население и золото.
   Поселения стоят ГРУППАМИ из 1–4 соседних клеток (деревня, городок), и у каждой клетки группы свой уровень 1–4 (он же число
   домиков в клетке, в painter). Вместе клетки образуют один населённый пункт.
   Население региона зависит от «обитаемости» его клеток: плодородные луга, поля, места у рек и побережья — много,
   пустыня, тундра и горы — мало. Чем больше население, тем больше клеток в группе, а населения самой клетки хватает
   на более высокий уровень. Большому региону достаётся ещё и вторая группа.
   ============================================================ */
{
    const { RARE_RESOURCES } = MapGen;
    const HABITABILITY_BY_BIOME = {
        [Biome.GRASSLAND]: 1, [Biome.SAVANNA]: 0.65, [Biome.STEPPE]: 0.6,
        [Biome.TAIGA]: 0.55, [Biome.TUNDRA]: 0.15, [Biome.DESERT]: 0.1
    };

    MapGen.Settlements = {
        defaults: {
            populationPerHabitability: 10,    // население региона = сумма «обитаемости» его клеток × это число × случайный множитель
            populationVariation: 0.9,         // разброс населения между регионами (больше — больше и крупных городов, и пустых земель)
            settlementMinPopulation: 60,      // население группы меньше этого — поселения нет
            settlementMaxGroup: 4,            // в группе (деревня, город) не больше стольких соседних клеток
            settlementGroupGrowth: 2.2,       // во сколько раз надо увеличить население, чтобы в группе стало на клетку больше
            settlementMaxLevel: 4,            // самый большой уровень клетки (он же число домиков в клетке)
            settlementTileMinPopulation: 58,  // население клетки, с которого начинается уровень 1
            settlementTileGrowth: 1.5,        // во сколько раз надо увеличить население клетки, чтобы уровень вырос на 1
            secondSettlementPopulation: 900,  // у региона с таким населением и больше будет вторая группа
            settlementSpacing: 2             // минимум клеток между группами поселений
        },

        build(map) {
            const o = map.options;
            const habitability = this.computeHabitability(map);

            const tilesByRegion = {}, sums = {};
            for (const i of map.landTiles) {
                const id = map.regionId[i];
                if (id < 0) continue; // клетки рек в регионы не входят
                (tilesByRegion[id] ||= []).push(i);
                sums[id] = (sums[id] || 0) + habitability[i];
            }

            const candidates = [];
            for (const key of Object.keys(sums)) {
                const id = Number(key);
                const gauss = (map.random() + map.random() + map.random() - 1.5) / 0.5; // ≈ нормальное распределение
                const population = Math.round(sums[id] * o.populationPerHabitability * Math.exp(gauss * o.populationVariation));
                map.regionPopulation[id] = population;
                if (population >= o.settlementMinPopulation) candidates.push({ regionId: id, population });
            }

            // Крупные группы ставим первыми: они занимают лучшие места, мелкие устраиваются вокруг.
            candidates.sort((a, b) => b.population - a.population);
            const blocked = new Uint8Array(map.terrain.length);
            for (const { regionId, population: regionPopulation } of candidates) {
                const shares = regionPopulation >= o.secondSettlementPopulation ? [0.62, 0.38] : [1];
                for (const share of shares) {
                    const population = Math.round(regionPopulation * share);
                    if (population < o.settlementMinPopulation) continue;
                    const group = this.growSettlementGroup(map, regionId, tilesByRegion[regionId], habitability, blocked, population);
                    if (group) this.commitSettlementGroup(map, group, population, blocked);
                }
            }
        },

        // Насколько клетка подходит для жизни: 0 (горы, вода) .. ~1.6 (плодородный луг у реки).
        computeHabitability(map) {
            const habitability = new Float32Array(map.terrain.length);
            for (const i of map.landTiles) {
                if (map.terrain[i] !== Terrain.PLAIN) continue;
                let value = HABITABILITY_BY_BIOME[map.biome[i]] * (0.6 + 0.4 * map.moisture[i]);
                if (map.resource[i] === Resource.WHEAT) value += 0.35;
                else if (map.resource[i] === Resource.WOOD) value += 0.1;
                if (map.neighbors(i).some(j => map.river[j] > 0)) value += 0.35;                 // вода для питья и торговли
                if (map.neighbors8(i).some(j => !map.isLand(j))) value += 0.2;                   // берег
                if (map.shore[i] === Shore.CLIFF) value -= 0.2;
                habitability[i] = clamp(value, 0, 1.6);
            }
            return habitability;
        },

        // Уровень клетки (1..settlementMaxLevel) по её населению: каждое увеличение в settlementTileGrowth раз добавляет уровень.
        settlementLevelFor(map, population) {
            const o = map.options;
            const level = 1 + Math.floor(Math.log(Math.max(1, population) / o.settlementTileMinPopulation) / Math.log(o.settlementTileGrowth));
            return clamp(level, 1, o.settlementMaxLevel);
        },

        isSettlementSite(map, i, regionId, habitability, blocked) {
            return map.terrain[i] === Terrain.PLAIN && !map.river[i] && !blocked[i] && habitability[i] > 0
                && map.regionId[i] === regionId && map.shore[i] !== Shore.CLIFF
                && !RARE_RESOURCES.has(map.resource[i]) && map.resource[i] !== Resource.SETTLEMENT;
        },

        // Выбирает лучшую клетку региона и наращивает вокруг неё группу из соседних клеток (до settlementMaxGroup).
        growSettlementGroup(map, regionId, regionTiles, habitability, blocked, population) {
            const o = map.options;
            const isSite = i => this.isSettlementSite(map, i, regionId, habitability, blocked);
            const scoreOf = i => habitability[i] + map.random() * 0.3;

            let center = -1, best = -Infinity;
            for (const i of regionTiles) {
                if (!isSite(i)) continue;
                const score = scoreOf(i);
                if (score > best) { best = score; center = i; }
            }
            if (center === -1) return null;

            const wanted = clamp(1 + Math.floor(Math.log(population / o.settlementMinPopulation) / Math.log(o.settlementGroupGrowth)), 1, o.settlementMaxGroup);
            const tiles = [center], parents = [-1], inside = new Set(tiles);
            while (tiles.length < wanted) {
                let next = -1, parent = -1, nextScore = -Infinity;
                for (const tile of tiles) {
                    for (const neighbor of map.neighbors(tile)) {
                        if (inside.has(neighbor) || !isSite(neighbor)) continue;
                        const score = scoreOf(neighbor);
                        if (score > nextScore) { nextScore = score; next = neighbor; parent = tile; }
                    }
                }
                if (next === -1) break;                                  // дальше расти некуда: вода, горы, соседний регион
                tiles.push(next);
                parents.push(parent);
                inside.add(next);
            }
            return { tiles, parents };
        },

        // Записывает группу: делит население между клетками (центр — больше всех), задаёт уровни и соединяет клетки дорожками.
        commitSettlementGroup(map, group, population, blocked) {
            const groupId = map.settlementGroups.length;
            const weights = group.tiles.map((_, k) => (k === 0 ? 1.4 : 0.6 + map.random() * 0.8));
            const total = weights.reduce((a, b) => a + b, 0);

            group.tiles.forEach((tile, k) => {
                const tilePopulation = Math.max(1, Math.round(population * weights[k] / total));
                const level = this.settlementLevelFor(map, tilePopulation);
                map.settlements.push({ id: map.settlements.length, groupId, regionId: map.regionId[tile], tile, population: tilePopulation, level, center: k === 0 });
                map.resource[tile] = Resource.SETTLEMENT;
                map.population[tile] = Math.min(65535, tilePopulation);
                map.settlementLevel[tile] = level;
                map.settlementGroup[tile] = groupId;
                if (group.parents[k] !== -1) MapGen.Roads.carveRoad(map, [group.parents[k], tile]);   // дорожка между соседними клетками группы
            });
            map.settlementGroups.push({ id: groupId, regionId: map.regionId[group.tiles[0]], tiles: group.tiles, tile: group.tiles[0], population });

            for (const tile of group.tiles) map.markSquare(blocked, tile, map.options.settlementSpacing);
        }
    };
}

/* ============================================================
   Roads — дороги между поселениями (A*, мосты и броды)

   Каждая группа поселений соединяется с ближайшими соседями; рёбра берутся по возрастанию длины, и в «каркас» попадают те,
   что связывают ещё не связанные группы (как остовное дерево), плюс несколько ближайших пар для петель. Путь ищет A*: горы и
   вода непроходимы, лес и подъёмы замедляют, а чужие дороги дёшевы — поэтому дороги сливаются в магистрали. Где дорога
   пересекает реку, ставится мост или брод. На дорогах нет ресурсов: дорога проложена через клетку, значит, она расчищена.
   ============================================================ */
{
    const { DIRECTIONS_8 } = MapGen;
    // Во сколько раз ресурс клетки удорожает шаг. Руды и эфир дороги не пересекают: на дороге ресурсов нет, жалко терять.
    const ROAD_RESOURCE_COST = Array.from({ length: Object.keys(Resource).length }, () => 1);
    Object.assign(ROAD_RESOURCE_COST, { [Resource.WOOD]: 1.5, [Resource.WHEAT]: 1.15, [Resource.GOLD]: 5, [Resource.IRON]: 5, [Resource.ETHER]: 5 });

    MapGen.Roads = {
        defaults: {
            roads: true,
            roadNeighbors: 3,     // с сколькими ближайшими соседями пробуем соединить каждое поселение
            roadMaxDistance: 28,  // дальше этого (в клетках) дорог не строим
            roadLoopChance: 0.4  // шанс добавить «петлю» — вторую по близости дорогу, когда связь уже есть
        },

        build(map) {
            this.connect(map);                 // дороги между группами поселений
            this.clearRoadResources(map);      // на дорогах нет ресурсов
        },

        // На дорогах нет ресурсов, леса и полей: дорога проложена через клетку, значит, она расчищена. Клетки поселений остаются.
        clearRoadResources(map) {
            for (let i = 0; i < map.resource.length; i++) {
                if (map.roadLevel[i] > 0 && map.resource[i] !== Resource.SETTLEMENT) map.resource[i] = Resource.NONE;
            }
        },

        connect(map) {
            const o = map.options;
            const groups = map.settlementGroups;
            if (!o.roads || groups.length < 2) return;

            const parent = groups.map((_, i) => i);   // система непересекающихся множеств: какие группы уже связаны дорогами
            const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
            for (const edge of this.roadCandidateEdges(map, groups)) {
                const joins = find(edge.a) !== find(edge.b);
                // каркас (связываем несвязанное) + петли (ближайшие пары)
                const loop = !joins && (edge.rank === 0 || (edge.rank === 1 && map.random() < o.roadLoopChance));
                if (!joins && !loop) continue;

                const path = this.findRoadPath(map, groups[edge.a].tile, groups[edge.b].tile);
                if (!path) continue;                                  // например, через море
                if (joins) parent[find(edge.a)] = find(edge.b);
                this.carveRoad(map, path);
            }
        },

        // Кандидаты в рёбра: roadNeighbors ближайших соседей каждой группы (поиск по сетке корзин), по возрастанию длины.
        // rank — какой по близости это сосед (0 — ближайший).
        roadCandidateEdges(map, groups) {
            const o = map.options, size = map.size;
            const coords = groups.map(g => [g.tile % size, Math.floor(g.tile / size)]);
            const bucketSize = 16, bucketOf = v => Math.floor(v / bucketSize);
            const buckets = new Map();
            coords.forEach(([x, y], id) => {
                const key = bucketOf(x) + ',' + bucketOf(y);
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(id);
            });
            const maxDistance = o.roadMaxDistance * size / 300;   // дальность дорог растёт вместе с картой
            const reach = Math.ceil(maxDistance / bucketSize);

            const edges = [], seen = new Set();
            coords.forEach(([x, y], id) => {
                const near = [];
                for (let by = bucketOf(y) - reach; by <= bucketOf(y) + reach; by++) {
                    for (let bx = bucketOf(x) - reach; bx <= bucketOf(x) + reach; bx++) {
                        for (const other of buckets.get(bx + ',' + by) || []) {
                            if (other === id) continue;
                            const distance = Math.hypot(coords[other][0] - x, coords[other][1] - y);
                            if (distance <= maxDistance) near.push({ other, distance });
                        }
                    }
                }
                near.sort((a, b) => a.distance - b.distance);
                near.slice(0, o.roadNeighbors).forEach(({ other, distance }, rank) => {
                    const key = Math.min(id, other) * 100000 + Math.max(id, other);
                    if (seen.has(key)) return;
                    seen.add(key);
                    edges.push({ a: id, b: other, distance, rank });
                });
            });
            return edges.sort((p, q) => p.distance - q.distance);
        },

        // Поиск пути A* от клетки к клетке; null, если пути нет.
        findRoadPath(map, start, goal) {
            const size = map.size;
            const count = size * size;
            const scratch = map.pathScratch ||= { cost: new Float32Array(count), stamp: new Int32Array(count), from: new Int32Array(count), run: 0 };
            const { cost, stamp, from } = scratch;
            const run = ++scratch.run;
            const goalX = goal % size, goalY = Math.floor(goal / size);
            const heuristic = i => Math.hypot((i % size) - goalX, Math.floor(i / size) - goalY) * 0.4;

            const heap = new MinHeap();
            cost[start] = 0;
            stamp[start] = run;
            from[start] = -1;
            heap.push(heuristic(start), start, 0);

            while (heap.size > 0) {
                const [, current, spent] = heap.pop();
                if (spent > cost[current] + 1e-6) continue;           // устаревшая запись
                if (current === goal) {
                    const path = [];
                    for (let i = goal; i !== -1; i = from[i]) path.push(i);
                    return path.reverse();
                }

                const around = map.neighbors8(current);
                for (let k = 0; k < around.length; k++) {
                    const next = around[k];
                    const step = this.roadStepCost(map, current, next);
                    if (step === Infinity) continue;
                    const total = cost[current] + step;
                    if (stamp[next] !== run || total < cost[next]) {
                        stamp[next] = run;
                        cost[next] = total;
                        from[next] = current;
                        heap.push(total + heuristic(next), next, total);
                    }
                }
            }
            return null;
        },

        // Цена шага по дороге из клетки current в соседнюю next (Infinity — нельзя).
        roadStepCost(map, current, next) {
            const { terrain, river } = map;
            if (terrain[next] !== Terrain.PLAIN) return Infinity;                // вода и горы
            if (river[current] && river[next]) return Infinity;                  // с клетки реки на клетку реки не шагаем: дорога заезжает на реку, только чтобы пересечь её
            const dx = (next % map.size) - (current % map.size);
            const diagonal = dx !== 0 && next - current !== dx;
            if (diagonal) {                                                      // по диагонали нельзя «срезать угол» воды, гор и рек
                const a = current + dx, b = next - dx;                           // клетки «за углом»
                if (terrain[a] !== Terrain.PLAIN || river[a] || terrain[b] !== Terrain.PLAIN || river[b]) return Infinity;
            }

            let cost = diagonal ? 1.414 : 1;
            if (river[next]) cost += 3;                                          // мост — дорого
            cost *= ROAD_RESOURCE_COST[map.resource[next]];
            if (map.biome[next] === Biome.TUNDRA || map.biome[next] === Biome.DESERT) cost *= 1.4;
            cost += Math.abs(map.elevation[next] - map.elevation[current]) * 12; // подъёмы
            if (map.roadLevel[next] > 0) cost *= 0.4;                           // готовые дороги дёшевы
            return cost;
        },

        // Сохраняет путь: уровень дороги в клетках (где дорогу используют несколько путей — выше), связи с соседями и мосты через реки.
        carveRoad(map, path) {
            path.forEach((tile, k) => {
                map.roadLevel[tile] = Math.min(3, map.roadLevel[tile] + 1);
                if (map.river[tile] > 0 && map.crossing[tile] === 0) map.crossing[tile] = MapGen.Crossings.crossingFor(map, tile);
                if (k === 0) return;
                const previous = path[k - 1];
                const [dx, dy] = map.delta(previous, tile);
                const forward = DIRECTIONS_8.findIndex(([ax, ay]) => ax === dx && ay === dy);
                map.roadLinks[previous] |= 1 << forward;
                map.roadLinks[tile] |= 1 << (7 - forward);                      // противоположное направление в списке — зеркальный индекс
            });
        }
    };
}

/* ============================================================
   Growth — начальная степень роста лесов и полей

   Изначально леса и поля полностью выросли (степень роста 1); дальше её меняет экономика (см. Economy).
   ============================================================ */
{
    const { isGrowing } = MapGen;

    MapGen.Growth = {
        // Изначально леса и поля полностью выросли (степень роста 1); дальше её меняет экономика.
        build(map) {
            map.growth.fill(0);
            for (let i = 0; i < map.resource.length; i++) {
                if (isGrowing(map.resource[i])) map.growth[i] = 1;
            }
        }
    };
}

/* ============================================================
   Turn — ход

   Карта не управляет ходами, экономикой и фракциями: этим занимаются отдельные модули (turn-manager.js, economy-manager.js,
   faction-manager.js). Они передают сюда готовое состояние (Turn / Economy / Factions .apply), карта его хранит, показывает
   и оповещает подписчиков — так рендерер перерисовывается сам. Данные копируются: менеджер остаётся единственным владельцем состояния.
   ============================================================ */
{
    MapGen.Turn = {
        // Ход: state = { turn, year, season, seasonIndex, turnInSeason, version } — текущее время; сезон показывает рендерер.
        apply(map, state) {
            map.turnState = { ...state, version: state.version === undefined ? map.turnState.version + 1 : state.version };
            map.turnChannel.emit(map.turnState);
        }
    };
}

/* ============================================================
   Economy — экономика: рост, население, ресурсы

   Все остальные поля карты (рельеф, дороги, поселения как места) не меняются. Карта пересчитывает только производное: уровень
   поселения (по населению), население групп и регионов.
   ============================================================ */
{
    const { tally, isGrowing } = MapGen;

    MapGen.Economy = {
        /* Экономика: state — любое из:
             growth: Float32Array          степень роста каждой клетки 0..1 (леса, поля)
             population: Uint16Array       население каждой клетки (учитывается только у клеток с поселением)
             resourceChanges: [{ tile, resource }]   лес или поле появились или исчезли (Resource.NONE / WOOD / WHEAT)
             version
           Все остальные поля карты (рельеф, дороги, поселения как места) не меняются. Сама карта пересчитывает только производное:
           уровень поселения (по населению), население групп и регионов.
           Слушателям уходит { visualChanged }: true, если изменилось то, что видно на карте (ступень роста, уровень поселения,
           появился или исчез лес или поле) — только тогда имеет смысл перерисовывать карту. */
        apply(map, { growth, population, resourceChanges = [], version } = {}) {
            const total = map.growth.length;
            if ((growth && growth.length !== total) || (population && population.length !== total)) throw new Error('Данные экономики не подходят к этой карте');
            const allowed = [Resource.NONE, Resource.WOOD, Resource.WHEAT];
            for (const { tile, resource } of resourceChanges) {
                if (!map.isLand(tile) || !allowed.includes(resource) || !allowed.includes(map.resource[tile])) {
                    throw new Error(`Нельзя менять ресурс клетки ${tile}: можно только лес, поле или пусто`);
                }
            }

            let visual = this.applyResourceChanges(map, resourceChanges);
            if (growth) visual = this.applyGrowth(map, growth) || visual;
            if (population) visual = this.applyPopulation(map, population) || visual;

            map.economyVersion = version === undefined ? map.economyVersion + 1 : version;
            if (visual) map.visualVersion++;
            map.economyChannel.emit({ visualChanged: visual, version: map.economyVersion });
        },

        // Все три метода ниже возвращают true, если изменилось то, что видно на карте.
        applyResourceChanges(map, changes) {
            let visual = false;
            for (const { tile, resource } of changes) {
                if (map.resource[tile] === resource) continue;
                map.resource[tile] = resource;
                visual = true;
            }
            return visual;
        },

        applyGrowth(map, growth) {
            let visual = false;
            for (let i = 0; i < growth.length; i++) {
                if (!Number.isFinite(growth[i])) continue;                // нечисловое значение игнорируем, клетка остаётся как была
                const value = clamp(growth[i]);
                if (map.growth[i] === value) continue;
                if (growthStage(map.growth[i]) !== growthStage(value) && isGrowing(map.resource[i])) visual = true;
                map.growth[i] = value;
            }
            return visual;
        },

        applyPopulation(map, population) {
            let visual = false;
            const groupTotals = new Map(), regionTotals = new Map();
            for (const settlement of map.settlements) {
                const tile = settlement.tile;
                const raw = population[tile];
                const value = Number.isFinite(raw) ? clamp(Math.round(raw), 0, 65535) : map.population[tile];
                map.population[tile] = value;
                settlement.population = value;
                const level = MapGen.Settlements.settlementLevelFor(map, value);
                if (level !== map.settlementLevel[tile]) {
                    map.settlementLevel[tile] = level;
                    visual = true;
                }
                settlement.level = level;
                tally(groupTotals, settlement.groupId, value);
                tally(regionTotals, settlement.regionId, value);
            }
            for (const [groupId, sum] of groupTotals) map.settlementGroups[groupId].population = sum;
            for (const [regionId, sum] of regionTotals) map.regionPopulation[regionId] = sum;
            return visual;
        }
    };
}

/* ============================================================
   Factions — фракции

   Фракции и владение клетками приходят от faction manager; рендерер рисует слой фракций по map.factionVersion.
   ============================================================ */
{
    MapGen.Factions = {
        // state = { factions: [{ id, name, color, capitalRegion, capitalTile }], tileFaction: Int16Array (id фракции или -1 на клетку), version }
        apply(map, { factions, tileFaction, version }) {
            if (!tileFaction || tileFaction.length !== map.tileFaction.length) throw new Error('tileFaction не подходит к этой карте');
            map.factions = factions.map(f => ({ ...f }));
            map.tileFaction = Int16Array.from(tileFaction);
            map.factionVersion = version === undefined ? map.factionVersion + 1 : version;
            map.factionChannel.emit(map);
        }
    };
}

/* ============================================================
   Info — запросы: что лежит в клетке и в регионе
   ============================================================ */
{
    MapGen.Info = {
        regionTiles(map, regionId) {
            return map.landTiles.filter(i => map.regionId[i] === regionId);
        },

        // Соседство регионов: общая граница или соседи через реку (регионы на разных берегах — тоже соседи). Map: id -> Set соседей.
        graph(map) {
            const graph = new Map();
            const link = (a, b) => {
                if (a < 0 || b < 0 || a === b) return;
                graph.get(a).add(b);
                if (!graph.has(b)) graph.set(b, new Set());
                graph.get(b).add(a);
            };
            for (const i of map.landTiles) {
                const a = map.regionId[i];
                if (a < 0) continue;
                if (!graph.has(a)) graph.set(a, new Set());
                for (const j of map.neighbors8(i)) {
                    const b = map.regionId[j];
                    if (b >= 0) link(a, b);
                    else if (map.river[j] > 0) for (const k of map.neighbors8(j)) link(a, map.regionId[k]);
                }
            }
            return graph;
        },

        region(map, regionId) {
            if (regionId < 0) return null;
            const tiles = this.regionTiles(map, regionId);
            const info = {
                id: regionId,
                tiles,
                size: tiles.length,
                mountains: 0,
                riverTiles: 0,
                population: map.regionPopulation[regionId] || 0,
                settlements: map.settlements.filter(s => s.regionId === regionId),
                coastal: false,
                resources: new Array(Object.keys(Resource).length).fill(0),   // по кодам Resource (0 — клетки без ресурса)
                biomes: new Array(Object.keys(Biome).length).fill(0),         // по кодам Biome (без гор)
                owners: {},                   // id фракции -> сколько клеток региона ей принадлежит
                owner: -1                     // фракция, которой принадлежит весь регион целиком (иначе -1)
            };
            const riverTiles = new Set();
            for (const i of tiles) {
                const faction = map.tileFaction[i];
                if (faction >= 0) info.owners[faction] = (info.owners[faction] || 0) + 1;
                if (map.terrain[i] === Terrain.MOUNTAIN) info.mountains++;
                else info.biomes[map.biome[i]]++;
                for (const j of map.neighbors(i)) if (map.river[j]) riverTiles.add(j); // реки в регион не входят — считаем те, что его омывают
                info.resources[map.resource[i]]++;
                if (map.neighbors(i).some(j => !map.isLand(j))) info.coastal = true;
            }
            info.riverTiles = riverTiles.size;
            const ownerIds = Object.keys(info.owners);
            if (ownerIds.length === 1 && info.owners[ownerIds[0]] === tiles.length) info.owner = Number(ownerIds[0]);
            return info;
        },

        tile(map, x, y) {
            if (x < 0 || y < 0 || x >= map.size || y >= map.size) return null;
            const i = map.index(x, y);
            const regionId = map.regionId[i];
            const group = map.settlementGroup[i];
            return {
                x, y,
                terrain: map.terrain[i],
                biome: map.biome[i],
                temperature: map.temperature[i],
                resource: map.resource[i],
                hasRiver: map.river[i] > 0,
                riverLevel: map.river[i],
                population: map.population[i],
                settlementLevel: map.settlementLevel[i],
                settlementGroupSize: group >= 0 ? map.settlementGroups[group].tiles.length : 0,
                roadLevel: map.roadLevel[i],
                shore: map.shore[i],
                crossing: map.crossing[i],
                waterDepth: map.waterDepth[i],
                regionId,
                regionSize: regionId >= 0 ? map.regionSizes[regionId] : 0,
                growth: map.growth[i],                   // степень роста леса или поля 0..1
                factionId: map.tileFaction[i]            // -1 — клетка никому не принадлежит
            };
        }
    };
}

/* ============================================================
   Слои данных клетки. Карта хранится в плоских массивах: клетка (x, y) — это индекс y * size + x.
   [тип массива, значение по умолчанию]. Всё, что не перечислено здесь, — объекты в resetState().
   ============================================================ */
MapGen.TILE_LAYERS = {
    elevation: [Float32Array],
    moisture: [Float32Array],
    ridge: [Float32Array],                 // 0..1: насколько клетка похожа на горный хребет
    massif: [Float32Array],                // 0..1: крупные «пятна» для горных массивов
    temperature: [Float32Array],
    terrain: [Uint8Array],                 // Terrain
    mountainHeight: [Float32Array],        // 0 вне гор; 0.3..1 в горах — по нему рисуется рельеф
    waterDepth: [Uint8Array],              // 0 на суше; в воде — расстояние до ближайшей суши
    biome: [Uint8Array],                   // Biome
    resource: [Uint8Array],                // Resource
    shore: [Uint8Array],                   // тип берега (Shore) у суши рядом с водой и реками
    river: [Uint8Array],                   // 0 — реки нет, 1..3 — её глубина
    riverTo: [Int32Array, -1],             // куда течёт река из этой клетки (-1 — не река или сток за краем карты)
    riverFlow: [Uint16Array],              // сколько воды проходит через клетку (определяет ширину реки)
    crossing: [Uint8Array],                // 0 — нет, 1 — брод, 2 — каменный мост
    regionId: [Int16Array, -1],            // -1 — клетка вне региона (вода и реки)
    population: [Uint16Array],             // население в клетке с поселением
    settlementLevel: [Uint8Array],         // уровень клетки с поселением 1..4 (0 — нет поселения)
    settlementGroup: [Int16Array, -1],     // номер группы поселений в клетке, -1 — нет
    roadLevel: [Uint8Array],               // 0 — нет дороги, 1..3 — насколько она наезжена
    roadLinks: [Uint8Array],               // биты: в какие из 8 сторон (DIRECTIONS_8) идёт дорога из клетки
    growth: [Float32Array],                // степень роста клетки 0..1: леса и поля (у остальных клеток 0)
    tileFaction: [Int16Array, -1]          // кому принадлежит клетка (id фракции), -1 — никому
};

// Слои шума: seed + порядковый номер (с 1). Порядок менять нельзя — от него зависят все существующие карты.
MapGen.NOISE_LAYERS = ['elevation', 'ridge', 'temperature', 'moisture', 'warpX', 'warpY', 'forest', 'fertility', 'shape', 'basin',
    'regionShape', 'islands', 'massif', 'forestClumps', 'fertilityClumps', 'ore', 'fault', 'shore', 'iron'];

// Шаги генерации по порядку. Каждый — метод MapGenerator (см. миксины ниже).
// Этапы генерации по порядку. Каждый — подсистема MapGen.<Имя> с единым входом build(map); её настройки (defaults) собираются
// в MapGenerator.DEFAULTS. Порядок важен: от него зависят и результат, и последовательность случайных чисел (а значит, все карты).
MapGen.PIPELINE = ['Relief', 'Drainage', 'Climate', 'Flora', 'Rivers', 'Shores', 'Deposits', 'Crossings', 'Regions', 'Settlements', 'Roads', 'Growth'];

/* Простой «канал»: подписчики получают каждое новое состояние. Подписка возвращает функцию отписки. */
MapGen.Emitter = class Emitter {
    constructor() {
        this.listeners = new Set();
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(payload) {
        for (const listener of [...this.listeners]) listener(payload);
    }
};

/* ============================================================
   MapGenerator — ядро
   ============================================================ */
class MapGenerator {
    // Настройки лежат рядом с кодом своей подсистемы (MapGen.<Имя>.defaults); здесь собираются в один плоский объект.
    static get DEFAULTS() {
        const options = {
            size: 150,                // сторона карты в клетках (значения «по размеру карты» заданы для 300 и пересчитываются)
            seed: 1
        };
        for (const name of MapGen.PIPELINE) Object.assign(options, MapGen[name].defaults);
        return JSON.parse(JSON.stringify(options));       // свежая копия: массивы (riverThresholds) не должны делиться между картами
    }

    constructor(options = {}) {
        this.options = { ...MapGenerator.DEFAULTS, ...options };
        this.size = this.options.size;
        this.cache4 = new Array(this.size * this.size);   // соседи клеток, считаются по требованию
        this.cache8 = new Array(this.size * this.size);
        // Подписчики переживают новую генерацию.
        this.turnChannel = new MapGen.Emitter();                 // состояние хода (onTurnState)
        this.economyChannel = new MapGen.Emitter();              // состояние экономики (onEconomyState)
        this.factionChannel = new MapGen.Emitter();              // состояние фракций (onFactionState)
    }

    // Конвейер генерации: один seed — одна карта.
    generate(seed = this.options.seed) {
        this.seed = seed;
        this.random = createRandom(seed);
        this.noise = Object.fromEntries(MapGen.NOISE_LAYERS.map((name, k) => [name, new ValueNoise(seed + k + 1)]));
        this.allocateLayers();
        for (const name of MapGen.PIPELINE) MapGen[name].build(this);
        return this;
    }

    allocateLayers() {
        const count = this.size * this.size;
        for (const [name, [Type, fill]] of Object.entries(MapGen.TILE_LAYERS)) {
            this[name] = new Type(count);
            if (fill !== undefined) this[name].fill(fill);
        }
        this.resetState();
    }

    // Всё, что не лежит по клеткам.
    resetState() {
        this.landTiles = [];                          // индексы всех клеток суши
        this.settlements = [];                        // по записи на каждую клетку с поселением: { id, groupId, regionId, tile, population, level, center }
        this.settlementGroups = [];                   // группы соседних клеток: { id, regionId, tiles, tile (центр), population }
        this.regionPopulation = {};                   // id региона -> население
        this.regionSizes = {};                        // id региона -> число клеток
        // Ход, экономика и фракции — только данные: их передают менеджеры (applyTurnState, applyEconomyState, applyFactionState).
        this.turnState = { turn: 0, year: 0, season: null, seasonIndex: 0, turnInSeason: 0, version: 0 };
        this.economyVersion = 0;                      // версия состояния экономики
        this.visualVersion = 0;                       // растёт, только когда экономика изменила то, что видно (ступень роста, уровень поселения)
        this.factions = [];                           // фракции: { id, name, color, capitalRegion, capitalTile }
        this.factionVersion = 0;                      // версия состояния от менеджера: по ней перерисовывается слой фракций
    }

    /* ---------- Сетка: координаты, соседи, обходы ---------- */

    index(x, y) {
        return y * this.size + x;
    }

    isLand(i) {
        return this.terrain[i] >= Terrain.PLAIN;
    }

    neighborList(i, directions) {
        const size = this.size, x = i % size, y = (i - x) / size;
        const result = [];
        for (const [dx, dy] of directions) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < size && ny < size) result.push(ny * size + nx);
        }
        return result;
    }

    // Четыре соседа (влево, вправо, вверх, вниз) внутри карты. Список общий для всех вызовов — не изменяйте его.
    neighbors(i) {
        return this.cache4[i] ??= this.neighborList(i, MapGen.DIRECTIONS_4);
    }

    // Восемь соседей, включая диагональных. Список общий — не изменяйте его.
    neighbors8(i) {
        return this.cache8[i] ??= this.neighborList(i, MapGen.DIRECTIONS_8);
    }

    // Смещение (dx, dy) от клетки from к клетке to.
    delta(from, to) {
        const size = this.size;
        return [(to % size) - (from % size), Math.floor(to / size) - Math.floor(from / size)];
    }

    isDiagonal(a, b) {
        const [dx, dy] = this.delta(a, b);
        return dx !== 0 && dy !== 0;
    }

    // fn(клетка, nx, ny) для каждой клетки; nx, ny — координаты 0..1.
    eachTile(fn) {
        const size = this.size;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) fn(y * size + x, x / size, y / size);
        }
    }

    // fn(клетка) для квадрата радиуса radius вокруг клетки i (включая её саму).
    eachInSquare(i, radius, fn) {
        const size = this.size, x = i % size, y = Math.floor(i / size);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && ny >= 0 && nx < size && ny < size) fn(ny * size + nx);
            }
        }
    }

    markSquare(flags, i, radius) {
        this.eachInSquare(i, radius, j => { flags[j] = 1; });
    }

    // Слой шума по всей карте: значение в клетке — noise.fractal(nx * scale, ny * scale, octaves), при желании пропущенное через transform.
    noiseLayer(noise, scale, octaves = 3, transform = v => v) {
        const layer = new Float32Array(this.size * this.size);
        this.eachTile((i, nx, ny) => { layer[i] = transform(noise.fractal(nx * scale, ny * scale, octaves)); });
        return layer;
    }

    // Слой «плотности»: плавный шум, выровненный до равномерных значений 0..1 (порог 1 - share отбирает долю share карты).
    densityLayer(noise, scale, octaves = 3, transform) {
        return rankNormalize(this.noiseLayer(noise, scale, octaves, transform));
    }

    // Связные куски клеток (соседи по сторонам); клетки одного куска связывает same(кандидат, старт). Старты — по порядку (по умолчанию все клетки).
    // Обход в ширину; порядок добавления в очередь сохраняется, поэтому результат детерминирован.
    // Это генератор: куски отдаются по одному, и карту можно менять между ними.
    * components(same, starts = null) {
        const visited = new Uint8Array(this.size * this.size);
        const total = starts ? starts.length : visited.length;
        for (let k = 0; k < total; k++) {
            const start = starts ? starts[k] : k;
            if (visited[start] || !same(start, start)) continue;
            const queue = [start];
            visited[start] = 1;
            for (let head = 0; head < queue.length; head++) {
                for (const neighbor of this.neighbors(queue[head])) {
                    if (visited[neighbor] || !same(neighbor, start)) continue;
                    visited[neighbor] = 1;
                    queue.push(neighbor);
                }
            }
            yield queue;
        }
    }

    // Расстояние (в шагах волны) от ближайшего из sources; -1 — не дошли. accept(клетка) — можно ли в неё войти.
    // diagonal — идти ли ещё и по диагоналям; maxDistance — дальше не расходимся.
    distanceFrom(sources, { accept = () => true, diagonal = false, maxDistance = Infinity } = {}) {
        const distance = new Int16Array(this.size * this.size).fill(-1);
        const queue = Array.from(sources);
        for (const source of queue) distance[source] = 0;
        for (let head = 0; head < queue.length; head++) {
            const current = queue[head];
            if (distance[current] >= maxDistance) continue;
            for (const next of diagonal ? this.neighbors8(current) : this.neighbors(current)) {
                if (distance[next] !== -1 || !accept(next)) continue;
                distance[next] = distance[current] + 1;
                queue.push(next);
            }
        }
        return distance;
    }

    shuffled(list) {
        const copy = list.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(this.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    /* ---------- Публичный интерфейс: то, чем пользуются рендерер, painter и менеджеры. Логика — в подсистемах ---------- */

    applyTurnState(state) { MapGen.Turn.apply(this, state); }
    applyEconomyState(state) { MapGen.Economy.apply(this, state); }
    applyFactionState(state) { MapGen.Factions.apply(this, state); }

    // Подписки на новое состояние; каждая возвращает функцию отписки.
    onTurnState(listener) { return this.turnChannel.subscribe(listener); }
    onEconomyState(listener) { return this.economyChannel.subscribe(listener); }
    onFactionState(listener) { return this.factionChannel.subscribe(listener); }

    getTileInfo(x, y) { return MapGen.Info.tile(this, x, y); }
    getRegionInfo(regionId) { return MapGen.Info.region(this, regionId); }
    regionTileList(regionId) { return MapGen.Info.regionTiles(this, regionId); }
    regionGraph() { return MapGen.Info.graph(this); }

    get landShare() {
        return this.landTiles.length / (this.size * this.size);
    }

    get regionCount() {
        return Object.keys(this.regionSizes).length;
    }
}