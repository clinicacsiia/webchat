// Fluxo: indicadores que o painel já calcula (painel_indicadores_decisao) + área externa (painel_simulacao_externa) + resultado da simulação → etapas com "dias de atendimento" → pontos de atenção ordenados.
// Versão 1.0 — 15/11/2026 / Mudança: criação ("indicadores primeiro": a análise roda antes de qualquer desenho e decide o que a tela e o 3D mostram).
// Só funções puras (sem tela, sem rede), testadas em node (testes/simulacao.test.mjs).

// Níveis: cores e símbolos da paleta de estado (nunca só cor: sempre símbolo + palavra).
export const LEVELS={
 critical:{rank:0,label:'Crítico',symbol:'▲',color:'#d03b3b'},
 serious:{rank:1,label:'Alto',symbol:'◆',color:'#ec835a'},
 warning:{rank:2,label:'Atenção',symbol:'●',color:'#fab219'},
 info:{rank:3,label:'Informação',symbol:'ℹ',color:'#7fbcd2'},
 good:{rank:4,label:'Em ordem',symbol:'✓',color:'#0ca30c'}
};
const pct=(a,b)=>b>0?100*a/b:null;
const nf=n=>Number(n??0).toLocaleString('pt-BR');
const pf=(n,d=0)=>n===null||n===undefined?'—':Number(n).toLocaleString('pt-BR',{maximumFractionDigits:d,minimumFractionDigits:d})+'%';
const byThreshold=(value,[critical,serious,warning])=>value>=critical?'critical':value>=serious?'serious':value>=warning?'warning':'good';
const worst=(...levels)=>levels.sort((a,b)=>LEVELS[a].rank-LEVELS[b].rank)[0];
const unitsOf=rows=>{
 const out={};
 for(const row of rows)out[row.unidade]=(out[row.unidade]??0)+(row.n??0);
 return out;
};

