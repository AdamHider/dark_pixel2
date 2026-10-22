/* ============================================================
   Реки и переправы
   ============================================================ */
{
    MapPaint.mixins.push({
        // Ширина реки в клетке по количеству воды: ручей — 2–3 пикселя, большая река у устья — до 14.
        riverWidthAt(i) {
            const flow = this.map.riverFlow[i];
            return Math.max(2, Math.min(this.px(14), Math.round((this.tileSize / 12) * (1 + 0.4 * Math.sqrt(flow)))));
        },

        /* Реки рисуем прямо в пиксели фона (а не поверх готовой картинки).
           Сначала строим маску: в каждом пикселе — уровень реки (1..3) или 0. Потом красим её жёстко, без растушёвки: вода
           доходит ровно до края маски, а снаружи — ровная линия берега. Чёткий контур читается лучше, чем размытая дизерингом кромка. */
        paintRivers() {
            const geometry = this.buildRiverGeometry();
            this.riverMask = geometry.riverOnly;                       // без декоративных концов: по ней считаются дороги, мосты и регионы
            if (geometry.riverTiles.length === 0) return;

            const { queue, distance, solid } = geometry;
            const { W } = this.dim;
            const pixels = this.pixels;
            const bankColors = new Map();                              // тёмный цвет берега считаем один раз на каждый цвет земли

            // Все реки — самой мелкой воды, цвета прибрежного мелководья (а не по глубине); зимой — лёд.
            const riverColor = tile => (this.seasonalTemperature(tile) < RIVER_ICE_TEMPERATURE ? this.packed.ice[0] : this.packed.waterShades[0]);

            for (const k of solid) pixels[k] = riverColor(this.tileOf(k));          // сердцевина реки — сплошной цвет
            for (const k of queue) {                                               // вода до самого края
                if (distance[k] > 0) pixels[k] = riverColor(this.tileOf(k));
            }

            // Берег: первый пиксель суши — ровная тёмная линия, второй — редкая галька или песок на пляжных и каменистых берегах.
            if (!this.options.shores) return;
            for (const k of queue) {
                if (distance[k] >= 0) continue;
                this.paintBankPixel(k % W, Math.floor(k / W), k, -distance[k], bankColors);
            }
        },

        /* Форма рек не зависит от сезона, поэтому считается один раз: маска (уровень реки в каждом пикселе), список
           пикселей кромки с расстоянием до края и список «сердцевины». Кэш сбрасывается при смене карты или параметров резкости. */
        buildRiverGeometry() {
            const o = this.options;
            const key = [this.tileSize, o.coastSharpness, o.blendSharpness, o.coastSmoothing, this.seedSalt, o.riverTails].join('|');
            return this.memo('river', [this.map.river, key], () => this.computeRiverGeometry());
        },

        computeRiverGeometry() {
            const map = this.map;
            const { size, W } = this.dim;
            const mask = new Uint8Array(W * W);

            const riverTiles = [];
            for (let i = 0; i < map.river.length; i++) {
                if (map.river[i] > 0) riverTiles.push(i);
            }
            if (riverTiles.length === 0) return { riverTiles, riverOnly: mask, queue: new Int32Array(0), distance: null, solid: new Int32Array(0) };

            // Кисть: круглое «перо» шириной width, которое красит в маске только сушу (не воду моря и озёр).
            const wobble = this.px(2);
            const centerOf = tile => this.tileCenter(tile % size, Math.floor(tile / size), 983, 984, wobble);
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

            this.stampRiverChannels(riverTiles, centerOf, stamp);
            const riverOnly = Uint8Array.from(mask);                                   // без декоративных концов
            const tailTiles = this.options.riverTails ? this.stampRiverTails(riverTiles, centerOf, stamp) : new Set();
            const { queue, distance, solid } = this.riverEdges(mask, [...riverTiles, ...tailTiles]);
            return { riverTiles, riverOnly, queue, distance, solid };
        },

        // 1) форма: каждая клетка реки соединена с клеткой, куда течёт вода (map.riverTo). Отрезок — слегка извилистая полоса,
        //    ширина которой плавно меняется от клетки к клетке по количеству воды (map.riverFlow); у устья река расширяется.
        stampRiverChannels(riverTiles, centerOf, stamp) {
            const map = this.map;
            for (const i of riverTiles) {
                const to = map.riverTo[i];
                if (to === -1) continue;
                const [ax, ay] = centerOf(i);
                let [bx, by] = centerOf(to);
                const toWater = !map.isLand(to);
                if (toWater) { bx = (ax + bx) / 2; by = (ay + by) / 2; }              // в море река заканчивается у берега
                const widthFrom = this.riverWidthAt(i);
                const widthTo = toWater ? Math.round(widthFrom * 1.4) : (map.river[to] > 0 ? this.riverWidthAt(to) : widthFrom);

                const points = this.curve(ax, ay, bx, by, length => (hashUnit(i, to, 985) - 0.5) * Math.min(this.px(5), length * 0.8));
                const level = map.river[i];
                points.forEach(([px, py], k) => stamp(px, py, widthFrom + (widthTo - widthFrom) * (k / Math.max(1, points.length - 1)), level));
            }
        },

        // 1б) истончающиеся концы: за истоком река продолжается в сушу, плавно сужаясь до нуля. Это только украшение: в
        //     riverOnly (по ней считаются дороги, мосты и регионы) концы не входят, в mask — входят (рисуются как река).
        //     Возвращает клетки, по которым прошли концы.
        stampRiverTails(riverTiles, centerOf, stamp) {
            const map = this.map;
            const { size, T, W } = this.dim;
            const tailTiles = new Set();
            const fed = new Uint8Array(size * size);                       // клетки, в которые впадает другая клетка реки
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
            return tailTiles;
        },

        // 2) расстояние до края реки: внутри — положительное, снаружи — отрицательное; ширина перехода из coastSharpness.
        //    Возвращает { queue (пиксели у края и волна от него), distance, solid (сердцевина реки) }.
        riverEdges(mask, tiles) {
            const map = this.map;
            const { size, T, W } = this.dim;
            const { DIRECTIONS_4 } = MapPaint;
            const edgeWidth = Math.max(2, T / this.options.coastSharpness);
            const reachPx = Math.ceil(edgeWidth / 2) + 1;
            const distance = new Int8Array(W * W);
            const queue = [];
            const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= W ? 0 : mask[yy * W + xx]);

            // Клетки, где может быть вода реки: сами реки и их соседи. Каждый пиксель — один раз.
            const zone = new Set();
            for (const i of tiles) {
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
                            queue.push(k);
                        } else if (mask[k] === 0 && around > 0) {
                            distance[k] = -1;                      // первый пиксель суши у воды
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
                for (const [dx, dy] of DIRECTIONS_4) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= W || ny >= W) continue;
                    const next = ny * W + nx;
                    if (distance[next] !== 0 || (mask[next] > 0) !== (sign > 0)) continue;
                    distance[next] = d + sign;
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

            return { queue: Int32Array.from(queue), distance, solid: Int32Array.from(solid) };
        },

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

            const { T } = this.dim;
            const type = this.map.shore[Math.floor(yy / T) * this.map.size + Math.floor(xx / T)];
            if ((type !== Shore.BEACH && type !== Shore.ROCKY && type !== Shore.CLIFF) || hashUnit(xx, yy, 631) >= 0.4) return;
            const c = this.colors;
            if (type === Shore.BEACH) pixels[k] = c.sand;
            else pixels[k] = hashUnit(xx, yy, 630) < 0.5 ? c.pebbleLight : c.pebbleDark;
        },

        /* Переправа: каменный мост (река глубже 1) или брод из камней (ручей).
           Мост состоит из «плеч»: от центра клетки к берегу в каждую сторону, куда идёт дорога. Прямая дорога даёт прямой мост,
           диагональная — диагональный, поворот — мост с изгибом. Если дороги нет (случайная переправа), мост кладётся поперёк
           течения — тоже по диагонали, если река течёт по диагонали. Длину плеча не угадываем по ширине реки, а меряем по
           самой нарисованной реке: идём от центра, пока пиксели воды или реки не кончатся, и добавляем немного суши за берегом,
           так что мост всегда опирается на землю с обеих сторон. */
        paintCrossing(x, y, i) {
            const map = this.map;
            const { T } = this.dim;
            const c = this.colors;
            const { W } = this.dim;

            // Центр реки в этой клетке — тот же, через который paintRivers проводит русло.
            const [centerX, centerY] = this.tileCenter(x, y, 983, 984, this.px(2));
            const cx = Math.round(centerX), cy = Math.round(centerY);

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
        },

        // В какие стороны идёт переправа от центра клетки (единичные векторы): по дороге, а без дороги — поперёк течения.
        crossingDirections(x, y, i) {
            const map = this.map;
            const { size } = this.dim;

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
    });
}
