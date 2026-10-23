// node bench.js "gen.js,painter.js" size tile  — прогрев + 8 смен сезона по кругу, медиана и разброс
const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync('paintertest.js','utf8');
eval(src.slice(src.indexOf('const palette'), src.indexOf('const SCENARIOS')).replace(/const (palette|seasons|makeContext)/g,'var $1'));
globalThis.SEASONS=seasons(false); globalThis.DARK_SEASONS=seasons(true);
globalThis.document={createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}})})};
for(const f of process.argv[2].split(',')) vm.runInThisContext(fs.readFileSync(f,'utf8'),{filename:f});
const SIZE=+process.argv[3]||110, T=+process.argv[4]||12, MOOD=process.argv[5]||'light';
const map=vm.runInThisContext(`new MapGenerator({size:${SIZE},seed:4}).generate(4)`);
const P=vm.runInThisContext('MapPainter'); const p=new P(map,{tileSize:T});
const base={view:'terrain',showBorders:true,mood:MOOD};
const time=a=>{const t=process.hrtime.bigint(); p.paint({...base,...a}); return Number(process.hrtime.bigint()-t)/1e6;};
const first=time({seasonName:'summer'});
for(const s of ['winter','autumn','spring']) time({seasonName:s});                  // прогрев JIT и кэшей
const seq=['winter','summer','autumn','spring'], runs=[];
for(let i=0;i<8;i++) runs.push(time({seasonName:seq[i%4]}));
runs.sort((a,b)=>a-b);
console.log(`первая ${first.toFixed(0)} мс | смена сезона: медиана ${runs[4].toFixed(0)} мс, мин ${runs[0].toFixed(0)}, макс ${runs[7].toFixed(0)}`);
