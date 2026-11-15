// Fluxo: agenda agregada → simulação e busca → mapa, jornadas e registro local.
// Versão 2.1 — 15/11/2026 / Mudança: ligada ao banco do webchat (Klingo #14359 + indicadores), premissas editáveis, capacidade salva, teste de encaixes e painel de decisão.
import * as E from './engine.mjs';
import {createScenes} from './scene.mjs';
import {config} from './config.mjs';
import {fetchSnapshot,fetchIndicators,fetchExterna,fetchDecisao,normalizeSnapshot,prepareSnapshot,localClock,openSnapshotStore,putSnapshot,listSnapshots} from './integration.mjs';
import * as D from './decisao.mjs';
import * as G from './grafico.mjs';
import * as A from './analise.mjs';
const $=id=>document.getElementById(id);
const key=config.storageNamespace+'-ui';
const snapshots=new Map();
let db=null;
try{db=await openSnapshotStore(config.storageNamespace);for(const feed of await listSnapshots(db)) snapshots.set(feed.date,feed);}catch{}
const response=await fetch('./agenda.json').catch(()=>null);
if(!response?.ok){$('save').textContent='Não foi possível carregar a agenda da simulação.';throw Error('Agenda indisponível');}
const agenda=await response.json(),dates=Object.keys(agenda);
let stored={};
try{stored=JSON.parse(localStorage.getItem(key)||'{}')??{};}catch{}
let state={days:{},notes:'',date:dates[0],active:false,...stored};
state.mode??='demo';
const wantedMode=state.mode==='observed'?'forecast':state.mode;
if(!['demo','observed','forecast'].includes(state.mode))state.mode='demo';
if(state.mode!=='demo'&&!snapshots.has(state.date))state.mode='demo';
if(state.mode==='demo'&&!dates.includes(state.date))state.date=dates[0];
state.assump??={reception:[3,6],prep:[4,8],duration:{}};
state.clinicPlan??=null;
state.extras??={};
E.setAssumptions(state.assump);
const client=window.supabase?.createClient?window.supabase.createClient(config.supabaseUrl,config.supabaseKey):null;
let indicators=null,indicatorsError='';
$('dataMode').value=state.mode;
$('sourceDate').value=state.sourceDate??localClock(new Date()).date;
const scenes=createScenes($('scenes'),openPatient);
state.profiles??={};
state.absence??=(Object.keys(state.days).length?0:10);
state.play??=true;
state.speed??=1;
state.focus??='all';
$('sceneUnit').value=state.focus;scenes.focus(state.focus);
$('absence').value=state.absence;$('rate').value=state.speed;
let selectedRoom='',selectedPerson=null,selectedAppointment=null,model,baseline,roster,baseRoster,current,prepared=null,activeDay;
let decisionKey='',decisionTimer=0,liveForToday=false,analysisKey='',scene3d=null,scene3dState='idle',lastAnalysis=null,lastDecision=null;
const observed=()=>state.mode==='observed';
const labels={reception:'Guichê',prep:'Preparo',consulta:'Consultório',us:'Ultrassom',rm:'Ressonância',tc:'Tomografia',eco:'Ecocardiografia',rx:'Radiologia',dmo:'Densitometria',mamo:'Mamografia',histero:'Histeroscopia'};
const escapeHTML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const pid=n=>'P'+String(n).padStart(3,'0');
const label=key=>{const [u,t]=key.split(':');return E.units[u]+' · '+E.types[t][0];};
const average=(m,k)=>Math.round(m.totals[k]/E.seeds.length);
function save(){
 try{localStorage.setItem(key,JSON.stringify(state));$('save').textContent='Progresso salvo neste navegador.';}
 catch{$('save').textContent='O navegador não conseguiu salvar o progresso.';}
}
function scenario(plan){return {plan,measure:E.measure(roster,plan,state.absence,!prepared)};}
function migrateLegacy(legacy){
 const profiles={};
 for(const date of dates){
  const daily={...(legacy.profiles?.[date]??{})};
  if(legacy.days?.[date]&&!daily[0])daily[0]=legacy.days[date];
  if(Object.keys(daily).length)profiles['demo:'+date]=daily;
 }
 return {...legacy,mode:'demo',profiles};
}
function populateDays(){
 const choices=state.mode==='demo'?dates:[...snapshots.keys()].sort();
 $('day').replaceChildren(...choices.map(date=>new Option(new Intl.DateTimeFormat('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')),date)));
 $('day').value=state.date;
}
function extraRows(profileKey){
 const rows=[];
 for(const [i,extra] of (state.extras[profileKey]??[]).entries())for(let n=0;n<extra.qty;n++){
  const id=900000+i*100+n;
  rows.push({id,person:id,unit:extra.unit,type:extra.type,slot:extra.hour*60+Math.floor((n+.5)*60/extra.qty),extra:true,previous:null,transfer:0,
   arrivalQ:prepared?.calibration?.arrival?.[extra.unit]?.quantiles??null,absenceRate:prepared?.calibration?.absenceOverall??null});
 }
 return rows;
}
const profileKeyNow=()=>state.mode+':'+state.date;
function openDay(keepSelection=false){
 const feed=state.mode==='demo'?null:snapshots.get(state.date);
 prepared=feed?prepareSnapshot(feed):null;
 activeDay=prepared?.day??agenda[state.date];
 const estimated=prepared?.plan??E.initialPlan(activeDay);
 const plan=Object.fromEntries(Object.entries(estimated).map(([pool,n])=>[pool,Math.min(6,Math.max(1,state.clinicPlan?.[pool]??n))]));
 baseRoster=prepared?.roster??E.makeRoster(activeDay);
 roster=[...baseRoster,...extraRows(profileKeyNow())].sort((a,b)=>a.slot-b.slot||a.id-b.id);
 const profileKey=state.mode+':'+state.date;
 const profiles=state.profiles[profileKey]??={};
 const level=observed()?'observed':state.absence;
 current=profiles[level]??={best:null,attempts:[],tested:[],count:0,time:420,live:false,done:false};
 if(!observed()&&prepared&&liveForToday&&dayKind(state.date)==='today'){current.live=true;liveForToday=false;}
 if(observed()){
  current.best={plan,measure:null};
  model=prepared.observed;
  if(current.followObserved!==false)current.time=prepared.cut;
  else current.time=Math.min(current.time,Math.max(E.OPEN+1,prepared.cut));
 }else{
  baseline=scenario(plan);
  if(current.revision!==feed?.asOf||!current.best?.measure){
   const prior=current.best?.plan;
   const updated=Object.fromEntries(Object.entries(plan).map(([pool,n])=>[pool,prior?.[pool]??n]));
   current.best=prior?scenario(updated):baseline;
   current.revision=feed?.asOf;
   current.tested=[E.planKey(current.best.plan)];
   current.done=false;
  }
  model=E.simulate(roster,current.best.plan,E.seeds[0],!prepared,state.absence);
 }
 if(!keepSelection){selectedRoom=selectedPerson=selectedAppointment=null;selectedIncident=null;}
 populateDays();
 render();
 renderDecision();
 renderAnalysis();
}
function trial(plan,manual=false){
 if(observed())return;
 const result=scenario(plan),old=current.best;
 const changes=Object.keys(plan).filter(k=>plan[k]!==old.plan[k]).map(k=>label(k)+' '+old.plan[k]+' → '+plan[k]);
 const accepted=manual||result.measure.score<old.measure.score;
 current.count++;
 current.tested.push(E.planKey(plan));
 current.attempts.unshift({n:current.count,changes,accepted,manual,p90:average(result.measure,'p90'),above:average(result.measure,'above'),over:average(result.measure,'over')});

 if(accepted){current.best=result;model=E.simulate(roster,plan,E.seeds[0],true,state.absence);}
 current.done=false;
 save();render();
}
function step(){
 if(observed())return;
 const plan=E.nextPlan(current.best,new Set(current.tested));
 if(plan){trial(plan);return;}
 current.done=true;state.active=false;save();render();
}
function actual(){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Bahia',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
 return {date:parts.year+'-'+parts.month+'-'+parts.day,minute:Number(parts.hour)*60+Number(parts.minute)};
}
function minute(){return !observed()&&current.live?actual().minute:current.time;}
function inRoom(j,kind,time){
 const s=E.stage(j,time);
 if(kind==='reception')return ['reception','checkin'].includes(s);
 if(kind==='prep')return ['prepQueue','prep'].includes(s);
 return j.type===kind&&['examQueue','exam'].includes(s);
}
let timeline, timelineModel, timelineFocus;
let timelineChart=null,timelineSeries=null;
function drawTimeline(time){
 const end=timeline.end;
 timelineSeries=E.presenceSeries(model.jobs,end);
 timelineChart=G.timelineChart({series:timelineSeries,time,focus:state.focus,best:timeline.best,incidents:E.patrolIncidents(model),end});
 $('timelineChart').innerHTML=timelineChart.svg;
 $('timelineLegend').innerHTML=timelineChart.legend;
 $('timelineTable').innerHTML=G.timelineTable(timelineSeries,state.focus);
 $('waitChart').innerHTML=G.waitChart(E.waitByHour(model.jobs));
 const svg=$('timelineChart').querySelector('svg'),tip=$('timelineTip'),hover=svg.querySelector('#chartHover');
 const minuteOf=event=>{const box=svg.getBoundingClientRect();return {minute:timelineChart.minuteAt((event.clientX-box.left)/box.width),box};};
 svg.onpointermove=event=>{
  const {minute,box}=minuteOf(event);
  const m=Math.max(timelineSeries.from,Math.min(end,Math.round(minute)));
  tip.innerHTML=timelineChart.tooltip(m);tip.hidden=false;
  const wrap=$('timelineBox').getBoundingClientRect();
  tip.style.left=Math.min(wrap.width-170,Math.max(0,event.clientX-wrap.left+14))+'px';tip.style.top=Math.max(0,event.clientY-wrap.top-70)+'px';
  hover.setAttribute('x1',timelineChart.x(m));hover.setAttribute('x2',timelineChart.x(m));hover.setAttribute('visibility','visible');
 };
 svg.onpointerleave=()=>{tip.hidden=true;hover.setAttribute('visibility','hidden');};
 svg.onclick=event=>selectTime(minuteOf(event).minute);
}
function refreshTimeline(time){
 if(timelineModel!==model||timelineFocus!==state.focus){
  const end=maxMinute();
  timeline={...E.occupancyTimeline(model.jobs,state.focus,end,prepared&&!observed()?Math.max(E.OPEN,prepared.cut):E.OPEN),end};
  if(observed())timeline.best=null;
  timelineModel=model;
  timelineFocus=state.focus;
  const {peak,best,interval}=timeline;
  drawTimeline(time);
  $('occupancyScope').textContent=(E.units[state.focus]??'Todas as unidades')+
   ' · Pacientes únicos presentes, da chegada à saída. Pico '+(observed()?'observado':'previsto')+': '+peak+'.';
  $('quietTime').textContent=best?'Menor ocupação: '+E.clock(best.start)+'–'+E.clock(best.end)+
   ' · média de '+(best.sum/interval).toLocaleString('pt-BR',{maximumFractionDigits:1})+
   ' pacientes · pico de '+best.peak+'.':observed()?'Abra a previsão para comparar horários futuros.':'Sem faixas com marcações para comparar.';
  $('goQuiet').disabled=!best;
 }
 const outside=time<E.OPEN||time>timeline.end;
 const count=timeline.counts[Math.floor(time)-E.OPEN];
 $('occupancy').textContent=outside?'Fora da linha do tempo':count+(count===1?' paciente presente':' pacientes presentes');
 const cursor=$('chartCursor');
 if(cursor){cursor.setAttribute('visibility',outside?'hidden':'visible');cursor.setAttribute('x1',timelineChart.x(time));cursor.setAttribute('x2',timelineChart.x(time));}
 $('time').setAttribute('aria-valuetext',E.clock(time)+(outside?'':', '+count+' pacientes presentes'));
}
function selectTime(time){
 current.time=Math.max(E.OPEN,Math.min(maxMinute(),Math.round(time)));
 if(observed())current.followObserved=false;
 current.live=false;
 state.play=false;
 save();render();
}
let patrolModel, patrolTime, patrolFocus, patrolRecords=[], selectedIncident=null, inspection=null;
let patrolAlerts=Object.fromEntries(Object.keys(E.units).map(unit=>[unit,[]]));
function updatePatrol(time){
 const minute=Math.floor(time);
 if(patrolModel===model&&patrolTime===minute&&patrolFocus===state.focus)return;
 if(patrolModel!==model){
  const selectedId=selectedIncident?.id;
  patrolRecords=E.patrolIncidents(model);
  selectedIncident=patrolRecords.find(record=>record.id===selectedId)??null;
 }
 patrolModel=model;patrolTime=minute;patrolFocus=state.focus;
 const open=patrolRecords.filter(r=>r.from<=minute&&(r.to===null||minute<r.to));
 patrolAlerts=Object.fromEntries(Object.keys(E.units).map(unit=>[unit,open.filter(r=>r.unit===unit)]));
 const matches=r=>state.focus==='all'||r.unit===state.focus;
 if(selectedIncident&&(selectedIncident.from>minute||!matches(selectedIncident)))selectedIncident=null;
 renderInspection(minute);
 const active=open.filter(matches);
 const done=patrolRecords.filter(r=>matches(r)&&r.to!==null&&r.to<=minute).sort((a,b)=>b.to-a.to);
 $('patrolSummary').textContent=active.length?active.length+' gargalo(s) em aberto.':'Nenhum gargalo ativo neste horário.';
 $('patrolDoneSummary').textContent='Resolvidos ('+done.length+')';
 function list(records,resolved){
  return records.length?'<ul class="rows">'+records.map(r=>
   '<li><button class="patrol-entry" data-incident="'+r.id+'" aria-pressed="'+(selectedIncident===r)+'"><strong>'+
   E.clock(resolved?r.to:r.from)+' · '+E.patrols[r.unit].name+' · '+E.units[r.unit]+'</strong><br>'+
   (resolved?E.patrolResolution(r):E.patrolMessage(r,minute))+'</button></li>').join('')+'</ul>':'';
 }
 $('patrolActive').innerHTML=list(active,false);
 $('patrolDone').innerHTML=list(done,true);
}
function renderInspection(time){
 const panel=$('patrolDetail');
 panel.hidden=!selectedIncident;
 inspection=selectedIncident?E.patrolExplanation(selectedIncident,time,model,current.best.plan):null;
 if(!inspection)return;
 $('patrolSpeaker').textContent=E.patrols[inspection.unit].name+' · '+E.units[inspection.unit];
 $('patrolProblem').textContent=inspection.problem;
 $('patrolLocation').textContent=inspection.location;
 $('patrolReason').textContent=inspection.reason;
 $('patrolPatient').hidden=!selectedIncident.job.person;
}
for(const id of ['patrolActive','patrolDone'])$(id).onclick=event=>{
 const button=event.target.closest('[data-incident]');
 if(!button)return;
 selectedIncident=patrolRecords.find(record=>record.id===button.dataset.incident);
 for(const entry of document.querySelectorAll('.patrol-entry[aria-pressed="true"]'))entry.setAttribute('aria-pressed','false');
 button.setAttribute('aria-pressed','true');
 renderInspection(minute());
 $('patrolDetail').focus({preventScroll:true});
 $('patrolDetail').scrollIntoView({block:'nearest'});
};
$('patrolClose').onclick=()=>{
 const button=document.querySelector('.patrol-entry[aria-pressed="true"]');
 selectedIncident=null;
 renderInspection(minute());
 button?.setAttribute('aria-pressed','false');
 button?.focus();
};
$('patrolPatient').onclick=()=>openPatient(selectedIncident.job.person,selectedIncident.job.id);
$('patrolLocate').onclick=()=>{
 const scene=$('scenes').querySelector('[data-unit="'+inspection.unit+'"]');
 scene.scrollIntoView({block:'center'});
};
function render(){
 const time=minute(), now=actual(),day=activeDay, m=current.best.measure;
 const jobs=model.jobs.filter(j=>E.stage(j,time)!=='future');
 const follow=observed()&&current.followObserved!==false;
 const done=jobs.filter(j=>E.stage(j,time)==='finished').length;
 $('time').max=maxMinute();$('time').value=Math.floor(time);$('clock').textContent=E.clock(time);
 refreshTimeline(time);
 updatePatrol(time);
 $('now').textContent=observed()?'Eventos recebidos até '+E.clock(prepared.cut)+' · '+done+' atendimentos concluídos até a hora exibida.':(current.live&&now.date!==state.date?'Hora de Salvador aplicada ao dia selecionado. Hoje não é a data desta agenda. ':'')+'Recorte projetado · '+done+' concluídos de '+model.jobs.length+' até esta hora.';
 $('live').setAttribute('aria-pressed',observed()?follow:current.live);
 $('live').textContent=observed()?'Seguir última atualização':'Usar hora atual';
 for(const id of ['auto','step','reset','play','rate','less','more','prompt'])$(id).disabled=observed();
 $('absenceControl').hidden=observed();
 $('attemptsPanel').hidden=observed();
 $('play').textContent=state.play&&!current.live?'Pausar simulação':'Reproduzir simulação';
 $('auto').disabled=observed()||current.done;
 const absences=jobs.filter(j=>E.stage(j,time)==='absent').length;
 const total=model.summary.total;
 $('absenceStatus').textContent=observed()?absences+' faltas registradas até a hora exibida.':absences+' faltas reconhecidas até esta hora · '+model.summary.absences+' de '+total+' no cenário do dia ('+(model.summary.absences*100/(total||1)).toFixed(1).replace('.',',')+'%). '+(prepared?'Histórico aplicado onde disponível.':'Hipótese ajustável da demonstração.');

 $('auto').textContent=state.active?'Pausar tentativas':'Iniciar tentativas';
 $('step').disabled=observed()||current.done;
 $('metrics').innerHTML=(observed()?[[jobs.length,'marcações com eventos até a hora exibida'],[done,'concluídos'],[absences,'faltas registradas'],[model.jobs.filter(j=>['reception','prepQueue','examQueue'].includes(E.stage(j,time))).length,'em fila']]:[
  [model.jobs.length+' / '+day.people,'marcações / pessoas'],[done,'concluídos até agora'],[average(m,'p90')+' min','espera P90 média dos cenários'],[average(m,'above'),'acima de 30 min por cenário'],[average(m,'over')+' min','hora extra média após 19:00']
 ]).map(([v,l])=>'<div class="card metric"><b>'+v+'</b>'+l+'</div>').join('');
 $('map').innerHTML=Object.entries(E.units).map(([unit,name])=>{
  const entries=Object.entries(current.best.plan).filter(([k])=>k.startsWith(unit+':'));
  const upcoming=model.jobs.filter(j=>j.unit===unit);
  const waiting=upcoming.filter(j=>['reception','prepQueue','examQueue'].includes(E.stage(j,time))).length;
  return '<section class="unit"><h3>'+name+'</h3><small>Entrada → corredor → salas</small><p>'+upcoming.length+' marcações · '+waiting+' em fila</p><div class="rooms">'+entries.map(([k,n])=>{
   const t=k.split(':')[1], count=upcoming.filter(j=>inRoom(j,t,time)).length;
   return '<button data-room="'+k+'" aria-pressed="'+(k===selectedRoom)+'">'+labels[t]+'<br>'+n+' estação(ões) · '+count+' no setor</button>';
  }).join('')+'</div><p>Espera com cadeiras e pufes · balcão com escrivaninha</p></section>';
 }).join('');
 $('room').textContent=selectedRoom?label(selectedRoom)+' · '+current.best.plan[selectedRoom]+' estações. Pico de espera nesta etapa: '+(model.pools[selectedRoom]?.peak??0)+' min.':'Selecione uma estação para examinar a fila ou ajustar a capacidade.';
 $('less').disabled=observed()||!selectedRoom||current.best.plan[selectedRoom]<=1;
 $('more').disabled=observed()||!selectedRoom||current.best.plan[selectedRoom]>=6;
 $('change').textContent=selectedRoom?'Aplica o ajuste e simula novamente.':'';
 $('comparison').textContent=observed()?'':'Base: P90 '+average(baseline.measure,'p90')+' min · atual: '+average(m,'p90')+' min. '+m.resources+' estações. '+current.count+' tentativas. '+(current.done?'Busca local concluída.':'')+' '+day.confirmed+' confirmadas · '+day.excluded+' canceladas ou remarcadas fora da simulação.';
 $('incident').textContent=model.downtime?(observed()?'Parada registrada: primeira estação de ':'Ocorrência de teste: primeira estação de ')+label(model.downtime.key)+' indisponível das '+E.clock(model.downtime.from)+(model.downtime.to===null?' e ainda indisponível.':' às '+E.clock(model.downtime.to)+'.'):'';
 $('history').innerHTML='<ol class="rows">'+current.attempts.map(a=>'<li>#'+a.n+' · '+(a.manual?'Aplicada manualmente':a.accepted?'Melhorou':'Mantida a alocação anterior')+' · '+escapeHTML(a.changes.join(', '))+' · P90 '+a.p90+' min · '+a.above+' acima da meta · '+a.over+' min extras</li>').join('')+'</ol>';
 renderRows();
}
function renderRows(){
 const time=minute(), unit=$('unit').value, search=$('filter').value.trim().toLocaleLowerCase('pt-BR');
 $('rows').innerHTML=model.jobs.filter(j=>(!unit||unit===j.unit)&&
  [pid(j.person),E.units[j.unit],E.types[j.type][0],E.stages[E.stage(j,time)]].join(' ').toLocaleLowerCase('pt-BR').includes(search))
  .map(j=>'<tr><td><button data-person="'+j.person+'" data-appointment="'+j.id+'">'+pid(j.person)+'</button></td><td>'+E.clock(j.slot)+'</td><td>'+E.units[j.unit]+' / '+E.types[j.type][0]+'</td><td>'+E.stages[E.stage(j,time)]+'</td></tr>').join('');
 renderPatient(time);
}
function openPatient(person,appointment=null){
 selectedPerson=person;
 selectedAppointment=appointment;
 renderPatient(minute());
 $('journey').focus({preventScroll:true});
 $('journey').scrollIntoView({block:'nearest'});
}
function renderPatient(time){
 const panel=$('journey');
 panel.hidden=selectedPerson===null;
 if(panel.hidden){panel.replaceChildren();return;}
 const visits=model.jobs.filter(j=>j.person===selectedPerson)
  .sort((a,b)=>Number(b.id===selectedAppointment)-Number(a.id===selectedAppointment));
 const detail=visits.map(j=>{
  const {status,wait,mood}=E.patientStatus(j,time);
  const emotion=mood?'<span title="'+E.patientEmotions[mood][1]+'">'+E.patientEmotions[mood][0]+'</span> ':'';
  const timing=status==='future'||status==='absent'?'':' · Chegada '+E.clock(j.arrive)
   +(j.start!==null&&j.start<=time?' · Início '+E.clock(j.start):'')
   +(status==='finished'?' · Saída '+E.clock(j.end):'');
  const route=j.absent?'':'<br><small class="muted">'+(j.observed?'Eventos recebidos: chegada ':'Trajeto simulado: chegada ')+E.clock(j.arrive)+
   ' → cadastro '+E.clock(j.check)+(j.prepare===null?'':' → preparo '+E.clock(j.prepare))+
   ' → sala '+(j.room??'—')+' às '+E.clock(j.start)+' → saída '+E.clock(j.end)+'</small>';
  return '<li><strong>'+E.types[j.type][0]+' · '+E.units[j.unit]+'</strong><br>'+
   emotion+E.stages[status]+' · Marcado para '+E.clock(j.slot)+timing+
   (wait===null?'':' · <strong>Espera '+wait+' min</strong>')+route+'</li>';
 }).join('');
 const content='<h3>Paciente '+pid(selectedPerson)+'</h3><p class="muted">Situação às '+E.clock(time)+'</p><ul class="rows">'+detail+'</ul>';
 if(panel.innerHTML!==content)panel.innerHTML=content;
}

