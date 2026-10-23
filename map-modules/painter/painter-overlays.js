/* ============================================================
   Слои поверх карты: границы регионов, ячейки и контуры (для выделения), сетка, территории фракций
   ============================================================ */
{
    MapPaint.mixins.push({
        // Чей пиксель: номер региона для каждого пикселя карты или -1 (вода, река, ничья земля).
        // Пиксель наследует регион своей клетки, но береговая линия скруглена и русла рек уже клетки, поэтому:
        //  - пиксели воды и реки не принадлежат никому (граница на них не рисуется);
        //  - клочки суши в клетках без региона (берег реки, выступ суши за краем клетки у моря) достаются ближайшему региону,
        //    чтобы граница дошла до самой воды и шла вдоль берега, а не обрывалась на краю клетки.
        // Результат не зависит от сезона — при смене сезона пересчитывать не нужно.
        buildPixelRegions() {
            const { map, options } = this;
            const key = [this.view, this.tileSize, options.coastSmoothing, options.regionBorderSmoothing].join('|');
            return this.memo('pixelRegions', [map.regionId, map.terrain, key, this.riverMask], () => this.computePixelRegions());
        },

        computePixelRegions() {
            const { size, regionId } = this.map;
            const { T, W } = this.dim;
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
            const pending = [];
            this.forEachTile((tx, ty) => {
                if (regionId[ty * size + tx] >= 0 || !this.anyAround(tx, ty, j => regionId[j] >= 0)) return;
                for (let oy = 0; oy < T; oy++) {
                    const row = (ty * T + oy) * W + tx * T;
                    for (let ox = 0; ox < T; ox++) {
                        const k = row + ox;
                        if (!water[k] && !(river && river[k])) pending.push(k);
                    }
                }
            });

            // Заливка слоями: за шаг пиксель получает регион большинства уже занятых соседей.
            this.spreadMajority(pending, T, owner, (k, j) => owner[j]);
            return this.smoothPixelRegions(owner);
        },

        /* Скругление границ регионов — тот же приём, что и у берега: мажоритарный фильтр. Каждый пиксель суши получает
           регион, которому принадлежит большинство пикселей суши в круге радиуса regionBorderSmoothing (при равенстве
           остаётся как был). Ступеньки по клеткам и прямые углы превращаются в плавные изгибы. Вода и реки не голосуют и
           не меняются, поэтому границы по-прежнему упираются в берег. Работаем только вблизи границ. */
        /* Сглаживание границ: каждый пиксель рядом с границей (в радиусе radius) переходит к региону, за который «голосует»
           большинство пикселей круга радиуса radius вокруг него (при равенстве остаётся свой, потом — кто встретился первым).
           Голосование идёт по снимку, чтобы результат не зависел от порядка обхода.
           Круг не пересчитывается заново для каждого пикселя: идя по строке, мы сдвигаем окно на пиксель (в каждой из строк круга
           одна точка добавляется, одна убирается). Результат тот же, что у прямого перебора (smoothPixelRegionsDirect), только в разы быстрее. */
        smoothPixelRegions(owner) {
            const radius = this.options.regionBorderSmoothing;
            if (!radius) return owner;
            const { W } = this.dim;
            const total = W * W;

            // круг: в строке dy точки от -half[dy] до +half[dy]
            const half = new Int32Array(2 * radius + 1);
            for (let dy = -radius; dy <= radius; dy++) {
                let h = 0;
                while ((h + 1) * (h + 1) + dy * dy <= radius * radius + 0.25) h++;
                half[dy + radius] = h;
            }

            // 1) пиксели рядом с границей (в радиусе radius)
            const near = new Uint8Array(total);
            const stamp = (cx, cy) => {
                for (let dy = -radius; dy <= radius; dy++) {
                    const y = cy + dy;
                    if (y < 0 || y >= W) continue;
                    const h = half[dy + radius];
                    near.fill(1, y * W + Math.max(0, cx - h), y * W + Math.min(W - 1, cx + h) + 1);   // пиксели вне регионов отсеем при голосовании
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

            // 2) голосование: окно (какие регионы и сколько пикселей каждого в круге)
            const result = Int16Array.from(owner);
            const MAX_DISTINCT = 16;                       // у прямого перебора больше 16 разных регионов в круге не учитываются
            let maxId = 0;
            for (let k = 0; k < total; k++) if (owner[k] > maxId) maxId = owner[k];
            const count = new Int32Array(maxId + 1);       // сколько пикселей региона в окне
            const active = new Int16Array((2 * radius + 1) * (2 * radius + 1) + 1);   // регионы, которые сейчас в окне
            let distinct = 0;
            const add = id => {
                if (count[id]++ === 0) active[distinct++] = id;
            };
            const remove = id => {
                if (--count[id] !== 0) return;
                for (let s = 0; s < distinct; s++) {         // регион ушёл из окна: на его место — последний
                    if (active[s] === id) { active[s] = active[--distinct]; return; }
                }
            };
            const fill = (x, y) => {                       // окно с нуля
                for (let s = 0; s < distinct; s++) count[active[s]] = 0;
                distinct = 0;
                for (let dy = -radius; dy <= radius; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= W) continue;
                    const h = half[dy + radius];
                    for (let nx = Math.max(0, x - h); nx <= Math.min(W - 1, x + h); nx++) {
                        const id = owner[ny * W + nx];
                        if (id >= 0) add(id);
                    }
                }
            };

            for (let y = 0; y < W; y++) {
                let inRun = false;
                for (let x = 0; x < W; x++) {
                    const k = y * W + x;
                    if (!near[k] || owner[k] < 0) { inRun = false; continue; }

                    if (!inRun) {
                        fill(x, y);
                        inRun = true;
                    } else {                               // окно сдвинулось с (x - 1) на x
                        for (let dy = -radius; dy <= radius; dy++) {
                            const ny = y + dy;
                            if (ny < 0 || ny >= W) continue;
                            const h = half[dy + radius];
                            const gone = x - 1 - h, came = x + h;
                            const left = gone >= 0 ? owner[ny * W + gone] : -1;
                            const right = came < W ? owner[ny * W + came] : -1;
                            if (left === right) continue;    // ушёл и пришёл один регион (или оба «пустые»): окно не изменилось
                            if (left >= 0) remove(left);
                            if (right >= 0) add(right);
                        }
                    }

                    // победитель: регион с наибольшим числом пикселей (строго больше, чем у своего)
                    const own = owner[k];
                    const ownVotes = count[own];
                    let top = 0, topId = 0, leaders = 0;
                    for (let s = 0; s < distinct; s++) {
                        const votes = count[active[s]];
                        if (votes > top) { top = votes; topId = active[s]; leaders = 1; } else if (votes === top) leaders++;
                    }
                    if (distinct > MAX_DISTINCT || (top > ownVotes && leaders > 1)) {
                        // редкие случаи (много регионов или ничья): порядок «кто встретился первым» знает только прямой перебор
                        result[k] = this.voteDirect(owner, x, y, radius, half);
                    } else {
                        result[k] = top > ownVotes ? topId : own;
                    }
                }
            }
            return result;
        },

        // Прямое голосование по кругу для одного пикселя: так считает smoothPixelRegionsDirect. Нужно для ничьих и «толпы» регионов.
        voteDirect(owner, x, y, radius, half) {
            const { W } = this.dim;
            const ids = new Int16Array(16), votes = new Int32Array(16);
            const own = owner[y * W + x];
            let distinct = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                const ny = y + dy;
                if (ny < 0 || ny >= W) continue;
                const h = half[dy + radius];
                for (let dx = -h; dx <= h; dx++) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= W) continue;
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
            }
            let ownVotes = 0;
            for (let s = 0; s < distinct; s++) if (ids[s] === own) ownVotes = votes[s];
            let best = own, bestVotes = ownVotes;
            for (let s = 0; s < distinct; s++) {
                if (votes[s] > bestVotes) { best = ids[s]; bestVotes = votes[s]; }
            }
            return best;
        },

        smoothPixelRegionsDirect(owner) {
            const radius = this.options.regionBorderSmoothing;
            if (!radius) return owner;
            const { W } = this.dim;
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
        },

        // Тонкая линия там, где соседние пиксели принадлежат разным регионам. Воды и рек в регионах нет, поэтому граница
        // доходит до берега и дальше не идёт; в горах делаем её бледнее.
        paintRegionBorders() {
            const { W } = this.dim;
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

                const alpha = relief ? 0.6 - 0.5 * Math.min(1, relief[k] / 110) : 0.6; // в горах границы почти растворяются
                this.pixels[k] = mixPacked(this.pixels[k], color, alpha);
            }
        },

        /* Контур области пикселей: замкнутые ломаные в пикселях карты (координаты — углы пикселей). inside(x, y) говорит,
           входит ли пиксель в область; ищем её только в рамке x0..x1, y0..y1. Обход по часовой стрелке, внутри — справа.
           Потом углы скругляются срезанием углов Чайкина (smoothing раз). Если keepCorners > 0, вершины, примыкающие к прямому
           отрезку длиннее keepCorners пикселей, остаются острыми: прямые линии (например, линии сетки) и их углы не округляются,
           сглаживаются только мелкие ступеньки. Контуров несколько, если у области есть отдельные куски или дыры. */
        traceOutline(inside, x0, y0, x1, y1, smoothing, keepCorners = 0) {
            const { W } = this.dim;
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
        },

        /* Контур региона для выделения по клику: из той же скруглённой попиксельной карты регионов, на которой стоят границы
           (buildPixelRegions), поэтому обводка в точности повторяет видимую форму региона, а не его клетки.
           Вызывать после paint(). Если карта ещё не нарисована, возвращает null. */
        regionOutline(regionId, smoothing = 3) {
            if (!this.waterMask) return null;
            const owner = this.buildPixelRegions();
            const { size, regionId: ids } = this.map;
            const { T, W } = this.dim;

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
        },

        /* Ячейки: на какую клетку карты «работает» каждый пиксель (Int32Array, индекс клетки или -1).
           Внутри региона ячейка — обычный квадрат клетки. У берега, рек и границ регионов она подгоняется под форму региона:
           пиксель принадлежит ячейке своей клетки, только если клетка того же региона; пиксели, которые сглаженная граница
           или берег реки увели в чужую клетку (или в воду), достаются ближайшей ячейке того же региона. Вода и реки делятся на
           обычные квадраты своих клеток. Так регион (и вся карта) разбиты на непересекающиеся ячейки, а по логике это всё те
           же клетки. */
        buildCellMap() {
            const owner = this.buildPixelRegions();
            return this.memo('cellMap', [owner], () => {
                const { size, regionId } = this.map;
                const { T, W } = this.dim;
                const cellOf = new Int32Array(W * W).fill(-1);
                const pending = [];
                this.forEachTile((tx, ty) => {
                    const tile = ty * size + tx, own = regionId[tile];
                    for (let oy = 0; oy < T; oy++) {
                        const row = (ty * T + oy) * W + tx * T;
                        for (let ox = 0; ox < T; ox++) {
                            const k = row + ox, id = owner[k];
                            if (id >= 0 ? id === own : own < 0) cellOf[k] = tile;   // пиксель на «своём» месте
                            else pending.push(k);
                        }
                    }
                });

                // Чужие пиксели заливаем слоями от своих: берём ячейку большинства соседей с тем же регионом (или водой).
                const rest = this.spreadMajority(pending, 2 * T, cellOf, (k, j) => (owner[j] === owner[k] ? cellOf[j] : -1));
                for (const k of rest) cellOf[k] = this.tileOf(k);   // запасной вариант
                return cellOf;
            });
        },

        // Ячейка в точке мира (пиксели карты): индекс клетки или -1. После paint().
        cellAt(worldX, worldY) {
            if (!this.waterMask) return -1;
            const { W } = this.dim;
            const x = Math.floor(worldX), y = Math.floor(worldY);
            if (x < 0 || y < 0 || x >= W || y >= W) return -1;
            return this.buildCellMap()[y * W + x];
        },

        /* Контур ячейки клетки tile (индекс): замкнутые ломаные в пикселях карты или null, если карта не нарисована.
           Прямые участки (линии сетки длиннее keepCorners пикселей) и их углы остаются строго прямыми, а ступеньки вдоль воды и
           границ сглаживаются. keepCorners = 0 — скруглять всё, smoothing = 0 — точная форма по пикселям. */
        cellOutline(tile, smoothing = 2, keepCorners = 5) {
            if (!this.waterMask) return null;
            const cellOf = this.buildCellMap();
            const { size } = this.map;
            const { T, W } = this.dim;
            const tx = tile % size, ty = Math.floor(tile / size);
            const x0 = Math.max(0, (tx - 1) * T), y0 = Math.max(0, (ty - 1) * T);
            const x1 = Math.min(W, (tx + 2) * T), y1 = Math.min(W, (ty + 2) * T);
            const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < W && cellOf[y * W + x] === tile;
            return this.traceOutline(inside, x0, y0, x1, y1, smoothing, keepCorners);
        },

        /* Сетка клеток: прозрачный холст с линиями между соседними ячейками одного региона (и внутри воды). Границы между
           регионами не дублируем — они уже нарисованы на карте. Цвет линии подбирается по тому, что под ней: светлая линия на тёмном,
           тёмная на светлом. Рисуется отдельным слоем, поэтому включать и выключать сетку можно без перерисовки карты.
           Вызывать после paint(). */
        paintGrid() {
            const owner = this.buildPixelRegions();
            const cellOf = this.buildCellMap();
            const { W } = this.dim;
            const layer = this.createLayer();
            const lines = layer.pixels;
            const base = this.pixels;
            const alpha = Math.round(255 * this.options.gridOpacity);
            const light = (255 << 16 | 255 << 8 | 255) | (alpha << 24);   // RGBA в порядке байтов r, g, b, a (little-endian)
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
            return layer.commit();
        },

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
        },

        // Клетка -> номер территории в списке (-1 — ничья). Территория задаётся клетками (tiles) и/или регионами (regions).
        tileTerritories(territories) {
            const map = this.map;
            const { size } = this.dim;
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
            return tileTerritory;
        },

        /* Толщина границы по пикселям территории: 1 — самый край, дальше внутрь до maxWidth. Граница — пиксели территории, рядом с
           которыми (по стороне) земля другой территории или ничья. У реки смотрим через русло на противоположный берег: граница
           есть, только если там уже другая территория (река внутри территории её не режет). */
        territoryBorderDepth(pixelTerritory, owner, maxWidth) {
            const { W } = this.dim;
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
            return depth;
        },

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
            const { T, W } = this.dim;
            const owner = this.buildPixelRegions();
            const cellOf = this.buildCellMap();
            const tileTerritory = this.tileTerritories(territories);

            // пиксель -> номер территории (только земля; воду и реки не красим)
            const pixelTerritory = new Int16Array(W * W).fill(-1);
            for (let k = 0; k < pixelTerritory.length; k++) {
                if (owner[k] >= 0 && cellOf[k] >= 0) pixelTerritory[k] = tileTerritory[cellOf[k]];
            }

            const widths = territories.map(t => Math.max(1, Math.round((t.border ?? this.options.factionBorder) * T / 16)));
            const depth = this.territoryBorderDepth(pixelTerritory, owner, Math.max(1, ...widths));

            const layer = this.createLayer();
            const pixels = layer.pixels;
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
            return layer.commit();
        }
    });
}
