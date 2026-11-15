// Fluxo: resposta JSON → validação e minimização → operação observada e previsão histórica.
// Versão 2.1 — 15/11/2026 / Mudança: lê do Supabase (funções painel_simulacao_*), aceita situação da confirmação, atendido e calibragem; guarda só a última leitura de cada dia.
import {units,types,OPEN,initialPlan,QUANTILE_POINTS} from './engine.mjs';

const services=Object.keys(types).filter(type=>!['reception','prep'].includes(type));
const datestring=/^\d{4}-\d{2}-\d{2}$/;
const confirmStates=['confirmado','a_confirmar','sem_resposta'];
const clockFields=['arrive','check','registered','prepare','ready','start','end'];
const key=(hour,unit,type)=>[hour,unit,type].join(':');
const LATE_ABSENCE=45;
// Quem aparece com chegada muito antes do horário (mais de 1 h) provavelmente teve o atendimento aberto cedo na recepção: não conta como presente na sala.
const ARRIVAL_FLOOR=-60;
const weekday=date=>new Date(date+'T12:00:00Z').getUTCDay();
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:0;
function validDate(date){
 if(typeof date!=='string'||!datestring.test(date))return false;
 const value=new Date(date+'T12:00:00Z');
 return Number.isFinite(value.valueOf())&&value.toISOString().slice(0,10)===date;
}
function integer(value,min,max){
 return Number.isInteger(value)&&value>=min&&value<=max;
}
function requireValue(condition,message){if(!condition)throw Error(message);}
function validService(unit,type){return Object.hasOwn(units,unit)&&services.includes(type);}
const brasil=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bahia',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function localClock(timestamp){
 const parts=Object.fromEntries(brasil.formatToParts(new Date(timestamp)).map(p=>[p.type,p.value]));
 return {date:parts.year+'-'+parts.month+'-'+parts.day,minute:Number(parts.hour)*60+Number(parts.minute)};
}

function number(value,min,max){return Number.isFinite(value)&&value>=min&&value<=max?value:null;}
function normalizeCalibration(source){
 const out={absenceByConfirm:{},absenceOverall:null,arrival:{}};
 if(!source||typeof source!=='object')return out;
 for(const state of confirmStates){
  const item=source.faltaPorConfirmacao?.[state];
  const rate=number(item?.taxa,0,100),n=number(item?.n,0,1e6);
  if(rate!==null&&n!==null)out.absenceByConfirm[state]={rate,n};
 }
 out.absenceOverall=number(source.faltaGeral,0,100);
 for(const unit of Object.keys(units)){
  const item=source.chegada?.[unit];
  const q=item?.quantis;
  if(Array.isArray(q)&&q.length===QUANTILE_POINTS.length&&q.every(n=>Number.isFinite(n))&&q.every((n,i)=>i===0||n>=q[i-1]))out.arrival[unit]={n:number(item.n,0,1e6)??0,quantiles:q.map(n=>Math.round(Math.max(ARRIVAL_FLOOR,n)*10)/10)};
 }
 return out;
}
function normalizeMeta(source){
 const out={};
 for(const key of ['marcacoes_no_dia','canceladas_ou_remarcadas','fora_do_modelo','com_chegada_real','com_hora_real','faltas_registradas']){
  out[key]=number(source?.[key],0,1e6)??0;
 }
 out.sync=typeof source?.sync_klingo_em==='string'&&Number.isFinite(Date.parse(source.sync_klingo_em))?new Date(source.sync_klingo_em).toISOString():null;
 return out;
}