for(const [u,name] of Object.entries(E.units))$('unit').add(new Option(name,u));
$('staff').innerHTML=E.team.map(([name],i)=>'<button data-staff="'+i+'"><span class="portrait" style="background-position:'+i*12.5+'% 0"></span>'+name+'</button>').join('');
$('staff').onclick=e=>{
 const button=e.target.closest('[data-staff]');
 if(!button)return;
 const [name,unit,role,type]=E.team[button.dataset.staff];
 const count=model.jobs.filter(j=>j.unit===unit&&(type==='exam'?['exam','examQueue'].includes(E.stage(j,minute())):inRoom(j,type,minute()))).length;
 $('staffDetail').textContent=name+' · '+E.units[unit]+' · '+role+'. '+count+' atendimentos no setor nesta hora simulada.';
};
$('day').onchange=()=>{state.date=$('day').value;if(state.mode==='demo'){openDay();save();return;} $('sourceDate').value=state.sourceDate=state.date;openDay();save();describeSource();};
$('auto').onclick=()=>{if(current.done)return;state.active=!state.active;save();render();};
$('step').onclick=()=>step();
$('time').oninput=()=>selectTime(Number($('time').value));
$('goQuiet').onclick=()=>{if(timeline.best)selectTime(timeline.best.start);};
$('play').onclick=()=>{
 if(current.live){current.live=false;state.play=true;}else state.play=!state.play;
 if(state.play&&current.time>=maxMinute())current.time=E.OPEN;
 save();render();
};
$('rate').onchange=()=>{state.speed=Number($('rate').value);save();};
$('sceneUnit').onchange=()=>{state.focus=$('sceneUnit').value;scenes.focus(state.focus);save();render();};
$('absence').onchange=()=>{
 const time=minute(),live=current.live;
 state.absence=Number($('absence').value);openDay();current.time=time;current.live=live;
 save();render();
};
$('live').onclick=()=>{if(observed()){current.followObserved=true;current.time=prepared.cut;}else current.live=!current.live;save();render();};
$('map').onclick=e=>{const button=e.target.closest('[data-room]');if(button){selectedRoom=button.dataset.room;render();}};
for(const [id,delta] of [['less',-1],['more',1]])$(id).onclick=()=>trial({...current.best.plan,[selectedRoom]:current.best.plan[selectedRoom]+delta},true);
$('reset').onclick=()=>{
 if(!window.confirm('Reiniciar os dois dias e descartar as tentativas? Os pedidos de melhoria serão mantidos.'))return;
 state.days={};state.profiles={};state.active=false;openDay();save();
};
$('rows').onclick=e=>{const b=e.target.closest('[data-person]');if(b)openPatient(Number(b.dataset.person),Number(b.dataset.appointment));};
$('filter').oninput=$('unit').onchange=renderRows;
$('notes').value=state.notes;
$('notes').oninput=()=>{state.notes=$('notes').value;save();};
$('prompt').onclick=()=>{
 const m=current.best.measure;
 const bottlenecks=Object.entries(m.pressure).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,n])=>label(k)+' ('+Math.round(n/3)+' min de espera acumulada por cenário)');
 $('export').value=[
  'Revise a simulação operacional da CSI para '+state.date+'. Proponha ajustes testáveis de capacidade, fluxo e distribuição do espaço. Informe que dados reais precisamos medir para calibrar o modelo.',
  'Agenda agregada: '+model.jobs.length+' marcações, '+activeDay.people+' pessoas estimadas na exportação. A projeção usa tempos simulados. Registros observados, quando disponíveis, calibram a previsão. Três amostras reproduzíveis por alocação.',
  'Faltas simuladas: '+model.summary.absences+' de '+model.summary.total+' na cena. Probabilidade configurada: '+state.absence+'%. '+
  'Resultados projetados: P90 '+average(m,'p90')+' min, '+average(m,'above')+' acima de 30 min, '+average(m,'over')+' min extras após 19:00 e '+average(m,'missed')+' pendentes por cenário. Base P90: '+average(baseline.measure,'p90')+' min.',
  'Gargalos: '+bottlenecks.join('; '),
  'Alocação: '+Object.entries(current.best.plan).map(([k,n])=>label(k)+' '+n).join('; '),
  'Últimas tentativas: '+current.attempts.slice(0,8).map(a=>'#'+a.n+' '+a.changes.join(', ')+' (P90 '+a.p90+' min)').join('; '),
  'Indicadores reais da clínica: '+(indicators?indicators.unidades.map(u=>E.units[u.unidade]+': '+u.marcadas+' marcadas, '+D.pct(u.pct_falta,1)+' de falta, '+D.pct(u.pct_cancela_remarca,1)+' canceladas/remarcadas').join('; ')+'. Falta por confirmação: '+indicators.confirmacao.filter(c=>c.situacao!=='x').map(c=>c.situacao+' '+D.pct(c.pct_falta,1)).join(', ')+'.':'não carregados'),
  'Recomendações automáticas: '+((lastDecision?.recs??[]).slice(0,6).map(r=>r.title+' — '+r.text).join(' | ')||'nenhuma'),
  'Limites dos dados: o Klingo não informa início e fim do exame nem salas; tempos internos são premissas.',
  'Pedidos de melhoria: '+(state.notes.trim()||'Nenhuma anotação manual.')
 ].join('\n\n');
 $('export').hidden=false;$('copy').disabled=false;
};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('export').value);$('copyStatus').textContent='Texto copiado.';}catch{$('export').select();$('copyStatus').textContent='Texto selecionado para copiar.';}};
function maxMinute(){return observed()?Math.max(E.OPEN+1,prepared.cut):Math.max(1200,model.summary.last+3,...model.jobs.filter(j=>j.absent).map(j=>j.slot+15));}
const todayDate=()=>localClock(new Date()).date;
const dayKind=date=>date<todayDate()?'past':date>todayDate()?'future':'today';
const kindText={past:'Dia fechado: marcações, faltas e chegadas reais do Klingo. O fluxo dentro da clínica (guichê, preparo, sala) é simulado.',
 today:'Hoje: marcações, faltas e chegadas até agora são reais. O restante do dia é projetado.',
 future:'Dia futuro: marcações atuais do Klingo mais o volume esperado pelo histórico. Faltas previstas pela situação da confirmação.'};
