/* ============================================================
   Shores — типы берегов

   Тип берега для суши рядом с морем, озером или рекой: пляж, каменистый берег или утёс.
   ============================================================ */
{
    MapGen.Shores = {
        defaults: {
            shoreScale: 12,    // размер участков одного типа берега (больше — мельче)
            beachShare: 0.55,  // доля подходящих (низких, тёплых) берегов, которые станут пляжами
            cliffShare: 0.25  // доля самых высоких берегов, которые станут утёсами (горы у воды — всегда утёсы)
        },

        // Тип берега для суши рядом с морем, озером или рекой: пляж, каменистый берег или утёс.
        // Горы у воды — всегда утёсы; низкие тёплые берега — пляжи (пятнами); остальное — камни.
        build(map) {
            const o = map.options;
            const coastal = map.landTiles.filter(i =>
                map.river[i] > 0
                || map.neighbors8(i).some(j => !map.isLand(j))
                || map.neighbors(i).some(j => map.river[j] > 0));
            if (coastal.length === 0) return;

            const heightRank = rankNormalize(Float32Array.from(coastal, i => map.elevation[i] - map.seaLevel));
            const clusters = map.densityLayer(map.noise.shore, o.shoreScale);
            const nearMountains = MapGen.Relief.tilesNearMountains(map, 2);

            coastal.forEach((i, k) => {
                const warmEnough = map.temperature[i] > 0.2;
                if (nearMountains[i] || heightRank[k] > 1 - o.cliffShare) map.shore[i] = Shore.CLIFF;
                else if (warmEnough && heightRank[k] < 0.65 && clusters[i] > 1 - o.beachShare) map.shore[i] = Shore.BEACH;
                else map.shore[i] = Shore.ROCKY;
            });
        }
    };
}
