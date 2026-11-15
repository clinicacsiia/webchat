// Fluxo: simulação do dia (motor) + indicadores reais do banco → recomendações com número e prova → HTML do painel "Decisão".
// Versão 1.0 — 15/11/2026 / Mudança: criação (testes de estação a mais ou a menos, plano de encaixes por falta esperada, oportunidade de confirmação, painéis de faltas, chegadas, demanda, próximos dias e processo chat → clínica).
// Só funções puras (sem tela, sem rede): testadas em node (testes/simulacao.test.mjs).
import * as E from './engine.mjs';

export const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
export const poolLabel=key=>{const [unit,type]=key.split(':');return (E.units[unit]??unit)+' · '+(E.types[type]?.[0]??type);};
export const pct=(value,digits=0)=>value===null||value===undefined||!Number.isFinite(Number(value))?'—':Number(value).toLocaleString('pt-BR',{maximumFractionDigits:digits,minimumFractionDigits:digits})+'%';
export const num=(value,digits=0)=>value===null||value===undefined||!Number.isFinite(Number(value))?'—':Number(value).toLocaleString('pt-BR',{maximumFractionDigits:digits,minimumFractionDigits:digits});
const weekdays=['','Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'];
const confirmNames={confirmado:'Confirmado','a_confirmar':'A confirmar','sem_resposta':'Sem resposta',x:'Sem situação'};
const confirmFromKlingo={'Confirmado':'confirmado','A Confirmar':'a_confirmar','Sem Resposta':'sem_resposta',x:'x'};

const brief=m=>({p90:Math.round(m.totals.p90/E.seeds.length),above:Math.round(m.totals.above/E.seeds.length),over:Math.round(m.totals.over/E.seeds.length),missed:Math.round(m.totals.missed/E.seeds.length),resources:m.resources});

// Testa, no mesmo dia, uma estação a mais nos setores que mais acumularam espera e uma a menos nos setores muito ociosos.
export function stationTests(roster,plan,absence,incident,{top=3}={}){
 const base=E.measure(roster,plan,absence,incident);
 const before=brief(base);
 const pressure=Object.entries(base.pressure).filter(([key,wait])=>wait>0&&plan[key]<6).sort((a,b)=>b[1]-a[1]).slice(0,top);
 const more=pressure.map(([pool,wait])=>{
  const after=brief(E.measure(roster,{...plan,[pool]:plan[pool]+1},absence,incident));
  return {pool,from:plan[pool],to:plan[pool]+1,waitPerScenario:Math.round(wait/E.seeds.length),before,after};
 });
 const summary=E.simulate(roster,plan,E.seeds[0],incident,absence).summary;
 const use=E.utilization(summary,plan);
 const less=Object.entries(use).filter(([pool,value])=>plan[pool]>=2&&value<.3).sort((a,b)=>a[1]-b[1]).slice(0,2).map(([pool,value])=>{
  const after=brief(E.measure(roster,{...plan,[pool]:plan[pool]-1},absence,incident));
  return {pool,from:plan[pool],to:plan[pool]-1,use:value,before,after,safe:after.p90<=before.p90+3&&after.above<=before.above+2&&after.missed<=before.missed};
 });
 return {before,more,less,use,pressure:base.pressure};
}

// Quantas faltas são esperadas por unidade, modalidade e hora entre quem ainda não chegou, e quantos encaixes o histórico sustenta.
export function absencePlan(roster,fallbackRate=0){
 const open=roster.filter(r=>!r.extra&&!r.historical&&!r.knownPresent&&!r.knownAbsent&&!Number.isFinite(r.actualArrival));
 const groups=new Map();
 for(const row of open){
  const hour=Math.floor(row.slot/60),id=row.unit+':'+row.type+':'+hour;
  const group=groups.get(id)??{unit:row.unit,type:row.type,hour,booked:0,expected:0};
  group.booked++;group.expected+=(row.absenceRate??fallbackRate)/100;
  groups.set(id,group);
 }
 const rows=[...groups.values()].map(g=>({...g,expected:Math.round(g.expected*10)/10,suggested:Math.max(0,Math.floor(g.expected*.6))}));
 return {rows:rows.sort((a,b)=>b.expected-a.expected),openCount:open.length,expected:Math.round(rows.reduce((s,g)=>s+g.expected,0)*10)/10};
}