// As etapas FORA da clínica, na ordem do caminho do paciente. dias = pessoas ÷ média de atendidos por dia (o total de atendimentos antigos é a régua).
export function buildStages(ext,sim=null){
 if(!ext)return [];
 const media=ext.base?.media_dia>0?ext.base.media_dia:null;
 const dias=n=>media?Math.round(10*n/media)/10:null;
 const stages=[];
 const chat=ext.chat??{};
 const convDay=chat.conversas_dia>0?chat.conversas_dia:null;
 stages.push({
  id:'chat',lane:'externa',rotulo:'Esperando resposta no chat',curto:'Chat',n:chat.esperando??0,
  dias:convDay?Math.round(10*(chat.esperando??0)/convDay)/10:null,baseTexto:convDay?`${nf(convDay)} conversas abertas por dia`:'',diasUnidade:'conversas',
  nivel:(chat.esperando??0)===0?'good':worst(byThreshold(chat.mais_antiga_min??0,[240,60,15]),(chat.esperando>=Math.max(3,(convDay??20)*.2))?'warning':'good'),
  texto:(chat.esperando??0)===0?'Ninguém esperando a equipe.':`${nf(chat.esperando)} pessoa(s) esperando a equipe; a mais antiga há ${fmtMinutes(chat.mais_antiga_min)}.`,
  unidades:null
 });
 const ped=ext.pedidos??{};
 stages.push({
  id:'pedidos',lane:'externa',rotulo:'Pedido pronto, falta marcar',curto:'Pedido',n:ped.prontos??0,dias:dias(ped.prontos??0),baseTexto:'por atendimento/dia',
  nivel:(ped.prontos??0)===0?'good':byThreshold(ped.mais_antigo_h??0,[72,24,8]),
  texto:(ped.prontos??0)===0?'Nenhum pedido pronto parado.':`${nf(ped.prontos)} pedido(s) pronto(s) sem marcação; o mais antigo está parado há ${fmtHours(ped.mais_antigo_h)}.`,unidades:null
 });
 const conf=ext.confirmacao??[];
 const near=conf.filter(r=>r.ordem<=2);
 const nearOpen=near.reduce((s,r)=>s+r.a_confirmar+r.sem_resposta,0),nearTotal=near.reduce((s,r)=>s+r.total,0);
 const nearUnits=unitsOf(near.map(r=>({unidade:r.unidade,n:r.a_confirmar+r.sem_resposta})));
 const nearPct=pct(nearOpen,nearTotal);
 const worstUnit=Object.keys(nearUnits).map(u=>{const t=near.filter(r=>r.unidade===u).reduce((s,r)=>s+r.total,0);return {u,n:nearUnits[u],p:pct(nearUnits[u],t)};}).sort((a,b)=>(b.p??0)-(a.p??0))[0];
 stages.push({
  id:'confirmar',lane:'externa',rotulo:'Sem confirmação (hoje e amanhã)',curto:'Confirmar',n:nearOpen,dias:dias(nearOpen),baseTexto:'por atendimento/dia',
  nivel:nearTotal<10?'info':byThreshold(nearPct??0,[30,20,10]),
  texto:nearTotal===0?'Sem exames para hoje e amanhã.':`${nf(nearOpen)} de ${nf(nearTotal)} exames de hoje e amanhã (${pf(nearPct)}) ainda sem confirmação${worstUnit?`; pior unidade: ${worstUnit.u} (${pf(worstUnit.p)})`:''}.`,
  unidades:nearUnits,pior:worstUnit?.u??null,pct:nearPct
 });
 const far=conf.filter(r=>r.ordem>2);
 const farTotal=far.reduce((s,r)=>s+r.total,0),farOpen=far.reduce((s,r)=>s+r.a_confirmar+r.sem_resposta,0);
 stages.push({
  id:'agenda',lane:'externa',rotulo:'Agenda dos próximos dias',curto:'Agenda',n:farTotal+nearTotal,dias:dias(farTotal+nearTotal),baseTexto:'dias de atendimento já marcados',
  nivel:'info',texto:`${nf(farTotal+nearTotal)} exames marcados nos próximos 15 dias = ${dias(farTotal+nearTotal)??'—'} dias de atendimento (${nf(farOpen)} adiante ainda sem confirmação, o que é normal quando falta tempo).`,
  unidades:unitsOf(conf.map(r=>({unidade:r.unidade,n:r.total})))
 });
 const hoje=ext.dia_de_hoje??{};
 const caminho=(hoje.a_caminho??0)+(hoje.atrasados??0);
 const atrasoPct=pct(hoje.atrasados??0,hoje.previstos??0);
 stages.push({
  id:'hoje',lane:'externa',rotulo:'A caminho da clínica hoje',curto:'A caminho',n:caminho,dias:dias(caminho),baseTexto:'por atendimento/dia',
  nivel:(hoje.previstos??0)<10?'info':byThreshold(atrasoPct??0,[25,15,8]),
  texto:(hoje.previstos??0)===0?'Sem exames hoje.':`${nf(hoje.atendidos)} atendidos, ${nf(hoje.faltaram)} faltas, ${nf(hoje.a_caminho)} a caminho e ${nf(hoje.atrasados)} atrasados (30 min ou mais) de ${nf(hoje.previstos)} do dia.`,
  unidades:unitsOf((hoje.por_unidade??[]).map(r=>({unidade:r.unidade,n:r.a_caminho+r.atrasados}))),atrasados:hoje.atrasados??0
 });
 if(sim){
  stages.push({id:'clinica',lane:'clinica',rotulo:'Na clínica (simulação)',curto:'Clínica',n:sim.waiting??0,dias:null,baseTexto:'',
   nivel:sim.level??'info',texto:sim.text??'',unidades:sim.units??null});
 }
 const res=ext.resultado??{};
 const entregues=Math.max(res.entregues_registrados??0,res.concluidos_jornada??0);
 const velhos=(res.faixas??[]).find(f=>f.faixa.startsWith('8'))?.n??0;
 const cego=(res.atendidos_14d??0)>0&&entregues===0;
 stages.push({
  id:'resultado',lane:'externa',rotulo:'Exame feito, resultado',curto:'Resultado',n:res.atendidos_14d??0,dias:dias(res.atendidos_14d??0),baseTexto:'dias de atendimento dos últimos 14 dias',
  nivel:cego?'serious':(entregues<(res.atendidos_14d??0)*.5?'warning':'good'),
  texto:cego?`${nf(res.atendidos_14d)} exames feitos nos últimos 14 dias e nenhuma entrega de resultado registrada (${nf(velhos)} com 8 dias ou mais). O sistema não sabe quem já buscou o resultado.`:`${nf(entregues)} entregas registradas de ${nf(res.atendidos_14d)} exames dos últimos 14 dias.`,
  unidades:null,cego,velhos
 });
 for(const s of stages)s.mediaDia=media;
 return stages;
}
export function fmtMinutes(min){
 if(!Number.isFinite(min))return '—';
 if(min<60)return Math.round(min)+' min';
 if(min<2880)return (Math.round(min/6)/10).toLocaleString('pt-BR')+' h';
 return (Math.round(min/144)/10).toLocaleString('pt-BR')+' dias';
}
export function fmtHours(h){
 if(!Number.isFinite(h))return '—';
 return h<48?h+' h':(Math.round(h/2.4)/10).toLocaleString('pt-BR')+' dias';
}

