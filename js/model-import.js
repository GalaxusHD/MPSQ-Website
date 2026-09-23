/* Static cuboid accessories: Java item models and Blockbench projects. */
async function importMpsqModel(file, pngFiles) {
  if(file.size>12000000)throw Error('Modell maximal 12 MB.');
  const source=JSON.parse(await file.text()), bb=file.name.toLowerCase().endsWith('.bbmodel');
  if(!Array.isArray(source.elements)||!source.elements.length)throw Error('Das Modell muss eigene Würfelelemente enthalten. Geerbte Modelle zuerst in Blockbench auflösen.');
  if(source.animations?.length)throw Error('Accessoires unterstützen statische Modelle. Animationen vor dem Export entfernen.');
  function checkGroups(groups){for(const g of groups??[]){if(typeof g!=='object')continue;if(g.rotation?.some(v=>v!==0))throw Error('Gruppenrotationen vor dem Export auf die Würfel anwenden.');checkGroups(g.children);}}
  if(bb)checkGroups(source.outliner);
  const textures={}, aliases={}, files=new Map();
  for(const png of pngFiles??[]){if(png.size>2000000)throw Error('PNG maximal 2 MB.');files.set(png.name.replace(/\.png$/i,''),png);}
  const read=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});
  if(bb){
    for(let i=0;i<(source.textures??[]).length;i++){
      const t=source.textures[i];let data=t.source;
      if(!data?.startsWith('data:image/png;base64,')){
        const png=files.get((t.name??'').replace(/\.png$/i,''));
        if(!png)throw Error('Fehlende Textur: '+t.name); data=await read(png);
      }
      textures[String(i)]=data;
    }
  }else{
    for(const [key,value] of Object.entries(source.textures??{})){
      if(value.startsWith('#')){aliases[key]=value.slice(1);continue;}
      const name=value.split('/').pop().replace(/\.png$/i,'');
      const png=files.get(name);if(!png)throw Error('PNG fehlt: '+name+'.png');
      textures[key]=await read(png);
    }
    for(const key of Object.keys(aliases)){let target=key;const seen=new Set();while(aliases[target]){if(seen.has(target))throw Error('Zyklischer Texturverweis');seen.add(target);target=aliases[target];}if(!textures[target])throw Error('Texturverweis fehlt');textures[key]=textures[target];}
  }
  const elements=source.elements.filter(e=>e.visibility!==false).map(e=>{
    if(e.type&&e.type!=='cube')throw Error('Mesh-Elemente werden nicht unterstützt; bitte Würfel verwenden.');
    const rotation=[0,0,0];let origin=e.origin??[8,8,8];
    if(bb){if(e.rotation)rotation.splice(0,3,...e.rotation);}
    else if(e.rotation){origin=e.rotation.origin??origin;rotation['xyz'.indexOf(e.rotation.axis)]=e.rotation.angle;if(e.rotation.rescale)throw Error('Rotation mit rescale bitte vor dem Export anwenden.');}
    const faces={};
    for(const [side,f] of Object.entries(e.faces??{})){
      if(f.texture===null||f.texture===undefined)continue;
      const texture=String(f.texture).replace(/^#/,'');
      if(!textures[texture])throw Error('Textur fehlt für Fläche '+side);
      if(!f.uv)throw Error('Bitte explizite UV-Koordinaten exportieren.');
      const w=bb?(source.resolution?.width??16):16, h=bb?(source.resolution?.height??16):16;
      faces[side]={texture,uv:f.uv.map((v,i)=>v/(i%2?h:w)),rotation:f.rotation??0};
    }
    return {from:e.from,to:e.to,origin,rotation,faces};
  });
  return {format:1,elements,textures};
}
