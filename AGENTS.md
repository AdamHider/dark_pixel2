# AGENTS.md

## Project

Browser-based pixel-art fantasy map generator. Plain ES classes, no build step, no
dependencies. Scripts are loaded in `index.html` in dependency order:
`map-generator.js` → `seasons.js` → `map-painter.js` → `sprite-renderer.js` →
`sprite-examples.js` → `map-renderer.js` → `core-module.js` → `faction-manager.js` →
`turn-manager.js` → `economy-manager.js` → `faction-economy.js` →
`construction-manager.js` → `army-manager.js` → `diplomacy-manager.js` → `ui-renderer.js`
→ `main.js`.

`core-module.js` defines `GameModule`, the base class every `*-manager.js` extends (it
owns `attach`, `onChange`, `emit`). It must load before any manager. `faction-manager.js`
reads `Resource`, `ResourceInfo`, `Terrain` from `map-generator.js`, so it must load after
it.

Architecture: `MapGenerator` fills flat typed arrays; `MapPainter` renders them once into
an offscreen 1:1 canvas; `MapRenderer` is just a camera over that canvas. `FactionManager`
is a separate module that owns faction state and hands it to the map via
`map.applyFactionState` (the map only stores and shows it).

See `CODE_GUIDE.md` for the full function-by-function guide and `OPTIMIZATION.md` for the
duplication/refactor backlog.

## Verification (do this after touching generator or painter)

Generation and painting are fully deterministic for a given seed, so any refactor can be
verified byte-for-byte. The canonical check is the Node harness `tools/baseline.js`
(79 cases: 3 seeds of generation + every view × season × mood × borders render + sprites):

    node tools/baseline.js check        # map generation/painting/sprites: "OK: 79 случаев"
    node tools/sim-baseline.js check    # managers/turns/armies: "OK: 7 шагов"

`tools/baseline.json` and `tools/sim-baseline.json` are the frozen references — do not
regenerate them during a refactor, or you lose the safety net. `save` is only for
deliberately accepting a new baseline. The sim harness drives the same manager wiring as
`connectManagers()` in `main.js` (factions → economy → construction → armies → diplomacy →
turns) through 6 deterministic turns with recruit/move/attack/build orders.

Additional ad-hoc checks, if needed:

1. Syntax: `node --check map-generator.js && node --check map-painter.js && node --check army-manager.js`
2. Generation: load `seasons.js` + `map-generator.js` with `vm.runInThisContext(...)` (they
   are classic scripts, not modules), then
   `new MapGenerator({ size: 120 }).generate(42)` and hash/serialize the result arrays.
3. Painting: `MapPainter` needs only a stub canvas with `createImageData` and
   `putImageData`. A stub whose `putImageData` hashes `image.data` (FNV-1a) lets you
   compare whole renders cheaply. Cover views × seasons × moods.

`node --check` refuses files without a `.js` extension, so copy to `/tmp/*.js` first.

`tools/map-test.html` is the in-browser tester: it runs generation + painting, hashes the
result, and compares against a saved baseline, so optimizations can be tracked without
changing the visible result. Its `MAP_TEST` module is reusable from Node (extract it and
load it after the map scripts).

## Conventions

- `SECTION: ...` banners (inside `/* ===== */` blocks) group code, both file-level and
  per class. Names mirror `docs/MapGeneratorReference.js` where they overlap (`MAP_COLORS`,
  `MAP_CONSTANTS`, `MAP_HASH_NOISE`, `MAP_SHADING`, `PIXEL_BUFFER`, ...). Full map is in
  `CODE_GUIDE.md` §12. Class methods are ordered in pipeline order, not alphabetically.
- Colors are packed into single `Int32` values (`packRgb`); use `mixPacked`/`shadePacked`.
- Sprite dimensions are authored for a 12×12 tile and scaled via `px(n)` / `pxMin(n)`.
- Never introduce `Math.random()` in generation or painting — determinism is a feature.
  Use `createRandom` / `hash32` / `tileHash`.
- Comments and UI text are in Russian.
- Managers own their state; the map only stores what they pass via `apply*State` and
  notifies subscribers. Do not let `MapGenerator` reach into manager internals.
