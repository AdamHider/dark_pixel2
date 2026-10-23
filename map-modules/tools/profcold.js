const fs=require('fs'),vm=require('vm'),inspector=require('inspector');
const src=fs.readFileSync('paintertest.js','utf8');
eval(src.slice(src.indexOf('const palette'), src.indexOf('const SCENARIOS')).replace(/const (palette|seasons|makeContext)/g,'var $1'));
globalThis.SEASONS=seasons(false); globalThis.DARK_SEASONS=seasons(true);
globalThis.document={createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}})})};
for(const f of process.argv[2].split(',')) vm.runInThisContext(fs.readFileSync(f,'utf8'),{filename:f});
const SIZE=+process.argv[3]||200;
const map=vm.runInThisContext(`new MapGenerator({size:${SIZE},seed:4}).generate(4)`);
const P=vm.runInThisContext('MapPainter');
// прогреть JIT на маленькой карте, чтобы холодная отрисовка большой не включала разогрев компилятора
{const m2=vm.runInThisContext('new MapGenerator({size:60,seed:9}).generate(9)'); const p0=new P(m2,{tileSize:12}); for(const s of ['summer','winter']) p0.paint({view:'terrain',seasonName:s,showBorders:true,mood:'light'});}
const names=['paintBase','smoothCoast','buildReliefHeights','paintHills','paintShores','buildShoreGeometry','paintRivers','buildRiverGeometry','paintRoads','buildRoadGeometry','paintSettlementGround','paintTexture','buildPixelRegions','paintRegionBorders','paintScene','buildFog','applyGrading','buildHillHeights','computeHills','speckLayout'];
const times={}; for(const n of names){const f=P.prototype[n]; if(!f) continue; P.prototype[n]=function(...a){const t=process.hrtime.bigint(); const r=f.apply(this,a); times[n]=(times[n]||0)+Number(process.hrtime.bigint()-t)/1e6; return r;};}
const p=new P(map,{tileSize:12});
const t0=process.hrtime.bigint(); p.paint({view:'terrain',seasonName:'summer',showBorders:true,mood:'light'}); const total=Number(process.hrtime.bigint()-t0)/1e6;
console.log(`холодная первая отрисовка ${SIZE}×${SIZE}: ${total.toFixed(0)} мс`);
console.log(Object.entries(times).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`  ${k.padEnd(24)}${v.toFixed(0).padStart(6)}`).join('\n'));
