// Fluxo: demanda agregada → agenda fictícia → filas e estações → comparação de capacidade.
// Versão 2.1 — 15/11/2026 / Mudança: premissas editáveis (tempos de guichê, preparo e exame), chegada sorteada pelo que a clínica mediu, falta por situação da confirmação, quem já foi atendido nunca vira falta, uso das estações.
export const units={csi1:'CSI 1',csi2:'CSI 2',ped:'CSI Pediatria'};
export const stages={future:'Previsto',absent:'Falta',reception:'Fila da recepção',checkin:'Cadastro',prepQueue:'Fila de preparo',prep:'Preparo',
 examQueue:'Fila da sala',exam:'Em atendimento',finished:'Concluído'};
export const types={
 reception:['Recepção',4],prep:['Preparo operacional',6],consulta:['Consultório',20],us:['Ultrassom / Doppler',23],
 rm:['Ressonância',32],tc:['Tomografia',18],eco:['Ecocardiografia',24],rx:['Radiologia',18],
 dmo:['Densitometria',15],mamo:['Mamografia',17],histero:['Histeroscopia',25]
};
export const team=[
 ['Lia','csi1','Recepção e fluxo de entrada','reception'],['Theo','csi1','Disponibilidade das salas','exam'],
 ['Bia','csi1','Preparo e ocupação da espera','prep'],['Nico','csi2','Recepção e cadastro','reception'],
 ['Maria','csi2','Fluxo das salas de exame','exam'],['Julho','csi2','Apoio na espera e preparo','prep'],
 ['Maya','ped','Recepção da Pediatria','reception'],['Davi','ped','Fluxo dos consultórios','exam'],['Lu','ped','Orientação da espera','prep']
];
export const OPEN=390,CLOSE=1140,LIMIT_WAIT=30;
// Premissas que a clínica pode corrigir na tela: tempo de guichê e de preparo (min, mínimo e máximo) e duração de cada exame (min).
export const defaultAssumptions=()=>({reception:[3,6],prep:[4,8],duration:{}});
export const assumptions=defaultAssumptions();
export function setAssumptions(next={}){
 const base=defaultAssumptions();
 const range=(value,fallback)=>Array.isArray(value)&&value.length===2&&value.every(n=>Number.isFinite(n)&&n>=1&&n<=120)&&value[0]<=value[1]?value.map(Math.round):fallback;
 assumptions.reception=range(next.reception,base.reception);
 assumptions.prep=range(next.prep,base.prep);
 assumptions.duration={};
 for(const [type,minutes] of Object.entries(next.duration??{}))if(Object.hasOwn(types,type)&&Number.isFinite(minutes)&&minutes>=3&&minutes<=240)assumptions.duration[type]=Math.round(minutes);
}
export const refMinutes=type=>assumptions.duration[type]??types[type][1];
// Quantis medidos (5%, 10%, 20% ... 90%, 95%) → minuto de chegada em relação ao horário marcado.
export const QUANTILE_POINTS=[.05,.1,.2,.3,.4,.5,.6,.7,.8,.9,.95];
export function sampleQuantile(quantiles,u){
 const q=quantiles,p=QUANTILE_POINTS,last=p.length-1;
 if(u<=p[0])return q[0]-Math.min(30,(p[0]-u)/(p[1]-p[0])*(q[1]-q[0]));
 if(u>=p[last])return q[last]+Math.min(30,(u-p[last])/(p[last]-p[last-1])*(q[last]-q[last-1]));
 let i=0;while(u>p[i+1])i++;
 return q[i]+(u-p[i])/(p[i+1]-p[i])*(q[i+1]-q[i]);
}
export const seeds=[17,43,91];
export function clock(minute){
 if(!Number.isFinite(minute))return '—';
 const value=Math.floor(minute), hour=Math.floor(value/60)%24, extra=value>=1440?' (+1 dia)':'';
 return [hour,value%60].map(v=>String(v).padStart(2,'0')).join(':')+extra;
}
function rng(seed){
 let value=seed>>>0;
 return ()=>{value=(Math.imul(1664525,value)+1013904223)>>>0;return value/4294967296;};
}
export function makeRoster(agenda){
 const rows=agenda.slots.flatMap(([hour,unit,type,count])=>Array.from({length:count},(_,i)=>({
  unit,type,slot:hour*60+Math.floor((i+.5)*60/count)
 }))).sort((a,b)=>a.slot-b.slot||a.unit.localeCompare(b.unit));
 const first=[];
 const repeat=rows.length-agenda.people;
 for(const [i,row] of rows.entries()){
  row.id=i+1;
  const previous=rows.length-i<=repeat?first.find(p=>!p.followUp&&p.unit===row.unit&&row.slot-p.slot>=55):undefined;
  if(previous){previous.followUp=true;row.person=previous.person;}
  else{row.person=first.length+1;first.push(row);}
 }
 // Mantém a quantidade total de pessoas, mesmo se faltarem pares na mesma unidade.
 const max=agenda.people;
 for(const row of rows.filter(r=>r.person>max)){
  const used=new Set(rows.filter(r=>r.id<row.id).flatMap(r=>
   r.followUp||r.slot+55>row.slot? [r.person]:[]));
  let compatible=first.find(p=>p.person<=max&&!used.has(p.person));
  compatible??=first.find(p=>p.person<=max&&p.slot<row.slot&&!p.followUp);
  if(compatible){compatible.followUp=true;row.person=compatible.person;}
 }
 const previousByPerson=new Map();
 return rows.map(({followUp,...row})=>{
  const previous=previousByPerson.get(row.person);
  previousByPerson.set(row.person,row);
  return {...row,previous:previous?.id??null,transfer:previous&&previous.unit!==row.unit?12:0};
 });
}
export function initialPlan(agenda){
 const plan={};
 for(const unit of Object.keys(units)){
  plan[unit+':reception']=1;
  plan[unit+':prep']=1;
 }
 const loads={};
 for(const [hour,unit,type,n] of agenda.slots){
  const key=unit+':'+type;
  loads[key]??={};
  loads[key][hour]=(loads[key][hour]??0)+n*types[type][1];
 }
 for(const [key,byHour] of Object.entries(loads)){
  const peak=Math.max(...Object.values(byHour));
  plan[key]=Math.max(1,Math.min(4,Math.round(peak/75)));
 }
 return plan;
}
const pendingCount=jobs=>jobs.filter(job=>!job.absent).length;
const percentile=(values,fraction)=>values.length?values[Math.ceil(values.length*fraction)-1]:0;
export function simulate(roster,plan,seed=seeds[0],incident=true,absenceRate=0){
 const random=rng(seed),attendance=rng(seed^0x9e3779b9);
 const stations=Object.fromEntries(Object.entries(plan).map(([key,n])=>[key,Array.from({length:n},()=>0)]));
 const jobs=roster.map(row=>{
  const drawA=random(),drawB=random();
  const arrive=Math.max(OPEN,row.arrivalQ?.length===QUANTILE_POINTS.length?row.slot+Math.round(sampleQuantile(row.arrivalQ,drawA)):row.slot+Math.round((drawA+drawB-1)*22)-6);
  const draw=attendance()*100;
  const [rLow,rHigh]=assumptions.reception,[pLow,pHigh]=assumptions.prep;
  const receptionTime=rLow+Math.floor(random()*(rHigh-rLow+1)),prepTime=pLow+Math.floor(random()*(pHigh-pLow+1));
  const durationDraw=random(),samples=row.durations;
  const fallback=Math.max(5,Math.round(refMinutes(row.type)*(.8+durationDraw*.4)));
  const examTime=row.actualDuration??(samples?.length?samples[Math.floor(durationDraw*samples.length)]:fallback);
  return {...row,arrive:Number.isFinite(row.actualArrival)?Math.max(OPEN,row.actualArrival):Math.max(arrive,row.notBefore??0),
   absent:row.knownAbsent||(!row.knownPresent&&!Number.isFinite(row.actualArrival)&&draw<(row.absenceRate??absenceRate)),
   receptionTime,prepTime,examTime,check:null,registered:null,prepare:null,ready:null,start:null,end:null,room:null};
 });
 const byId=new Map(jobs.map(job=>[job.id,job]));
 const delayedKey=plan['csi1:us']?'csi1:us':Object.keys(plan).find(k=>k.endsWith(':us'));
 const downtime=incident&&delayedKey?{key:delayedKey,from:540,to:565}:null;
 const work={};
 const queues={};
 const pending=jobs.filter(job=>!job.absent);
 function assign(minute,pool,readyAt,duration,startField,endField){
  const queue=queues[pool]??[];
  queue.sort((a,b)=>readyAt(a)-readyAt(b)||a.slot-b.slot||a.id-b.id);
  const rooms=stations[pool];
  if(!rooms)return;
  for(const [i,until] of rooms.entries()){
   if(!queue.length||until>minute)continue;
   const job=queue[0],finish=minute+duration(job);
   if(downtime?.key===pool&&i===0&&minute<downtime.to&&finish>downtime.from)continue;
   queue.shift();job[startField]=minute;job[endField]=finish;rooms[i]=finish;
   if(startField==='start')job.room=i+1;
   if(startField==='check')job.desk=i+1;
   if(startField==='prepare')job.bay=i+1;
   work[pool]=(work[pool]??0)+finish-minute;
  }
 }
 function enqueue(key,job){(queues[key]??=[]).push(job);}
 const inCheck=[],inPrep=[];
 let left=pending.length;
 for(let minute=OPEN;left&&minute<5760;minute++){
  for(let i=pending.length-1;i>=0;i--){
   const job=pending[i];
   let previous=byId.get(job.previous);
   while(previous?.absent)previous=byId.get(previous.previous);
   const transit=previous&&previous.unit!==job.unit?12:0;
   if(previous&&(previous.end===null||previous.end+transit>minute)||job.arrive>minute)continue;
   job.arrive=Math.max(job.arrive,previous?previous.end+transit:OPEN);
   enqueue(job.unit+':reception',job);inCheck.push(job);pending.splice(i,1);
  }
  for(const unit of Object.keys(units))assign(minute,unit+':reception',j=>j.arrive,j=>j.receptionTime,'check','registered');
  for(let i=inCheck.length-1;i>=0;i--){
   const job=inCheck[i];
   if(job.registered!==minute)continue;
   inCheck.splice(i,1);
   if(['consulta','dmo','mamo','eco'].includes(job.type)){
    job.ready=minute;enqueue(job.unit+':'+job.type,job);
   }else{enqueue(job.unit+':prep',job);inPrep.push(job);}
  }
  for(const unit of Object.keys(units))assign(minute,unit+':prep',j=>j.registered,j=>j.prepTime,'prepare','ready');
  for(let i=inPrep.length-1;i>=0;i--){
   const job=inPrep[i];
   if(job.ready!==minute)continue;
   inPrep.splice(i,1);enqueue(job.unit+':'+job.type,job);
  }
  for(const key of Object.keys(stations)){
   if(key.endsWith(':reception')||key.endsWith(':prep'))continue;
   const before=queues[key]?.length??0;
   assign(minute,key,j=>j.ready,j=>j.examTime,'start','end');
   left-=before-(queues[key]?.length??0);
  }
 }
 const finished=jobs.filter(j=>j.end!==null);
 const last=Math.max(OPEN,...finished.map(j=>j.end));
 const waits=finished.map(j=>j.start-j.arrive).sort((a,b)=>a-b);
 const absences=jobs.length-pendingCount(jobs);
 const summary={total:jobs.length,served:finished.length,last,absences,missed:jobs.length-absences-finished.length,
  over:Math.max(0,last-CLOSE),above:waits.filter(w=>w>LIMIT_WAIT).length,p90:percentile(waits,.9),
  mean:Math.round(waits.reduce((a,b)=>a+b,0)/(waits.length||1)),work};
 const pools={};
 for(const j of finished){
  const stalled=[[j.unit+':reception',j.check-j.arrive],[j.unit+':'+j.type,j.start-j.ready]];
  if(j.prepare!==null)stalled.push([j.unit+':prep',j.prepare-j.registered]);
  for(const [key,wait] of stalled){
   const pool=pools[key]??={n:0,wait:0,peak:0};
   pool.n++;pool.wait+=wait;pool.peak=Math.max(pool.peak,wait);
  }
 }
 return {jobs,summary,pools,downtime};
}
export function stage(job,time){
 if(job.absent)return time>=(job.absentAt??job.slot+15)?'absent':'future';
 if(job.observed){
  if(job.arrive===null||time<job.arrive)return 'future';
  if(job.end!==null&&time>=job.end)return 'finished';
  if(job.start!==null&&time>=job.start)return 'exam';
  if(job.ready!==null&&time>=job.ready)return 'examQueue';
  if(job.prepare!==null&&time>=job.prepare)return 'prep';
  if(job.registered!==null&&time>=job.registered)return ['consulta','dmo','mamo','eco'].includes(job.type)?'examQueue':'prepQueue';
  if(job.check!==null&&time>=job.check)return 'checkin';
  return 'reception';
 }
 if(time<job.arrive)return 'future';
 if(job.check===null||time<job.check)return 'reception';
 if(time<job.registered)return 'checkin';
 if(job.prepare!==null&&time<job.prepare)return 'prepQueue';
 if(job.prepare!==null&&time<job.ready)return 'prep';
 if(job.start===null||time<job.start)return 'examQueue';
 if(time<job.end)return 'exam';
 return 'finished';
}
export function patientStatus(job,time){
 const status=stage(job,time);
 if(status==='future'||status==='absent')return {status,wait:null,mood:null};
 const wait=Math.floor(Math.min(time,job.start??time)-job.arrive);
 if(status==='finished')return {status,wait,mood:'relieved'};
 if(status==='exam')return {status,wait,mood:'calm'};
 return {status,wait,mood:wait>60?'angry':wait>LIMIT_WAIT?'worried':'patient'};
}
export const patientEmotions={
 patient:['😐','Aguardando atendimento'],
 worried:['😟','Espera acima de 30 minutos'],
 angry:['😠','Espera acima de 1 hora'],
 calm:['🙂','Em atendimento'],
 relieved:['😊','Atendimento concluído']
};
export function occupancyTimeline(jobs,unit,end,earliest=OPEN){
 const relevant=jobs.filter(job=>unit==='all'||job.unit===unit);
 const people=Array.from({length:end-OPEN+1},()=>new Set());
 const candidates=new Set();
 const interval=30;
 for(const job of relevant){
  const slot=Math.floor(job.slot/interval)*interval;
  if(slot>=earliest&&slot+interval<=Math.min(CLOSE,end+1))candidates.add(slot);
  if(job.absent||!Number.isFinite(job.arrive))continue;
  const from=Math.max(OPEN,job.arrive);
  const until=Math.min(end+1,job.end??end+1);
  for(let minute=from;minute<until;minute++)people[minute-OPEN].add(job.person);
 }
 const counts=people.map(present=>present.size);
 const windows=[...candidates].map(start=>{
  const values=counts.slice(start-OPEN,start-OPEN+interval);
  return {start,end:start+interval,peak:Math.max(...values),sum:values.reduce((total,count)=>total+count,0)};
 }).sort((a,b)=>a.sum-b.sum||a.peak-b.peak||a.start-b.start);
 return {counts,peak:Math.max(...counts),best:windows[0]??null,interval};
}
export const patrols={
 csi1:{name:'Dora',row:2},
 csi2:{name:'Raul',row:5},
 ped:{name:'Nina',row:8}
};
export function patrolIncidents(model){
 const incidents=[];
 function record(unit,kind,from,to,job=null){
  if(Number.isFinite(from)&&(to===null||from<to))incidents.push({id:unit+'-'+kind+'-'+(job.id??from),unit,kind,from,to,job});
 }
 for(const job of model.jobs){
  if(job.absent||!Number.isFinite(job.arrive))continue;
  record(job.unit,'wait',job.arrive+LIMIT_WAIT+1,job.start,job);
  if(job.start!==null)record(job.unit,'exam',job.start+refMinutes(job.type)+1,job.end,job);
 }
 if(model.downtime){
  const {key,from,to}=model.downtime;
  const [unit,type]=key.split(':');
  record(unit,'downtime',from,to,{type});
 }
 return incidents.sort((a,b)=>a.from-b.from);
}
export function patrolMessage(incident,time){
 const {job,kind,from}=incident;
 const service=types[job.type][0];
 if(kind==='downtime')return 'Uma estação de '+service+' está parada há '+Math.floor(time-from)+' min.';
 const person='P'+String(job.person).padStart(3,'0');
 const elapsed=Math.floor(time-(kind==='wait'?job.arrive:job.start));
 return kind==='wait'
  ? person+' aguarda '+service+' há '+elapsed+' min. Agora: '+stages[stage(job,time)].toLowerCase()+'.'
  : person+' está há '+elapsed+' min em '+service+' (referência: '+refMinutes(job.type)+' min).';
}
export function patrolResolution({job,kind,to}){
 if(kind==='downtime')return 'Estação de '+types[job.type][0]+' voltou a funcionar.';
 const subject='P'+String(job.person).padStart(3,'0');
 return kind==='wait' ? subject+' entrou em atendimento após '+(to-job.arrive)+' min de espera.'
  : subject+' saiu de '+types[job.type][0]+' após '+(to-job.start)+' min.';
}
export function patrolExplanation(record,time,model,plan){
 const {unit,kind,job,from,to}=record;
 const resolved=to!==null&&time>=to;
 const observed=resolved?to-1:Math.floor(time);
 const problem=resolved?patrolResolution(record):patrolMessage(record,observed);
 const service=types[job.type][0];
 if(kind==='downtime')return {unit,room:job.type,location:'Sala de '+service,
  problem,reason:(model.jobs.some(j=>j.observed)?'O sistema de origem informou a parada':'O cenário simulou a parada')+' da estação 1 às '+clock(from)+(to===null?'. A liberação ainda não foi registrada.':', com liberação às '+clock(to)+'.')};
 if(kind==='exam')return {unit,room:job.type,location:service+(job.room?' · Estação '+job.room:''),
  problem,reason:(job.observed?'A duração registrada':'A duração simulada')+' passou dos '+refMinutes(job.type)+' min de referência.'+(job.observed?'':' O cenário varia a duração dos atendimentos.')};
 const status=stage(job,observed);
 const room=['reception','checkin'].includes(status)?'reception':['prepQueue','prep'].includes(status)?'prep':job.type;
 const queue=['reception','prepQueue','examQueue'].includes(status);
 const location=queue?'Área de espera · '+(room==='reception'?'fila da recepção':room==='prep'?'fila de preparo':'fila de '+service):
  room==='reception'?'Guichê '+(job.desk??''):room==='prep'?'Preparo · Estação '+(job.bay??''):'Sala de '+service;
 const key=unit+':'+room;
 const down=model.downtime?.key===key&&observed>=model.downtime.from&&observed<model.downtime.to?1:0;
 const busy=model.jobs.filter(j=>{
  if(j.unit!==unit||j.absent)return false;
  const [start,end]=room==='reception'?[j.check,j.registered]:room==='prep'?[j.prepare,j.ready]:j.type===room?[j.start,j.end]:[null,null];
  return start!==null&&end!==null&&start<=observed&&observed<end;
 }).length;
 const slots=plan[key];
 const capacity=slots===undefined?'':down?' Há '+busy+' estação(ões) ocupada(s) e uma parada entre '+slots+' neste setor.':
  busy>=slots?' As '+slots+' estações deste setor estão ocupadas.':' O cenário mostra '+busy+' de '+slots+' estações ocupadas neste setor.';
 const longestQueue=[
  ['recepção',job.arrive,job.check],
  ['preparo',job.registered,job.prepare??job.ready],
  ['sala de '+service,job.ready,job.start]
 ].filter(([,start])=>start!==null&&start<=observed)
  .map(([sector,start,end])=>[sector,Math.max(0,Math.min(end??observed,observed)-start)])
  .sort((a,b)=>b[1]-a[1])[0];
 const past=longestQueue?.[1]>0?' Maior espera em fila: '+longestQueue[1]+' min em '+longestQueue[0]+'.':'';
 const reason=queue?'O paciente ainda aguarda liberação nesta etapa.'+capacity+past:
  'O paciente ainda está em '+stages[status].toLowerCase()+' antes do exame.'+past;
 return {unit,room,area:queue?'waiting':'station',location,problem,reason};
}
export const planKey=plan=>Object.keys(plan).sort().map(key=>key+'='+plan[key]).join('|');
export function measure(roster,plan,absenceRate=0,incident=true){
 const results=seeds.map(seed=>simulate(roster,plan,seed,incident,absenceRate));
 const totals={missed:0,above:0,over:0,p90:0,mean:0};
 const pressure={};
 for(const {summary,pools} of results){
  for(const key of Object.keys(totals))totals[key]+=summary[key];
  for(const [key,pool] of Object.entries(pools))pressure[key]=(pressure[key]??0)+pool.wait;
 }
 const resources=Object.values(plan).reduce((total,count)=>total+count,0);
 const score=totals.missed*1e6+totals.above*15+totals.over*8+totals.p90*3+totals.mean+resources*6;
 return {summary:results[0].summary,totals,pressure,resources,score};
}
export function nextPlan(best,tested){
 const ordered=Object.keys(best.plan).sort((a,b)=>(best.measure.pressure[b]??0)-(best.measure.pressure[a]??0));
 const changes=ordered.flatMap(key=>[-1,1].filter(delta=>best.plan[key]+delta>=1&&best.plan[key]+delta<=6)
  .map(delta=>[key,delta])).sort((a,b)=>b[1]-a[1]);
 const candidate=(...moves)=>{
  const plan={...best.plan};
  for(const [key,delta] of moves)plan[key]+=delta;
  return tested.has(planKey(plan))?null:plan;
 };
 for(const change of changes){
  const plan=candidate(change);
  if(plan)return plan;
 }
 // Troca capacidade entre estações quando uma mudança isolada já foi testada.
 for(const add of changes.filter(c=>c[1]>0))for(const remove of changes.filter(c=>c[1]<0&&c[0]!==add[0])){
  const plan=candidate(add,remove);
  if(plan)return plan;
 }
 return null;
}

// Uso de cada estação no dia: minutos de trabalho ÷ (estações × horário de funcionamento). 100% = nunca parada.
export function utilization(summary,plan){
 const span=CLOSE-OPEN;
 return Object.fromEntries(Object.entries(plan).map(([pool,count])=>[pool,Math.min(1.5,(summary.work[pool]??0)/(count*span))]));
}
