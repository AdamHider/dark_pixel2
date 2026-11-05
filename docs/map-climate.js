/* ============================================================
   Climate — климат: влажность, температура, биомы

   Север (y = 0) холодный, юг жаркий; шум добавляет разнообразия, высота охлаждает. Биом клетки — по температуре и влажности.
   ============================================================ */
{
    MapGen.Climate = {
        defaults: {
            temperatureScale: 4,
            temperatureNoise: 0.55,  // разброс температуры вокруг «север холодно, юг жарко»
            altitudeCooling: 0.1,    // насколько высота охлаждает
            moistureScale: 5,
            aridity: 0.45           // 0..1: доля сухих клеток, где вместо луга степь/пустыня (меньше — меньше степей)
        },

        build(map) {
            this.generateMoisture(map);
            this.generateTemperature(map);
            this.assignBiomes(map);
        },

        // Выравниваем до равномерных 0..1: порог 0.4 в биомах честно значит «самые сухие 40%».
        generateMoisture(map) {
            map.moisture = map.densityLayer(map.noise.moisture, map.options.moistureScale, 4);
        },

        // Север (y = 0) холодный, юг (y = size) жаркий; шум добавляет разнообразия, высота охлаждает.
        generateTemperature(map) {
            const o = map.options;
            map.eachTile((i, nx, latitude) => {
                const noise = map.noise.temperature.fractal(nx * o.temperatureScale, latitude * o.temperatureScale, 3);
                const altitude = Math.max(0, map.elevation[i] - map.seaLevel);
                map.temperature[i] = clamp(latitude * 0.9 + 0.05 + (noise - 0.5) * o.temperatureNoise - altitude * o.altitudeCooling);
            });
        },

        assignBiomes(map) {
            for (const i of map.landTiles) {
                if (map.terrain[i] === Terrain.PLAIN) map.biome[i] = this.pickBiome(map, map.temperature[i], map.moisture[i]);
            }
        },

        pickBiome(map, temperature, moisture) {
            const dry = map.options.aridity; // клетки суше этого порога — степь или пустыня
            if (temperature < 0.1) return Biome.TUNDRA;

            if (temperature < 0.42) {                 // холодный пояс
                if (moisture > 0.55) return Biome.TAIGA;
                return moisture > dry * 0.8 ? Biome.GRASSLAND : Biome.STEPPE;
            }
            if (temperature < 0.7) {                  // умеренный пояс
                if (moisture < dry) return Biome.STEPPE;
                return moisture > 0.8 ? Biome.TAIGA : Biome.GRASSLAND;
            }
            // жаркий пояс
            if (moisture < dry) return Biome.DESERT;
            return moisture < 0.6 ? Biome.SAVANNA : Biome.GRASSLAND;
        }
    };
}
