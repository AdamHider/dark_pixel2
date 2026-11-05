/* ============================================================
   Rivers — реки

   Подсчёт стока: дождь выпадает на каждую клетку (во влажных местах больше) и стекает вниз по map.flowTo (его строит Drainage);
   в каждой клетке накапливается вода всех клеток выше по течению. Где её много — там река; чем больше воды, тем река шире.
   Получаются притоки, слияния, бассейны — как в природе, а не 16 одиноких ручьёв.
   ============================================================ */
{
    MapGen.Rivers = {
        defaults: {
            rainfall: 0.5,                    // сколько воды даёт клетка (во влажных местах больше); больше — больше и шире реки
            riverThresholds: [60, 180, 480]  // сколько воды надо, чтобы появился ручей / река / большая река
        },

        build(map) {
            const o = map.options;
            const count = map.size * map.size;

            // Дождь на каждую клетку суши; воду собираем сверху вниз (от высоких клеток к низким), в том числе через озёра.
            const flow = new Float32Array(count);
            const order = [];
            for (let i = 0; i < count; i++) {
                if (map.flowTo[i] !== -1) order.push(i);
                if (map.isLand(i)) flow[i] = o.rainfall * (0.4 + 1.6 * map.moisture[i]) * (map.terrain[i] === Terrain.MOUNTAIN ? 1.3 : 1);
            }
            order.sort((a, b) => map.filled[b] - map.filled[a]);
            for (const i of order) flow[map.flowTo[i]] += flow[i];

            const area = (map.size / 300) ** 2;                      // пороги заданы для карты 300×300: на меньшей карте воды набирается меньше
            const [first, second, third] = o.riverThresholds.map(t => t * area);
            for (const i of map.landTiles) {
                if (map.terrain[i] !== Terrain.PLAIN || flow[i] < first) continue;
                map.river[i] = flow[i] >= third ? 3 : flow[i] >= second ? 2 : 1;
                map.riverFlow[i] = Math.min(65535, Math.round(flow[i]));
                map.riverTo[i] = map.flowTo[i];
                map.resource[i] = Resource.NONE;                        // на реке ресурсов нет
            }
        }
    };
}
