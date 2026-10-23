const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync('paintertest.js','utf8');
eval(src.slice(src.indexOf('const palette'), src.indexOf('const SCENARIOS')).replace(/const (palette|seasons|makeContext)/g,'var $1'));
globalThis.SEASONS=seasons(false); globalThis.DARK_SEASONS=seasons(true);
globalThis.document={createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData(){}})})};
for(const f of ["../gen2/map-generator.js","../painter2/map-painter.js"]) vm.runInThisContext(fs.readFileSync(f,'utf8'),{filename:f});
const P=vm.runInThisContext('MapPainter');
const map=vm.runInThisContext('new MapGenerator({size:20,seed:1}).generate(1)');
let rng=12345; const rand=()=>((rng=(Math.imul(rng,1103515245)+12345)>>>0)/4294967296);
function make(W,kind,n){
  const o=new Int16Array(W*W);
  if(kind==='voronoi'){ const sx=[],sy=[]; for(let i=0;i<n;i++){sx.push(rand()*W);sy.push(rand()*W);}
    for(let y=0;y<W;y++)for(let x=0;x<W;x++){let b=0,bd=1e18;for(let i=0;i<n;i++){const d=(x-sx[i])**2+(y-sy[i])**2;if(d<bd){bd=d;b=i;}} o[y*W+x]=b;} }
  else if(kind==='noise'){ for(let i=0;i<o.length;i++) o[i]=Math.floor(rand()*n); }
  else if(kind==='holes'){ const v=make(W,'voronoi',n); for(let i=0;i<o.length;i++) o[i]= rand()<0.15 ? -1 : v[i]; return v.map((x,i)=>o[i]); }
  else if(kind==='blocks'){ for(let y=0;y<W;y++)for(let x=0;x<W;x++) o[y*W+x]=((x>>2)*7+(y>>2)*13)%n; }
  return o;
}
let bad=0,cases=0;
for(const [kind,n] of [['voronoi',5],['voronoi',40],['voronoi',120],['noise',3],['noise',25],['holes',30],['blocks',9],['blocks',70]]){
  for(const r of [1,2,3,5,7,9]){
    const W=150; const p=new P(map,{tileSize:12,regionBorderSmoothing:r}); p.dim={size:20,T:12,W};
    const owner=make(W,kind,n);
    const a=p.smoothPixelRegions(Int16Array.from(owner)), b=p.smoothPixelRegionsDirect(Int16Array.from(owner));
    let diff=0; for(let i=0;i<a.length;i++) if(a[i]!==b[i]) diff++;
    cases++; if(diff){bad++; console.log('РАСХОЖДЕНИЕ',kind,n,'r',r,'пикселей',diff);}
  }
}
console.log(bad?`ПРОВАЛ: ${bad} из ${cases}`:`все ${cases} случаев идентичны прямому перебору`);
