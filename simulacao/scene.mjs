// Fluxo: tempos do motor → posições no mapa → desenho isométrico → seleção de paciente.
// Versão 1.3 — 15/11/2026 / Mudança: destaque do local e explicação no balão da ronda.
import {patientStatus,patientEmotions,team,types,units,patrols,patrolMessage} from './engine.mjs';

const atlas=new Image();
atlas.src='./assets/residents.png';
const furniture=new Image();
furniture.src='./assets/furniture.webp';
const sprites={desk:[6,101,108],plant:[7,74,87],pouf:[9,92,80]};
const colors={reception:'#5fa7a4',prep:'#b19bd0',consulta:'#c3a379',us:'#7fbc92',rm:'#8ea7d6',tc:'#b98998'};
const roomNames={reception:'Recepção',prep:'Preparo',consulta:'Consultas',us:'Ultrassom',rm:'Ressonância',tc:'Tomografia',eco:'Eco',rx:'Raio X',dmo:'Densitometria',mamo:'Mamografia',histero:'Histeroscopia'};
const active=['checkin','prep','exam'];
const queue=['reception','prepQueue','examQueue'];
const clamp=n=>Math.max(0,Math.min(1,n));
const lerp=(a,b,t)=>a+(b-a)*clamp(t);
const short=(s,n)=>s.length>n?s.slice(0,n-1)+'…':s;

export function createScenes(root,selectPerson){
 const scenes={};
 for(const [unit,name] of Object.entries(units)){
  const block=document.createElement('section');
  block.className='mini-unit';block.dataset.unit=unit;
  const title=document.createElement('h3');title.textContent=name;
  const caption=document.createElement('small');caption.style.paddingLeft='10px';
  const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=510;
  canvas.setAttribute('aria-label','Simulação visual de '+name+'. A jornada também pode ser consultada na tabela.');
  const map=document.createElement('div');
  map.className='patrol-map';
  const bubble=document.createElement('span');
  bubble.className='patrol-bubble';
  bubble.setAttribute('aria-hidden','true');
  map.append(canvas,bubble);block.append(title,caption,map);root.append(block);
  const scene=scenes[unit]={block,canvas,caption,bubble,targets:[],g:canvas.getContext('2d')};
  canvas.addEventListener('click',event=>{
   const rect=canvas.getBoundingClientRect();
   const x=(event.clientX-rect.left)*canvas.width/rect.width;
   const y=(event.clientY-rect.top)*canvas.height/rect.height;
   const targets=[...scene.targets].reverse();
   const distance=p=>Math.hypot(x-(p.x+10),y-(p.y-43));
   const badge=targets.filter(p=>distance(p)<=12).sort((a,b)=>distance(a)-distance(b))[0];
   const hit=badge??[...targets].sort((a,b)=>b.depth-a.depth).find(p=>Math.abs(x-p.x)<=17&&y>=p.y-38&&y<=p.y+4);
   if(hit)selectPerson(hit.person,hit.id);
  });
 }
 function focus(unit){
  root.dataset.focus=unit;
  for(const [id,scene] of Object.entries(scenes))scene.block.hidden=unit!=='all'&&unit!==id;
 }
 function draw(model,plan,time,selected,animate,patrolAlerts,inspection,timestamp){
  for(const [unit,scene] of Object.entries(scenes)){
   if(scene.block.hidden)continue;
   drawUnit(scene,unit,model,plan,time,selected,animate,patrolAlerts[unit],inspection?.unit===unit?inspection:null,timestamp);
  }
 }
 return {focus,draw};
}