// Quanto da falta esperada vem de quem não confirmou e quantas vagas voltariam se metade passasse a faltar como os confirmados.
export function confirmationOpportunity(roster,calibration){
 const rates=calibration?.absenceByConfirm??{};
 const open=roster.filter(r=>!r.extra&&!r.historical&&!r.knownPresent&&!r.knownAbsent&&!Number.isFinite(r.actualArrival));
 const count=state=>open.filter(r=>r.confirm===state).length;
 const confirmed=rates.confirmado?.rate;
 const lines=['sem_resposta','a_confirmar'].map(state=>{
  const n=count(state),rate=rates[state]?.rate;
  const gain=confirmed!==undefined&&rate!==undefined?n*Math.max(0,rate-confirmed)/100*.5:0;
  return {state,n,rate,gain:Math.round(gain*10)/10};
 });
 return {lines,confirmedRate:confirmed,total:Math.round(lines.reduce((s,l)=>s+l.gain,0)*10)/10};
}

export function buildRecommendations({date,jobs,summary,tests,absence,confirmation,timeline,indicators,calibration,meta,mode}){
 const out=[];
 const add=(level,title,text,proof=[],extra={})=>out.push({level,title,text,proof,...extra});
 const total=summary.total;
 if(summary.missed>0)add('alta','Dia não fecha',summary.missed+' atendimento(s) ficariam sem acontecer até o fim da simulação.',['Aumente estações nos setores com fila ou tire marcações do pico.']);
 if(summary.over>0)add('alta','Passa das 19:00','O último atendimento termina às '+E.clock(summary.last)+' ('+summary.over+' min depois das 19:00).',['Veja o setor com maior espera abaixo.']);
 for(const t of tests?.more??[]){
  const gain=t.before.above-t.after.above;
  if(gain<2&&t.before.p90-t.after.p90<5)continue; // ganho pequeno é ruído do sorteio, não decisão
  add(t.before.p90>=45||t.before.above>=8?'alta':'media','Mais uma estação em '+poolLabel(t.pool),
   'Passar de '+t.from+' para '+t.to+' reduz a espera P90 de '+t.before.p90+' para '+t.after.p90+' min e os atendimentos acima de 30 min de '+t.before.above+' para '+t.after.above+'.',
   ['Esse setor acumulou ≈ '+t.waitPerScenario+' min de espera no dia simulado.'],{unit:t.pool.split(':')[0],pool:t.pool});
 }
 for(const t of tests?.less??[]){
  if(!t.safe)continue;
  add('info','Estação folgada em '+poolLabel(t.pool),
   'Uso de '+pct(t.use*100)+' do horário. Com '+t.to+' estação(ões) em vez de '+t.from+', a espera P90 continua em '+t.after.p90+' min (antes '+t.before.p90+').',['Candidata a ser realocada para um setor com fila.'],{unit:t.pool.split(':')[0],pool:t.pool});
 }
 if(confirmation&&confirmation.total>=1){
  const parts=confirmation.lines.filter(l=>l.n>0).map(l=>l.n+' '+confirmNames[l.state].toLowerCase()+' ('+pct(l.rate)+' faltam)');
  add(confirmation.total>=3?'alta':'media','Confirmar quem ainda não respondeu',
   'Ainda sem confirmação: '+parts.join(' e ')+'. Quem confirma falta '+pct(confirmation.confirmedRate)+'. Se metade responder, voltam ≈ '+num(confirmation.total,1)+' vaga(s).',
   ['Chame primeiro as marcações das primeiras horas e de exames longos (RM, TC).'],{unit:null});
 }
 const slots=(absence?.rows??[]).filter(r=>r.suggested>=1).slice(0,3);
 if(slots.length)add('media','Encaixes que o histórico sustenta',
  slots.map(r=>E.units[r.unit]+' · '+E.types[r.type][0]+' às '+String(r.hour).padStart(2,'0')+'h: '+num(r.expected,1)+' falta(s) esperada(s) de '+r.booked+', encaixe até '+r.suggested).join('; ')+'.',
  ['Teste cada encaixe em "Testar encaixe" antes de oferecer: a simulação mostra se a espera piora.'],{unit:slots[0].unit});
 if(timeline?.best&&mode!=='observed')add('info','Melhor janela para novas marcações',E.clock(timeline.best.start)+'–'+E.clock(timeline.best.end)+' tem a menor ocupação ('+num(timeline.best.sum/timeline.interval,1)+' pacientes em média, pico '+timeline.best.peak+').');
 const punctual=(indicators?.pontualidade??[]);
 for(const u of punctual){
  if(u.pct_15_antes>=25)add('info','Chegam cedo em '+(E.units[u.unidade]??u.unidade),pct(u.pct_15_antes)+' chegam 15 min ou mais antes do horário e '+pct(u.pct_15_depois)+' chegam 15 min ou mais depois (mediana '+num(u.p50)+' min).',['O pico da recepção começa antes da hora marcada: reforce o guichê 15–20 min antes.'],{unit:u.unidade});
 }
 if(meta?.com_chegada_real===0&&mode!=='demo')add('info','Sem chegada real neste dia','Nenhum paciente tem a chegada registrada pelo Klingo; a simulação sorteia a chegada pelo padrão medido.');
 const fila=indicators?.fila_chegada;
 if(fila&&fila.n<30)add('info','Espera real quase não é medida','Só '+fila.n+' paciente(s) usaram o "Minha vez" nos últimos dias. É a única fonte de espera de verdade: quanto mais check-ins, melhor a calibragem da simulação.');
 if(!out.length)add('info','Sem alerta','Com a capacidade atual, o dia simulado não tem fila relevante nem estourou o horário ('+total+' marcações).');
 const order={alta:0,media:1,info:2};
 return out.sort((a,b)=>order[a.level]-order[b.level]);
}

