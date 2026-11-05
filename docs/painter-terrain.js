/* ============================================================
   Рельеф равнин и берегов: холмы и овраги, берега, текстура и трава
   ============================================================ */
{
    const { bilinear } = MapPaint;

    MapPaint.mixins.push({
        /* На равнинах — лёгкая светотень «карты холмов» (свет слева сверху, как у гор и деревьев) плюс тёмные овраги
           в сухих местах. Карта холмов — шум плюс крупный рельеф суши из генератора; считается один раз на карту. */
        paintHills() {
            const o = this.options;
            if (o.hillStrength <= 0 && o.ravineDensity <= 0) return;

            const key = `${this.tileSize}|${o.hillStrength}|${o.ravineDensity}`;
            applyHillShading(this.pixels, this.memo('hillShading', [this.map.elevation, key], () => this.computeHills()));
        },

        computeHills() {
            const o = this.options;
            const map = this.map;
            const { size, T, W } = this.dim;
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
                hills: this.buildHillHeights(), waterMask: this.waterMask, flags, tileOfColumn,
                width: W, tile: T, strength: o.hillStrength,
                ravineWidth: 0.012 + 0.03 * o.ravineDensity,
                valleyNoise: new LatticeNoise(W, Math.max(6, this.px(22)), 611 + this.seedSalt),
                capacity: eligible * T * T
            });
        },

        // Карта холмов по пикселям (0..255). От сезона не зависит, поэтому кэшируется.
        buildHillHeights() {
            const map = this.map;
            return this.memo('hillHeights', [map.elevation, this.tileSize], () => {
                const { size, T, W } = this.dim;
                const height = new Uint8Array(W * W);
                const { first, second, fraction } = this.axis;
                const broad = new LatticeNoise(W, Math.max(6, this.px(20)), 601 + this.seedSalt);
                const landHeight = new Float32Array(size * size);
                for (let i = 0; i < landHeight.length; i++) landHeight[i] = clamp((map.elevation[i] - map.seaLevel) / 0.5);

                this.forEachTile((tx, ty) => {
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
        },

        /* Тип берега задаёт генератор (map.shore). Расстояние от воды считаем в пикселях: волной от воды вглубь суши.
             пляж     — полоса мокрого, потом сухого песка; в воде у берега белая пена;
             каменистый — галька и камни, пена послабее;
             утёс     — суша приподнята над водой: под её краем видна каменная стенка (на юге) и тень на воде.
           Форма берега (какой пиксель какого вида, где пена) от сезона не зависит и считается один раз; при смене сезона
           остаётся только перекраска. */
        paintShores() {
            if (!this.options.shores) return;

            const geometry = this.buildShoreGeometry();
            this.colorShoreLand(geometry);
            this.paintFoam(geometry);
            this.paintCliffs(geometry.queue, geometry.distance, geometry.kind);
        },

        buildShoreGeometry() {
            const map = this.map;
            const key = [this.tileSize, this.options.coastSharpness, this.waterKey].join('|');
            return this.memo('shores', [map.shore, map.river, map.terrain, key], () => this.computeShoreGeometry());
        },

        computeShoreGeometry() {
            const map = this.map;
            const { size, T, W } = this.dim;
            const waterMask = this.waterMask;
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
                    if (!this.anyAround(tx, ty, j => typedTile(j % size, Math.floor(j / size)))) continue;
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
                tiles[n] = this.tileOf(k);
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
            const foamTiles = Int32Array.from(foamPixels, k => this.tileOf(k));

            return { queue: Int32Array.from(queue), distance, kind, tiles, phase, variant, wet, reach, foamPixels: Int32Array.from(foamPixels), foamTiles };
        },

        // 3) покраска суши
        colorShoreLand({ queue, distance, kind, tiles, phase, variant, wet, reach }) {
            const pixels = this.pixels;
            const c = this.colors;
            const snowColor = this.packed.snow;

            for (let n = 0; n < queue.length; n++) {
                const k = queue[n];
                const d = distance[k];
                const type = kind[k];
                const threshold = BAYER[phase[n]];
                let color = 0;

                if (type === Shore.BEACH) {
                    if (d <= wet) color = c.wetSand;
                    else if (threshold < 1 - (d - wet) / (reach - wet + 1)) color = variant[n] ? c.wetSand : c.sand;
                    if (color !== 0) {
                        const snow = this.snowCoverage(tiles[n]);
                        if (snow > 0) color = mixPacked(color, snowColor, 0.9 * snow);
                    }
                } else if (type === Shore.ROCKY) {
                    if (threshold < 1 - (d - 1) / (reach + 1)) {
                        color = variant[n] === 0 ? c.pebbleLight : variant[n] === 1 ? c.pebbleDark : mixPacked(pixels[k], c.stoneMid, 0.6);
                    }
                } else if (type === Shore.CLIFF) {
                    if (d <= 3 && threshold < 0.7) color = shadePacked(pixels[k], -0.2);
                }
                if (color !== 0) pixels[k] = color;
            }
        },

        // 4) пена на воде у пляжей и каменистых берегов (если вода не замёрзла)
        paintFoam({ foamPixels, foamTiles }) {
            const pixels = this.pixels;
            for (let n = 0; n < foamPixels.length; n++) {
                if (this.seasonalTemperature(foamTiles[n]) < ICE_TEMPERATURE) continue;
                const k = foamPixels[n];
                pixels[k] = mixPacked(pixels[k], WHITE, 0.16);
            }
        },

        // Утёсы: суша «приподнята» — под её южным краем стенка из камня, под ней тень на воде. Идём по тем же пикселям берега,
        // что и полоса берега (а не по клеткам), поэтому сглаженная береговая линия не рвёт обрыв на куски.
        paintCliffs(queue, distance, kind) {
            const { W } = this.dim;
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
        },

        paintTexture() {
            const map = this.map;
            const { T } = this.dim;
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
        },

        // Расположение крапинок: одинаково при любом сезоне и виде, поэтому считается один раз на карту.
        speckLayout(speckCount) {
            const { size, T } = this.dim;
            return this.memo('specks', [size, T, this.seedSalt], () => {
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
        paintGroundDetail(x, y, i) {
            const colors = this.pal.groundDetail;
            const map = this.map;
            if (!colors || map.terrain[i] !== Terrain.PLAIN || map.biome[i] !== Biome.GRASSLAND || map.river[i] || map.resource[i] === Resource.SETTLEMENT || map.roadLevel[i] > 0) return;
            if (tileHash(x, y, 100) % 3 !== 0) return;

            const { T } = this.dim;
            for (let k = 0; k < 3; k++) {
                const h = tileHash(x, y, 101 + k);
                this.put(x * T + (h % T), y * T + ((h >>> 8) % T), hexToPacked(colors[h % colors.length]));
            }
        },

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

            const { T, W } = this.dim;
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
    });
}
