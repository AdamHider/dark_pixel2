/* ============================================================
   UI RENDERER (Двухуровневая система биомов и надстроек)
   ============================================================ */

// Словари названий и прилагательных для красивой сборки названий
const BASE_BIOME_NAMES = {
    'plains': { name: 'Равнина', adj: 'Равнинные' },
    'snow_plains': { name: 'Заснеженная равнина', adj: 'Заснеженные' },
    'tundra': { name: 'Тундра', adj: 'Тундровые' },
    'taiga': { name: 'Тайга', adj: 'Таёжные' },
    'steppe': { name: 'Степь', adj: 'Степные' },
    'desert': { name: 'Пустыня', adj: 'Пустынные' },
    'savanna': { name: 'Саванна', adj: 'Саванные' }
};

const MODIFIER_NAMES = {
    'flat': '', // Без надстройки (просто базовый биом)
    'farmland': 'плодородные земли',
    'forest': 'густой лес',
    'woodland': 'роща / редколесье',
    'hills': 'холмы',
    'mountains': 'горные массивы',
    'oasis': 'оазис / водоём'
};

class UIRenderer {
    constructor() {}

    createElement(tag, className = '', attributes = {}, children = []) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        
        for (const [key, value] of Object.entries(attributes)) {
            if (key === 'text') el.textContent = value;
            else if (key === 'html') el.innerHTML = value;
            else el.setAttribute(key, value);
        }

        children.forEach(child => {
            if (child) el.appendChild(child);
        });

