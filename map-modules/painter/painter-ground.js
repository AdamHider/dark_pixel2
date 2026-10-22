/* ============================================================
   Земля: фон, сглаживание берега, цвет клетки
   ============================================================ */
{
    MapPaint.mixins.push({
        /* Сглаживание.
           Считаем, что цвет клетки «живёт» в её центре. Любой пиксель лежит внутри квадрата, углы которого — центры
           четырёх ближайших клеток (A B / C D). Вес каждой клетки — как при билинейной интерполяции, но вместо
           смешивания цветов мы выбираем один из четырёх с помощью дизеринга. Получается пиксельный градиент:
           у выпуклого угла («ступеньки») пиксели плавно уходят в цвет соседей, а внутри однотонных областей ничего не меняется. */
        paintBase() {
            const { size, T, W } = this.dim;
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
                    if (!this.anyAround(tx, ty, j => colors[j] !== color)) {
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
        },

        /* Какой из четырёх цветов (A, B, C или D) получит пиксель, зависит только от его положения в клетке и
           от узора дизеринга, а не от самих цветов. Поэтому это считается заранее — по одной таблице на каждую
           «резкость» смешивания и каждый вариант сдвига узора (узор повторяется каждые 4 пикселя). */
        blendGrid() {
            return this.memo('blendGrid', [this.tileSize], () => {
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
                return { quadOf, u, v, cache: {} };
            });
        },

        // Три таблицы выбора (мягкая, береговая, «ближайший сосед») для клетки с данным сдвигом узора дизеринга.
        blendChoices(tx, ty) {
            const { T } = this.dim;
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
        },

        // Для каждого пикселя по одной оси: между центрами каких клеток он лежит и на каком расстоянии от первого.
        buildAxisTables() {
            const { size, W } = this.dim;
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
        },

        /* Скругление берега. Береговая линия из квадратных клеток и дизеринга — ступенчатая и «зашумлённая». Мажоритарный
           фильтр по маске воды (каждый пиксель становится водой или сушей — как большинство пикселей в окне радиуса
           coastSmoothing) убирает ступеньки и скругляет углы; чем больше радиус, тем круглее берег. 0 — выключить. */
        smoothCoast() {
            const { map, options } = this;
            const radius = options.coastSmoothing;
            if (!radius) return;

            // Форма берега от сезона не зависит: считается один раз, потом только копируем цвета и обновляем маску воды.
            const key = [this.tileSize, radius, options.blendSharpness, options.coastSharpness, this.seedSalt].join('|');
            const { changed, sources, mask } = this.memo('coast', [map.terrain, key], () => this.coastShape(radius));
            for (let n = 0; n < changed.length; n++) this.pixels[changed[n]] = this.pixels[sources[n]];
            this.waterMask.set(mask);
        },

        // Новая маска воды и список пикселей, которые «перешли» с воды на сушу или обратно (и с какого пикселя взять их цвет).
        coastShape(radius) {
            const map = this.map;
            const { size, T, W } = this.dim;
            const water = this.waterMask;
            const next = Uint8Array.from(water);
            const changed = [];
            const sources = [];

            const coastTiles = [];                          // клетки, рядом с которыми есть и вода, и суша
            this.forEachTile((tx, ty) => {
                if (this.anyAround(tx, ty, j => map.isLand(j)) && this.anyAround(tx, ty, j => !map.isLand(j))) coastTiles.push(ty * size + tx);
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
            return { mask: next, changed: Int32Array.from(changed), sources: Int32Array.from(sources) };
        },

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
        },

        // В режиме регионов реки не рисуются, но клетки рек в регионы не входят (regionId = -1): показываем их как воду.
        isRiverTileInRegionsView(i) {
            return this.view === 'regions' && this.map.regionId[i] < 0;
        },

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
        },

        // Вода темнее по мере удаления от берега — и в океане, и в озёрах. В холод у берега появляется лёд.
        waterColor(i) {
            const depth = this.map.waterDepth[i];
            const temperature = this.seasonalTemperature(i);

            if (this.view === 'terrain' && temperature < ICE_TEMPERATURE) {
                const freezeDepth = Math.round((ICE_TEMPERATURE - temperature) / ICE_TEMPERATURE * 10); // чем холоднее, тем дальше от берега лёд
                if (depth > 0 && depth <= freezeDepth) return this.packed.ice[depth <= 3 ? 0 : depth <= 6 ? 1 : 2];
            }
            return this.packed.waterShades[waterShadeIndex(depth)];
        },

        // Цвет земли: цвет биома в этом сезоне, с поправкой на плодородие, а в холод — с примесью снега.
        groundColor(i) {
            const base = this.packed.biome[this.map.biome[i]];
            if (this.view !== 'terrain') return base;

            const tinted = this.fertilityTint(i, base);
            const coverage = this.snowCoverage(i);
            return coverage > 0 ? mixPacked(tinted, this.packed.snow, 0.9 * coverage) : tinted;
        },

        // Доля снега на земле: 0, 1/3, 2/3 или 1 («пиксельные» ступени).
        snowCoverage(i) {
            return Math.round(clamp((SNOW_TEMPERATURE - this.seasonalTemperature(i)) / 0.16) * 3) / 3;
        },

        // Клетка рядом с рекой (считается один раз на карту).
        nearRiver(i) {
            const map = this.map;
            const near = this.memo('nearRiver', [map.river], () => {
                const flags = new Uint8Array(map.river.length);
                for (let k = 0; k < flags.length; k++) {
                    if (map.river[k] > 0) for (const j of map.neighbors8(k)) flags[j] = 1;
                }
                return flags;
            });
            return near[i];
        },

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
    });
}
