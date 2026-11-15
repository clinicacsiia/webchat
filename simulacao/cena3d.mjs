// Fluxo: etapas (área externa + clínica) e pontos de atenção → cena 3D onde SÓ os pontos de atenção ganham corpo, cor, gente e luz; o resto aparece como contorno fantasma.
// Versão 1.0 — 15/11/2026 / Mudança: criação (three.js 0.160 pelo importmap da página; se o navegador não tiver WebGL, devolve null e a página mostra a lista).
// Escala: cada "pessoa" é uma figura pequena; a quantidade desenhada é proporcional ao número real, limitada a 90 por espaço.
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {LEVELS} from './analise.mjs';

const UNIT_COLORS={csi1:0x3987e5,csi2:0xd95926,ped:0x199e70};
const UNIT_NAMES={csi1:'CSI 1',csi2:'CSI 2',ped:'CSI Pediatria'};
// Posições no chão: o caminho do paciente da esquerda para a direita; a clínica à direita, com as 3 unidades.
const PAD_X={chat:-19,pedidos:-13.5,confirmar:-8,agenda:-2.5,hoje:3,resultado:21};
const PAD_Z={chat:2.6,pedidos:-2.6,confirmar:2.6,agenda:-2.6,hoje:2.6,resultado:0};
const CLINIC={x:12,z:{csi1:-6.5,csi2:0,ped:6.5}};
const SEVERITY_RANK={critical:3,serious:2,warning:1,info:0,good:0};

function seeded(seed){let v=seed>>>0;return()=>{v=(Math.imul(1664525,v)+1013904223)>>>0;return v/4294967296;};}

export function webglAvailable(){
 try{const canvas=document.createElement('canvas');return !!(canvas.getContext('webgl2')||canvas.getContext('webgl'));}catch{return false;}
}