        return el;
    }

    // Двухуровневый анализ региона: Базовый биом + Надстройка
    getRegionBiomeData(region, generator) {
        const totalTiles = region.size || 1;
        
        // 1. ОПРЕДЕЛЕНИЕ БАЗОВОГО БИОМА
        const dominantBiomeIndex = region.biomes.indexOf(Math.max(...region.biomes));
        let baseBiome = ['tundra', 'taiga', 'plains', 'steppe', 'desert', 'savanna'][dominantBiomeIndex] || 'plains';

        // Подсчёт параметров региона
        let woodCount = 0;
        let wheatCount = 0;
        let mountainCount = region.mountains || 0;
        let riverCount = region.riverTiles || 0;
        let totalTemp = 0;

        if (region.tiles && region.tiles.length > 0) {
            region.tiles.forEach(tileIdx => {
                const terrain = generator.terrain[tileIdx];
                const resource = generator.resource[tileIdx];
                const temp = generator.temperature ? generator.temperature[tileIdx] : 0.5;

                totalTemp += temp;
                if (terrain === 3) mountainCount++; // Terrain.MOUNTAIN
                if (resource === 1) woodCount++;    // Resource.WOOD
                if (resource === 2) wheatCount++;   // Resource.WHEAT
            });
        } else if (region.resources) {
            woodCount = region.resources[1] || 0;
            wheatCount = region.resources[2] || 0;
        }

        const avgTemp = totalTemp / totalTiles;
        const woodRatio = woodCount / totalTiles;
        const wheatRatio = wheatCount / totalTiles;
        const mountainRatio = mountainCount / totalTiles;
        const hasRiver = riverCount > (totalTiles * 0.15);

        // Уточнение заснеженных равнин по низкой температуре
        if (baseBiome === 'plains' && avgTemp < 0.35) {
            baseBiome = 'tundra';
        }

        // 2. ОПРЕДЕЛЕНИЕ НАДСТРОЙКИ (МОДИФИКАТОРА)
        let modifier = 'flat';

        if (mountainRatio > 0.35) {
            modifier = 'mountains';
        } else if (mountainRatio > 0.12) {
            modifier = 'hills';
        } else if (woodRatio > 0.35) {
            modifier = 'forest';
        } else if (woodRatio > 0.12) {
            modifier = 'woodland';
        } else if (wheatRatio > 0.08) {
            modifier = 'farmland';
        } else if (hasRiver && (baseBiome === 'desert' || baseBiome === 'steppe')) {
            modifier = 'oasis';
        }

        // 3. СБОРКА ИТОГОВОГО НАЗВАНИЯ И ФАЙЛА ИЗОБРАЖЕНИЯ
        const baseData = BASE_BIOME_NAMES[baseBiome] || BASE_BIOME_NAMES['plains'];
        const modTitle = MODIFIER_NAMES[modifier];

        let displayName = baseData.name;
        if (modTitle) {
            displayName = `${baseData.adj} ${modTitle}`;
        }

        // Ключ картинки: 'desert_farmland', 'steppe_hills', 'tundra_forest' или просто 'desert'
        const imageKey = modifier !== 'flat' ? `${baseBiome}_${modifier}` : baseBiome;

        return {
            baseBiome,
            modifier,
            displayName,
            imageKey,
            imagePath: `img/regions/${imageKey}.png`
        };
    }

    renderRegionCard(region, biomeNames, resourceNames, factionNameFn, factionsList, generator) {
        // Получаем сведённые данные о биоме
        const biomeData = this.getRegionBiomeData(region, generator);
        const biomeClass = this.getBiomeBadgeClass(biomeData.baseBiome);

        // Подсчёт базовых ресурсов
        let goldCount = 0, foodCount = 0, productionCount = 0;
        let populationCount = region.population || 0;

        if (region.resources) {
            region.resources.forEach((count, code) => {
                if (!count || count <= 0) return;
                const resName = resourceNames[code] ? resourceNames[code].toLowerCase() : '';
                if (resName.includes('золот') || code === 3) goldCount += count;
                if (resName.includes('пшениц') || resName.includes('дерев') || code === 1 || code === 2) foodCount += count;
                if (resName.includes('производ') || resName.includes('желез') || code === 5) productionCount += count;
            });
        }

        // Определение владельца
        let ownerElement;
        if (region.owner >= 0 && factionsList[region.owner]) {
            const faction = factionsList[region.owner];
            ownerElement = this.createElement('span', 'owner-badge', {
                style: `border-color: ${faction.color}; color: ${faction.color};`,
                text: `👑 ${faction.name}`
            });
        } else if (Object.keys(region.owners).length > 0) {
            const parts = Object.entries(region.owners).map(([id, n]) => `${factionNameFn(Number(id))} (${n} кл.)`);
            ownerElement = this.createElement('span', 'owner-partial', { text: `Оспаривается: ${parts.join(', ')}` });
        } else {
            ownerElement = this.createElement('span', 'owner-neutral', { text: 'Нейтральная территория' });
        }

        // Рендер баннера с фоном и собранным составным названием
        const bannerEl = this.createElement('div', 'region-banner', {
            style: `background-image: url('${biomeData.imagePath}');`
        }, [
            this.createElement('div', 'region-banner-overlay'),
            this.createElement('span', `biome-badge ${biomeClass}`, { text: biomeData.displayName })
        ]);

        const statsGrid = this.createElement('div', 'region-stats-grid', {}, [
            this.createStatBox(`🪙 ${goldCount}`, 'Золото'),
            this.createStatBox(`🌾 ${foodCount}`, 'Еда'),
            this.createStatBox(`⚙️ ${productionCount}`, 'Производ.'),
            this.createStatBox(`👥 ${populationCount}`, 'Население')
        ]);

        const resourcesSection = this.createElement('div', 'region-resources-section', {}, [
            this.createElement('div', 'section-subtitle', { text: 'Ресурсы региона' }),
            statsGrid
        ]);

        const metaInfo = this.createElement('div', 'region-meta-info', {}, [
            this.createElement('span', {}, { html: `<b>Площадь:</b> ${region.size} кв.` }),
            this.createElement('span', {}, { html: `<b>Горы:</b> ${region.mountains} кл.` }),
            this.createElement('span', {}, { html: `<b>Реки:</b> ${region.riverTiles} кл.` })
        ]);
        if (region.coastal) {
            metaInfo.appendChild(this.createElement('span', 'feature-tag', { text: '🌊 Выход к морю' }));
        }

        const detailsSection = this.createElement('div', 'region-details-section', {}, [
            this.createElement('div', 'section-subtitle', { text: 'Характеристики территории' }),
            metaInfo
        ]);

        return this.createElement('div', 'region-card', {}, [
            bannerEl,
            this.createElement('div', 'region-card-header', {}, [
                this.createElement('div', 'region-title-row', {}, [
                    this.createElement('span', 'region-id', { text: `Регион #${region.id}` }),
                    ownerElement
                ])
            ]),
            resourcesSection,
            detailsSection
        ]);
    }

    createStatBox(numText, subText) {
        return this.createElement('div', 'stat-box', {}, [
            this.createElement('span', 'stat-num', { text: numText }),
            this.createElement('span', 'stat-sub', { text: subText })
        ]);
    }

    renderTileCard(tile, terrainNames, biomeNames, resourceNames, crossingNames, temperatureName) {
        let kind = terrainNames[tile.terrain];
        if (tile.terrain < 2) {
            kind = `${kind} (глубина ${tile.waterDepth})`;
        } else if (tile.terrain === 2) {
            kind = tile.hasRiver ? `Река (глубина ${tile.riverLevel})` : biomeNames[tile.biome];
        }
        if (tile.crossing) kind += `, ${crossingNames[tile.crossing]}`;
       
        const statsGrid = this.createElement('div', 'tile-stats-grid', {}, [
            this.createElement('div', 'stat-item', { html: `<span class="stat-label">Климат</span><span class="stat-val">${temperatureName(tile.temperature)} (${this.getTemperature(tile.temperature)}°C)</span>` })
        ]);

        if (tile.resource !== 0 && tile.resource !== 6) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Ресурс</span><span class="stat-val highlight">${resourceNames[tile.resource]}</span>` }));
        }
        if (tile.resource === 6) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Поселение</span><span class="stat-val">${tile.population} чел. (ур. ${tile.settlementLevel})</span>` }));
        }
        if (tile.roadLevel > 0) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Инфраструктура</span><span class="stat-val">Дорога</span>` }));
        }

        return this.createElement('div', 'tile-card', {}, [
            this.createElement('div', 'tile-card-header', {}, [
                this.createElement('span', 'tile-coords', { text: `📍 Клетка (${tile.x}, ${tile.y})` }),
                this.createElement('span', 'tile-kind', { text: kind })
            ]),
            statsGrid
        ]);
    }

    getTemperature(val, minTemp = -20, maxTemp = 40) {
        const clamped = Math.max(0, Math.min(1, val));
        return Math.round(minTemp + clamped * (maxTemp - minTemp));
    }

    getBiomeBadgeClass(biomeName) {
        switch (biomeName) {
            case 'tundra': return 'biome-tundra';
            case 'taiga': return 'biome-taiga';
            case 'plains': return 'biome-plains';
            case 'snow_plains': return 'biome-tundra';
            case 'steppe': return 'biome-steppe';
            case 'desert': return 'biome-desert';
            case 'savanna': return 'biome-savanna';
            default: return '';
        }
    }
}

const uiRenderer = new UIRenderer();