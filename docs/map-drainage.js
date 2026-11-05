/* ============================================================
   Drainage — сток воды: заливка впадин, озёра, глубина воды

   Реки — часть рельефа, а не линии, нарисованные поверх: вода стекает по высотам.
   «Заливка впадин» (priority-flood): из моря и краёв карты затопляем сушу от низких мест к высоким; так у каждой клетки
   появляется сток (map.flowTo) к морю, а впадины, которые не имеют стока, становятся озёрами. Потом считаем глубину воды.
   ============================================================ */
{
    const { hash01 } = MapGen;

    MapGen.Drainage = {
        defaults: {
            shallowWaterDistance: 2,  // вода не дальше N клеток от суши считается мелководьем
            riverMeander: 0.010,      // насколько русла отклоняются от «кратчайшего» пути (больше — извилистее)
            lakeDepth: 0.02,          // впадина глубже этого становится озером
            lakeMinSize: 4           // озёра меньше этого (в клетках) не создаём
        },

        build(map) {
            this.fillDepressions(map);         // сток к морю (map.flowTo) и озёра
            this.computeWaterDepth(map);       // мелководье и глубокая вода
        },

        // Глубина воды = расстояние до ближайшей суши (в клетках). Работает и для океана, и для озёр:
        // у берега мелко, к середине водоёма всё глубже. Мелководье — узкая полоса у берега, остальное — глубокая вода.
        computeWaterDepth(map) {
            const distance = map.distanceFrom(map.landTiles, { accept: i => !map.isLand(i), diagonal: true });
            for (let i = 0; i < map.terrain.length; i++) {
                if (map.isLand(i)) continue;
                const depth = Math.min(255, Math.max(0, distance[i]));
                map.waterDepth[i] = depth;
                map.terrain[i] = depth > 0 && depth <= map.options.shallowWaterDistance ? Terrain.SHALLOW_WATER : Terrain.DEEP_WATER;
            }
        },

        fillDepressions(map) {
            const { size, options: o } = map;
            const count = size * size;
            const filled = new Float32Array(count);
            const flowTo = new Int32Array(count).fill(-1);
            const done = new Uint8Array(count);
            const heap = new MinHeap();
            const jitter = i => hash01(i) * o.riverMeander;  // чтобы русла петляли, а не шли по линейке

            // Затопление начинается с моря (клетки у берега) и с суши на краю карты.
            for (let i = 0; i < count; i++) {
                const x = i % size, y = Math.floor(i / size);
                const onEdge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
                if (!map.isLand(i)) {
                    done[i] = 1;
                    filled[i] = map.seaLevel;
                    if (map.neighbors8(i).some(j => map.isLand(j))) heap.push(map.seaLevel, i, 0);
                } else if (onEdge) {
                    done[i] = 1;
                    filled[i] = map.elevation[i] + jitter(i);
                    heap.push(filled[i], i, 0);
                }
            }
            while (heap.size > 0) {
                const [level, current] = heap.pop();
                for (const next of map.neighbors8(current)) {
                    if (done[next]) continue;
                    done[next] = 1;
                    flowTo[next] = current;
                    // Шаг заливки случайный (и длиннее по диагонали): на плоских местах русла петляют, а не бегут параллельными прямыми.
                    const step = 2e-4 * (0.3 + 2 * hash01(next + 7919)) * (map.isDiagonal(current, next) ? 1.4 : 1);
                    filled[next] = Math.max(map.elevation[next] + jitter(next), level + step);
                    heap.push(filled[next], next, 0);
                }
            }
            map.filled = filled;
            map.flowTo = flowTo;

            // Озёра: впадины достаточной глубины и размера.
            const deep = new Uint8Array(count);
            for (const i of map.landTiles) {
                if (map.terrain[i] === Terrain.PLAIN && filled[i] - map.elevation[i] > o.lakeDepth) deep[i] = 1;
            }
            for (const lake of map.components(i => deep[i], map.landTiles)) {
                if (lake.length < o.lakeMinSize) continue;
                for (const i of lake) {
                    map.terrain[i] = Terrain.DEEP_WATER;
                    map.mountainHeight[i] = 0;
                }
            }
            MapGen.Relief.collectLandTiles(map);
        }
    };
}