function describeSource(message){
 const feed=snapshots.get(state.date);
 const retained=db?'':' Armazenamento de dados indisponível neste navegador.';
 if(message){$('sourceStatus').textContent=message+retained;return;}
 if(state.mode==='demo'){$('sourceStatus').textContent='Demonstração com dados fictícios. Escolha "Klingo + banco" para usar a clínica real.'+retained;return;}
 const sync=feed.meta?.sync?' · Jornada leu o Klingo em '+new Date(feed.meta.sync).toLocaleString('pt-BR',{timeZone:'America/Bahia'}):'';
 $('sourceStatus').textContent='Relatório #14359 do Klingo pela Jornada · lido em '+new Date(feed.asOf).toLocaleString('pt-BR',{timeZone:'America/Bahia'})+sync+'. '+
  kindText[dayKind(state.date)]+' '+(prepared?.meta?D.num(prepared.meta.com_chegada_real)+' chegada(s) real(is), '+D.num(prepared.meta.faltas_registradas)+' falta(s) registrada(s), '+D.num(prepared.probableAbsences)+' falta(s) provável(is), '+D.num(prepared.meta.canceladas_ou_remarcadas)+' cancelada(s)/remarcada(s) fora da simulação'+(prepared.meta.fora_do_modelo?', '+D.num(prepared.meta.fora_do_modelo)+' de procedimento fora do modelo':'')+'. ':'')+
  prepared.historicalDays+' dia(s) de histórico, '+prepared.historicalVisits+' marcação(ões) a mais estimada(s) pelo histórico.'+retained;
}
function applyMode(mode){
 if(mode==='demo')state.date=dates.includes(state.date)?state.date:dates[0];
 else if(!snapshots.has(state.date)){
  state.sourceDate=$('sourceDate').value||todayDate();
  state.mode=mode;$('dataMode').value=mode;save();
  sync(true);
  return;
 }
 state.mode=mode;
 $('dataMode').value=mode;
 openDay();save();describeSource();
}
$('dataMode').onchange=()=>{
 const asked=$('dataMode').value;
 $('dataMode').value=state.mode;
 applyMode(asked);
};
$('sourceDate').onchange=()=>{state.sourceDate=$('sourceDate').value;save();if(state.mode!=='demo')sync(true);};
for(const [id,delta] of [['dayBack',-1],['dayNext',1]])$(id).onclick=()=>{
 const base=new Date(($('sourceDate').value||todayDate())+'T12:00:00Z');
 base.setUTCDate(base.getUTCDate()+delta);
 $('sourceDate').value=base.toISOString().slice(0,10);
 state.mode='forecast';$('dataMode').value='forecast';
 sync(true);
};
$('dayToday').onclick=()=>{$('sourceDate').value=todayDate();state.mode='forecast';$('dataMode').value='forecast';sync(true);};
async function session(){
 if(!client)return null;
 try{return (await client.auth.getSession()).data.session;}catch{return null;}
}
function showLogin(show,message=''){$('loginCard').hidden=!show;$('loginMessage').textContent=message;}
$('loginForm').onsubmit=async event=>{
 event.preventDefault();
 $('loginMessage').textContent='Entrando…';
 const {error}=await client.auth.signInWithPassword({email:$('loginEmail').value.trim(),password:$('loginPassword').value});
 if(error){$('loginMessage').textContent=/invalid login/i.test(error.message)?'E-mail ou senha incorretos.':error.message;return;}
 $('loginPassword').value='';
 showLogin(false);
 sync(true);
};
let indicatorsAt=0;
let externa=null,decisaoPainel=null,demoExterna=null,demoDecisao=null;
async function loadIndicators(force=false){
 if(!client||(!force&&Date.now()-indicatorsAt<600000&&indicators))return;
 const [ind,ext,dec]=await Promise.allSettled([fetchIndicators(client,config.indicatorDays),fetchExterna(client,config.indicatorDays),fetchDecisao(client,config.indicatorDays)]);
 if(ind.status==='fulfilled'){indicators=ind.value;indicatorsError='';}else indicatorsError=ind.reason.message;
 if(ext.status==='fulfilled')externa=ext.value;
 if(dec.status==='fulfilled')decisaoPainel=dec.value;
 if(ind.status==='fulfilled'||ext.status==='fulfilled')indicatorsAt=Date.now();
 decisionKey='';renderDecision();analysisKey='';renderAnalysis();
}
let syncing=false;
async function sync(showDate=false){
 if(syncing)return;
 if(!client){describeSource('O Supabase não carregou. Verifique a conexão e recarregue a página.');return;}
 const requested=showDate?$('sourceDate').value:state.date;
 if(!requested){describeSource('Selecione a data que deseja carregar.');return;}
 if(!await session()){showLogin(true,'Entre com a conta do painel (administrador ou atendente) para carregar os dados reais da clínica.');return;}
 showLogin(false);
 syncing=true;
 $('sync').disabled=true;
 try{
  const next=await fetchSnapshot(client,requested);
  const previous=snapshots.get(requested);
  const newer=!previous||previous.asOf<next.asOf;
  let saved=false;
  if(newer){
   snapshots.set(requested,next);
   if(db)try{await putSnapshot(db,next);saved=true;}catch{}
  }
  if(showDate){
   state.sourceDate=requested;
   state.date=requested;
   state.mode=state.mode==='demo'?'forecast':state.mode;
   $('dataMode').value=state.mode;
   if(dayKind(requested)==='today')liveForToday=true;
   applyMode(state.mode);
  }else if(newer&&state.mode!=='demo'&&state.date===requested){openDay(true);save();describeSource();}
  else describeSource();
  if(newer&&!saved)describeSource('Dados atualizados em memória. O navegador não gravou este retorno.');
  loadIndicators(showDate);
 }catch(error){describeSource('Falha ao carregar. Últimos dados preservados. '+error.message);if(/Entre com/.test(error.message))showLogin(true,error.message);}
 finally{syncing=false;$('sync').disabled=false;}
}
$('sync').onclick=()=>sync(true);
$('backup').onclick=async()=>{
 try{
  const revisions=db?await listSnapshots(db):[];
  const combined=new Map([...revisions,...snapshots.values()].map(feed=>[feed.date,feed]));
  const file=new Blob([JSON.stringify({version:3,state,snapshots:[...combined.values()]},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(file),link=document.createElement('a');
  link.href=url;link.download='clinica-csi-backup-'+localClock(new Date()).date+'.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){describeSource('Falha ao exportar: '+error.message);}
};
$('restore').onchange=async()=>{
 const file=$('restore').files[0];
 if(!file)return;
 try{
  const fileData=JSON.parse(await file.text());
  const legacy=fileData?.version===undefined&&typeof fileData?.notes==='string'&&(fileData?.profiles||fileData?.days);
  const backup=legacy?{version:3,state:migrateLegacy(fileData),snapshots:[]}:fileData;
  if(![2,3].includes(backup?.version)||!Array.isArray(backup.snapshots)||!backup.state||typeof backup.state!=='object'||Array.isArray(backup.state))throw Error('Backup incompatível.');
  const revisions=backup.snapshots.map(feed=>normalizeSnapshot(feed));
  if(!window.confirm('Restaurar as configurações, anotações e tentativas do backup? Os retornos do endpoint serão mesclados.'))return;
  const restored=backup.state;
  // Valida as opções de interface e usa somente o estado gerado por este aplicativo.
  if(!['demo','forecast','observed'].includes(restored.mode)||typeof restored.notes!=='string'||!restored.profiles||typeof restored.profiles!=='object')throw Error('Estado de simulação inválido.');
  for(const levels of Object.values(restored.profiles)){
   for(const profile of Object.values(levels)){
    const plan=Object.fromEntries(Object.entries(profile.best?.plan??{}).filter(([pool,n])=>{
     const [unit,type,extra]=pool.split(':');
     return !extra&&Object.hasOwn(E.units,unit)&&Object.hasOwn(E.types,type)&&Number.isInteger(n)&&n>=1&&n<=6;
    }));
    profile.best={plan};
    profile.revision=null;
    profile.attempts=Array.isArray(profile.attempts)?profile.attempts.map(a=>({
     n:Number(a.n), manual:a.manual===true, accepted:a.accepted===true,
     changes:Array.isArray(a.changes)?a.changes.filter(x=>typeof x==='string'):[],
     p90:Number(a.p90),above:Number(a.above),over:Number(a.over)
    })):[];
   }
  }
  restored.extras=Object.fromEntries(Object.entries(restored.extras??{}).map(([k,list])=>[k,(Array.isArray(list)?list:[]).filter(x=>Object.hasOwn(E.units,x?.unit)&&Object.hasOwn(E.types,x?.type)&&!['reception','prep'].includes(x.type)&&Number.isInteger(x.hour)&&x.hour>=0&&x.hour<=23&&Number.isInteger(x.qty)&&x.qty>=1&&x.qty<=20)]));
  restored.clinicPlan=restored.clinicPlan&&typeof restored.clinicPlan==='object'?Object.fromEntries(Object.entries(restored.clinicPlan).filter(([pool,n])=>{const [unit,type,extra]=pool.split(':');return !extra&&Object.hasOwn(E.units,unit)&&Object.hasOwn(E.types,type)&&Number.isInteger(n)&&n>=1&&n<=6;})):null;
  if(!restored.assump||typeof restored.assump!=='object')restored.assump={reception:[3,6],prep:[4,8],duration:{}};
  if(revisions.length&&!db)throw Error('Habilite o armazenamento do navegador antes de restaurar os retornos.');
  for(const feed of revisions)await putSnapshot(db,feed);
  localStorage.setItem(key,JSON.stringify(restored));
  location.reload();
 }catch(error){describeSource('Falha ao restaurar: '+error.message);}
 finally{$('restore').value='';}
};
openDay();save();describeSource();

function clinicStage(){
 if(!model||!current?.best?.measure)return null;
 const time=minute(),waitingByUnit={};
 let waiting=0;
 for(const unit of Object.keys(E.units)){
  waitingByUnit[unit]=model.jobs.filter(j=>j.unit===unit&&['reception','prepQueue','examQueue'].includes(E.stage(j,time))).length;
  waiting+=waitingByUnit[unit];
 }
 const p90=average(current.best.measure,'p90'),above=average(current.best.measure,'above');
 const level=p90>=60?'critical':p90>=45?'serious':p90>=30?'warning':'good';
 return {waiting,waitingByUnit,level,units:waitingByUnit,text:'Espera P90 simulada de '+p90+' min; '+above+' atendimento(s) acima de 30 min; '+waiting+' pessoa(s) em fila às '+E.clock(time)+'.'};
}
function renderAnalysis(force=false){
 if(!current||!$('kpis'))return;
 const demo=state.mode==='demo';
 const ext=demo?demoExterna:externa,dec=demo?demoDecisao:decisaoPainel;
 const sim=observed()?null:clinicStage();
 const signature=[state.mode,state.date,ext?.gerado_em,dec?.periodo?.ate,(lastDecision?.recs??[]).map(r=>r.title).join('|'),sim?.level,state.clinicPlan?1:0].join('#');
 if(signature===analysisKey&&!force)return;
 analysisKey=signature;
 const stages=A.buildStages(ext,sim);
 const pontos=A.pontosDeAtencao({stages,decisao:dec,recs:lastDecision?.recs??[]});
 lastAnalysis={stages,pontos,sim,ext,dec};
 $('kpis').innerHTML=dec?G.kpiTiles(A.cartoesDoPainel(dec)):'<p class="muted">'+(state.mode==='demo'?'Sem dados de demonstração.':'Os indicadores do painel ainda não carregaram.')+'</p>';
 $('indPeriod').textContent=dec?.periodo?'Período dos indicadores: '+dec.periodo.de+' a '+dec.periodo.ate+(demo?' (dados fictícios)':'')+'.':'';
 $('attention').innerHTML=G.attentionList(pontos);
 $('strip').innerHTML=G.stageStrip(stages,ext?.base);
 update3D();
}
async function update3D(){
 if(!lastAnalysis)return;
 if(scene3dState==='idle'){
  scene3dState='loading';
  try{
   const module=await import('./cena3d.mjs');
   scene3d=module.createScene($('scene3d'),{onSelect:selectPoint});
   if(!scene3d){scene3dState='off';$('scene3dMsg').textContent='Este navegador não abriu o 3D (WebGL indisponível). A lista de pontos de atenção acima traz as mesmas informações.';$('d3Status').textContent='3D indisponível';return;}
   scene3dState='ready';$('scene3dMsg').remove();
  }catch(error){scene3dState='off';$('scene3dMsg').textContent='Não foi possível carregar o 3D ('+error.message+'). A lista de pontos de atenção acima traz as mesmas informações.';$('d3Status').textContent='3D indisponível';return;}
 }
 if(scene3dState!=='ready')return;
 scene3d.setData({stages:lastAnalysis.stages,pontos:lastAnalysis.pontos,sim:lastAnalysis.sim});
 const s=scene3d.state();
 $('d3Status').textContent=s.attention.length+' ponto(s) de atenção em destaque · '+s.ghost.length+' em ordem (contorno)';
}
function selectPoint(id){
 const point=lastAnalysis?.pontos.find(p=>p.id===id);
 if(!point)return;
 for(const li of document.querySelectorAll('#attention li'))li.removeAttribute('aria-current');
 const button=document.querySelector('#attention [data-point="'+id+'"]');
 button?.closest('li')?.setAttribute('aria-current','true');
 button?.scrollIntoView({block:'nearest',behavior:'smooth'});
}
$('attention').onclick=event=>{
 const button=event.target.closest('[data-point]');
 if(!button)return;
 const stage=button.dataset.stage;
 selectPoint(button.dataset.point);
 if(scene3d&&stage)scene3d.focusOn(stage);
 $('sec-3d').scrollIntoView({behavior:'smooth',block:'start'});
};
$('strip').onclick=event=>{const space=event.target.closest('[data-stage]');if(space&&scene3d){scene3d.focusOn(space.dataset.stage);$('sec-3d').scrollIntoView({behavior:'smooth',block:'start'});}};
$('d3Rotate').onclick=()=>{if(!scene3d)return;$('d3Rotate').setAttribute('aria-pressed',String(scene3d.toggleRotate()));};
$('d3Reset').onclick=()=>{if(!scene3d)return;scene3d.resetView();$('d3Rotate').setAttribute('aria-pressed','true');};
function invalidate(){
 for(const levels of Object.values(state.profiles))for(const profile of Object.values(levels))profile.revision='stale';
 decisionKey='';
}
const brief=measure=>({p90:average(measure,'p90'),above:average(measure,'above'),over:average(measure,'over')});
function renderDecision(force=false){
 if(!current||!$('decisionCard'))return;
 const extras=state.extras[profileKeyNow()]??[];
 const signature=[state.mode,state.date,E.planKey(current.best.plan),prepared?.cut,snapshots.get(state.date)?.asOf,state.absence,JSON.stringify(state.assump),JSON.stringify(extras),indicatorsAt,indicatorsError].join('|');
 if(signature===decisionKey&&!force)return;
 decisionKey=signature;
 clearTimeout(decisionTimer);
 decisionTimer=setTimeout(computeDecision,25);
}
function computeDecision(){
 const box=$('recommendations');
 const extras=state.extras[profileKeyNow()]??[];
 if(observed()||!current?.best?.measure){box.innerHTML='<p class="muted">As recomendações usam a simulação do dia (modo Demonstração ou Klingo + banco).</p>';renderPanels();return;}
 const plan=current.best.plan,incident=!prepared;
 const tests=D.stationTests(roster,plan,state.absence,incident);
 const open=D.absencePlan(roster,prepared?.calibration?.absenceOverall??state.absence);
 const confirmation=D.confirmationOpportunity(roster,prepared?.calibration);
 const recs=D.buildRecommendations({date:state.date,jobs:model.jobs,summary:model.summary,tests,absence:open,confirmation,timeline,indicators,calibration:prepared?.calibration,meta:prepared?.meta,mode:state.mode});
 lastDecision={recs,tests,open,confirmation};
 renderAnalysis();
 box.innerHTML='<ul class="recs">'+recs.map(r=>'<li data-level="'+r.level+'"><span class="tag">'+({alta:'Agir hoje',media:'Avaliar',info:'Informação'})[r.level]+'</span> <strong>'+D.esc(r.title)+'</strong><br>'+D.esc(r.text)+(r.proof.length?'<br><small class="muted">'+r.proof.map(D.esc).join(' · ')+'</small>':'')+'</li>').join('')+'</ul>';
 const use=Object.entries(tests.use).filter(([pool])=>plan[pool]).sort((a,b)=>b[1]-a[1]);
 $('usage').innerHTML='<h4>Uso de cada estação no dia simulado</h4><div class="usage">'+use.map(([pool,value])=>'<span class="usage-row"><span>'+D.esc(D.poolLabel(pool))+' · '+plan[pool]+' estação(ões)</span><span class="bar" role="img" aria-label="'+D.pct(value*100)+' de uso"><i style="width:'+Math.min(100,value*100).toFixed(0)+'%;background:'+(value>.85?'#f6c970':value<.3?'#7c99a3':'#9be8d6')+'"></i></span><b>'+D.pct(value*100)+'</b></span>').join('')+'</div><p class="muted">Amarelo: acima de 85% (pouca folga para atrasos). Cinza: abaixo de 30% (sobra).</p>';
 const effect=extras.length?(()=>{
  const without=E.measure(baseRoster,plan,state.absence,incident),a=brief(without),b=brief(current.best.measure);
  return '<p><strong>Efeito dos encaixes:</strong> sem eles, espera P90 de '+a.p90+' min e '+a.above+' atendimento(s) acima de 30 min; com eles, '+b.p90+' min e '+b.above+'. Horas extras: '+a.over+' → '+b.over+' min.</p>';
 })():'';
 $('extraList').innerHTML=(extras.length?'<ul class="rows">'+extras.map((x,i)=>'<li>'+x.qty+' encaixe(s) · '+D.esc(E.units[x.unit])+' · '+D.esc(E.types[x.type][0])+' às '+String(x.hour).padStart(2,'0')+'h <button data-extra-remove="'+i+'">Remover</button></li>').join('')+'</ul>':'<p class="muted">Nenhum encaixe testado neste dia.</p>')+effect;
 const suggestions=open.rows.filter(r=>r.suggested>=1).slice(0,4);
 $('extraSuggest').innerHTML=suggestions.length?'Sugestões pelo histórico: '+suggestions.map(r=>'<button data-suggest="'+r.unit+':'+r.type+':'+r.hour+':'+r.suggested+'">'+D.esc(E.units[r.unit])+' '+D.esc(E.types[r.type][0])+' '+String(r.hour).padStart(2,'0')+'h × '+r.suggested+'</button>').join(' '):'';
 renderPanels();
}
const panelBuilders={summary:D.panelSummary,absence:D.panelAbsence,arrival:D.panelArrival,demand:D.panelDemand,upcoming:D.panelUpcoming,process:D.panelProcess};
state.panel??='summary';
function renderPanels(){
 for(const button of document.querySelectorAll('[data-panel]'))button.setAttribute('aria-pressed',String(button.dataset.panel===state.panel));
 if(!indicators){$('panelBody').innerHTML='<p class="muted">'+(indicatorsError?D.esc(indicatorsError):(state.mode==='demo'?'Os indicadores reais aparecem ao carregar o modo "Klingo + banco".':'Carregando indicadores…'))+'</p>';return;}
 $('panelBody').innerHTML=panelBuilders[state.panel](indicators)+'<details><summary>O que o Klingo não informa</summary><ul class="rows">'+D.dataGaps(prepared?.meta,prepared?.calibration).map(x=>'<li>'+D.esc(x)+'</li>').join('')+'</ul></details>';
}
for(const button of document.querySelectorAll('[data-panel]'))button.onclick=()=>{state.panel=button.dataset.panel;save();renderPanels();};
// Encaixes
for(const [unit,name] of Object.entries(E.units))$('extraUnit').add(new Option(name,unit));
for(const [type,[name]] of Object.entries(E.types))if(!['reception','prep'].includes(type))$('extraType').add(new Option(name,type));
for(let hour=7;hour<=18;hour++)$('extraHour').add(new Option(String(hour).padStart(2,'0')+'h',hour));
$('extraHour').value=9;
function addExtra(unit,type,hour,qty){
 if(observed())return;
 const list=state.extras[profileKeyNow()]??=[];
 list.push({unit,type,hour,qty:Math.max(1,Math.min(20,qty))});
 invalidate();openDay(true);save();
}
$('extraAdd').onclick=()=>addExtra($('extraUnit').value,$('extraType').value,Number($('extraHour').value),Number($('extraQty').value)||1);
$('extraClear').onclick=()=>{delete state.extras[profileKeyNow()];invalidate();openDay(true);save();};
$('extraList').onclick=event=>{
 const button=event.target.closest('[data-extra-remove]');
 if(!button)return;
 state.extras[profileKeyNow()].splice(Number(button.dataset.extraRemove),1);
 invalidate();openDay(true);save();
};
$('extraSuggest').onclick=event=>{
 const button=event.target.closest('[data-suggest]');
 if(!button)return;
 const [unit,type,hour,qty]=button.dataset.suggest.split(':');
 addExtra(unit,type,Number(hour),Number(qty));
};
// Premissas do fluxo dentro da clínica
const assumptionTypes=Object.keys(E.types).filter(type=>!['reception','prep'].includes(type));
$('durations').innerHTML=assumptionTypes.map(type=>'<label>'+E.types[type][0]+' <input type="number" min="3" max="240" data-duration="'+type+'" placeholder="'+E.types[type][1]+'"> min</label>').join('');
function fillAssumptions(){
 const [rl,rh]=E.assumptions.reception,[pl,ph]=E.assumptions.prep;
 $('recLow').value=rl;$('recHigh').value=rh;$('prepLow').value=pl;$('prepHigh').value=ph;
 for(const input of document.querySelectorAll('[data-duration]'))input.value=E.assumptions.duration[input.dataset.duration]??'';
}
function readAssumptions(){
 const duration={};
 for(const input of document.querySelectorAll('[data-duration]'))if(input.value!=='')duration[input.dataset.duration]=Number(input.value);
 return {reception:[Number($('recLow').value),Number($('recHigh').value)],prep:[Number($('prepLow').value),Number($('prepHigh').value)],duration};
}
fillAssumptions();
$('assumptions').onchange=()=>{
 state.assump=readAssumptions();E.setAssumptions(state.assump);fillAssumptions();state.assump={reception:E.assumptions.reception,prep:E.assumptions.prep,duration:E.assumptions.duration};
 invalidate();openDay(true);save();
};
$('assumptionsReset').onclick=()=>{state.assump={reception:[3,6],prep:[4,8],duration:{}};E.setAssumptions(state.assump);fillAssumptions();invalidate();openDay(true);save();};
// Capacidade atual da clínica
function describeCapacity(){
 $('capacityStatus').textContent=state.clinicPlan?'Capacidade salva: '+Object.entries(state.clinicPlan).filter(([pool,n])=>n>1||pool.endsWith(':reception')===false&&n>0).map(([pool,n])=>D.poolLabel(pool)+' '+n).join(' · '):'Capacidade estimada pelo volume do dia (o Klingo não informa salas e profissionais). Ajuste e salve para valer em todos os dias.';
}
$('capacitySave').onclick=()=>{
 if(observed())return;
 state.clinicPlan={...current.best.plan};state.profiles={};state.active=false;
 openDay(true);save();describeCapacity();
};
$('capacityClear').onclick=()=>{state.clinicPlan=null;state.profiles={};state.active=false;openDay(true);save();describeCapacity();};
describeCapacity();
renderDecision(true);
let previousFrame=0,lastDraw=0,lastUi=0;
function frame(timestamp){
 const delta=Math.min(.09,(timestamp-(previousFrame||timestamp))/1000);
 previousFrame=timestamp;
 if(!observed()&&state.play&&!current.live&&!document.hidden){
  current.time=Math.min(maxMinute(),current.time+delta*state.speed);
  if(current.time>=maxMinute()){state.play=false;save();render();}
 }
 if(timestamp-lastDraw>=32&&!document.hidden){
  const time=minute();
  updatePatrol(time);
  scenes.draw(model,current.best.plan,time,selectedPerson,state.play&&!current.live,patrolAlerts,inspection,timestamp);
  lastDraw=timestamp;
 }
 if(timestamp-lastUi>=700&&!observed()&&(state.play||current.live)&&!document.hidden){lastUi=timestamp;render();}
 requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(()=>{if(!observed()&&state.active&&!document.hidden)step();},1500);
setInterval(()=>{if(state.play&&!document.hidden)save();},5000);
document.addEventListener('visibilitychange',()=>{if(document.hidden)save();});
window.addEventListener('pagehide',save);
window.__simulacao={analise:()=>lastAnalysis,cena:()=>scene3d?.state?.()??null,estado3d:()=>scene3dState};
// Início: só depois de tudo definido (o await abaixo deixa os temporizadores rodarem).
try{[demoExterna,demoDecisao]=await Promise.all([fetch('./examples/externa.json').then(r=>r.json()),fetch('./examples/decisao.json').then(r=>r.json())]);}catch{}
renderAnalysis(true);
if(client){
 const active=await session();
 if(active){
  if(stored.mode===undefined||wantedMode!=='demo'){state.mode='forecast';state.sourceDate=todayDate();$('sourceDate').value=state.sourceDate;$('dataMode').value='forecast';liveForToday=true;sync(true);}
  else loadIndicators();
 }else if(wantedMode!=='demo'||stored.mode===undefined)showLogin(true,'Entre com a conta do painel para carregar os dados reais da clínica. Sem login, a demonstração continua disponível.');
}
setInterval(()=>{if(!document.hidden&&state.mode!=='demo'&&dayKind(state.date)==='today'){sync();loadIndicators(true);}},Math.max(15000,config.pollMs));
