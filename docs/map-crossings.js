/* ============================================================
   Crossings — переправы через реки

   На прямых участках рек (вода входит и выходит в одном направлении) изредка ставим мост или брод.
   ============================================================ */
{
    MapGen.Crossings = {
        defaults: {
            riverCrossingChance: 0.2  // доля подходящих прямых участков рек, где ставится мост или брод
        },

        // Переправы: на прямых участках рек (вода входит и выходит в одном направлении) изредка ставим мост или брод.
        build(map) {
            const upstream = new Map();                                  // клетка -> реки, впадающие в неё
            for (const i of map.landTiles) {
                const to = map.riverTo[i];
                if (map.river[i] > 0 && to !== -1 && map.river[to] > 0) {
                    if (!upstream.has(to)) upstream.set(to, []);
                    upstream.get(to).push(i);
                }
            }

            for (const i of map.landTiles) {
                if (map.river[i] === 0 || map.riverTo[i] === -1 || map.crossing[i]) continue;
                const sources = upstream.get(i) || [];
                if (sources.length !== 1) continue;                       // начало реки или слияние — не место для моста
                const [ax, ay] = map.delta(sources[0], i), [bx, by] = map.delta(i, map.riverTo[i]);
                if (ax !== bx || ay !== by) continue;                    // поворот
                if (map.random() > map.options.riverCrossingChance) continue;
                if (map.neighbors8(i).some(j => map.crossing[j])) continue;
                map.crossing[i] = this.crossingFor(map, i);
            }
        },

        // Тип переправы для клетки реки: брод (1) или каменный мост (2, если река глубже 1).
        crossingFor(map, i) {
            return map.river[i] >= 2 ? 2 : 1;
        }
    };
}