// ----- Painéis com os indicadores do banco -----
const bar=(value,max,label,color='var(--bar,#9be8d6)')=>'<span class="bar" role="img" aria-label="'+esc(label)+'"><i style="width:'+Math.max(0,Math.min(100,100*value/(max||1))).toFixed(1)+'%;background:'+color+'"></i></span>';
const heat=value=>value===null||value===undefined?'':'style="background:rgba(246,120,100,'+Math.min(.75,value/70).toFixed(2)+')"';
const table=(head,rows,cls='')=>'<div class="scroll"><table class="'+cls+'"><thead><tr>'+head.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';

export function panelSummary(ind){
 if(!ind)return '';
 const rows=ind.unidades.map(u=>'<tr><td>'+esc(E.units[u.unidade])+'</td><td>'+num(u.marcadas)+'</td><td>'+num(u.atendidas)+'</td><td '+heat(u.pct_falta)+'>'+num(u.faltaram)+' ('+pct(u.pct_falta,1)+')</td><td>'+num(u.canceladas+u.remarcadas)+' ('+pct(u.pct_cancela_remarca,1)+')</td></tr>');
 return '<p class="muted">De '+esc(ind.periodo.de)+' a '+esc(ind.periodo.ate)+' · '+ind.periodo.dias_com_dado+' dia(s) com dado (o banco guarda desde '+esc(ind.periodo.primeiro_dia_do_banco)+').</p>'+
  table(['Unidade','Marcadas','Atendidas','Faltaram','Canceladas ou remarcadas'],rows);
}
export function panelAbsence(ind){
 if(!ind)return '';
 const conf=ind.confirmacao.filter(c=>c.situacao!=='x').map(c=>{const key=confirmFromKlingo[c.situacao]??c.situacao;return '<tr><td>'+esc(confirmNames[key]??c.situacao)+'</td><td>'+num(c.n)+'</td><td>'+num(c.faltaram)+'</td><td>'+bar(c.pct_falta,70,pct(c.pct_falta,1)+' faltam')+' '+pct(c.pct_falta,1)+'</td></tr>';});
 const mods=ind.modalidades.filter(m=>m.n>=10).map(m=>'<tr><td>'+esc(E.units[m.unidade])+'</td><td>'+esc(E.types[m.tipo][0])+'</td><td>'+num(m.n)+'</td><td>'+num(m.por_dia,1)+'</td><td '+heat(m.pct_falta)+'>'+pct(m.pct_falta,1)+'</td></tr>');
 const hours=[...new Set(ind.horas.map(h=>h.hora))].sort((a,b)=>a-b),units=Object.keys(E.units);
 const grid=hours.map(h=>'<tr><td>'+String(h).padStart(2,'0')+'h</td>'+units.map(u=>{const c=ind.horas.find(x=>x.hora===h&&x.unidade===u);return c?'<td '+heat(c.pct_falta)+' title="'+esc(c.dias)+' dia(s) de dado">'+pct(c.pct_falta)+' <small>('+num(c.media_por_dia,1)+'/dia)</small></td>':'<td class="muted">—</td>';}).join('')+'</tr>');
 return '<h4>Falta por situação da confirmação</h4>'+table(['Situação','Marcações','Faltaram','% de falta'],conf)+
  '<p class="muted">Cuidado ao ler: a recepção pode marcar "Confirmado" quando o paciente chega, o que melhora esta taxa. Vale checar com a equipe.</p>'+
  '<h4>Falta por unidade e exame</h4>'+table(['Unidade','Exame','Marcações','Por dia','% de falta'],mods)+
  '<h4>Falta por hora do dia (média de marcações por dia entre parênteses)</h4>'+table(['Hora',...units.map(u=>E.units[u])],grid);
}
export function panelArrival(ind){
 if(!ind)return '';
 const rows=ind.pontualidade.map(p=>'<tr><td>'+esc(E.units[p.unidade])+'</td><td>'+num(p.n)+'</td><td>'+num(p.p10)+'</td><td><strong>'+num(p.p50)+'</strong></td><td>'+num(p.p90)+'</td><td>'+pct(p.pct_15_antes,1)+'</td><td>'+pct(p.pct_15_depois,1)+'</td></tr>');
 return '<p class="muted">Minutos em relação ao horário marcado (negativo = chegou antes). A chegada é o momento em que o Klingo marcou o atendimento como aberto, lido a cada 30 s; só vale quando foi no mesmo dia.</p>'+
  table(['Unidade','Pacientes','10% chegam até','Mediana','90% chegam até','15+ min antes','15+ min depois'],rows)+
  (ind.pontualidade.length?'':'<p>Ainda não há chegadas suficientes (mínimo 20 por unidade).</p>');
}
export function panelDemand(ind){
 if(!ind)return '';
 const units=Object.keys(E.units);
 const days=[1,2,3,4,5,6,7].filter(d=>ind.semana.some(s=>s.dow===d));
 const max=Math.max(1,...ind.semana.map(s=>s.media_por_dia));
 const rows=days.map(d=>'<tr><td>'+weekdays[d]+'</td>'+units.map(u=>{const c=ind.semana.find(s=>s.dow===d&&s.unidade===u);return c?'<td>'+bar(c.media_por_dia,max,num(c.media_por_dia,1)+' por dia')+' '+num(c.media_por_dia,1)+' <small class="muted">('+c.dias+' dia'+(c.dias>1?'s':'')+', '+pct(c.pct_falta)+' falta)</small></td>':'<td class="muted">—</td>';}).join('')+'</tr>');
 return '<p class="muted">Média de atendimentos e faltas por dia da semana. Poucos dias de histórico: números de dias com 1 ou 2 amostras são só um indício.</p>'+table(['Dia',...units.map(u=>E.units[u])],rows);
}
export function panelUpcoming(ind){
 if(!ind)return '';
 const fmt=new Intl.DateTimeFormat('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit',timeZone:'UTC'});
 const rows=ind.proximos.map(p=>'<tr><td>'+esc(fmt.format(new Date(p.dia+'T12:00:00Z')))+'</td><td>'+esc(E.units[p.unidade])+'</td><td>'+num(p.marcadas)+'</td><td>'+num(p.confirmadas)+'</td><td>'+num(p.a_confirmar+p.sem_resposta)+'</td><td><strong>'+num(p.faltas_esperadas,1)+'</strong> <small class="muted">('+pct(100*p.faltas_esperadas/(p.marcadas||1))+')</small></td></tr>');
 return '<p class="muted">Faltas esperadas = soma, por marcação, da taxa histórica de falta da situação da confirmação. São vagas que provavelmente ficarão vazias.</p>'+table(['Dia','Unidade','Marcadas','Confirmadas','Sem confirmar','Faltas esperadas'],rows)+(rows.length?'':'<p>Sem marcações nos próximos dias.</p>');
}
export function panelProcess(ind){
 if(!ind)return '';
 const origin=ind.origem.map(o=>'<tr><td>'+esc(o.origem==='sem_origem'?'Sem origem':o.origem)+'</td><td>'+num(o.n)+'</td><td>'+num(o.do_chat)+'</td></tr>');
 const chat=ind.pedidos_chat.map(o=>'<tr><td>'+esc(o.situacao)+'</td><td>'+num(o.n)+'</td></tr>');
 const lead=ind.antecedencia;
 return '<h4>Antecedência das marcações</h4><p>Mediana de <strong>'+num(lead.p50_dias,1)+' dia(s)</strong> entre marcar e fazer o exame; 90% com até '+num(lead.p90_dias,1)+' dia(s); '+pct(lead.pct_menos_de_1_dia,1)+' marcadas com menos de 1 dia. ('+num(lead.n)+' marcações)</p>'+
  '<h4>De onde vêm as marcações</h4>'+table(['Origem no Klingo','Marcações','Ligadas a uma conversa do chat'],origin)+
  '<h4>Pedidos do chat</h4>'+table(['Situação do pedido','Quantidade'],chat)+
  '<h4>Fila "Minha vez" (espera real medida)</h4><p>'+num(ind.fila_chegada.n)+' paciente(s) com chamada registrada; espera mediana de '+num(ind.fila_chegada.espera_mediana_min,1)+' min.'+(ind.fila_chegada.n<30?' Amostra pequena demais para calibrar a simulação.':'')+'</p>';
}
export const dataGaps=(meta,calibration)=>[
 'O Klingo não envia a hora de início e de fim do exame, nem do guichê e do preparo. Tempos dentro da clínica são hipóteses ajustáveis em "Premissas".',
 'A chegada é aproximada: o momento em que o Klingo marcou o atendimento (lido a cada 30 s). '+(meta?.com_chegada_real!==undefined?num(meta.com_chegada_real)+' marcação(ões) deste dia têm chegada.':''),
 'A quantidade de salas e profissionais por setor não vem do Klingo; a capacidade começa por uma estimativa e pode ser salva como "capacidade atual da clínica".',
 (calibration?.arrival&&Object.keys(calibration.arrival).length?'':'Sem chegadas suficientes para calibrar: usando a distribuição padrão da demonstração.')
].filter(Boolean);
