/* ============================================================
   Deposits — редкие ресурсы: золото, железо, эфир

   Золото и железо — в горах и предгорьях (не на реках), эфир — вдоль «линий разлома». Все три кладутся одним и тем же способом (placeVein).
   ============================================================ */
{
    MapGen.Deposits = {
        defaults: {
            foothillDistance: 2,  // руда встречается в горах и на равнине не дальше N клеток от них
            goldScale: 6,
            goldShare: 0.45,      // доля карты, где вообще возможно золото (скопления)
            goldChance: 0.05,     // шанс золота в такой клетке (в предгорьях вдвое меньше)
            ironScale: 5,
            ironShare: 0.5,       // то же для железной руды
            ironChance: 0.16,     // железо встречается заметно чаще золота
            faultScale: 5,        // масштаб «линий разлома», вдоль которых растёт эфир
            etherShare: 0.06,     // доля карты вдоль линий разлома
            etherChance: 0.35    // шанс эфира на такой клетке
        },

        build(map) {
            const o = map.options;
            const foothills = MapGen.Relief.tilesNearMountains(map, o.foothillDistance);
            const inFoothills = i => foothills[i] && !map.river[i];                 // руда — в горах и предгорьях, не на реках
            const oreChance = chance => i => (map.terrain[i] === Terrain.MOUNTAIN ? chance : chance * 0.5);   // в предгорьях вдвое реже

            // Золото — редкое, скоплениями; перекрывает лес и поля.
            this.placeVein(map, Resource.GOLD, map.densityLayer(map.noise.ore, o.goldScale), o.goldShare, oreChance(o.goldChance),
                { eligible: inFoothills });
            // Железо — там же, но другие скопления и заметно чаще; золото не вытесняет.
            this.placeVein(map, Resource.IRON, map.densityLayer(map.noise.iron, o.ironScale), o.ironShare, oreChance(o.ironChance),
                { eligible: inFoothills, canReplace: current => current !== Resource.GOLD });
            // Эфир (гигантские фиолетовые кристаллы и грибы) растёт вдоль «линий разлома» — тонких извилистых полос шума, с разрывами.
            // Линии: максимум там, где шум пересекает 0.5.
            const faults = map.densityLayer(map.noise.fault, o.faultScale, 3, n => 1 - Math.abs(2 * n - 1));
            this.placeVein(map, Resource.ETHER, faults, o.etherShare, () => o.etherChance,
                { eligible: i => !map.river[i], canReplace: current => current === Resource.NONE });
        },

        // Кладёт ресурс в клетки, где слой density попал в верхнюю долю share, с шансом chanceOf(клетка).
        // eligible(клетка) — можно ли вообще; canReplace(текущий ресурс) — можно ли вытеснить то, что уже лежит.
        placeVein(map, resource, density, share, chanceOf, { eligible = () => true, canReplace = () => true } = {}) {
            for (const i of map.landTiles) {
                if (!eligible(i) || !canReplace(map.resource[i])) continue;
                if (density[i] > 1 - share && map.random() < chanceOf(i)) map.resource[i] = resource;
            }
        }
    };
}