export function createScene(container,{onSelect=()=>{}}={}){
 if(!webglAvailable())return null;
 let renderer;
 try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});}catch{return null;}
 renderer.setPixelRatio(Math.min(2,window.devicePixelRatio||1));
 renderer.setClearColor(0x101c27);
 const canvas=renderer.domElement;
 canvas.setAttribute('role','img');
 canvas.setAttribute('aria-label','Cena 3D com os pontos de atenção da clínica. A lista ao lado traz as mesmas informações em texto.');
 container.prepend(canvas);
 const labels=document.createElement('div');
 labels.className='labels3d';
 container.append(labels);
 const scene=new THREE.Scene();
 scene.fog=new THREE.Fog(0x101c27,38,80);
 const camera=new THREE.PerspectiveCamera(42,1,.1,200);
 camera.position.set(1,15,27);
 const controls=new OrbitControls(camera,canvas);
 controls.target.set(1,0,0);
 controls.enableDamping=true;controls.dampingFactor=.08;
 controls.maxPolarAngle=Math.PI*.47;controls.minDistance=7;controls.maxDistance=52;
 controls.autoRotate=true;controls.autoRotateSpeed=.35;
 controls.addEventListener('start',()=>{controls.autoRotate=false;});
 scene.add(new THREE.HemisphereLight(0xcfe8ff,0x1a2a38,1.1));
 const sun=new THREE.DirectionalLight(0xffffff,1.1);
 sun.position.set(-8,16,10);scene.add(sun);
 // chão
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(90,40),new THREE.MeshStandardMaterial({color:0x172635,roughness:1}));
 ground.rotation.x=-Math.PI/2;ground.position.set(1,-.02,0);scene.add(ground);
 const grid=new THREE.GridHelper(90,45,0x2a4258,0x1f3347);grid.position.set(2,0,0);grid.material.transparent=true;grid.material.opacity=.45;scene.add(grid);

 const world=new THREE.Group();scene.add(world);
 const pulses=[];
 const personGeo=new THREE.CapsuleGeometry(.15,.38,3,8);
 const labelEls=[];
 let disposed=false,running=false,raf=0,state={attention:[],ghost:[],people:0,labels:0};

 const ghostMat=()=>new THREE.MeshBasicMaterial({color:0x4a6a85,transparent:true,opacity:.09,depthWrite:false});
 const ghostLine=()=>new THREE.LineBasicMaterial({color:0x5f819c,transparent:true,opacity:.35});

 function label(position,html,level,id){
  const el=document.createElement('button');
  el.type='button';el.className='label3d';el.dataset.level=level;el.dataset.id=id;
  el.style.setProperty('--lv',level?LEVELS[level]?.color??'#7f98a6':'#7f98a6');
  el.innerHTML=html;
  el.addEventListener('click',()=>onSelect(id));
  labels.append(el);
  labelEls.push({el,position:position.clone()});
  return el;
 }

 function addPad(stage,pointsOfStage,index){
  const x=PAD_X[stage.id];
  if(x===undefined)return;
  const radius=Math.max(1.2,Math.min(2.7,1.0+.5*Math.sqrt(Math.max(.5,stage.dias??2))));
  const z=PAD_Z[stage.id]??0;
  const group=new THREE.Group();group.position.set(x,0,z);world.add(group);
  const attention=pointsOfStage.length>0;
  const level=attention?pointsOfStage.reduce((w,p)=>SEVERITY_RANK[p.nivel]>SEVERITY_RANK[w]?p.nivel:w,'warning'):'good';
  const color=new THREE.Color(LEVELS[level].color);
  if(!attention){
   const disc=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,.05,40),ghostMat());disc.position.y=.03;group.add(disc);
   const ring=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.CylinderGeometry(radius,radius,.05,40)),ghostLine());ring.position.y=.03;group.add(ring);
   label(new THREE.Vector3(x,.9,z),'<span class="l-name">'+stage.curto+'</span><span class="l-ok">em ordem</span>','good','ghost-'+stage.id);
   state.ghost.push(stage.id);
   return;
  }
  const disc=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,.18,48),new THREE.MeshStandardMaterial({color:0x22384c,roughness:.8}));disc.position.y=.09;group.add(disc);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(radius,.08,10,64),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.8}));ring.rotation.x=Math.PI/2;ring.position.y=.2;group.add(ring);
  // gente: proporcional ao número real
  const media=stage.mediaDia??100;
  const count=Math.min(90,Math.max(1,Math.round(stage.n/Math.max(1,media/18))));
  const people=new THREE.InstancedMesh(personGeo,new THREE.MeshStandardMaterial({color,roughness:.5,emissive:color,emissiveIntensity:.25}),count);
  const rand=seeded(1000+index*77);
  const dummy=new THREE.Object3D();
  for(let i=0;i<count;i++){
   const angle=i*2.399963,r=Math.sqrt((i+.5)/count)*(radius-.35);
   dummy.position.set(Math.cos(angle)*r,.5,Math.sin(angle)*r);
   dummy.rotation.y=rand()*6.28;dummy.scale.setScalar(.9+rand()*.25);
   dummy.updateMatrix();people.setMatrixAt(i,dummy.matrix);
  }
  group.add(people);state.people+=count;
  // coluna de luz
  const height=2.2+SEVERITY_RANK[level]*.9;
  const beam=new THREE.Mesh(new THREE.CylinderGeometry(.14,radius*.55,height,24,1,true),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.22,depthWrite:false,side:THREE.DoubleSide}));
  beam.position.y=height/2+.2;group.add(beam);pulses.push({beam,ring,phase:index});
  const top=pointsOfStage[0];
  const name=stage.curto;
  label(new THREE.Vector3(x,height+.9,z),'<span class="l-sym">'+LEVELS[level].symbol+'</span> <span class="l-name">'+name+'</span><span class="l-n">'+Number(stage.n).toLocaleString('pt-BR')+'</span><span class="l-t">'+escapeText(shorten(top.texto,110))+'</span>',level,top.id);
  state.attention.push(stage.id);
 }

 function addClinic(pointsOfClinic,sim){
  const byUnit={};
  for(const p of pointsOfClinic)if(p.unidades)for(const u of Object.keys(p.unidades))(byUnit[u]??=[]).push(p);
  const general=pointsOfClinic.filter(p=>!p.unidades);
  let index=20;
  for(const unit of Object.keys(CLINIC.z)){
   const pts=[...(byUnit[unit]??[])];
   const z=CLINIC.z[unit],attention=pts.length>0;
   const group=new THREE.Group();group.position.set(CLINIC.x,0,z);world.add(group);
   const w=4.8,d=3,h=2.2;
   const geo=new THREE.BoxGeometry(w,h,d);
   const unitColor=new THREE.Color(UNIT_COLORS[unit]);
   if(!attention){
    const box=new THREE.Mesh(geo,ghostMat());box.position.y=h/2;group.add(box);
    const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geo),ghostLine());edges.position.y=h/2;group.add(edges);
    label(new THREE.Vector3(CLINIC.x,h+.8,z),'<span class="l-name">'+UNIT_NAMES[unit]+'</span><span class="l-ok">sem alerta</span>','good','ghost-'+unit);
    state.ghost.push('clinica-'+unit);
    continue;
   }
   const level=pts.reduce((wst,p)=>SEVERITY_RANK[p.nivel]>SEVERITY_RANK[wst]?p.nivel:wst,'warning');
   const color=new THREE.Color(LEVELS[level].color);
   const box=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:unitColor,roughness:.6,transparent:true,opacity:.92}));box.position.y=h/2;group.add(box);
   const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geo),new THREE.LineBasicMaterial({color:color}));edges.position.y=h/2;group.add(edges);
   const waiting=sim?.waitingByUnit?.[unit]??1;
   const count=Math.min(70,Math.max(3,waiting*2));
   const people=new THREE.InstancedMesh(personGeo,new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.3,roughness:.5}),count);
   const rand=seeded(500+index);const dummy=new THREE.Object3D();
   for(let i=0;i<count;i++){dummy.position.set(-w/2+.3+(i%14)*.34,.42,d/2+.7+Math.floor(i/14)*.38);dummy.rotation.y=rand()*6.28;dummy.updateMatrix();people.setMatrixAt(i,dummy.matrix);}
   group.add(people);state.people+=count;
   const beam=new THREE.Mesh(new THREE.CylinderGeometry(.12,1.5,5,24,1,true),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.22,depthWrite:false,side:THREE.DoubleSide}));
   beam.position.y=h+2.5;group.add(beam);pulses.push({beam,ring:edges,phase:index++});
   const top=pts[0];
   label(new THREE.Vector3(CLINIC.x,h+4.2,z),'<span class="l-sym">'+LEVELS[level].symbol+'</span> <span class="l-name">'+UNIT_NAMES[unit]+'</span><span class="l-t">'+escapeText(shorten(top.titulo,70))+'</span>',level,top.id);
   state.attention.push('clinica-'+unit);
  }
  if(general.length){
   const top=general[0];
   label(new THREE.Vector3(CLINIC.x,8.2,0),'<span class="l-sym">'+LEVELS[top.nivel].symbol+'</span> <span class="l-name">Clínica</span><span class="l-t">'+escapeText(shorten(top.titulo,70))+'</span>',top.nivel,top.id);
  }
 }

 function addPath(){
  const pts=[['chat'],['pedidos'],['confirmar'],['agenda'],['hoje']].map(([id])=>new THREE.Vector3(PAD_X[id],.04,PAD_Z[id])).concat([new THREE.Vector3(CLINIC.x-3.2,.04,0),new THREE.Vector3(CLINIC.x+3.2,.04,0),new THREE.Vector3(PAD_X.resultado,.04,PAD_Z.resultado)]);
  const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineDashedMaterial({color:0x5f819c,dashSize:.5,gapSize:.35,transparent:true,opacity:.6}));
  line.computeLineDistances();world.add(line);
 }

 function clearWorld(){
  while(world.children.length){const child=world.children.pop();child.traverse(o=>{if(o.geometry&&o.geometry!==personGeo)o.geometry.dispose();if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose());});}
  pulses.length=0;labels.replaceChildren();labelEls.length=0;
  state={attention:[],ghost:[],people:0,labels:0};
 }

 function setData({stages=[],pontos=[],sim=null}){
  clearWorld();
  addPath();
  const mediaDia=stages.find(s=>s.mediaDia)?.mediaDia;
  stages.filter(s=>s.lane!=='clinica').forEach((stage,index)=>{
   const mine=pontos.filter(p=>p.stage===stage.id);
   addPad({...stage,mediaDia:stage.mediaDia??mediaDia},mine,index);
  });
  addClinic(pontos.filter(p=>p.stage==='clinica'),sim);
  state.labels=labelEls.length;
 }

 function focusOn(stageId){
  const x=stageId==='clinica'?CLINIC.x:PAD_X[stageId];
  if(x===undefined)return;
  controls.autoRotate=false;
  const z=stageId==='clinica'?0:(PAD_Z[stageId]??0);
  const target=new THREE.Vector3(x,0,z),from=camera.position.clone(),to=new THREE.Vector3(x+(stageId==='clinica'?-3:2),8,z+(stageId==='clinica'?16:11));
  const t0=performance.now(),from0=controls.target.clone();
  const tween=now=>{
   const k=Math.min(1,(now-t0)/700),e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;
   camera.position.lerpVectors(from,to,e);controls.target.lerpVectors(from0,target,e);
   if(k<1&&!disposed)requestAnimationFrame(tween);
  };
  requestAnimationFrame(tween);
 }

 const tmp=new THREE.Vector3();
 function frame(time){
  raf=0;
  if(disposed||!running)return;
  for(const p of pulses){const k=.5+.5*Math.sin(time/450+p.phase);p.beam.material.opacity=.14+.16*k;if(p.ring.material.emissiveIntensity!==undefined)p.ring.material.emissiveIntensity=.5+.8*k;}
  controls.update();
  renderer.render(scene,camera);
  const rect=container.getBoundingClientRect();
  for(const item of labelEls){
   tmp.copy(item.position).project(camera);
   const visible=tmp.z<1&&Math.abs(tmp.x)<1.1&&Math.abs(tmp.y)<1.1;
   item.el.style.display=visible?'':'none';
   if(visible)item.el.style.transform='translate(-50%,-100%) translate('+((tmp.x*.5+.5)*rect.width).toFixed(1)+'px,'+((-tmp.y*.5+.5)*rect.height).toFixed(1)+'px)';
  }
  raf=requestAnimationFrame(frame);
 }
 function start(){if(running||disposed)return;running=true;raf=requestAnimationFrame(frame);}
 function stop(){running=false;if(raf)cancelAnimationFrame(raf);raf=0;}
 function resize(){
  const w=container.clientWidth||600,h=container.clientHeight||420;
  renderer.setSize(w,h,false);canvas.style.width='100%';canvas.style.height='100%';
  camera.aspect=w/h;camera.updateProjectionMatrix();
  camera.fov=w<520?55:42;camera.updateProjectionMatrix();
 }
 const observer=new IntersectionObserver(entries=>{for(const e of entries)e.isIntersecting&&!document.hidden?start():stop();},{threshold:.05});
 observer.observe(container);
 const onVisibility=()=>{document.hidden?stop():start();};
 document.addEventListener('visibilitychange',onVisibility);
 const onResize=()=>resize();
 window.addEventListener('resize',onResize);
 resize();
 return {
  setData,focusOn,resize,start,stop,
  toggleRotate(){controls.autoRotate=!controls.autoRotate;return controls.autoRotate;},
  resetView(){camera.position.set(1,15,27);controls.target.set(1,0,0);controls.autoRotate=true;},
  snapshot(){renderer.render(scene,camera);return canvas.toDataURL('image/png');},
  state:()=>({...state,attention:[...state.attention],ghost:[...state.ghost]}),
  dispose(){disposed=true;stop();observer.disconnect();document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('resize',onResize);clearWorld();renderer.dispose();canvas.remove();labels.remove();}
 };
}
function shorten(text,max){return text.length>max?text.slice(0,max-1)+'…':text;}
function escapeText(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
