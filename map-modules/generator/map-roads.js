/* ============================================================
   Дороги между поселениями (A*, мосты и броды)

   Дороги по всей карте. Каждая группа поселений соединяется с ближайшими соседями; рёбра берутся по
   возрастанию длины, и в «каркас» попадают те, что связывают ещё не связанные группы (как остовное дерево), плюс
   несколько ближайших пар для петель. Путь ищет A*: горы и вода непроходимы, лес и подъёмы замедляют, а чужие
   дороги дёшевы — поэтому дороги сливаются в магистрали. Где дорога пересекает реку, ставится мост или брод.
   ============================================================ */
{
    const { DIRECTIONS_8 } = MapGen;
    // Во сколько раз ресурс клетки удорожает шаг. Руды и эфир дороги не пересекают: на дороге ресурсов нет, жалко терять.
    const ROAD_RESOURCE_COST = Array.from({ length: Object.keys(Resource).length }, () => 1);
    Object.assign(ROAD_RESOURCE_COST, { [Resource.WOOD]: 1.5, [Resource.WHEAT]: 1.15, [Resource.GOLD]: 5, [Resource.IRON]: 5, [Resource.ETHER]: 5 });

    MapGen.mixins.push({
        buildRoads() {
            const o = this.options;
            const groups = this.settlementGroups;
            if (!o.roads || groups.length < 2) return;

            const parent = groups.map((_, i) => i);   // система непересекающихся множеств: какие группы уже связаны дорогами
            const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
            for (const edge of this.roadCandidateEdges(groups)) {
                const joins = find(edge.a) !== find(edge.b);
                // каркас (связываем несвязанное) + петли (ближайшие пары)
                const loop = !joins && (edge.rank === 0 || (edge.rank === 1 && this.random() < o.roadLoopChance));
                if (!joins && !loop) continue;

                const path = this.findRoadPath(groups[edge.a].tile, groups[edge.b].tile);
                if (!path) continue;                                  // например, через море
                if (joins) parent[find(edge.a)] = find(edge.b);
                this.carveRoad(path);
            }
        },

        // Кандидаты в рёбра: roadNeighbors ближайших соседей каждой группы (поиск по сетке корзин), по возрастанию длины.
        // rank — какой по близости это сосед (0 — ближайший).
        roadCandidateEdges(groups) {
            const o = this.options, size = this.size;
            const coords = groups.map(g => [g.tile % size, Math.floor(g.tile / size)]);
            const bucketSize = 16, bucketOf = v => Math.floor(v / bucketSize);
            const buckets = new Map();
            coords.forEach(([x, y], id) => {
                const key = bucketOf(x) + ',' + bucketOf(y);
                if (!buckets.has(key)) buckets.set(key, []);
                buckets.get(key).push(id);
            });
            const maxDistance = o.roadMaxDistance * size / 300;   // дальность дорог растёт вместе с картой
            const reach = Math.ceil(maxDistance / bucketSize);

            const edges = [], seen = new Set();
            coords.forEach(([x, y], id) => {
                const near = [];
                for (let by = bucketOf(y) - reach; by <= bucketOf(y) + reach; by++) {
                    for (let bx = bucketOf(x) - reach; bx <= bucketOf(x) + reach; bx++) {
                        for (const other of buckets.get(bx + ',' + by) || []) {
                            if (other === id) continue;
                            const distance = Math.hypot(coords[other][0] - x, coords[other][1] - y);
                            if (distance <= maxDistance) near.push({ other, distance });
                        }
                    }
                }
                near.sort((a, b) => a.distance - b.distance);
                near.slice(0, o.roadNeighbors).forEach(({ other, distance }, rank) => {
                    const key = Math.min(id, other) * 100000 + Math.max(id, other);
                    if (seen.has(key)) return;
                    seen.add(key);
                    edges.push({ a: id, b: other, distance, rank });
                });
            });
            return edges.sort((p, q) => p.distance - q.distance);
        },

        // Поиск пути A* от клетки к клетке; null, если пути нет.
        findRoadPath(start, goal) {
            const size = this.size;
            const count = size * size;
            const scratch = this.pathScratch ||= { cost: new Float32Array(count), stamp: new Int32Array(count), from: new Int32Array(count), run: 0 };
            const { cost, stamp, from } = scratch;
            const run = ++scratch.run;
            const goalX = goal % size, goalY = Math.floor(goal / size);
            const heuristic = i => Math.hypot((i % size) - goalX, Math.floor(i / size) - goalY) * 0.4;

            const heap = new MinHeap();
            cost[start] = 0;
            stamp[start] = run;
            from[start] = -1;
            heap.push(heuristic(start), start, 0);

            while (heap.size > 0) {
                const [, current, spent] = heap.pop();
                if (spent > cost[current] + 1e-6) continue;           // устаревшая запись
                if (current === goal) {
                    const path = [];
                    for (let i = goal; i !== -1; i = from[i]) path.push(i);
                    return path.reverse();
                }

                const around = this.neighbors8(current);
                for (let k = 0; k < around.length; k++) {
                    const next = around[k];
                    const step = this.roadStepCost(current, next);
                    if (step === Infinity) continue;
                    const total = cost[current] + step;
                    if (stamp[next] !== run || total < cost[next]) {
                        stamp[next] = run;
                        cost[next] = total;
                        from[next] = current;
                        heap.push(total + heuristic(next), next, total);
                    }
                }
            }
            return null;
        },

        // Цена шага по дороге из клетки current в соседнюю next (Infinity — нельзя).
        roadStepCost(current, next) {
            const { terrain, river } = this;
            if (terrain[next] !== Terrain.PLAIN) return Infinity;                // вода и горы
            if (river[current] && river[next]) return Infinity;                  // с клетки реки на клетку реки не шагаем: дорога заезжает на реку, только чтобы пересечь её
            const dx = (next % this.size) - (current % this.size);
            const diagonal = dx !== 0 && next - current !== dx;
            if (diagonal) {                                                      // по диагонали нельзя «срезать угол» воды, гор и рек
                const a = current + dx, b = next - dx;                           // клетки «за углом»
                if (terrain[a] !== Terrain.PLAIN || river[a] || terrain[b] !== Terrain.PLAIN || river[b]) return Infinity;
            }

            let cost = diagonal ? 1.414 : 1;
            if (river[next]) cost += 3;                                          // мост — дорого
            cost *= ROAD_RESOURCE_COST[this.resource[next]];
            if (this.biome[next] === Biome.TUNDRA || this.biome[next] === Biome.DESERT) cost *= 1.4;
            cost += Math.abs(this.elevation[next] - this.elevation[current]) * 12; // подъёмы
            if (this.roadLevel[next] > 0) cost *= 0.4;                           // готовые дороги дёшевы
            return cost;
        },

        // Сохраняет путь: уровень дороги в клетках (где дорогу используют несколько путей — выше), связи с соседями и мосты через реки.
        carveRoad(path) {
            path.forEach((tile, k) => {
                this.roadLevel[tile] = Math.min(3, this.roadLevel[tile] + 1);
                if (this.river[tile] > 0 && this.crossing[tile] === 0) this.crossing[tile] = this.crossingFor(tile);
                if (k === 0) return;
                const previous = path[k - 1];
                const [dx, dy] = this.delta(previous, tile);
                const forward = DIRECTIONS_8.findIndex(([ax, ay]) => ax === dx && ay === dy);
                this.roadLinks[previous] |= 1 << forward;
                this.roadLinks[tile] |= 1 << (7 - forward);                      // противоположное направление в списке — зеркальный индекс
            });
        }
    });
}
