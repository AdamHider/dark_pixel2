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