export function normalizeSnapshot(payload,requestedDate){
 const {date,asOf,visits,history,capacity={},outage=null,calibragem=null,meta=null}=payload??{};
 requireValue(validDate(date)&&(!requestedDate||date===requestedDate),'Data do retorno inválida ou diferente da data solicitada.');
 requireValue(typeof asOf==='string'&&/(?:[zZ]|[+-]\d\d:\d\d)$/.test(asOf)&&Number.isFinite(Date.parse(asOf)),'Informe asOf ISO 8601 com fuso.');
 requireValue(Array.isArray(visits)&&Array.isArray(history),'O retorno deve conter visits e history.');
 const local=localClock(asOf);
 const cut=local.date===date?local.minute:local.date>date?1439:0;
 const ids=new Set();
 const normalizedVisits=[];
 for(const source of visits){
  requireValue(source&&integer(source.id,1,2147483647)&&!ids.has(source.id),'Cada marcação precisa de um id numérico único.');
  ids.add(source.id);
  if(source.cancelled===true)continue;
  requireValue(integer(source.person,1,2147483647)&&validService(source.unit,source.type)&&integer(source.slot,0,1439),'Identificador de pessoa, unidade, modalidade ou horário de marcação inválido.');
  const visit={id:source.id,person:source.person,unit:source.unit,type:source.type,slot:source.slot,
   confirm:confirmStates.includes(source.confirm)?source.confirm:null,done:source.done===true};
  let previous=null;
  for(const field of clockFields){
   const value=source[field]??null;
   requireValue(value===null||(integer(value,0,cut)&&(previous===null?field==='arrive':value>=previous)),'Etapa fora da ordem, sem chegada ou posterior à atualização.');
   visit[field]=value;
   if(value!==null)previous=value;
  }
  requireValue(visit.end===null||visit.start!==null,'Saída sem início de atendimento.');
  visit.absentAt=source.absentAt??null;
  requireValue(visit.absentAt===null||(integer(visit.absentAt,0,cut)&&visit.arrive===null),'Falta inválida ou paciente com chegada registrada.');
  for(const field of ['room','desk','bay']){
   visit[field]=source[field]??null;
   requireValue(visit[field]===null||integer(visit[field],1,6),'Estação fora da faixa de 1 a 6.');
  }
  normalizedVisits.push(visit);
 }
 const bins=new Set();
 const normalizedHistory=history.map(h=>{
  requireValue(h&&validDate(h.date)&&h.date<date&&integer(h.hour,0,23)&&validService(h.unit,h.type),'Histórico deve apontar para dias anteriores e modalidades válidas.');
  const id=h.date+'|'+key(h.hour,h.unit,h.type);
  requireValue(!bins.has(id),'A mesma faixa histórica foi enviada duas vezes.');
  bins.add(id);
  requireValue(integer(h.booked,0,10000)&&integer(h.arrivals,0,h.booked),'Contagens de histórico inválidas.');
  const durations=h.durations??[];
  requireValue(Array.isArray(durations)&&durations.every(n=>integer(n,1,480)),'Duração histórica inválida.');
  return {date:h.date,hour:h.hour,unit:h.unit,type:h.type,booked:h.booked,arrivals:h.arrivals,durations};
 });
 const normalizedCapacity={};
 requireValue(capacity&&typeof capacity==='object'&&!Array.isArray(capacity),'Capacidade inválida.');
 for(const [pool,count] of Object.entries(capacity)){
  const [unit,type,extra]=pool.split(':');
  requireValue(!extra&&Object.hasOwn(units,unit)&&Object.hasOwn(types,type)&&integer(count,1,6),'Capacidade inválida para '+pool+'.');
  normalizedCapacity[pool]=count;
 }
 let normalizedOutage=null;
 if(outage!==null){
  const [unit,type,extra]=String(outage.key).split(':');
  requireValue(!extra&&Object.hasOwn(units,unit)&&Object.hasOwn(types,type)&&integer(outage.from,0,cut)&&
   (outage.to===null||integer(outage.to,outage.from+1,cut)),'Parada de estação inválida.');
  normalizedOutage={key:outage.key,from:outage.from,to:outage.to};
 }
 return {date,asOf:new Date(asOf).toISOString(),visits:normalizedVisits,history:normalizedHistory,capacity:normalizedCapacity,outage:normalizedOutage,
  calibration:normalizeCalibration(calibragem),meta:normalizeMeta(meta)};
}

