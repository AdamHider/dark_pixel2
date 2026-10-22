/* ============================================================
   Регионы

   Регион — связный кусок суши БЕЗ рек (как и без моря с озёрами). Реки при этом остаются границами: регион не может
   перешагнуть русло, в том числе по диагонали.

   Как строим: (1) раскладываем «семена» по каждому массиву суши пропорционально его площади; (2) делим землю между
   семенами по «стоимости пути» (горы дороже, шум чуть искажает границы); (3) несколько раз двигаем каждое семя в центр
   своего региона и делим заново (релаксация Ллойда) — именно она превращает случайные клочки в ровные, почти
   шестиугольные области; (4) чиним обрывки, вливаем мелочь, выравниваем размеры и сглаживаем границы.
   ============================================================ */
{
    const { tally, topKey, hash01 } = MapGen;
    MapGen.mixins.push({
        buildRegions() {
            const o = this.options;

            this.regionId.fill(-1);
            this.regionMask = new Uint8Array(this.size * this.size); // 1 — клетка может входить в регион (суша без реки)
            this.regionTiles = [];
            for (const i of this.landTiles) {
                if (this.river[i]) continue;
                this.regionMask[i] = 1;
                this.regionTiles.push(i);
            }
            this.regionSizes = {};
            if (this.regionTiles.length === 0) return;

            this.regionCost = this.buildRegionCosts();
            const averageSize = (o.regionMinSize + o.regionMaxSize) / 2;

            let seeds = [];
            for (const area of this.components(i => this.regionMask[i], this.regionTiles)) {
                // Остров, который одним регионом вышел бы заметно больше максимума, делим на несколько (соседям такой остров не отдашь).
                const seedCount = Math.max(1, Math.round(area.length / averageSize), Math.ceil(area.length / (o.regionMaxSize * 1.2)));
                seeds.push(...this.pickRegionSeeds(area, seedCount));
            }
            this.nextRegionId = seeds.length;

            for (let pass = 0; pass < o.regionRelaxPasses; pass++) {
                this.assignRegions(seeds);
                seeds = this.relaxRegionSeeds(seeds);
            }
            this.assignRegions(seeds);

            this.repairRegionConnectivity();
            this.repairRegionConnectivity();
            this.countRegionSizes();
            this.mergeSmallRegions();
            this.balanceRegionSizes();            // выравниваем размеры (излишек перетекает к мелким соседям)
            this.smoothRegionBorders();           // убираем зубцы и отростки, почти не выходя за [min, max]
            this.balanceRegionSizes();            // подтягиваем размеры после сглаживания
            this.smoothRegionBorders();
            this.renumberRegions();
        },

        // Сколько стоит «зайти» в клетку при росте региона: единица, шум (неправильность границ) и горы (преграда).
        buildRegionCosts() {
            const o = this.options;
            const noiseLayer = this.densityLayer(this.noise.regionShape, 10);
            const cost = new Float32Array(this.size * this.size);
            for (const i of this.regionTiles) {
                cost[i] = 1 + noiseLayer[i] * 2 * o.regionIrregularity;
                if (this.terrain[i] === Terrain.MOUNTAIN) cost[i] += o.regionBarrierCost;
            }
            return cost;
        },

        // Соседи для роста региона: 4 стороны и диагонали (чтобы формы были круглее, а не «ромбами»). Диагональ разрешена,
        // только если обе клетки «за углом» тоже годятся: так регион не просачивается сквозь диагональный изгиб реки или берега.
        regionNeighbors(i) {
            const { size, regionMask: mask } = this;
            const x = i % size;
            const result = [], around = this.neighbors8(i);
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
        pickRegionSeeds(area, count) {
            const isFlat = i => this.terrain[i] !== Terrain.MOUNTAIN;
            const order = this.shuffled(area.filter(isFlat)).concat(this.shuffled(area.filter(i => !isFlat(i))));
            count = Math.min(count, order.length);

            const averageSize = (this.options.regionMinSize + this.options.regionMaxSize) / 2;
            const spacing = Math.max(1, Math.round(Math.sqrt(averageSize) * 0.7));
            const blocked = new Uint8Array(this.terrain.length);
            const seeds = [];

            for (let radius = spacing; radius >= 0 && seeds.length < count; radius--) {
                blocked.fill(0);
                for (const seed of seeds) this.markSquare(blocked, seed, radius);
                for (const i of order) {
                    if (seeds.length >= count) break;
                    if (blocked[i] || seeds.includes(i)) continue;
                    seeds.push(i);
                    this.markSquare(blocked, i, radius);
                }
            }
            return seeds;
        },

        // Делим землю между семенами: каждая клетка достаётся тому, до кого «дешевле» дойти (Дейкстра от всех семян сразу).
        assignRegions(seeds) {
            this.regionId.fill(-1);
            const dist = new Float32Array(this.size * this.size).fill(Infinity);
            const heap = new MinHeap();
            seeds.forEach((tile, id) => {
                dist[tile] = 0;
                heap.push(0, tile, id);
            });

            while (heap.size > 0) {
                const [cost, tile, id] = heap.pop();
                if (this.regionId[tile] !== -1) continue;
                this.regionId[tile] = id;

                const steps = this.regionNeighbors(tile);
                for (let k = 0; k < steps.length; k += 2) {
                    const neighbor = steps[k];
                    if (this.regionId[neighbor] !== -1) continue;
                    const next = cost + steps[k + 1] * this.regionCost[neighbor];
                    if (next < dist[neighbor]) {
                        dist[neighbor] = next;
                        heap.push(next, neighbor, id);
                    }
                }
            }
        },

        // Новое семя — клетка региона, ближайшая к его «центру тяжести» (лёгкий штраф за горы).
        relaxRegionSeeds(seeds) {
            const size = this.size;
            const tilesByRegion = seeds.map(() => []);
            for (const i of this.regionTiles) {
                const id = this.regionId[i];
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
                    const distance = dx * dx + dy * dy + (this.terrain[i] === Terrain.MOUNTAIN ? 4 : 0);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = i;
                    }
                }
                return best;
            });
        },

        // Регион должен быть цельным (по 4 соседям). Обрывки, отрезанные от основной части, отдаём соседу с самой длинной общей границей.
        repairRegionConnectivity() {
            const sameRegion = (j, start) => this.regionId[j] === this.regionId[start];
            const componentsByRegion = {};
            for (const component of this.components(sameRegion, this.regionTiles)) {
                (componentsByRegion[this.regionId[component[0]]] ||= []).push(component);
            }

            for (const components of Object.values(componentsByRegion)) {
                if (components.length < 2) continue;
                components.sort((a, b) => b.length - a.length);
                for (const fragment of components.slice(1)) {
                    const target = this.bestNeighborRegion(fragment, this.regionId[fragment[0]]);
                    const newId = target !== -1 ? target : this.nextRegionId++;
                    for (const i of fragment) this.regionId[i] = newId;
                }
            }
        },

        // Сосед с самой длинной общей границей (при равенстве — меньший).
        bestNeighborRegion(tiles, ownId) {
            const contacts = new Map();
            for (const i of tiles) {
                for (const j of this.neighbors(i)) {
                    const other = this.regionId[j];
                    if (other !== -1 && other !== ownId) tally(contacts, other);
                }
            }
            return topKey(contacts, (a, b) => (this.regionSizes[a] ?? 0) < (this.regionSizes[b] ?? 0));
        },

        // Клочок суши, отрезанный рекой от всего остального, лучше присоединить к региону на другом берегу, чем делать из него
        // отдельный «регион» в пару клеток (река при этом по-прежнему в регион не входит).
        regionAcrossRiver(tiles, ownId) {
            const contacts = new Map();
            for (const i of tiles) {
                for (const river of this.neighbors(i)) {
                    if (!this.river[river]) continue;
                    for (const j of this.neighbors8(river)) {
                        const other = this.regionId[j];
                        if (other !== -1 && other !== ownId) tally(contacts, other);
                    }
                }
            }
            return topKey(contacts);
        },

        countRegionSizes() {
            this.regionSizes = {};
            for (const i of this.regionTiles) {
                const id = this.regionId[i];
                if (id >= 0) this.regionSizes[id] = (this.regionSizes[id] || 0) + 1;
            }
        },

        // Переводит клетку в другой регион и поддерживает счётчики размеров.
        moveTile(tile, from, to) {
            this.regionId[tile] = to;
            this.regionSizes[from]--;
            this.regionSizes[to]++;
        },

        // Обрывки меньше regionMergeBelow вливаем в соседа (с самой длинной общей границей), начиная с самых мелких.
        mergeSmallRegions() {
            const tilesByRegion = {};
            for (const i of this.regionTiles) (tilesByRegion[this.regionId[i]] ||= []).push(i);

            const ids = Object.keys(this.regionSizes).map(Number).sort((a, b) => this.regionSizes[a] - this.regionSizes[b]);
            for (const id of ids) {
                const tiles = tilesByRegion[id];
                if (!tiles || tiles.length >= this.options.regionMergeBelow) continue;

                let target = this.bestNeighborRegion(tiles, id);
                if (target === -1) target = this.regionAcrossRiver(tiles, id);
                if (target === -1) continue; // обрывок суши, до которого не добраться даже через реку, — оставляем как есть

                for (const i of tiles) this.regionId[i] = target;
                tilesByRegion[target].push(...tiles);
                this.regionSizes[target] += tiles.length;
                delete this.regionSizes[id];
                delete tilesByRegion[id];
            }
        },

        // Сколько из 8 соседей клетки принадлежит региону id.
        regionContacts(tile, id) {
            let n = 0;
            for (const neighbor of this.neighbors8(tile)) if (this.regionId[neighbor] === id) n++;
            return n;
        },

        // Выравниваем размеры: граничные клетки переходят от слишком больших регионов к слишком маленьким. Сначала идут клетки,
        // которые «и так почти внутри» получателя (так граница не обрастает отростками); клетку не отдаём, если донор развалится.
        balanceRegionSizes() {
            const { regionMinSize, regionMaxSize, regionBalancePasses } = this.options;
            // Излишек перетекает «по цепочке» к более мелким соседям: слишком большой регион отдаёт клетки любому соседу, который
            // меньше него хотя бы на 2, а слишком маленький берёт у любого соседа, который больше него хотя бы на 2.
            const needed = (donor, receiver) => {
                const donorSize = this.regionSizes[donor], receiverSize = this.regionSizes[receiver];
                return (donorSize > regionMaxSize && receiverSize < donorSize - 1) || (receiverSize < regionMinSize && donorSize > receiverSize + 1);
            };

            for (let pass = 0; pass < regionBalancePasses; pass++) {
                const moves = [];
                for (const tile of this.regionTiles) {
                    const donor = this.regionId[tile];
                    let best = -1, bestScore = -Infinity;
                    for (const neighbor of this.neighbors(tile)) {
                        const receiver = this.regionId[neighbor];
                        if (receiver === -1 || receiver === donor || !needed(donor, receiver)) continue;
                        const toReceiver = this.regionContacts(tile, receiver);
                        if (toReceiver < 2) continue;
                        const score = toReceiver - this.regionContacts(tile, donor) + hash01(tile) * 0.01;
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
                    const donor = this.regionId[tile];
                    if (donor === receiver || !needed(donor, receiver)) continue;
                    if (!this.neighbors(tile).some(n => this.regionId[n] === receiver)) continue;
                    if (this.regionContacts(tile, receiver) < 2) continue;
                    if (!this.staysConnectedWithout(tile, donor)) continue;

                    this.moveTile(tile, donor, receiver);
                    moved++;
                }
                if (moved === 0) break;
            }
        },

        // Сглаживание: клетка, у которой среди 8 соседей больше «чужих» одного региона, чем «своих», переходит к нему.
        // Убирает зубцы и узкие отростки, границы становятся плавными. Размеры при этом могут чуть выйти за [min, max] — потом их подтягивает выравнивание.
        smoothRegionBorders() {
            const { regionMinSize, regionMaxSize, regionSmoothPasses } = this.options;
            const floor = regionMinSize - 1, ceiling = regionMaxSize + 1;   // допуск по размеру: регион не уменьшаем меньше floor и не увеличиваем больше ceiling

            for (let pass = 0; pass < regionSmoothPasses; pass++) {
                let moved = 0;
                for (const tile of this.shuffled(this.regionTiles)) {
                    const own = this.regionId[tile];
                    const counts = new Map();
                    for (const neighbor of this.neighbors8(tile)) {
                        const id = this.regionId[neighbor];
                        if (id !== -1) tally(counts, id);
                    }

                    let best = -1, bestCount = counts.get(own) || 0;
                    for (const [id, n] of counts) {
                        if (id !== own && n > bestCount && this.neighbors(tile).some(j => this.regionId[j] === id)) {
                            best = id;
                            bestCount = n;
                        }
                    }
                    if (best === -1) continue;
                    if (this.regionSizes[own] - 1 < floor || this.regionSizes[best] + 1 > ceiling) continue;
                    if (!this.staysConnectedWithout(tile, own)) continue;

                    this.moveTile(tile, own, best);
                    moved++;
                }
                if (moved === 0) break;
            }
        },

        // Не расколется ли регион, если убрать из него клетку removed: все её соседи по региону должны остаться связанными между собой.
        // (Регион с карманом за рекой уже состоит из двух кусков — для него проверяем только тот кусок, где лежит клетка.)
        staysConnectedWithout(removed, id) {
            const own = this.neighbors(removed).filter(n => this.regionId[n] === id);
            if (own.length <= 1) return true;

            const seen = new Set([removed, own[0]]);
            const queue = [own[0]];
            let reached = 1;
            for (let head = 0; head < queue.length && reached < own.length; head++) {
                for (const neighbor of this.neighbors(queue[head])) {
                    if (this.regionId[neighbor] !== id || seen.has(neighbor)) continue;
                    seen.add(neighbor);
                    queue.push(neighbor);
                    if (own.includes(neighbor)) reached++;
                }
            }
            return reached === own.length;
        },

        // Номера регионов подряд: 0, 1, 2, ... (после слияний в нумерации остаются дыры).
        renumberRegions() {
            const mapping = new Map();
            for (const i of this.regionTiles) {
                const id = this.regionId[i];
                if (id === -1) continue;
                if (!mapping.has(id)) mapping.set(id, mapping.size);
                this.regionId[i] = mapping.get(id);
            }
            this.countRegionSizes();
        }
    });
}
