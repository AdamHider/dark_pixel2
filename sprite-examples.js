/* ============================================================
   Примеры конфигов для SpriteRenderer (см. описание формата в sprite-renderer.js).
   Это просто данные: их можно хранить в JSON, генерировать кодом или править в sprite-demo.html.
   Размеры — в пикселях для клетки 12×12.
   ============================================================ */
const SPRITE_EXAMPLES = {

    // Деревня: три домика, дым из трубы, зимой снег на крышах.
    village: {
        id: 'village',
        size: [28, 22],
        anchor: [14, 19],
        palette: {
            wall: '#cdb890',
            roof: '#a44f33',
            wood: '#6b4a2e',
            window: '#f4d98a',
            smoke: '#d9d9d9'
        },
        shadow: { rx: 12, ry: 2.5, alpha: 0.28 },
        outline: '#2b1d12',
        layers: [
            // левый дом
            { shape: 'rect', x: 3, y: 12, w: 9, h: 7, fill: 'wall', bevel: 0.5 },
            { shape: 'polygon', points: [[2, 12], [7.5, 6], [13, 12]], fill: 'roof', bevel: 0.5 },
            { shape: 'rect', x: 5, y: 15, w: 2, h: 4, fill: 'wood' },
            { shape: 'rect', x: 9, y: 14, w: 2, h: 2, fill: 'window' },
            // правый дом
            { shape: 'rect', x: 15, y: 13, w: 9, h: 6, fill: 'wall', bevel: 0.5 },
            { shape: 'polygon', points: [[14, 13], [19.5, 8], [25, 13]], fill: 'roof', bevel: 0.5 },
            { shape: 'rect', x: 18, y: 15, w: 2, h: 4, fill: 'wood' },
            { shape: 'rect', x: 21, y: 15, w: 2, h: 2, fill: 'window' },
            // труба
            { shape: 'rect', x: 10, y: 6, w: 2, h: 4, fill: { shade: 'wall', amount: -0.35 } },
            // дым (кадры анимации 0 и 1 — разные)
            { shape: 'pixels', x: 10, y: 2, rows: ['.s', 's.'], legend: { s: 'smoke' }, alpha: 0.7, when: { frame: 0 } },
            { shape: 'pixels', x: 10, y: 2, rows: ['s.', '.s'], legend: { s: 'smoke' }, alpha: 0.7, when: { frame: 1 } },
            // забор
            { shape: 'line', points: [[13, 19], [14, 19]], fill: 'wood' }
        ],
        variants: {
            winter: {
                palette: { roof: '#eef3f5', wall: '#d8cdb4' },
                addLayers: [
                    { shape: 'polygon', points: [[2, 12], [7.5, 6], [13, 12], [11, 12], [7.5, 8], [4, 12]], fill: '#ffffff', alpha: 0.9 }
                ]
            },
            autumn: { palette: { roof: '#9a4426' } }
        }
    },

    // Город: стена с зубцами, башни со знамёнами (цвет игрока), донжон. Знамёна машут (2 кадра).
    city: {
        id: 'city',
        size: [40, 32],
        anchor: [20, 29],
        palette: {
            stone: '#9a968c',
            stoneDark: { shade: 'stone', amount: -0.3 },
            roof: '#7b3a2c',
            gate: '#4a3322',
            window: '#f4d98a',
            flag: '$team'
        },
        shadow: { rx: 18, ry: 3, alpha: 0.3 },
        outline: '#241810',
        layers: [
            // стена
            { shape: 'rect', x: 3, y: 18, w: 34, h: 10, fill: 'stone', bevel: 0.5 },
            { shape: 'rect', x: 3, y: 16, w: 3, h: 2, fill: 'stone', bevel: 0.4, repeat: { count: 6, dx: 6 } },
            { shape: 'rect', x: 15, y: 21, w: 10, h: 7, fill: 'gate' },
            { shape: 'ellipse', cx: 20, cy: 21, rx: 5, ry: 3, fill: 'gate' },
            // донжон
            { shape: 'rect', x: 14, y: 8, w: 12, h: 12, fill: 'stone', bevel: 0.5 },
            { shape: 'polygon', points: [[13, 8], [20, 1], [27, 8]], fill: 'roof', bevel: 0.5 },
            { shape: 'rect', x: 19, y: 12, w: 2, h: 3, fill: 'window' },
            // боковые башни
            { shape: 'rect', x: 1, y: 11, w: 7, h: 17, fill: 'stone', bevel: 0.5 },
            { shape: 'polygon', points: [[0, 11], [4.5, 5], [9, 11]], fill: 'roof', bevel: 0.5 },
            { shape: 'rect', x: 32, y: 11, w: 7, h: 17, fill: 'stone', bevel: 0.5 },
            { shape: 'polygon', points: [[31, 11], [35.5, 5], [40, 11]], fill: 'roof', bevel: 0.5 },
            { shape: 'rect', x: 4, y: 14, w: 1, h: 2, fill: 'window' },
            { shape: 'rect', x: 35, y: 14, w: 1, h: 2, fill: 'window' },
            // знамёна на башнях
            { shape: 'line', points: [[4, 5], [4, 1]], fill: 'stoneDark' },
            { shape: 'polygon', points: [[5, 1], [9, 2], [5, 4]], fill: 'flag', when: { frame: 0 } },
            { shape: 'polygon', points: [[5, 1], [9, 3], [5, 4]], fill: 'flag', when: { frame: 1 } },
            { shape: 'line', points: [[35, 5], [35, 1]], fill: 'stoneDark' },
            { shape: 'polygon', points: [[36, 1], [40, 2], [36, 4]], fill: 'flag', when: { frame: 0 } },
            { shape: 'polygon', points: [[36, 1], [40, 3], [36, 4]], fill: 'flag', when: { frame: 1 } }
        ],
        variants: {
            winter: {
                addLayers: [
                    { shape: 'polygon', points: [[13, 8], [20, 1], [27, 8], [25, 8], [20, 3], [15, 8]], fill: '#ffffff', alpha: 0.9 },
                    { shape: 'rect', x: 3, y: 16, w: 3, h: 1, fill: '#ffffff', alpha: 0.9, repeat: { count: 6, dx: 6 } }
                ]
            }
        }
    },

    // Армия: отряд из трёх воинов со знаменем (цвет игрока). Флаг 'marching' добавляет пыль.
    army: {
        id: 'army',
        size: [22, 20],
        anchor: [11, 17],
        palette: {
            skin: '#e0b48a',
            steel: '#aeb4bb',
            cloth: '$team',
            clothDark: { shade: '$team', amount: -0.35 },
            leather: '#6b4a2e',
            pole: '#5a3d24',
            dust: '#c9b48a'
        },
        shadow: { rx: 9, ry: 2, alpha: 0.28 },
        outline: '#1f160e',
        layers: [
            { shape: 'pixels', x: 2, y: 8, rows: [
                '.hh.',
                '.ss.',
                'cccc',
                'cccc',
                '.cc.',
                '.ll.',
                '.ll.'
            ], legend: { h: 'steel', s: 'skin', c: 'cloth', l: 'leather' } },
            { shape: 'pixels', x: 9, y: 6, rows: [
                '.hh.',
                '.ss.',
                'cccc',
                'cccc',
                '.cc.',
                '.ll.',
                '.ll.'
            ], legend: { h: 'steel', s: 'skin', c: 'cloth', l: 'leather' } },
            { shape: 'pixels', x: 15, y: 8, rows: [
                '.hh.',
                '.ss.',
                'cccc',
                'cccc',
                '.cc.',
                '.ll.',
                '.ll.'
            ], legend: { h: 'steel', s: 'skin', c: 'cloth', l: 'leather' } },
            // копья
            { shape: 'line', points: [[1, 15], [1, 5]], fill: 'pole' },
            { shape: 'line', points: [[14, 14], [14, 2]], fill: 'pole' },
            // знамя
            { shape: 'polygon', points: [[15, 2], [20, 3], [15, 6]], fill: 'cloth', when: { frame: 0 } },
            { shape: 'polygon', points: [[15, 2], [20, 4], [15, 6]], fill: 'cloth', when: { frame: 1 } },
            // пыль при движении
            { shape: 'scatter', area: { ellipse: [11, 17, 9, 2] }, count: 7, colors: ['dust'], seed: 3, alpha: 0.6, when: { flag: 'marching' } }
        ]
    }
};