// Frases que o painel de indicadores já escreve (mesmas regras de painel/index.html, função destaques), com a etapa a que cada uma se refere.
export const FUNIL=[['entraram','Procuraram o chat'],['pedido','Começaram um pedido de exame'],['data_hora','Chegaram à escolha de data'],['horario','Escolheram o horário'],['completo','Terminaram o pedido'],['agendaram','Agendaram']];
export function destaquesDoPainel(A={},B={}){
 const out=[],add=(nivel,txt,stage,numero=null,titulo='Indicador do painel')=>out.push({nivel,texto:txt,stage,numero,titulo,fonte:'indicadores do painel'});
 const F=A.chat?.funil??{},K=A.clinica??{},KB=B.clinica??{};
 const ent=F.entraram??0,ag=F.agendaram??0;
 if(ent>=10){
  const t=pct(ag,ent);
  add(t<30?'serious':t<50?'warning':'good',`Só ${pf(t)} das pessoas que procuraram o chat agendaram (${nf(ag)} de ${nf(ent)}).`,'chat',t,'Poucos agendam pelo chat');
  let pior=null;
  for(let i=1;i<FUNIL.length;i++){const de=F[FUNIL[i-1][0]]??0,para=F[FUNIL[i][0]]??0,perda=de-para;if(de>=10&&(!pior||perda>pior.perda))pior={perda,de,i};}
  if(pior&&pior.perda>0)add('warning',`A maior perda no chat é entre "${FUNIL[pior.i-1][1]}" e "${FUNIL[pior.i][1]}": ${nf(pior.perda)} pessoas (${pf(pct(pior.perda,pior.de))}) não seguiram.`,'chat',pior.perda,'Maior perda no caminho do chat');
  const sem=A.chat?.sem_agendar_motivo?.sem_equipe??0;
  if(sem>=3)add('critical',`${nf(sem)} pessoas nunca foram respondidas por alguém da equipe.`,'chat',sem,'Chat sem resposta da equipe');
 }
 if((K.novas_marcacoes??0)>=20){
  const p=pct(K.novas_pelo_chat??0,K.novas_marcacoes);
  add(p<20?'warning':'good',`Só ${nf(K.novas_pelo_chat??0)} de ${nf(K.novas_marcacoes)} marcações novas (${pf(p)}) vieram do chat.`,'pedidos',p,'Pouca marcação vem do chat');
 }
 if((KB.novas_marcacoes??0)>=20&&K.novas_marcacoes!=null){
  const v=100*(K.novas_marcacoes-KB.novas_marcacoes)/KB.novas_marcacoes;
  if(v<=-15)add('serious',`As marcações novas caíram ${Math.round(-v)}% em relação ao período anterior.`,'pedidos',v,'Marcações novas em queda');
  else if(v>=15)add('good',`As marcações novas subiram ${Math.round(v)}% em relação ao período anterior.`,'pedidos',v);
 }
 const nF=(K.atendidos??0)+(K.faltaram??0),tF=pct(K.faltaram??0,nF);
 if(nF>=20){
  add(tF>=20?'serious':tF>=10?'warning':'good',`${pf(tF)} dos pacientes com exame marcado faltaram (${nf(K.faltaram)} de ${nf(nF)}).`,'confirmar',tF,'Taxa de falta');
  const dims=[['confirmação',K.falta_confirmacao],['antecedência',K.falta_antecedencia],['unidade',K.falta_unidade],['tipo de atendimento',K.falta_plano]];
  const achados=[];
  for(const [dim,group] of dims)for(const g of group??[]){const n=g.atendidos+g.faltaram,t=pct(g.faltaram,n);if(n>=20&&t>=tF*1.25)achados.push({dim,nome:g.nome,t,n,f:g.faltaram,r:t/tF});}
  achados.sort((x,y)=>y.r-x.r).slice(0,2).forEach(x=>add('warning',`Faltam mais: ${x.dim} "${x.nome}" tem ${pf(x.t)} de falta (a média é ${pf(tF)}; ${nf(x.f)} de ${nf(x.n)}).`,'confirmar',x.t,'Falta concentrada em um grupo'));
 }
 return out;
}