export function prepareSnapshot(snapshot){
 const local=localClock(snapshot.asOf);
 const cut=local.date===snapshot.date?local.minute:local.date>snapshot.date?1439:0;
 const slots=new Map(), history=new Map(), modelHistory=new Map();
 for(const visit of snapshot.visits){
  const id=key(Math.floor(visit.slot/60),visit.unit,visit.type);
  slots.set(id,(slots.get(id)??0)+1);
 }
 for(const h of snapshot.history){
  const id=key(h.hour,h.unit,h.type);
  if(!history.has(id))history.set(id,[]);
  history.get(id).push(h);
  const pool=h.unit+':'+h.type;
  if(!modelHistory.has(pool))modelHistory.set(pool,[]);
  modelHistory.get(pool).push(h);
 }
 const historicalDays=new Set();
 const roster=snapshot.visits.map(visit=>({
  id:visit.id,person:visit.person,unit:visit.unit,type:visit.type,slot:visit.slot,
  actualArrival:visit.arrive??(visit.done?Math.min(visit.slot,cut):null),knownAbsent:visit.absentAt!==null,knownPresent:visit.done||visit.arrive!==null,
  confirm:visit.confirm,
  actualDuration:visit.end!==null?Math.max(1,visit.end-visit.start):null
 }));
 // Quem não chegou: se já passou muito do horário, vira falta provável; se está dentro da tolerância, só pode chegar daqui para frente.
 for(const row of roster){
  if(row.actualArrival!==null||row.knownAbsent||row.knownPresent||row.slot>cut)continue;
  if(row.slot+LATE_ABSENCE<cut){row.knownAbsent=true;row.probableAbsence=true;}
  else row.notBefore=cut;
 }
 let id=roster.reduce((max,row)=>Math.max(max,row.id),0);
 let person=roster.reduce((max,row)=>Math.max(max,row.person),0);
 for(const [bin,samples] of history){
  const [hourText,unit,type]=bin.split(':');
  const hour=Number(hourText);
  const comparable=samples.filter(h=>weekday(h.date)===weekday(snapshot.date));
  const usable=comparable.length?comparable:samples;
  for(const h of usable)historicalDays.add(h.date);
  if(hour*60<cut)continue;
  const target=Math.round(mean(usable.map(h=>h.booked)));
  const count=Math.max(0,target-(slots.get(bin)??0));
  if(!count)continue;
  slots.set(bin,(slots.get(bin)??0)+count);
  for(let i=0;i<count;i++){
   const slot=hour*60+Math.floor((i+.5)*60/count);
   roster.push({id:++id,person:++person,unit,type,slot,historical:true});
  }
 }
 roster.sort((a,b)=>a.slot-b.slot||a.id-b.id);
 const previous=new Map();
 for(const row of roster){
  const group=modelHistory.get(row.unit+':'+row.type)??[];
  const matching=group.filter(h=>weekday(h.date)===weekday(snapshot.date));
  const pool=matching.length?matching:group;
  for(const h of pool)historicalDays.add(h.date);
  const booked=pool.reduce((sum,h)=>sum+h.booked,0);
  const historical=booked?100*(1-pool.reduce((sum,h)=>sum+h.arrivals,0)/booked):null;
  const byConfirm=snapshot.calibration?.absenceByConfirm?.[row.confirm];
  row.absenceRate=byConfirm&&byConfirm.n>=30?byConfirm.rate:historical??snapshot.calibration?.absenceOverall??null;
  row.arrivalQ=snapshot.calibration?.arrival?.[row.unit]?.quantiles??null;
  row.durations=pool.flatMap(h=>h.durations);
  row.previous=previous.get(row.person)?.id??null;
  previous.set(row.person,row);
 }
 const day={people:new Set(roster.map(row=>row.person)).size,confirmed:snapshot.visits.length,excluded:(snapshot.meta?.canceladas_ou_remarcadas??0)+(snapshot.meta?.fora_do_modelo??0),slots:[...slots].map(([bin,count])=>{
  const [hour,unit,type]=bin.split(':');
  return [Number(hour),unit,type,count];
 })};
 const plan={...initialPlan(day),...snapshot.capacity};
 const jobs=snapshot.visits.map(visit=>({...visit,observed:true,absent:visit.absentAt!==null}));
 for(const job of jobs){
  for(const [type,station] of [['reception',job.desk],['prep',job.bay],[job.type,job.room]]){
   const pool=job.unit+':'+type;
   if(station>plan[pool])plan[pool]=station;
  }
 }
 const completed=jobs.filter(j=>j.end!==null).length;
 const absences=jobs.filter(j=>j.absent).length;
 return {day,roster,plan,cut,calibration:snapshot.calibration,meta:snapshot.meta,probableAbsences:roster.filter(r=>r.probableAbsence).length,historicalDays:historicalDays.size,historicalVisits:roster.filter(j=>j.historical).length,
  observed:{jobs,summary:{total:jobs.length,served:completed,absences,last:Math.max(OPEN,cut)},pools:{},downtime:snapshot.outage}};
}

