/* Converts static Blockbench, glTF and Wavefront OBJ models to the MPSQ client bundle. */
async function importMpsqModel(file, pngFiles) {
  if(file.size>12000000)throw Error('Modell maximal 12 MB.');
  const text=await file.text(),ext=file.name.split('.').pop().toLowerCase(),source=ext==='obj'?null:JSON.parse(text);
  const textures={},read=blob=>new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});
  const files=new Map((pngFiles??[]).map(p=>[p.name.toLowerCase(),p]));
  if(ext==='obj'){
    const positions=[],uvs=[],vertices=[],indices=[];let textureFile=(pngFiles??[])[0];
    for(const raw of text.split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const p=line.split(/\s+/);
      if(p[0]==='v'&&p.length>=4)positions.push(p.slice(1,4).map(Number));
      else if(p[0]==='vt'&&p.length>=3)uvs.push([Number(p[1]),1-Number(p[2])]);
      else if(p[0]==='f'&&p.length>=4){const face=p.slice(1).map(t=>{const a=t.split('/'),pi=Number(a[0]),ui=Number(a[1]??0);return {p:positions[pi<0?positions.length+pi:pi-1],uv:ui?uvs[ui<0?uvs.length+ui:ui-1]:[0,0]};});for(let i=1;i<face.length-1;i++)for(const v of [face[0],face[i],face[i+1]]){if(!v.p)throw Error('OBJ enthält einen ungültigen Vertex.');indices.push(vertices.length);vertices.push([...v.p.map(n=>n*16),...v.uv]);}}
    }
    if(!vertices.length)throw Error('OBJ enthält keine Dreiecke.');if(vertices.length>200000)throw Error('Modell hat zu viele Flächen.');
    textures['0']=textureFile?await read(textureFile):null;if(!textures['0'])throw Error('Zum OBJ-Modell muss die PNG-Textur mit ausgewählt werden.');
    return {format:1,elements:[],meshes:[{texture:'0',vertices,indices}],textures};
  }
  if(ext==='gltf'){
    const gltf=source;if(!Array.isArray(gltf.meshes)||!gltf.buffers?.[0]?.uri?.startsWith('data:'))throw Error('Bitte ein GLTF mit eingebettetem Buffer verwenden.');
    const bin=Uint8Array.from(atob(gltf.buffers[0].uri.split(',')[1]),c=>c.charCodeAt(0)),dv=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);
    for(const [i,image] of (gltf.images??[]).entries()){if(!image.uri?.startsWith('data:image/png;base64,'))throw Error('GLTF-Bild muss eingebettet und als PNG vorliegen.');textures[String(i)]=image.uri;}
    if(!Object.keys(textures).length)throw Error('GLTF enthält keine Textur.');
    const component={5120:[1,'getInt8'],5121:[1,'getUint8'],5122:[2,'getInt16'],5123:[2,'getUint16'],5125:[4,'getUint32'],5126:[4,'getFloat32']},width={SCALAR:1,VEC2:2,VEC3:3,VEC4:4};
    function accessor(index){const a=gltf.accessors[index],view=gltf.bufferViews[a.bufferView],spec=component[a.componentType],n=width[a.type];if(!a||!view||!spec||!n)throw Error('GLTF-Accessor wird nicht unterstützt.');const stride=view.byteStride??spec[0]*n,base=(view.byteOffset??0)+(a.byteOffset??0),out=[];for(let i=0;i<a.count;i++){const row=[];for(let k=0;k<n;k++)row.push(dv[spec[1]](base+i*stride+k*spec[0],true));out.push(row);}return out;}
    const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    function mul(a,b){const o=Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)o[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];return o;}
    function local(n){if(n.matrix)return n.matrix;const [x,y,z,w]=n.rotation??[0,0,0,1],[sx,sy,sz]=n.scale??[1,1,1], [tx,ty,tz]=n.translation??[0,0,0];const r=[1-2*y*y-2*z*z,2*x*y+2*w*z,2*x*z-2*w*y,0,2*x*y-2*w*z,1-2*x*x-2*z*z,2*y*z+2*w*x,0,2*x*z+2*w*y,2*y*z-2*w*x,1-2*x*x-2*y*y,0,tx,ty,tz,1];return mul(r,[sx,0,0,0,0,sy,0,0,0,0,sz,0,0,0,0,1]);}
    const meshes=[];let total=0;
    function addMesh(meshIndex,matrix){for(const primitive of gltf.meshes[meshIndex].primitives??[]){if((primitive.mode??4)!==4)continue;const pa=accessor(primitive.attributes.POSITION),uv=primitive.attributes.TEXCOORD_0===undefined?pa.map(()=>[0,0]):accessor(primitive.attributes.TEXCOORD_0),idx=primitive.indices===undefined?pa.map((_,i)=>i):accessor(primitive.indices).map(r=>r[0]);const vertices=pa.map((p,i)=>{const x=p[0],y=p[1],z=p[2],w=matrix[3]*x+matrix[7]*y+matrix[11]*z+matrix[15];return [16*(matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12])/w,16*(matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13])/w,16*(matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14])/w,uv[i][0],uv[i][1]];});total+=vertices.length;if(total>200000)throw Error('GLTF-Modell hat zu viele Vertices.');meshes.push({texture:'0',vertices,indices:idx});}}
    function visit(i,parent){const n=gltf.nodes[i],matrix=mul(parent,local(n));if(n.mesh!==undefined)addMesh(n.mesh,matrix);for(const child of n.children??[])visit(child,matrix);}
    const scene=gltf.scenes?.[gltf.scene??0];for(const i of scene?.nodes??gltf.nodes.map((_,i)=>i).filter(i=>!gltf.nodes.some(n=>n.children?.includes(i))))visit(i,identity());
    if(!meshes.length)throw Error('GLTF enthält keine unterstützten Dreiecksflächen.');return {format:1,elements:[],meshes,textures};
  }
  const bb=ext==='bbmodel';if(!['bbmodel','json'].includes(ext))throw Error('Unterstützt werden .bbmodel, .json, .gltf oder .obj.');
  if(!Array.isArray(source.elements)||!source.elements.length)throw Error('Das Blockbench-Modell muss Würfelelemente enthalten.');
  if(source.animations?.length)throw Error('Bitte Animationen vor dem Export entfernen.');
  function checkGroups(groups){for(const g of groups??[]){if(typeof g!=='object')continue;if(g.rotation?.some(v=>v!==0))throw Error('Gruppenrotationen vor dem Export auf die Würfel anwenden.');checkGroups(g.children);}}if(bb)checkGroups(source.outliner);
  const aliases={},pngMap=new Map((pngFiles??[]).map(p=>[p.name.replace(/\.png$/i,'').toLowerCase(),p]));
  if(bb){for(let i=0;i<(source.textures??[]).length;i++){const t=source.textures[i];let data=t.source;if(!data?.startsWith('data:image/png;base64,')){const png=pngMap.get((t.name??'').replace(/\.png$/i,'').toLowerCase());if(!png)throw Error('Fehlende Textur: '+t.name);data=await read(png);}textures[String(i)]=data;}}
  else{for(const [k,v] of Object.entries(source.textures??{})){if(v.startsWith('#')){aliases[k]=v.slice(1);continue;}const name=v.split('/').pop().replace(/\.png$/i,'').toLowerCase(),png=pngMap.get(name);if(!png)throw Error('PNG fehlt: '+name+'.png');textures[k]=await read(png);}for(const k of Object.keys(aliases)){let target=k,seen=new Set();while(aliases[target]){if(seen.has(target))throw Error('Zyklischer Texturverweis');seen.add(target);target=aliases[target];}if(!textures[target])throw Error('Texturverweis fehlt');textures[k]=textures[target];}}
  const elements=source.elements.filter(e=>e.visibility!==false).map(e=>{if(e.type&&e.type!=='cube')throw Error('Dieses Blockbench-Meshformat wird nicht unterstützt. Bitte als GLTF oder OBJ exportieren.');const rotation=[0,0,0];let origin=e.origin??[8,8,8];if(bb){if(e.rotation)rotation.splice(0,3,...e.rotation);}else if(e.rotation){origin=e.rotation.origin??origin;rotation['xyz'.indexOf(e.rotation.axis)]=e.rotation.angle;if(e.rotation.rescale)throw Error('Rotation mit rescale bitte vor dem Export anwenden.');}const faces={};for(const [side,f]of Object.entries(e.faces??{})){if(f.texture==null)continue;const texture=String(f.texture).replace(/^#/,'');if(!textures[texture])throw Error('Textur fehlt für Fläche '+side);if(!f.uv)throw Error('Bitte explizite UV-Koordinaten exportieren.');const w=bb?(source.resolution?.width??16):16,h=bb?(source.resolution?.height??16):16;faces[side]={texture,uv:f.uv.map((v,i)=>v/(i%2?h:w)),rotation:f.rotation??0};}return {from:e.from,to:e.to,origin,rotation,faces};});
  return {format:1,elements,meshes:[],textures};
}