// Junta tudo e ordena. Cada ponto aponta para uma etapa (stage) para o 3D saber onde acender.
export function pontosDeAtencao({stages=[],decisao=null,recs=[],limit=12}={}){
 const pontos=[];
 for(const s of stages){
  if(!['critical','serious','warning'].includes(s.nivel))continue;
  pontos.push({id:'etapa-'+s.id,nivel:s.nivel,titulo:s.rotulo,texto:s.texto,stage:s.id,fonte:'área externa',numero:s.n,unidades:s.unidades??null});
 }
 for(const d of destaquesDoPainel(decisao?.atual,decisao?.anterior)){
  if(!['critical','serious','warning'].includes(d.nivel))continue;
  pontos.push({id:'painel-'+pontos.length,nivel:d.nivel,titulo:d.titulo,texto:d.texto,stage:d.stage,fonte:d.fonte,numero:d.numero,unidades:null});
 }
 for(const r of recs){
  if(r.level==='info')continue;
  pontos.push({id:'sim-'+pontos.length,nivel:r.level==='alta'?'serious':'warning',titulo:r.title,texto:r.text,stage:'clinica',fonte:'simulação',numero:null,unidades:r.unit?{[r.unit]:1}:null});
 }
 pontos.sort((a,b)=>LEVELS[a.nivel].rank-LEVELS[b.nivel].rank);
 return pontos.slice(0,limit);
}

// Cartões do topo: os quatro números que o painel mostra.
export function cartoesDoPainel(decisao){
 const A=decisao?.atual??{},B=decisao?.anterior??{},F=A.chat?.funil??{},FB=B.chat?.funil??{},K=A.clinica??{},KB=B.clinica??{};
 const falta=(k)=>{const n=(k.atendidos??0)+(k.faltaram??0);return pct(k.faltaram??0,n);};
 const delta=(a,b)=>a===null||b===null||b===0||a===undefined||b===undefined?null:100*(a-b)/b;
 return [
  {rotulo:'Pessoas que procuraram o chat',valor:F.entraram??0,texto:nf(F.entraram??0),delta:delta(F.entraram,FB.entraram),bomSobe:true},
  {rotulo:'Agendaram pelo chat',valor:pct(F.agendaram??0,F.entraram??0),texto:pf(pct(F.agendaram??0,F.entraram??0)),sub:`${nf(F.agendaram??0)} de ${nf(F.entraram??0)}`,delta:delta(pct(F.agendaram??0,F.entraram??0),pct(FB.agendaram??0,FB.entraram??0)),bomSobe:true},
  {rotulo:'Marcações novas na clínica',valor:K.novas_marcacoes??0,texto:nf(K.novas_marcacoes??0),sub:`${nf(K.novas_pelo_chat??0)} vieram do chat`,delta:delta(K.novas_marcacoes,KB.novas_marcacoes),bomSobe:true},
  {rotulo:'Faltas',valor:falta(K),texto:pf(falta(K),1),sub:`${nf(K.faltaram??0)} de ${nf((K.atendidos??0)+(K.faltaram??0))}`,delta:delta(falta(K),falta(KB)),bomSobe:false}
 ];
}