// Lê um dia pela função do banco (precisa estar logado no painel como administrador ou atendente).
export async function fetchSnapshot(client,date){
 const {data,error}=await client.rpc('painel_simulacao_dia',{p_dia:date});
 if(error)throw Error(error.code==='42501'?'Entre com uma conta de administrador ou atendente do painel.':error.message);
 return normalizeSnapshot(data,date);
}
export async function fetchIndicators(client,days=28){
 const {data,error}=await client.rpc('painel_simulacao_indicadores',{p_dias:days});
 if(error)throw Error(error.message);
 return data;
}

// O que falta nos dados: por situação do exame, quantas marcações e pessoas e que parte tem cada dado (só contagem).
export async function fetchLacunas(client,days=28){
 const {data,error}=await client.rpc('painel_simulacao_lacunas',{p_dias:days});
 if(error)throw Error(error.message);
 return data;
}
// Área externa (etapas fora da clínica, com a régua dos atendimentos antigos) e os indicadores que o painel já calcula.
export async function fetchExterna(client,days=28){
 const {data,error}=await client.rpc('painel_simulacao_externa',{p_dias:days});
 if(error)throw Error(error.message);
 return data;
}
export async function fetchDecisao(client,days=28){
 const today=localClock(new Date()).date;
 const from=new Date(today+'T12:00:00Z');from.setUTCDate(from.getUTCDate()-(days-1));
 const {data,error}=await client.rpc('painel_indicadores_decisao',{p_de:from.toISOString().slice(0,10),p_ate:today,p_unidade:null,p_incluir_teste:false});
 if(error)throw Error(error.message);
 return data;
}

export function openSnapshotStore(namespace){
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(namespace,2);
  request.onupgradeneeded=()=>{
   if(request.result.objectStoreNames.contains('snapshots'))request.result.deleteObjectStore('snapshots');
   request.result.createObjectStore('snapshots',{keyPath:'date'});
  };
  request.onerror=()=>reject(request.error);
  request.onsuccess=()=>resolve(request.result);
 });
}
export function putSnapshot(db,snapshot){
 return new Promise((resolve,reject)=>{
  const tx=db.transaction('snapshots','readwrite');
  tx.objectStore('snapshots').put(snapshot);
  tx.oncomplete=resolve;
  tx.onabort=()=>reject(tx.error);
 });
}
export function listSnapshots(db){
 return new Promise((resolve,reject)=>{
  const request=db.transaction('snapshots').objectStore('snapshots').getAll();
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
}
