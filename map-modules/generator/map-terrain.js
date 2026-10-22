/* ============================================================
   Рельеф: высота, острова, горы, суша и вода
   ============================================================ */
{
    MapGen.mixins.push({
        // Шум + падение к краям (вода вокруг) + хребты.
        generateElevation() {
            const { noise, options: o } = this;
            let wx, wy;
            const sample = (name, scale, octaves) => noise[name].fractal(wx * scale, wy * scale, octaves);

            this.eachTile((i, nx, ny) => {
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

                this.elevation[i] = height;
                this.ridge[i] = ridge;
                this.massif[i] = sample('massif', o.massifScale, 3);
            });
        },

        // Острова: в полосе мелководья вокруг материка отдельные «горбы» шума поднимаем над уровнем моря.
        scatterIslands() {
            const o = this.options;
            if (o.islandDensity <= 0) return;

            const estimatedSea = percentile(this.elevation, o.waterShare);
            const threshold = 0.72 - 0.16 * o.islandDensity; // выше плотность — ниже порог — больше островов
            this.eachTile((i, nx, ny) => {
                const belowSea = estimatedSea - this.elevation[i];
                if (belowSea <= 0 || belowSea > 0.15) return; // только полоса моря недалеко от «почти суши»

                const bump = this.noise.islands.fractal(nx * o.islandScale, ny * o.islandScale, 2);
                if (bump > threshold) this.elevation[i] = estimatedSea + 0.01 + (bump - threshold) * 0.5;
            });
        },

        // Выравниваем до равномерных 0..1: порог 0.4 в биомах честно значит «самые сухие 40%».
        generateMoisture() {
            this.moisture = this.densityLayer(this.noise.moisture, this.options.moistureScale, 4);
        },

        // Пороги считаем по долям, а не по абсолютным числам: так соотношение воды и гор не зависит от настроек шума.
        classifyTerrain() {
            const { waterShare, mountainShare, mountainClustering: clustering } = this.options;
            this.seaLevel = percentile(this.elevation, waterShare);

            // Горы = «хребтовость» (тонкие линии) + «массивность» (крупные пятна) + чуть высоты.
            // Одни хребты дают тонкие змейки; массивы собирают их в кучи, а между грядами остаются ущелья.
            const landIndices = [];
            for (let i = 0; i < this.elevation.length; i++) {
                if (this.elevation[i] > this.seaLevel) landIndices.push(i);
            }
            const rankOnLand = values => rankNormalize(Float32Array.from(landIndices, i => values[i]));
            const ridgeRank = rankOnLand(this.ridge), massifRank = rankOnLand(this.massif), heightRank = rankOnLand(this.elevation);

            const scores = landIndices.map((_, k) =>
                0.85 * ((1 - clustering) * ridgeRank[k] + clustering * massifRank[k]) + 0.15 * heightRank[k]);
            this.mountainLevel = percentile(scores, 1 - mountainShare);
            const maxScore = scores.reduce((a, b) => Math.max(a, b), this.mountainLevel);

            this.terrain.fill(Terrain.DEEP_WATER);
            landIndices.forEach((i, k) => {
                const isMountain = scores[k] > this.mountainLevel;
                this.terrain[i] = isMountain ? Terrain.MOUNTAIN : Terrain.PLAIN;
                // Высота горы растёт к «хребтовым» и «массивным» клеткам: по ней рисуется рельеф (хребты выше, края ниже).
                if (isMountain) this.mountainHeight[i] = 0.3 + 0.7 * (scores[k] - this.mountainLevel) / (maxScore - this.mountainLevel);
            });
        },

        // Одиночная «гора» на равнине выглядит нелепо: горы должны занимать не меньше minMountainSize клеток.
        removeSmallMountains() {
            const isMountain = i => this.terrain[i] === Terrain.MOUNTAIN;
            for (const mountain of this.components(isMountain)) {
                if (mountain.length >= this.options.minMountainSize) continue;
                for (const i of mountain) {
                    this.terrain[i] = Terrain.PLAIN;
                    this.mountainHeight[i] = 0;
                }
            }
        },

        // Шум порождает одиночные клетки и крошечные островки, особенно посреди озёр. Убираем всё, что меньше minIslandSize.
        removeSmallIslands() {
            for (const island of this.components(i => this.isLand(i))) {
                if (island.length >= this.options.minIslandSize) continue;
                for (const i of island) {
                    this.terrain[i] = Terrain.DEEP_WATER;
                    this.elevation[i] = Math.min(this.elevation[i], this.seaLevel);
                    this.mountainHeight[i] = 0;
                }
            }
        },

        collectLandTiles() {
            this.landTiles = [];
            for (let i = 0; i < this.terrain.length; i++) {
                if (this.isLand(i)) this.landTiles.push(i);
            }
        },

        // Глубина воды = расстояние до ближайшей суши (в клетках). Работает и для океана, и для озёр:
        // у берега мелко, к середине водоёма всё глубже. Мелководье — узкая полоса у берега, остальное — глубокая вода.
        computeWaterDepth() {
            const distance = this.distanceFrom(this.landTiles, { accept: i => !this.isLand(i), diagonal: true });
            for (let i = 0; i < this.terrain.length; i++) {
                if (this.isLand(i)) continue;
                const depth = Math.min(255, Math.max(0, distance[i]));
                this.waterDepth[i] = depth;
                this.terrain[i] = depth > 0 && depth <= this.options.shallowWaterDistance ? Terrain.SHALLOW_WATER : Terrain.DEEP_WATER;
            }
        },

        // 1 для гор и для суши не дальше distance клеток от гор (предгорья).
        tilesNearMountains(distance) {
            const mountains = this.landTiles.filter(i => this.terrain[i] === Terrain.MOUNTAIN);
            const reach = this.distanceFrom(mountains, { accept: i => this.isLand(i), maxDistance: distance });
            return Uint8Array.from(reach, d => (d >= 0 ? 1 : 0));
        }
    });
}

