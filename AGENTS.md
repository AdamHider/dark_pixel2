# AGENTS.md

## Project

Browser-based pixel-art fantasy map generator. Plain ES classes, no build step, no
dependencies. Scripts are loaded in `index.html` in dependency order:
`map-generator.js` → `seasons.js` → `map-painter.js` → `sprite-renderer.js` →
`sprite-examples.js` → `map-renderer.js` → `faction-manager.js` → `main.js`.

`faction-manager.js` reads `Resource`, `ResourceInfo`, `Terrain` from `map-generator.js`,
so it must load after it.

Architecture: `MapGenerator` fills flat typed arrays; `MapPainter` renders them once into
an offscreen 1:1 canvas; `MapRenderer` is just a camera over that canvas. `FactionManager`
is a separate module that owns faction state and hands it to the map via
`map.applyFactionState` (the map only stores and shows it).

See `CODE_GUIDE.md` for the full function-by-function guide and `OPTIMIZATION.md` for the
duplication/refactor backlog.

## Verification (do this after touching generator or painter)

Generation and painting are fully deterministic for a given seed, so any refactor can be
verified byte-for-byte. There is no test runner; use ad-hoc Node harnesses, or the
browser tester `map-test.html`.

1. Syntax: `node --check map-generator.js && node --check map-painter.js && node --check faction-manager.js`
2. Generation: load `seasons.js` + `map-generator.js` with `vm.runInThisContext(...)` (they
   are classic scripts, not modules), then
   `new MapGenerator({ size: 120 }).generate(42)` and hash/serialize the result arrays.
3. Painting: `MapPainter` needs only a stub canvas with `createImageData` and
   `putImageData`. A stub whose `putImageData` hashes `image.data` (FNV-1a) lets you
   compare whole renders cheaply. Cover views × seasons × moods.

`node --check` refuses files without a `.js` extension, so copy to `/tmp/*.js` first.

`map-test.html` is the in-browser tester: it runs generation + painting, hashes the
result, and compares against a saved baseline, so optimizations can be tracked without
changing the visible result. Its `MAP_TEST` module is reusable from Node (extract it and
load it after the map scripts).

## Conventions

- `SECTION: ...` banners group code. File-level sections in `map-painter.js` mirror
  `MapGeneratorReference.js` naming (`MAP_COLORS`, `MAP_CONSTANTS`, `MAP_HASH & NOISE`,
  `MAP_SHADING`, `PIXEL_BUFFER`, ...). Class methods are ordered in pipeline order, not
  alphabetically.
- Colors are packed into single `Int32` values (`packRgb`); use `mixPacked`/`shadePacked`.
- Sprite dimensions are authored for a 12×12 tile and scaled via `px(n)` / `pxMin(n)`.
- Never introduce `Math.random()` in generation or painting — determinism is a feature.
  Use `createRandom` / `hash32` / `tileHash`.
- Comments and UI text are in Russian.
- Managers own their state; the map only stores what they pass via `apply*State` and
  notifies subscribers. Do not let `MapGenerator` reach into manager internals.