function drawUnit(scene,unit,model,plan,time,selected,animate,alerts,inspection,timestamp){
 const {g,canvas}=scene;
 const jobs=model.jobs.filter(j=>j.unit===unit);
 const people=jobs.map(j=>({job:j,...patientStatus(j,time)})).filter(({job,status})=>
  !job.absent&&status!=='future'&&(status!=='finished'||time-job.end<2));
 const waiting=people.filter(p=>queue.includes(p.status)).length;
 const nextLabel=waiting+' em fila · '+people.filter(p=>active.includes(p.status)).length+' em atendimento/preparo';
 if(scene.caption.textContent!==nextLabel)scene.caption.textContent=nextLabel;
 const rooms=Object.keys(plan).filter(k=>k.startsWith(unit+':')).map(k=>k.split(':')[1]);
 const endY=17;
 const roomCols=Math.ceil(rooms.length/2);
 const w=Math.max(19,roomCols*4);
 const sx=Math.min(32,915/(w+endY)),sy=Math.min(15,385/(w+endY)),ox=47+endY*sx,oy=54;
 const iso=(x,y,z=0)=>[ox+(x-y)*sx,oy+(x+y)*sy-z];
 function shape(points,fill,stroke){
  g.beginPath();points.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.closePath();
  if(fill){g.fillStyle=fill;g.fill();}
  if(stroke){g.strokeStyle=stroke;g.stroke();}
 }
 function rect(x,y,dx,dy,fill,stroke){shape([iso(x,y),iso(x+dx,y),iso(x+dx,y+dy),iso(x,y+dy)],fill,stroke);}
 function wall(x,y,dx,dy,h,fill){shape([iso(x,y),iso(x+dx,y+dy),iso(x+dx,y+dy,h),iso(x,y,h)],fill,'#55727f');}
 function text(value,x,y,color='#edf7f5',size=15){g.font='600 '+size+'px system-ui';g.fillStyle=color;g.fillText(value,x,y);}
 function prop(item,x,y,width=36){
  if(!furniture.complete||!furniture.naturalWidth)return;
  const [row,sw,sh]=sprites[item];const [px,py]=iso(x,y);
  const h=width*sh/sw;g.drawImage(furniture,0,row*192,sw,sh,px-width/2,py-h,width,h);
 }
 g.clearRect(0,0,canvas.width,canvas.height);
 g.fillStyle='#142533';g.fillRect(0,0,canvas.width,canvas.height);
 rect(0,0,w,endY,'#253d50','#598491');
 for(let x=0;x<w;x++)for(let y=0;y<endY;y++)rect(x,y,1,1,(x+y)%2?'#22394a':'#294052','#2e4855');
 wall(0,0,w,0,24,'#395665');wall(0,0,0,endY,20,'#2d4d5b');
 rect(0,5.8,w,2,'#425d65');rect(0,13.7,w,2,'#425d65');
 rect(0,8.1,w,5.4,inspection?.area==='waiting'?'#62553b':'#40525b',inspection?.area==='waiting'?'#ffd07b':'#7c938e');
 prop('plant',.6,8.6,36);prop('plant',.6,13.5,36);
 for(let x=2;x<w-1;x+=2)prop('pouf',x,12.9,28);
 const [wx,wy]=iso(1,11);
 text('ESPERA',wx,wy,'#d0e0d7',14);
 const [ex,ey]=iso(.9,15.6);
 text('ENTRADA / SAÍDA',ex-10,ey+21,'#a4dac6',14);
 const dest={};
 const props=[];
 const roomFaces=[];
 for(const [i,type] of rooms.entries()){
  const top=i<roomCols, x=(i%roomCols)*4+.2, y=top?.25:14.9, dy=top?5.3:1.9;
  const color=colors[type]??'#84a6b2';
  const count=plan[unit+':'+type];
  if(inspection?.room===type&&inspection.area!=='waiting')g.lineWidth=4;
  rect(x,y,3.8,dy,color,g.lineWidth===4?'#ffd07b':'#93a8ad');
  g.lineWidth=1;
  if(top)wall(x,y,0,dy,16,'#355261');
  const [tx,ty]=iso(x+.45,y+.55,5);
  const offline=model.downtime?.key===unit+':'+type&&time>=model.downtime.from&&(model.downtime.to===null||time<model.downtime.to);
  roomFaces.push([short(roomNames[type]??types[type][0],15),tx,ty,offline]);
  const points=Array.from({length:count},(_,idx)=>{
   const slot=[x+.62+(idx%3)*1.14,top?y+2.1+Math.floor(idx/3)*1.35:y+.65+Math.floor(idx/3)*.75];
   props.push({x:slot[0]+.32,y:slot[1]+.43,kind:type==='prep'?'pouf':'desk',width:type==='prep'?20:24});
   return slot;
  });
  dest[type]={points,aisle:top?6.8:14.3};
 }
 const staff=team.flatMap(([name,u,,role],i)=>{
  if(u!==unit)return [];
  const sector=role==='exam'?rooms.find(t=>!['reception','prep'].includes(t)):role;
  const point=dest[sector]?.points[0]??[3,6.8];
  const patrol=role==='prep'?Math.sin(time*.8):0;
  return [{id:i,name,x:point[0]-.4+patrol*.45,y:point[1]+.8,row:i,staff:true,walk:animate&&role==='prep',face:Math.cos(time*.8)<0?Math.PI:0,tag:'✚'}];
 });
 const patrol=patrols[unit];
 const north=6.8,south=14.3,left=.85,right=w-.85;
 const span=right-left,cross=south-north;
 const distance=(timestamp/440+Object.keys(units).indexOf(unit)*8)%(2*(span+cross));
 const route=distance<span?[left+distance,north,0]
  :distance<span+cross?[right,north+distance-span,Math.PI/2]
  :distance<2*span+cross?[right-(distance-span-cross),south,Math.PI]
  :[left,south-(distance-2*span-cross),-Math.PI/2];
 const [px,py]=iso(route[0],route[1]);
 staff.push({id:patrol.row,name:patrol.name,x:route[0],y:route[1],face:route[2],row:patrol.row,staff:true,patrol:true,walk:true});
 const alert=alerts[Math.floor(timestamp/5200)%alerts.length];
 const message=inspection?inspection.problem+' Local: '+inspection.location+'. '+inspection.reason:
  alert?patrolMessage(alert,time):'Em ronda. Nenhum gargalo ativo.';
 const speech=patrol.name+' · '+message;
 if(scene.bubble.textContent!==speech)scene.bubble.textContent=speech;
 scene.bubble.dataset.alert=Boolean(inspection||alert);
 scene.bubble.style.left=Math.max(29,Math.min(71,100*px/canvas.width))+'%';
 scene.bubble.style.top=(py-49)/canvas.height*100+'%';
 const stableQueue=people.filter(p=>queue.includes(p.status)).sort((a,b)=>a.job.id-b.job.id);
 const waiters=new Map(stableQueue.map(({job},i)=>[job.id,i]));
 const width=Math.max(7,Math.floor((w-1.5)*1.5));
 function spot(j){
  const pos=waiters.get(j.id)??j.id%width;
  return [1.1+(pos%width)*.63,8.75+(Math.floor(pos/width)%10)*.43];
 }
 const figures=people.map(({job:j,status,mood})=>{
  const front=[.9,15], desk=dest.reception.points[(j.desk??1)-1]??front;
  const prep=dest.prep.points[(j.bay??1)-1]??desk;
  const exam=dest[j.type]?.points[(j.room??1)-1]??front;
  const wait=spot(j);
  let x,y,walk=false,face=0;
  function travel(a,b,progress,aisle){
   const path=aisle===undefined?[a,b]:[a,[a[0],aisle],[b[0],aisle],b];
   const distances=path.slice(1).map((p,i)=>Math.abs(p[0]-path[i][0])+Math.abs(p[1]-path[i][1]));
   let distance=clamp(progress)*distances.reduce((p,q)=>p+q,0);
   let idx=0;
   while(idx<distances.length-1&&distance>=distances[idx])distance-=distances[idx++];
   const begin=path[idx],end=path[idx+1],t=distances[idx]?distance/distances[idx]:1;
   x=lerp(begin[0],end[0],t);y=lerp(begin[1],end[1],t);
   face=Math.atan2(end[1]-begin[1],end[0]-begin[0]);walk=progress<1;
  }
  function arrive(origin,target,start,aisle){travel(origin,target, time-start,aisle);}
  if(status==='reception')arrive(front,wait,j.arrive,14.3);
  else if(status==='checkin')arrive(j.check-j.arrive>=1?wait:front,desk,j.check,dest.reception.aisle);
  else if(status==='prepQueue')arrive(desk,wait,j.registered,6.8);
  else if(status==='prep')arrive(j.prepare-j.registered>=1?wait:desk,prep,j.prepare,dest.prep.aisle);
  else if(status==='examQueue')arrive(j.prepare===null?desk:prep,wait,j.ready,6.8);
  else if(status==='exam')arrive(j.start-j.ready>=1?wait:j.prepare===null?desk:prep,exam,j.start,dest[j.type]?.aisle);
  else travel(exam,front,(time-j.end)/2,14.3);
  return {id:j.id,person:j.person,x,y,row:(j.person*7)%9,walk,face,mood,selected:j.person===selected};
 });
 scene.targets=[];
 for(const o of [...props,...staff,...figures].sort((a,b)=>a.x+a.y-b.x-b.y)){
  if(o.kind){prop(o.kind,o.x,o.y,o.width);continue;}
  const [px,py]=iso(o.x,o.y);
  g.fillStyle='#0b15228c';g.beginPath();g.ellipse(px,py,10,3,0,0,Math.PI*2);g.fill();
  if(o.selected){g.strokeStyle='#fed775';g.beginPath();g.ellipse(px,py,15,6,0,0,Math.PI*2);g.stroke();}
  if(atlas.complete&&atlas.naturalWidth){
   const direction=(Math.round((Math.PI/4-(o.face??0))/(Math.PI/4))+8)%8;
   const frame=o.walk&&(animate||o.patrol)?Math.floor(timestamp/85+o.id)%6:0;
   g.imageSmoothingEnabled=false;
   g.drawImage(atlas,(direction*6+frame)*24,o.row*32,24,32,px-15,py-38,30,40);
  }else text('●',px-6,py-10,'#e3ab78');
  if(o.staff||o.selected)text(o.staff?o.name:'P'+String(o.person).padStart(3,'0'),px-20,py-31,o.patrol?'#ffcc71':o.staff?'#d7f0d5':'#fff0b0',12);
  if(o.person)scene.targets.push({x:px,y:py,person:o.person,id:o.id,mood:o.mood,selected:o.selected,depth:o.x+o.y});
 }
 for(const [name,x,y,offline] of roomFaces)text(name+(offline?' · parada':''),x,y,offline?'#ffe2c7':'#1b2935',13);
 const badges=scene.targets.sort((a,b)=>Number(a.mood==='angry'||a.selected)-Number(b.mood==='angry'||b.selected));
 g.save();
 g.font='20px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",system-ui';
 g.textAlign='center';g.textBaseline='middle';
 for(const p of badges){
  const x=p.x+10,y=p.y-43,angry=p.mood==='angry';
  g.beginPath();g.arc(x,y,11,0,Math.PI*2);
  g.fillStyle=angry?'#6d2028':'#193543';g.fill();
  g.strokeStyle=angry?'#ff777d':'#547c8a';g.stroke();
  g.fillStyle='#fff';
  g.fillText(patientEmotions[p.mood][0],x,y+1);
 }
 g.restore();
}
