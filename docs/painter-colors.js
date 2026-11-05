/* ============================================================
   SECTION: MAP_COLORS
   Цвета, не зависящие от сезона (в виде hex).
   ============================================================ */
const COLORS = {
    bridgeDeck: '#a39e92',
    bridgeEdge: '#6e6a62',
    stone: '#b9b5ab',
    stoneShadow: '#7d7a72',
    gold: '#f2d15b',
    goldShadow: '#8a6a14',
    goldLight: '#fff2b0',
    riftDark: '#2a1250',
    riftGlow: '#a45cff',
    riftCore: '#e9ccff',
    regionBorder: '#19110a',
    sand: '#dccb96',
    wetSand: '#b5a67c',
    pebbleLight: '#a9a59a',
    pebbleDark: '#6f6c66',
    stoneMid: '#8a877e',
    hay: '#c9b774',
    dirt: '#8a7650',
    dirtLight: '#a89168',
    mud: '#5d4f38',
    plank: '#4a3524',
    wallA: '#dccca4',
    wallB: '#c8b48c',
    thatch: '#b09a5a',
    roofA: '#a24d34',
    roofB: '#7e3a2c',
    roofC: '#8d6238',
    roofD: '#5e5a66',
    outline: '#140e0a',
    window: '#f0b24a',
    fire: '#ffb347',
    fireCore: '#fff0b0',
    chapelStone: '#8d8a85',
    bone: '#cfc8b4',
    crow: '#16161a'
};

/* ============================================================
   SECTION: MAP_PACKED_COLORS
   Цвета в виде одного числа (так пиксели быстро записываются в ImageData).
   ============================================================ */
const packRgb = (r, g, b) => 0xFF000000 | (b << 16) | (g << 8) | r; // знаковое 32-битное число, как в Int32Array
const hexToPacked = hex => packRgb(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
const WHITE = packRgb(255, 255, 255);
const BLACK = packRgb(0, 0, 0);

function hslToPacked(hue, saturation, lightness) {
    const s = saturation / 100, l = lightness / 100;
    const k = n => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const channel = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return packRgb(channel(0), channel(8), channel(4));
}

// Смесь двух цветов: t = 0 — цвет a, t = 1 — цвет b. Целочисленная арифметика: функция вызывается миллионы раз.
function mixPacked(a, b, t) {
    const w = Math.round(t * 256);
    const inv = 256 - w;
    const r = ((a & 255) * inv + (b & 255) * w) >> 8;
    const g = (((a >>> 8) & 255) * inv + ((b >>> 8) & 255) * w) >> 8;
    const bl = (((a >>> 16) & 255) * inv + ((b >>> 16) & 255) * w) >> 8;
    return 0xFF000000 | (bl << 16) | (g << 8) | r;
}

// Крапинка: чуть светлее или чуть темнее (на ~13%), целочисленно.
function speckColor(color, lighter) {
    const target = lighter ? 255 : 0;
    const r = (color & 255) + (((target - (color & 255)) * 33) >> 8);
    const g = ((color >>> 8) & 255) + (((target - ((color >>> 8) & 255)) * 33) >> 8);
    const b = ((color >>> 16) & 255) + (((target - ((color >>> 16) & 255)) * 33) >> 8);
    return 0xFF000000 | (b << 16) | (g << 8) | r;
}

// Светлее (amount > 0) или темнее (amount < 0) на amount/256 — целочисленно, без выделения памяти.
function shadeFast(color, amount) {
    const r = color & 255, g = (color >>> 8) & 255, b = (color >>> 16) & 255;
    if (amount < 0) {
        const keep = 256 + amount;
        return 0xFF000000 | (((b * keep) >> 8) << 16) | (((g * keep) >> 8) << 8) | ((r * keep) >> 8);
    }
    return 0xFF000000 | ((b + (((255 - b) * amount) >> 8)) << 16) | ((g + (((255 - g) * amount) >> 8)) << 8) | (r + (((255 - r) * amount) >> 8));
}

// Светлее (amount > 0) или темнее (amount < 0).
const shadePacked = (color, amount) => mixPacked(color, amount > 0 ? WHITE : BLACK, Math.abs(amount));

// Скалы гор (по референсу): от холодной фиолетовой тени к тёплому бежевому свету. Сезон слегка подкрашивает их цветом камня.
const MOUNTAIN_RAMP = Object.freeze(['#463f50', '#554e5b', '#6c677c', '#877466', '#aa9989', '#cbbfae']);

// Палитра выбранного сезона в виде чисел.
const packPalette = palette => ({
    biome: palette.biome.map(hexToPacked),
    waterShades: palette.water.map(hexToPacked),
    ice: palette.ice.map(hexToPacked),
    rock: hexToPacked(palette.rock),
    snow: hexToPacked(palette.snow),
    snowShade: hexToPacked(palette.snowShade),
    trunk: hexToPacked(palette.trunk)
});
