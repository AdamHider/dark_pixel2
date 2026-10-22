/* ============================================================
   Горы: карта высот, светотень, подъём «вверх» (рельеф рисуется строка за строкой вместе с декорациями)
   ============================================================ */
{
    const { bilinear } = MapPaint;

    MapPaint.mixins.push({
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
            return this.memo('relief', [map.mountainHeight, this.tileSize, sharp, detail, ragged], () => this.computeRelief(sharp, detail, ragged));
        },

        computeRelief(sharp, detail, ragged) {
            const { size, T, W } = this.dim;
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
            const smooth = this.blurHeights(height, zone, Math.max(2, this.px(5)));

            return { zone, height, smooth };
        },

        // Размытие карты высот (по строкам, потом по столбцам) только в клетках, где есть горы.
        blurHeights(height, zone, radius) {
            const { size, T, W } = this.dim;
            const window = 2 * radius + 1;
            const pass = (source, vertical) => {
                const result = new Uint8Array(W * W);
                for (const tile of zone) {
                    const x0 = (tile % size) * T, y0 = Math.floor(tile / size) * T;
                    for (let y = y0; y < y0 + T; y++) {
                        for (let x = x0; x < x0 + T; x++) {
                            let sum = 0;
                            for (let d = -radius; d <= radius; d++) {
                                const p = (vertical ? y : x) + d;
                                if (p >= 0 && p < W) sum += source[vertical ? p * W + x : y * W + p];
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
        prepareReliefRows() {
            if (!this.relief) return null;
            const { zone, height, smooth } = this.relief;
            if (zone.length === 0) return null;

            const { size, W } = this.dim;
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
        },

        // Одна строка карты высот -> экран. Горы поднимаются вверх на lift * высота; пустоты между строками
        // (южные склоны) закрашиваются цветом склона.
        paintReliefRow(relief, gy) {
            const { T, W, size } = this.dim;
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
        },

        fillColumn(gx, fromY, toY, color) {
            const { W } = this.dim;
            for (let y = Math.max(0, fromY); y <= toY; y++) this.pixels[y * W + gx] = color;
        },

        // Высоты клеток, дважды размытые по соседям: горы «набухают» за пределы своих клеток, а разброс высот
        // от клетки к клетке сглаживается (иначе на массиве проступает сетка).
        blurMountainHeights() {
            const { size } = this.dim;
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
        },

        // Клетки, занятые горами (1) и остальные (0): от этого зависит, докуда рельеф может доходить.
        mountainFootprint() {
            const mountainHeight = this.map.mountainHeight;
            const footprint = new Float32Array(mountainHeight.length);
            for (let i = 0; i < footprint.length; i++) footprint[i] = mountainHeight[i] > 0 ? 1 : 0;
            return footprint;
        },

        // Клетки, на которых может быть рельеф: сами горы и всё, что рядом.
        tilesNearRelief(blurred) {
            const { size } = this.dim;
            const zone = [];
            this.forEachTile((x, y) => {
                if (this.anyAround(x, y, j => blurred[j] > 0)) zone.push(y * size + x);
            });
            return zone;
        },

        // С какой относительной высоты лежит снег: чем холоднее (с учётом сезона), тем он ниже.
        snowLevel(tile) {
            const fraction = clamp((0.36 - this.seasonalTemperature(tile)) / 0.3);
            return 0.95 - fraction * 0.6;
        }
    });
}
