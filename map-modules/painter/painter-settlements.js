/* ============================================================
   Дороги и поселения
   ============================================================ */
{
    MapPaint.mixins.push({
        roadWidth(level) {
            return Math.max(1, this.px([2, 3, 4][Math.min(3, Math.max(1, level)) - 1]));
        },

        /* Дороги строит генератор (map.roadLinks: из каждой клетки — в какие из 8 сторон идёт дорога, map.roadLevel — насколько
           она наезжена). Здесь каждый отрезок между центрами соседних клеток рисуется слегка извилистой полосой:
           центр клетки смещён случайно, середина отрезка тоже. Сначала мягкая полоса утоптанной земли, потом сама дорога. */
        paintRoads() {
            if (!this.options.roads || !this.map.roadLinks) return;

            const geometry = this.buildRoadGeometry();
            const kinds = this.dirtShades();
            const pixels = this.pixels;

            for (const k of geometry.halo) pixels[k] = mixPacked(pixels[k], kinds[0], 0.28);
            for (let n = 0; n < geometry.core.length; n++) {
                const k = geometry.core[n];
                let color = kinds[geometry.kind[n]];
                const snow = this.snowCoverage(this.tileOf(k));
                if (snow > 0) color = mixPacked(color, this.packed.snow, 0.75 * snow);
                pixels[k] = color;
            }
        },

        // Цвета грунта (земля, светлая земля, грязь) в текущем стиле.
        dirtShades() {
            const c = this.colors;
            return [this.moodize(c.dirt), this.moodize(c.dirtLight), this.moodize(c.mud)];
        },

        // Вид пикселя дороги и двора по хешу: 0 — земля, 1 — светлая, 2 — грязь.
        dirtKind(x, y) {
            const r = hashUnit(x, y, 975);
            return r < 0.2 ? 1 : r < 0.45 ? 2 : 0;
        },

        // Пиксели дорог (не зависят от сезона): мягкая полоса утоптанной земли и сама дорога с тремя оттенками.
        buildRoadGeometry() {
            const map = this.map;
            return this.memo('roads', [map.roadLinks, this.tileSize, this.seedSalt, this.riverMask], () => {
                const { size } = this.dim;
                const wobble = this.px(2);
                const halo = new Set();
                const core = new Map();

                const centerOf = (x, y) => this.tileCenter(x, y, 980, 981, wobble);
                const stamp = (cx, cy, width, isHalo) => this.eachFreeInSquare(cx, cy, width, (k, x, y) => {
                    if (isHalo) halo.add(k); else core.set(k, this.dirtKind(x, y));
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
                        const points = this.curve(ax, ay, bx, by, (hashUnit(i, j, 982) - 0.5) * wobble * 1.6);   // середина отрезка уходит в сторону
                        const width = this.roadWidth(Math.min(map.roadLevel[i], map.roadLevel[j]));
                        for (const [px, py] of points) stamp(px, py, width + 2, true);
                        for (const [px, py] of points) stamp(px, py, width, false);
                    }
                    if (count !== 2) stamp(Math.round(ax), Math.round(ay), this.roadWidth(map.roadLevel[i]) + 1, false);   // перекрёсток или конец дороги
                }
                for (const k of core.keys()) halo.delete(k);

                return { halo: Int32Array.from(halo), core: Int32Array.from(core.keys()), kind: Uint8Array.from(core.values()) };
            });
        },

        // Раскладка не зависит от сезона и считается один раз. Экономика меняет население и уровни на месте, поэтому раскладка
        // зависит ещё и от версии видимых изменений карты.
        settlementLayout(x, y, i) {
            const map = this.map;
            const layouts = this.memo('settlements', [map.population, this.tileSize, this.seedSalt, map.visualVersion], () => new Map());
            if (!layouts.has(i)) layouts.set(i, this.layoutSettlement(x, y, i));
            return layouts.get(i);
        },

        layoutSettlement(x, y, i) {
            const map = this.map;
            const o = this.options;
            const { T, W } = this.dim;
            const level = map.settlementLevel[i] || 1;
            const maxLevel = (map.options && map.options.settlementMaxLevel) || 4;
            const rnd = n => hashUnit(x, y, 1000 + n);
            const n = value => this.px1(value);

            // Сколько домиков: от settlementMinHouses (уровень 1) до settlementMaxHouses (высший уровень).
            const share = (level - 1) / Math.max(1, maxLevel - 1);
            const count = clamp(Math.round(o.settlementMinHouses + share * (o.settlementMaxHouses - o.settlementMinHouses)),
                o.settlementMinHouses, o.settlementMaxHouses);

            const left = x * T, top = y * T;
            const slack = Math.round(T * o.settlementOverflow);       // насколько основание дома может выйти за клетку
            const usable = (px, py) => px >= 0 && py >= 0 && px < W && py < W && this.isFree(py * W + px);
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

        // Утоптанная земля вокруг домов и улица между ними (на земле, до деревьев и границ).
        paintSettlementGround() {
            const map = this.map;
            if (!this.options.settlements || map.settlements.length === 0) return;

            const { size } = this.dim;
            const streetColors = this.dirtShades();
            const [dirt, , mud] = streetColors;
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
        },

        // Пиксели земли поселения (не зависят от сезона): пятна вокруг домов и улица. Считаются один раз для поселения.
        settlementGround(layout) {
            if (layout.ground) return layout.ground;

            const { W } = this.dim;
            const strengths = new Map();
            const mudPixels = new Set();

            for (const [bx, by, radius] of layout.blobs) {
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const distance = Math.hypot(dx, dy);
                        const px = Math.round(bx + dx), py = Math.round(by + dy);
                        if (distance > radius || px < 0 || py < 0 || px >= W || py >= W) continue;
                        const k = py * W + px;
                        if (!this.isFree(k) || hashUnit(px, py, 977) < 0.12) continue;
                        const strength = Math.round(255 * 0.55 * Math.pow(1 - distance / radius, 0.7));
                        if (strength > (strengths.get(k) || 0)) strengths.set(k, strength);
                        if (hashUnit(px, py, 978) < 0.3) mudPixels.add(k);
                    }
                }
            }

            const street = new Map();
            const [[ax, ay], [bx, by]] = layout.street;
            const width = this.px1(2);
            for (const [px, py] of this.linePoints(Math.round(ax), Math.round(ay), Math.round(bx), Math.round(by))) {
                this.eachFreeInSquare(px, py, width, (k, x, y) => street.set(k, this.dirtKind(x, y)));
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

        collectSettlement(items, x, y, i) {
            const layout = this.settlementLayout(x, y, i);
            const snow = this.snowCoverage(i);
            for (const part of layout.houses) {
                const sprite = this.houseSprite(part, part.roll, snow);
                items.push({ y: part.base, x: part.x, cover: true, draw: () => this.drawHouse(sprite, part.x, part.base, part, layout.level) });
            }
        },

        // Лёгкое приглушение цвета построек в тёмном стиле: они должны оставаться светлее фона.
        houseColor(color) {
            return this.mood === 'dark' ? shadePacked(mixPacked(color, packRgb(128, 128, 128), 0.1), -0.06) : color;
        },

        // Рисунок здания (кэшируется): стены, крыша, дверь, контур.
        houseSprite(part, roll, snow) {
            const key = [part.kind, part.w, part.bodyH, part.roofH, Math.floor(roll * 4), Math.round(snow * 3), this.mood, this.season.name].join('|');
            const c = this.colors;
            const tower = part.kind === 'tower';
            const pad = 1;
            const overhang = tower ? 0 : 1;
            const width = part.w + 2 * overhang + 2 * pad;
            const height = part.roofH + part.bodyH + 2 * pad;

            return this.sprite(key, width, height, c.outline, buffer => {
                const wall = this.houseColor(tower ? c.chapelStone : [c.wallA, c.wallB][Math.floor(roll * 2) % 2]);
                let roof = this.houseColor(part.kind === 'hut' ? c.thatch : tower ? c.roofD : [c.roofA, c.roofB, c.roofC, c.roofD][Math.floor(roll * 4) % 4]);
                if (snow > 0) roof = mixPacked(roof, this.packed.snow, 0.85 * snow);

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
        },

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
    });
}
