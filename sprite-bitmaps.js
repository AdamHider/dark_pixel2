/* ============================================================
   SECTION: SPRITE_BITMAPS
   Растровые спрайты: конфиг вида «pixels (строки символов) + legend + palette».

   Отличие от фигурных спрайтов в sprite-examples.js только в способе описания:
   здесь картинка задаётся растром, символ за символом, а не набором фигур. Формат
   поддерживает сам SpriteRenderer (см. normalize в sprite-renderer.js): если в
   конфиге есть pixels, они становятся единственным слоем.

   Так хранятся спрайты старой версии проекта (например black_warrior) и так будут
   выглядеть армии, здания, деревья, флаги и пашни. Цвета палитры можно связать с
   игрой: значение '$team' берётся из options.colors.team (основной цвет фракции),
   поэтому один и тот же растр даёт разные армии у разных фракций.

   Подключать после sprite-renderer.js. Размеры — в пикселях для клетки 12×12.
   ============================================================ */
const SPRITE_BITMAPS = (() => {

    /* ---------- Растр воина (пример старой версии: black_warrior) ----------
       Размер 40×32, опора — по центру внизу. Палитра из 44 цветов (color_1..color_44),
       символы a..z и A..R — как в исходном конфиге. */

    const WARRIOR_PIXELS = [
        '.............aab........................',
        '..............cdddddddddddddd...........',
        '.......eeeef..cggggggggggghd............',
        '......feeijf..cggggggggggggd............',
        '.....ffeeeif..cggkkgkggklgm.............',
        '......nnnnnn..cglkggkggklgm.............',
        '......opqqqr..cgkkgkkkgklgm.............',
        '......qpooop..cgkkglklgklgm.............',
        '.......pooop..cgkkggkggklgd.............',
        '.......qpppq..cggkkgkggklgm.............',
        '...sssstttttt.cggllgkgggggmm............',
        '...uvwsxeeejiycgggggllggggdm............',
        '..uuvweeeeejwycdddddddddddddm...........',
        '.zAABwexeeeewyC.........................',
        '.zAABweeeeeewDDD........................',
        'zzAB.seEeeeewFFF........................',
        'GGH..seeeeeewIJJ........................',
        'GGH..seEeijeiKII........................',
        'HGH.LLcccijciKII........................',
        '.GH.LLLccccciII.........................',
        '.MNFLLLOOOOOP.c.........................',
        '.MMFLLOOOOOOO.c.........................',
        '.NFFLLOOOcOOO.c.........................',
        '....cOOQ.ccOOPc.........................',
        '....cOOQ..cOOPc.........................',
        '....cOQ...cOOPc.........................',
        '...cOOQ...ccccc.........................',
        '...cOQ.....Qccc.........................',
        '...cOQ.....QORc.........................',
        '...OO......QORc.........................',
        '..ROO......QORc.........................',
        '..QQQ......QQQc.........................'
    ];

    const WARRIOR_LEGEND = {
        a: 'color_1', b: 'color_2', c: 'color_3', d: 'color_4', e: 'color_5', f: 'color_6',
        g: 'color_7', h: 'color_8', i: 'color_9', j: 'color_10', k: 'color_11', l: 'color_12',
        m: 'color_13', n: 'color_14', o: 'color_15', p: 'color_16', q: 'color_17', r: 'color_18',
        s: 'color_19', t: 'color_20', u: 'color_21', v: 'color_22', w: 'color_23', x: 'color_24',
        y: 'color_25', z: 'color_26', A: 'color_27', B: 'color_28', C: 'color_29', D: 'color_30',
        E: 'color_31', F: 'color_32', G: 'color_33', H: 'color_34', I: 'color_35', J: 'color_36',
        K: 'color_37', L: 'color_38', M: 'color_39', N: 'color_40', O: 'color_41', P: 'color_42',
        Q: 'color_43', R: 'color_44'
    };

    const WARRIOR_PALETTE = {
        color_1: '#252b2b', color_2: '#23262b', color_3: '#181a19', color_4: '#1f2326',
        color_5: '#2e3231', color_6: '#21221e', color_7: '#1f2826', color_8: '#181e1e',
        color_9: '#817366', color_10: '#a5a08d', color_11: '#798584', color_12: '#3f494d',
        color_13: '#0f1818', color_14: '#241d17', color_15: '#e99667', color_16: '#bb805a',
        color_17: '#874c3b', color_18: '#4d2b22', color_19: '#3b3d39', color_20: '#33322d',
        color_21: '#777976', color_22: '#525451', color_23: '#0c0d0c', color_24: '#e0e2d9',
        color_25: '#232929', color_26: '#20221f', color_27: '#374545', color_28: '#252726',
        color_29: '#20201e', color_30: '#92958e', color_31: '#656962', color_32: '#6a6c67',
        color_33: '#9da79c', color_34: '#6d7872', color_35: '#1c2023', color_36: '#888c8d',
        color_37: '#675e54', color_38: '#101210', color_39: '#48494b', color_40: '#9fa59b',
        color_41: '#292e31', color_42: '#242d2a', color_43: '#0e0e0d', color_44: '#343837'
    };

    // color_5 (плащ) и color_7 (щит) — крупные цельные области: их и красим цветом фракции.
    const WARRIOR_TEAM_PALETTE = { ...WARRIOR_PALETTE, color_5: '$team', color_7: '$team' };


    /* ---------- Щит (фигурка армии) ----------
       Армия на карте — не отряд, а геральдический щит: поле цвета фракции, полоса и
       эмблема — вторым цветом. Так армии читаются с одного взгляда, как фишки в
       настольной игре. o — контур, t — поле, h/T — блик и тень, a — полоса и эмблема. */

    const SHIELD_LEGEND = { o: 'outline', t: 'field', h: 'lit', T: 'shade', a: 'mark' };

    const SHIELD_PALETTE = {
        outline: '#241810',
        field: '$team',
        lit: { shade: '$team', amount: 0.22 },
        shade: { shade: '$team', amount: -0.28 },
        mark: '$accent'
    };

    return {
        // Растр как есть: тёмный воин, цвет не зависит от фракции.
        black_warrior: {
            id: 'black_warrior',
            size: [40, 32],
            anchor: [20, 30],
            palette: WARRIOR_PALETTE,
            pixels: WARRIOR_PIXELS,
            legend: WARRIOR_LEGEND
        },

        // Тот же растр, но плащ и щит — цвет фракции ($team): одна картинка, разные армии.
        army_black: {
            id: 'army_black',
            size: [40, 32],
            anchor: [20, 30],
            palette: WARRIOR_TEAM_PALETTE,
            pixels: WARRIOR_PIXELS,
            legend: WARRIOR_LEGEND
        },

        // Щит с эмблемой «star»: поле — цвет фракции, полоса и знак — второй цвет.
        shield_star: {
            id: 'shield_star',
            size: [12, 13],
            anchor: [6, 12],
            palette: SHIELD_PALETTE,
            pixels: [
            "...ohttho...",
            "..oohtthoo..",
            ".oohhaahhoo.",
            ".ohhaaaaTTo.",
            ".ohaaaaaaTo.",
            ".ohtaaaatTo.",
            ".ohttaattTo.",
            ".ohhttttTTo.",
            ".oohhttTToo.",
            "..oohhTToo..",
            "...oohToo...",
            "....oooo....",
            ".....oo....."
        ],
            legend: SHIELD_LEGEND
        },

        // Щит с эмблемой «circle»: поле — цвет фракции, полоса и знак — второй цвет.
        shield_circle: {
            id: 'shield_circle',
            size: [12, 13],
            anchor: [6, 12],
            palette: SHIELD_PALETTE,
            pixels: [
            "...ohttho...",
            "..oohtthoo..",
            ".oohaaaahoo.",
            ".ohaaaaaaTo.",
            ".ohaaaaaaTo.",
            ".ohaaaaaaTo.",
            ".ohaaaaaaTo.",
            ".ohhaaaaTTo.",
            ".oohhttTToo.",
            "..oohhTToo..",
            "...oohToo...",
            "....oooo....",
            ".....oo....."
        ],
            legend: SHIELD_LEGEND
        },

        // Щит с эмблемой «diamond»: поле — цвет фракции, полоса и знак — второй цвет.
        shield_diamond: {
            id: 'shield_diamond',
            size: [12, 13],
            anchor: [6, 12],
            palette: SHIELD_PALETTE,
            pixels: [
            "...ohttho...",
            "..oohtthoo..",
            ".oohhaahhoo.",
            ".ohhaaaaTTo.",
            ".ohaaaaaaTo.",
            ".ohaaaaaaTo.",
            ".ohtaaaatTo.",
            ".ohhtaatTTo.",
            ".oohhttTToo.",
            "..oohhTToo..",
            "...oohToo...",
            "....oooo....",
            ".....oo....."
        ],
            legend: SHIELD_LEGEND
        },

        // Щит с эмблемой «tower»: поле — цвет фракции, полоса и знак — второй цвет.
        shield_tower: {
            id: 'shield_tower',
            size: [12, 13],
            anchor: [6, 12],
            palette: SHIELD_PALETTE,
            pixels: [
            "...ohttho...",
            "..oohtthoo..",
            ".oohaaaahoo.",
            ".ohhaaaaTTo.",
            ".ohaaaaaaTo.",
            ".ohaaaaaaTo.",
            ".ohaattaaTo.",
            ".ohaattaaTo.",
            ".oohhttTToo.",
            "..oohhTToo..",
            "...oohToo...",
            "....oooo....",
            ".....oo....."
        ],
            legend: SHIELD_LEGEND
        },

        // Щит с эмблемой «cross»: поле — цвет фракции, полоса и знак — второй цвет.
        shield_cross: {
            id: 'shield_cross',
            size: [12, 13],
            anchor: [6, 12],
            palette: SHIELD_PALETTE,
            pixels: [
            "...ohttho...",
            "..oohtthoo..",
            ".ooaattaaoo.",
            ".ohaattaaTo.",
            ".ohaaaaaaTo.",
            ".ohaaaaaaTo.",
            ".ohaattaaTo.",
            ".ohaattaaTo.",
            ".oohhttTToo.",
            "..oohhTToo..",
            "...oohToo...",
            "....oooo....",
            ".....oo....."
        ],
            legend: SHIELD_LEGEND
        },

        // Щит с эмблемой «none»: поле — цвет фракции, полоса и знак — второй цвет.
        shield_none: {
            id: 'shield_none',
            size: [12, 13],
            anchor: [6, 12],
            palette: SHIELD_PALETTE,
            pixels: [
            "...ohttho...",
            "..oohtthoo..",
            ".oohhtthhoo.",
            ".ohhttttTTo.",
            ".ohttttttTo.",
            ".ohttttttTo.",
            ".ohttttttTo.",
            ".ohhttttTTo.",
            ".oohhttTToo.",
            "..oohhTToo..",
            "...oohToo...",
            "....oooo....",
            ".....oo....."
        ],
            legend: SHIELD_LEGEND
        }
    };
})();
