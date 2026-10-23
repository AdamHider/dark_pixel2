/* ============================================================
   UI RENDERER (Словарь названий биомов и ландшафтов)
   ============================================================ */

   const REGION_TYPE_NAMES = {
    // Тундра
    'tundra': 'Тундра',
    'alpine_tundra': 'Альпийская тундра',
    'tundra_barrens': 'Тундровая пустошь',
    'deep_arctic': 'Арктическая глушь',
    'frozen_swamp': 'Ледяное болото',

    // Тайга и леса
    'taiga': 'Тайга',
    'dense_taiga': 'Густая тайга',
    'forest': 'Лес',
    'dense_forest': 'Густой лес',
    'woodland': 'Редколесье',

    // Равнины и холмы
    'plains': 'Равнина',
    'plateau': 'Предгорье',
    'hills': 'Холмы',
    'farmland': 'Плодородные земли',
    'river_valley': 'Речная долина',
    'river_farmland': 'Речные угодья',

    // Степи
    'steppe': 'Степь',
    'wooded_steppe': 'Лесостепь',
    'dry_steppe': 'Сухая степь',

    // Пустыни
    'desert': 'Пустыня',
    'canyon': 'Скалистый каньон',
    'scorched_desert': 'Выжженная пустыня',
    'dunes': 'Песчаные дюны',
    'oasis': 'Оазис',

    // Саванны
    'savanna': 'Саванна',
    'dry_savanna': 'Сухая саванна',
    'lush_savanna': 'Зеленая саванна'
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

    // Анализ региона с учетом леса, гор, рек и ресурсов
    getRegionVisualType(region, generator) {
        const dominantBiomeIndex = region.biomes.indexOf(Math.max(...region.biomes));
        const baseBiome = ['tundra', 'taiga', 'plains', 'steppe', 'desert', 'savanna'][dominantBiomeIndex] || 'plains';

        let totalTiles = region.size || 1;
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
                if (terrain === 3) mountainCount++;
                if (resource === 1) woodCount++;
                if (resource === 2) wheatCount++;
            });
        } else {
            if (region.resources) {
                woodCount = region.resources[1] || 0;
                wheatCount = region.resources[2] || 0;
            }
        }

        const avgTemp = totalTemp / totalTiles;
        const woodRatio = woodCount / totalTiles;
        const wheatRatio = wheatCount / totalTiles;
        const mountainRatio = mountainCount / totalTiles;
        const hasRiver = riverCount > (totalTiles * 0.15);
        // Правила комбинаций
        if (mountainRatio > 0.6) {
            if (baseBiome === 'tundra') return 'alpine_tundra';
            if (baseBiome === 'desert') return 'canyon';
            return 'plateau';
        }
        if (mountainRatio > 0.25) return 'hills';

        if (woodRatio > 0.65) return baseBiome === 'taiga' ? 'dense_taiga' : 'dense_forest';
        if (woodRatio > 0.4) return 'forest';
        if (woodRatio > 0.2) return 'woodland';

        if (wheatRatio > 0.15 || (baseBiome === 'plains' && wheatRatio > 0.05)) {
            return hasRiver ? 'river_farmland' : 'farmland';
        }

        if (hasRiver) {
            if (baseBiome === 'desert') return 'oasis';
            if (baseBiome === 'tundra' && avgTemp < 0.3) return 'frozen_swamp';
            return 'river_valley';
        }

        if (baseBiome === 'tundra') return avgTemp < 0.2 ? 'deep_arctic' : 'tundra_barrens';
        if (baseBiome === 'desert') return avgTemp > 0.85 ? 'scorched_desert' : 'dunes';
        if (baseBiome === 'steppe') return woodRatio > 0.05 ? 'wooded_steppe' : 'dry_steppe';
        if (baseBiome === 'savanna') return hasRiver ? 'lush_savanna' : 'dry_savanna';

        return baseBiome;
    }

    renderRegionCard(region, biomeNames, resourceNames, factionNameFn, factionsList, generator) {
        const dominantBiomeIndex = region.biomes.indexOf(Math.max(...region.biomes));
        const baseBiomeKey = ['tundra', 'taiga', 'plains', 'steppe', 'desert', 'savanna'][dominantBiomeIndex] || 'plains';
        
        // Определяем детальный визуальный тип и берем название из словаря
        const visualKey = this.getRegionVisualType(region, generator);
        const displayName = REGION_TYPE_NAMES[visualKey] || biomeNames[dominantBiomeIndex];
        
        const biomeClass = this.getBiomeBadgeClass(baseBiomeKey);
        const imagePath = `img/regions/${visualKey}.png`;

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

        let ownerElement;
        if (region.owner >= 0 && factionsList[region.owner]) {
            const faction = factionsList[region.owner];
            ownerElement = this.createElement('span', 'owner-badge', {
                style: `border-color: ${faction.color}; color: ${faction.color};`,
                text: `${faction.name}`
            });
        } else if (Object.keys(region.owners).length > 0) {
            const parts = Object.entries(region.owners).map(([id, n]) => `${factionNameFn(Number(id))} (${n} кл.)`);
            ownerElement = this.createElement('span', 'owner-partial', { text: `Оспаривается: ${parts.join(', ')}` });
        } else {
            ownerElement = this.createElement('span', 'owner-neutral', { text: 'Нейтральная территория' });
        }

        // Рендер баннера с картинкой и красивым названием из словаря
        const bannerEl = this.createElement('div', 'region-banner', {
            style: `background-image: url('${imagePath}');`
        }, [
            this.createElement('span', 'region-id', { text: `Регион #${region.id}` }),
            this.createElement('div', 'region-banner-overlay'),
            this.createElement('span', `biome-badge ${biomeClass}`, { text: displayName })
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
            this.createElement('div', 'section-subtitle', { text: 'Характеристики региона' }),
            metaInfo
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

       

        return this.createElement('div', 'region-card', {}, [
            bannerEl,
            this.createElement('div', 'region-card-header', {}, [
                this.createElement('div', 'region-title-row', {}, [
                    ownerElement
                ])
            ]),
            detailsSection,
            resourcesSection
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
            this.createElement('div', 'stat-item', { html: `<span class="stat-label">Климат: </span><span class="stat-val">${temperatureName(tile.temperature)}</span>` })
        ]);

        if (tile.resource !== 0 && tile.resource !== 6) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Ресурс: </span><span class="stat-val highlight">${resourceNames[tile.resource]}</span>` }));
        }
        if (tile.resource === 6) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Поселение: </span><span class="stat-val">${tile.population} чел. (ур. ${tile.settlementLevel})</span>` }));
        }
        if (tile.roadLevel > 0) {
            statsGrid.appendChild(this.createElement('div', 'stat-item', { html: `<span class="stat-label">Инфраструктура: </span><span class="stat-val">Дорога</span>` }));
        }

        return this.createElement('div', 'tile-card', {}, [
            this.createElement('div', 'tile-card-header', {}, [
                this.createElement('span', 'tile-coords', { text: `${kind} (${tile.x}, ${tile.y})` }),
            ]),
            statsGrid
        ]);
    }

    getBiomeBadgeClass(biomeName) {
        switch (biomeName) {
            case 'тундра': case 'tundra': return 'biome-tundra';
            case 'тайга': case 'taiga': return 'biome-taiga';
            case 'равнина': case 'plains': return 'biome-plains';
            case 'степь': case 'steppe': return 'biome-steppe';
            case 'пустыня': case 'desert': return 'biome-desert';
            case 'саванна': case 'savanna': return 'biome-savanna';
            default: return '';
        }
    }
}

const uiRenderer = new UIRenderer();