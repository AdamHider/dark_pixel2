/* ============================================================
   Flora — лес и поля

   Крупные массивы плюс мелкие рощи, только на равнине и в подходящем климате.
   ============================================================ */
{
    MapGen.Flora = {
        defaults: {
            forestScale: 15,         // масштаб крупных лесных массивов (больше — мельче)
            forestShare: 0.70,       // доля карты под крупными лесными массивами
            forestClumpShare: 0.14,  // ...и ещё столько же мелких разрозненных рощ
            woodChance: 0.9,         // шанс дерева в клетке внутри леса
            wheatScale: 15,
            wheatShare: 0.5,         // то же для полей
            wheatClumpShare: 0.14,
            wheatChance: 0.85,
            clumpScale: 16          // размер мелких рощ и полей (больше — мельче)
        },

        // Лес и поля: крупные массивы + мелкие рощи, только на равнине и в подходящем климате.
        build(map) {
            const o = map.options;
            const forest = this.createPatchLayer(map, map.noise.forest, o.forestScale, o.forestShare, map.noise.forestClumps, o.clumpScale, o.forestClumpShare);
            const fields = this.createPatchLayer(map, map.noise.fertility, o.wheatScale, o.wheatShare, map.noise.fertilityClumps, o.clumpScale, o.wheatClumpShare);

            for (const i of map.landTiles) {
                if (map.terrain[i] !== Terrain.PLAIN) continue;

                const t = map.temperature[i], m = map.moisture[i];
                const roll = map.random();
                const goodForWood = forest[i] && m > 0.3 && t > 0.12 && t < 0.8;
                const goodForWheat = fields[i] && m > 0.1 && m < 0.9 && t > 0.18 && t < 0.85;

                if (goodForWood && roll < o.woodChance) map.resource[i] = Resource.WOOD;
                else if (goodForWheat && roll < o.wheatChance) map.resource[i] = Resource.WHEAT;
            }
        },

        // «Пятна» ресурса: крупные скопления плюс мелкие разрозненные кучки. Вместе дают хаотичное, но не пустое распределение.
        createPatchLayer(map, bigNoise, bigScale, bigShare, smallNoise, smallScale, smallShare) {
            const big = map.densityLayer(bigNoise, bigScale);
            const small = map.densityLayer(smallNoise, smallScale);
            return Uint8Array.from(big, (value, i) => (value > 1 - bigShare || small[i] > 1 - smallShare ? 1 : 0));
        }
    };
}
