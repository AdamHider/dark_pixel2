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