/* ============================================================
   Климат и биомы
   ============================================================ */
{
    MapGen.mixins.push({
        // Север (y = 0) холодный, юг (y = size) жаркий; шум добавляет разнообразия, высота охлаждает.
        generateTemperature() {
            const o = this.options;
            this.eachTile((i, nx, latitude) => {
                const noise = this.noise.temperature.fractal(nx * o.temperatureScale, latitude * o.temperatureScale, 3);
                const altitude = Math.max(0, this.elevation[i] - this.seaLevel);
                this.temperature[i] = clamp(latitude * 0.9 + 0.05 + (noise - 0.5) * o.temperatureNoise - altitude * o.altitudeCooling);
            });
        },

        assignBiomes() {
            for (const i of this.landTiles) {
                if (this.terrain[i] === Terrain.PLAIN) this.biome[i] = this.pickBiome(this.temperature[i], this.moisture[i]);
            }
        },

        pickBiome(temperature, moisture) {
            const dry = this.options.aridity; // клетки суше этого порога — степь или пустыня
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
    });
}

/* ============================================================
   Ресурсы и берега
   ============================================================ */
{
    const { isGrowing } = MapGen;
    MapGen.mixins.push({
        // Лес и поля: крупные массивы + мелкие рощи, только на равнине и в подходящем климате.
        placeResources() {
            const o = this.options;
            const forest = this.createPatchLayer(this.noise.forest, o.forestScale, o.forestShare, this.noise.forestClumps, o.clumpScale, o.forestClumpShare);
            const fields = this.createPatchLayer(this.noise.fertility, o.wheatScale, o.wheatShare, this.noise.fertilityClumps, o.clumpScale, o.wheatClumpShare);

            for (const i of this.landTiles) {
                if (this.terrain[i] !== Terrain.PLAIN) continue;

                const t = this.temperature[i], m = this.moisture[i];
                const roll = this.random();
                const goodForWood = forest[i] && m > 0.3 && t > 0.12 && t < 0.8;
                const goodForWheat = fields[i] && m > 0.1 && m < 0.9 && t > 0.18 && t < 0.85;

                if (goodForWood && roll < o.woodChance) this.resource[i] = Resource.WOOD;
                else if (goodForWheat && roll < o.wheatChance) this.resource[i] = Resource.WHEAT;
            }
        },

        // «Пятна» ресурса: крупные скопления плюс мелкие разрозненные кучки. Вместе дают хаотичное, но не пустое распределение.
        createPatchLayer(bigNoise, bigScale, bigShare, smallNoise, smallScale, smallShare) {
            const big = this.densityLayer(bigNoise, bigScale);
            const small = this.densityLayer(smallNoise, smallScale);
            return Uint8Array.from(big, (value, i) => (value > 1 - bigShare || small[i] > 1 - smallShare ? 1 : 0));
        },

        placeRareResources() {
            const o = this.options;
            const foothills = this.tilesNearMountains(o.foothillDistance);
            const inFoothills = i => foothills[i] && !this.river[i];                 // руда — в горах и предгорьях, не на реках
            const oreChance = chance => i => (this.terrain[i] === Terrain.MOUNTAIN ? chance : chance * 0.5);   // в предгорьях вдвое реже

            // Золото — редкое, скоплениями; перекрывает лес и поля.
            this.placeVein(Resource.GOLD, this.densityLayer(this.noise.ore, o.goldScale), o.goldShare, oreChance(o.goldChance),
                { eligible: inFoothills });
            // Железо — там же, но другие скопления и заметно чаще; золото не вытесняет.
            this.placeVein(Resource.IRON, this.densityLayer(this.noise.iron, o.ironScale), o.ironShare, oreChance(o.ironChance),
                { eligible: inFoothills, canReplace: current => current !== Resource.GOLD });
            // Эфир (гигантские фиолетовые кристаллы и грибы) растёт вдоль «линий разлома» — тонких извилистых полос шума, с разрывами.
            // Линии: максимум там, где шум пересекает 0.5.
            const faults = this.densityLayer(this.noise.fault, o.faultScale, 3, n => 1 - Math.abs(2 * n - 1));
            this.placeVein(Resource.ETHER, faults, o.etherShare, () => o.etherChance,
                { eligible: i => !this.river[i], canReplace: current => current === Resource.NONE });
        },

        // Кладёт ресурс в клетки, где слой density попал в верхнюю долю share, с шансом chanceOf(клетка).
        // eligible(клетка) — можно ли вообще; canReplace(текущий ресурс) — можно ли вытеснить то, что уже лежит.
        placeVein(resource, density, share, chanceOf, { eligible = () => true, canReplace = () => true } = {}) {
            for (const i of this.landTiles) {
                if (!eligible(i) || !canReplace(this.resource[i])) continue;
                if (density[i] > 1 - share && this.random() < chanceOf(i)) this.resource[i] = resource;
            }
        },

        // Тип берега для суши рядом с морем, озером или рекой: пляж, каменистый берег или утёс.
        // Горы у воды — всегда утёсы; низкие тёплые берега — пляжи (пятнами); остальное — камни.
        classifyShores() {
            const o = this.options;
            const coastal = this.landTiles.filter(i =>
                this.river[i] > 0
                || this.neighbors8(i).some(j => !this.isLand(j))
                || this.neighbors(i).some(j => this.river[j] > 0));
            if (coastal.length === 0) return;

            const heightRank = rankNormalize(Float32Array.from(coastal, i => this.elevation[i] - this.seaLevel));
            const clusters = this.densityLayer(this.noise.shore, o.shoreScale);
            const nearMountains = this.tilesNearMountains(2);

            coastal.forEach((i, k) => {
                const warmEnough = this.temperature[i] > 0.2;
                if (nearMountains[i] || heightRank[k] > 1 - o.cliffShare) this.shore[i] = Shore.CLIFF;
                else if (warmEnough && heightRank[k] < 0.65 && clusters[i] > 1 - o.beachShare) this.shore[i] = Shore.BEACH;
                else this.shore[i] = Shore.ROCKY;
            });
        },

        // На дорогах нет ресурсов, леса и полей: дорога проложена через клетку, значит, она расчищена. Клетки поселений остаются.
        clearRoadResources() {
            for (let i = 0; i < this.resource.length; i++) {
                if (this.roadLevel[i] > 0 && this.resource[i] !== Resource.SETTLEMENT) this.resource[i] = Resource.NONE;
            }
        },

        // Изначально леса и поля полностью выросли (степень роста 1); дальше её меняет экономика.
        initGrowth() {
            this.growth.fill(0);
            for (let i = 0; i < this.resource.length; i++) {
                if (isGrowing(this.resource[i])) this.growth[i] = 1;
            }
        }
    });
}
