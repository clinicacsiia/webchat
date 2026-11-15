// FLUXO: entrada (cartões e pontos de atenção que a análise já calculou + o dia simulado: model.jobs e o plano de estações) -> validação (só números e textos escritos aqui; nada de nome, telefone ou CPF) -> lógica (cada indicador vira um assunto que a Indi explica em 4 partes; ao clicar nela, o programa acha NO DIA SIMULADO o local e a hora exata em que o problema aparece) -> saída (assuntos, fala em HTML escapado e o alvo da visita: unidade, setor, minuto)
// Versão 1.0 — 15/11/2026 / Mudança: criação (a personagem Indi no lugar dos cartões de indicadores).
// Só funções puras (sem tela, sem rede), testadas em node (testes/indi.test.mjs).
//
// Regra de honestidade: a hora só é "exata" quando sai da simulação do dia (fila, falta, atraso, sala vazia). Indicadores do chat e do Klingo não guardam a hora em que o problema acontece:
// para esses a Indi vai ao balcão da recepção, NÃO muda a hora e diz isso na fala (alvo.exata = false).
import {stage,types,units,OPEN,clock} from './engine.mjs';

export const INDI={nome:'Indi',linhaSprite:4,retrato:4};

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const nf=n=>Number(n??0).toLocaleString('pt-BR');
const SIMBOLO={critical:['▲','Crítico'],serious:['◆','Alto'],warning:['●','Atenção'],info:['ℹ','Informação'],good:['✓','Em ordem']};

// ---------- o que a Indi sabe explicar ----------
const TEXTOS={
 'cartao-entraram':{oQueE:'Quantas pessoas abriram o chat da clínica e começaram uma conversa neste período.',porQue:'É a porta de entrada. Se pouca gente chega, a clínica depende só do balcão e do telefone.',oQueFazer:'Compare com o período anterior. Se caiu, confira se o endereço do chat continua nas redes e no site.'},
 'cartao-agendaram':{oQueE:'De cada 100 pessoas que procuraram o chat, quantas terminaram com horário marcado.',porQue:'Quem procura e não agenda é paciente que a clínica pode estar perdendo, ou que precisou de ajuda de uma pessoa.',oQueFazer:'Veja em que passo as pessoas desistem. A lista de problemas mostra a maior perda do caminho.'},
 'cartao-novas':{oQueE:'Quantas marcações novas entraram na agenda da clínica neste período, por qualquer caminho: balcão, telefone ou chat.',porQue:'Mostra o tamanho do chat perto do resto. Se o chat é pequeno, melhorar o chat muda pouco a agenda.',oQueFazer:'Acompanhe a parte que vem do chat semana a semana, junto com o tempo de resposta da equipe.'},
 'cartao-faltas':{oQueE:'De cada 100 pessoas com exame marcado que já passaram, quantas não vieram.',porQue:'Cada falta deixa uma sala parada e tira a vaga de quem poderia ter sido atendido.',oQueFazer:'Confirme com antecedência quem ainda não respondeu e mantenha uma lista de espera para encaixar. Eu mostro a hora em que as faltas mais deixam sala vazia.'},
 'etapa-chat':{oQueE:'Pessoas que escreveram no chat e ainda esperam uma resposta da equipe.',porQue:'Quem espera muito desiste ou procura outro lugar.',oQueFazer:'Atender primeiro quem espera há mais tempo e avisar a equipe quando a espera passar de alguns minutos.'},
 'etapa-pedidos':{oQueE:'Pedidos de exame que o paciente deixou prontos pelo chat e que ninguém marcou ainda.',porQue:'É paciente decidido que ainda não tem data. Quanto mais tempo parado, maior a chance de desistir.',oQueFazer:'Marcar os mais antigos primeiro. Eu mostro o horário em que a clínica está mais vazia, que é onde eles cabem.'},
 'etapa-confirmar':{oQueE:'Exames de hoje e de amanhã em que o paciente ainda não confirmou presença.',porQue:'Quem não confirma falta bem mais. Esses horários correm o risco de ficar vazios.',oQueFazer:'Ligar ou mandar mensagem hoje para esses pacientes, começando pela unidade com mais pendências, e ter quem encaixar no lugar.'},
 'etapa-hoje':{oQueE:'Pessoas com exame hoje que ainda não chegaram, e as que já passaram do horário em 30 minutos ou mais.',porQue:'Atraso bagunça a sequência da sala: o horário fica vazio e depois chegam todos juntos.',oQueFazer:'Avisar quem está atrasado e, se for o caso, chamar o próximo da lista para não perder a sala.'},
 'etapa-clinica':{oQueE:'Quantas pessoas estão esperando atendimento dentro da clínica, no dia simulado.',porQue:'Fila grande dentro da clínica é o que o paciente sente: espera longa e sensação de desorganização.',oQueFazer:'Ver qual setor concentra a fila e se vale reforçar a recepção, o preparo ou a sala nessa hora.'},
 'etapa-resultado':{oQueE:'Exames feitos nos últimos 14 dias cujo resultado ainda não aparece como entregue.',porQue:'O sistema não registra quem já buscou o resultado, então não dá para saber quem está esperando.',oQueFazer:'Registrar a entrega do resultado (no balcão ou pelo chat) para esse número deixar de ser um ponto cego.'},
 'dest-agendam':{oQueE:'A parte das pessoas que procuraram o chat e chegaram a agendar.',porQue:'Se é baixa, a maioria sai sem horário marcado.',oQueFazer:'Olhar o passo em que mais gente sai e simplificar essa tela.'},
 'dest-perda':{oQueE:'O passo do chat onde mais gente deixa de seguir em frente.',porQue:'Corrigir o passo com mais perda traz mais agendamentos do que melhorar passos que já funcionam.',oQueFazer:'Revisar o texto e as opções desse passo e testar uma mudança por vez.'},
 'dest-semresposta':{oQueE:'Pessoas que escreveram e nunca foram respondidas por alguém da equipe.',porQue:'Foram embora sem nenhuma resposta; é a pior experiência possível.',oQueFazer:'Responder hoje, pedir desculpa pela demora e rever em que horários o chat fica sem atendente.'},
 'dest-pouco-chat':{oQueE:'A parte das marcações novas que veio do chat.',porQue:'Se o chat responde por pouco da agenda, ele ainda não é o caminho principal do paciente.',oQueFazer:'Divulgar o chat e medir se essa parte cresce.'},
 'dest-queda':{oQueE:'A comparação das marcações novas deste período com o anterior.',porQue:'Queda grande pode ser menos procura, problema no caminho de agendar ou feriado.',oQueFazer:'Conferir se houve feriado ou mudança na agenda; se não, olhar o chat e o telefone.'},
 'dest-falta':{oQueE:'A parte das pessoas com exame marcado que não vieram.',porQue:'Falta alta deixa sala vazia e fila de espera sem vaga.',oQueFazer:'Confirmar antes e encaixar. Eu mostro a hora em que mais salas ficam sem paciente.'},
 'dest-falta-grupo':{oQueE:'Um grupo de pacientes (por confirmação, antecedência, unidade ou tipo de atendimento) que falta mais do que a média.',porQue:'Concentrar o esforço no grupo certo reduz mais faltas do que avisar todo mundo igual.',oQueFazer:'Criar um lembrete extra só para esse grupo.'},
 sim:{oQueE:'Uma recomendação da simulação do dia, feita com os dados reais de chegada e de duração dos exames.',porQue:'Mostra onde a fila se forma no dia e quanto uma mudança ajudaria.',oQueFazer:'Seguir a recomendação e acompanhar a fila depois.'},
 generico:{oQueE:'Um indicador que o painel calcula a partir do chat e da agenda.',porQue:'Está fora do normal, por isso apareceu na lista.',oQueFazer:'Olhe o número com a equipe e decida o que mudar.'}
};
const TITULOS_DO_PAINEL={
 'Poucos agendam pelo chat':'dest-agendam','Maior perda no caminho do chat':'dest-perda','Chat sem resposta da equipe':'dest-semresposta',
 'Pouca marcação vem do chat':'dest-pouco-chat','Marcações novas em queda':'dest-queda','Taxa de falta':'dest-falta','Falta concentrada em um grupo':'dest-falta-grupo'
};
export const tipoDoPonto=p=>String(p.id).startsWith('etapa-')?p.id:String(p.id).startsWith('sim-')?'sim':(TITULOS_DO_PAINEL[p.titulo]??'generico');

// Como o problema de cada tipo aparece na clínica.
const MODO={'etapa-clinica':'fila',sim:'fila','etapa-confirmar':'falta','cartao-faltas':'falta','dest-falta':'falta','dest-falta-grupo':'falta','etapa-hoje':'atraso','etapa-pedidos':'vazio'};
export const modoDoTipo=tipo=>MODO[tipo]??'sem_hora';

function nivelDoCartao(chave,c){
 const v=c.valor;
 if(v===null||v===undefined)return 'info';
 if(chave==='agendaram')return v<30?'serious':v<50?'warning':'good';
 if(chave==='faltas')return v>=20?'serious':v>=10?'warning':'good';
 return 'info';
}
function textoDoCartao(c){
 const d=c.delta;
 const comparacao=d===null||d===undefined?'':' Em relação ao período anterior: '+(d>0?'subiu ':d<0?'caiu ':'ficou igual')+(d?Math.abs(Math.round(d))+'%.':'.');
 return (c.rotulo+': '+c.texto+(c.sub?' ('+c.sub+')':'')+'.'+comparacao);
}

// Lista única de assuntos: os 4 números do painel e os problemas encontrados (do mais ao menos grave).
export function assuntos({pontos=[],cartoes=[]}={}){
 const chaves=['entraram','agendaram','novas','faltas'];
 const lista=cartoes.slice(0,4).map((c,i)=>({id:'cartao-'+chaves[i],grupo:'indicador',tipo:'cartao-'+chaves[i],titulo:c.rotulo,nivel:nivelDoCartao(chaves[i],c),texto:textoDoCartao(c),unidades:null}));
 for(const p of pontos)lista.push({id:p.id,grupo:'problema',tipo:tipoDoPonto(p),titulo:p.titulo,nivel:p.nivel,texto:p.texto,fonte:p.fonte??'',unidades:p.unidades??null});
 return lista;
}

// A fala da Indi: 4 partes curtas.
export function explicar(assunto){
 const t=TEXTOS[assunto.tipo]??TEXTOS.generico;
 return [
  {rotulo:'O que é',texto:t.oQueE},
  {rotulo:'Como está agora',texto:assunto.texto||'Sem número neste período.'},
  {rotulo:'Por que importa',texto:t.porQue},
  {rotulo:'O que eu faria',texto:t.oQueFazer}
 ];
}
export function falaHtml(assunto){
 const [simbolo,palavra]=SIMBOLO[assunto.nivel]??SIMBOLO.info;
 return '<h3>'+esc(assunto.titulo)+' <span class="badge" style="--lv:var(--lv-'+esc(assunto.nivel)+')">'+simbolo+' '+palavra+'</span></h3><dl>'+
  explicar(assunto).map(p=>'<dt>'+esc(p.rotulo)+'</dt><dd>'+esc(p.texto)+'</dd>').join('')+'</dl>';
}
export function chipsHtml(lista,selecionado=null){
 const grupo=(nome,itens)=>itens.length?'<h4>'+nome+'</h4><ul class="indi-chips">'+itens.map(a=>{
  const [simbolo,palavra]=SIMBOLO[a.nivel]??SIMBOLO.info;
  return '<li><button type="button" data-assunto="'+esc(a.id)+'" data-level="'+esc(a.nivel)+'" aria-pressed="'+(a.id===selecionado)+'"><span class="sym" aria-hidden="true">'+simbolo+'</span> '+esc(a.titulo)+'<span class="sr"> — '+palavra+'</span></button></li>';
 }).join('')+'</ul>':'';
 return grupo('Indicadores do painel',lista.filter(a=>a.grupo==='indicador'))+grupo('Problemas que eu encontrei',lista.filter(a=>a.grupo==='problema'))||'<p class="muted">Ainda não carreguei nada para explicar.</p>';
}

// ---------- o alvo da visita: onde e a que horas ----------
const FILA=['reception','prepQueue','examQueue'];
const PRESENTE=['reception','checkin','prepQueue','prep','examQueue','exam'];
const ROTULO_SETOR=s=>s==='reception'?'Recepção':s==='prep'?'Preparo':(types[s]?.[0]??s);

export function unidadeId(chave){
 if(units[chave])return chave;
 const achada=Object.entries(units).find(([,nome])=>nome.toLowerCase()===String(chave).toLowerCase());
 return achada?achada[0]:null;
}
export function unidadeDoAssunto(assunto){
 let melhor=null;
 for(const [chave,valor] of Object.entries(assunto.unidades??{})){
  const id=unidadeId(chave);
  if(id&&(melhor===null||valor>melhor.valor))melhor={id,valor};
 }
 return melhor&&melhor.valor>0?melhor.id:null;
}
const ultimoMinuto=model=>Math.min(1439,Math.max(OPEN,...model.jobs.map(j=>Math.max(Number.isFinite(j.end)?j.end:0,Number.isFinite(j.arrive)?j.arrive:0,j.slot??0))));
const unidadesDe=(model,unidade)=>unidade?[unidade]:Object.keys(units).filter(u=>model.jobs.some(j=>j.unit===u));
const mediana=lista=>[...lista].sort((a,b)=>a-b)[Math.floor((lista.length-1)/2)];
const setorDoJob=(job,t)=>{const s=stage(job,t);return s==='reception'?'reception':s==='prepQueue'?'prep':job.type;};

function ocupadas(model,unidade,setor,t){
 return model.jobs.filter(j=>{
  if(j.unit!==unidade||j.absent)return false;
  const [a,b]=setor==='reception'?[j.check,j.registered]:setor==='prep'?[j.prepare,j.ready]:j.type===setor?[j.start,j.end]:[null,null];
  return Number.isFinite(a)&&Number.isFinite(b)&&a<=t&&t<b;
 }).length;
}
const montar=(base,extra)=>({exata:true,area:'station',aviso:'',...base,inicio:Math.max(OPEN,base.minuto-20),local:ROTULO_SETOR(base.setor)+' · '+units[base.unidade],...extra});

// FILA: o minuto em que mais gente espera (na unidade pedida, ou na pior), e o setor com a fila mais longa nesse minuto.
export function picoDeFila(model,plan,unidade=null){
 const fim=ultimoMinuto(model);
 let melhor=null;
 for(const u of unidadesDe(model,unidade)){
  const jobs=model.jobs.filter(j=>j.unit===u&&!j.absent);
  for(let t=OPEN;t<=fim;t++){
   const n=jobs.reduce((s,j)=>s+(FILA.includes(stage(j,t))?1:0),0);
   if(n>0&&(melhor===null||n>melhor.n))melhor={unidade:u,minuto:t,n};
  }
 }
 if(!melhor)return null;
 const naFila=model.jobs.filter(j=>j.unit===melhor.unidade&&!j.absent&&FILA.includes(stage(j,melhor.minuto)));
 const porSetor={};
 for(const j of naFila){const s=setorDoJob(j,melhor.minuto);porSetor[s]=(porSetor[s]??0)+1;}
 const setor=Object.entries(porSetor).sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1))[0][0];
 const slots=plan?.[melhor.unidade+':'+setor];
 const ocupa=ocupadas(model,melhor.unidade,setor,melhor.minuto);
 const maior=Math.max(...naFila.map(j=>Math.floor(melhor.minuto-j.arrive)));
 return montar({tipo:'fila',unidade:melhor.unidade,setor,minuto:melhor.minuto,
  legenda:nf(melhor.n)+' pessoa(s) esperando na '+units[melhor.unidade]+' às '+clock(melhor.minuto)+'; a maior fila é em '+ROTULO_SETOR(setor).toLowerCase()+' ('+porSetor[setor]+')'+
   (slots?', com '+ocupa+' de '+slots+' estação(ões) ocupada(s)':'')+'. A espera mais longa chega a '+maior+' min.'});
}

// FALTA: a hora do dia em que mais gente marcada não veio; o minuto é o do horário de uma dessas pessoas (a cadeira vazia).
export function picoDeFalta(model,plan,unidade=null){
 const faltas=model.jobs.filter(j=>j.absent&&Number.isFinite(j.slot)&&(!unidade||j.unit===unidade));
 if(!faltas.length)return null;
 const baldes={};
 for(const j of faltas){const k=j.unit+'|'+Math.floor(j.slot/60);(baldes[k]??=[]).push(j);}
 const [chave,lista]=Object.entries(baldes).sort((a,b)=>b[1].length-a[1].length||(a[0]<b[0]?-1:1))[0];
 const [u,hora]=[chave.split('|')[0],Number(chave.split('|')[1])];
 const slotMediano=mediana(lista.map(j=>j.slot));
 const exemplo=lista.find(j=>j.slot===slotMediano)??lista[0];
 const setor=exemplo.type;
 const slots=plan?.[u+':'+setor];
 const ocupa=ocupadas(model,u,setor,slotMediano);
 return montar({tipo:'falta',unidade:u,setor,minuto:slotMediano,
  legenda:nf(lista.length)+' pessoa(s) marcada(s) entre '+String(hora).padStart(2,'0')+':00 e '+String(hora).padStart(2,'0')+':59 na '+units[u]+' não vieram. Às '+clock(slotMediano)+' era a vez de uma delas em '+ROTULO_SETOR(setor).toLowerCase()+
   (slots?': '+Math.max(0,slots-ocupa)+' de '+slots+' estação(ões) ficaram livres.':'.')});
}

// ATRASO: o minuto com mais gente que já passou do horário e ainda não chegou (30 min; se ninguém passa disso, 15 min).
export function picoDeAtraso(model,plan,unidade=null){
 const fim=ultimoMinuto(model);
 for(const limite of [30,15]){
  let melhor=null;
  for(const u of unidadesDe(model,unidade)){
   const jobs=model.jobs.filter(j=>j.unit===u&&!j.absent&&Number.isFinite(j.arrive)&&Number.isFinite(j.slot));
   for(let t=OPEN;t<=fim;t++){
    const n=jobs.reduce((s,j)=>s+(j.slot+limite<=t&&t<j.arrive?1:0),0);
    if(n>0&&(melhor===null||n>melhor.n))melhor={unidade:u,minuto:t,n};
   }
  }
  if(melhor)return montar({tipo:'atraso',unidade:melhor.unidade,setor:'reception',area:'door',minuto:melhor.minuto,
   legenda:nf(melhor.n)+' pessoa(s) da '+units[melhor.unidade]+' já passaram '+limite+' min do horário marcado às '+clock(melhor.minuto)+' e ainda não chegaram. As salas deles ficam esperando.'},{local:'Entrada · '+units[melhor.unidade]});
 }
 return null;
}

// VAZIO: a hora (entre 8h e 17h) em que a unidade tem menos gente; é onde cabem os pedidos prontos que ainda não foram marcados.
export function horaVazia(model,plan,unidade=null){
 let melhor=null;
 for(const u of unidadesDe(model,unidade)){
  const jobs=model.jobs.filter(j=>j.unit===u&&!j.absent);
  if(!jobs.length)continue;
  for(let hora=8;hora<=16;hora++){
   let soma=0,minimo=null;
   for(let t=hora*60;t<hora*60+60;t++){
    const n=jobs.reduce((s,j)=>s+(PRESENTE.includes(stage(j,t))?1:0),0);
    soma+=n;
    if(minimo===null||n<minimo.n)minimo={t,n};
   }
   if(melhor===null||soma<melhor.soma)melhor={unidade:u,soma,minuto:minimo.t,n:minimo.n};
  }
 }
 if(!melhor)return null;
 const salas=Object.keys(plan??{}).filter(k=>k.startsWith(melhor.unidade+':')&&!['reception','prep'].some(s=>k.endsWith(':'+s))).sort((a,b)=>plan[b]-plan[a]||(a<b?-1:1));
 if(!salas.length)return null;
 const setor=salas[0].split(':')[1];
 const livres=plan[salas[0]]-ocupadas(model,melhor.unidade,setor,melhor.minuto);
 return montar({tipo:'vazio',unidade:melhor.unidade,setor,minuto:melhor.minuto,
  legenda:'Às '+clock(melhor.minuto)+' só '+nf(melhor.n)+' pessoa(s) na '+units[melhor.unidade]+' e '+livres+' de '+plan[salas[0]]+' estação(ões) de '+ROTULO_SETOR(setor).toLowerCase()+' livres. É aqui que cabem os pedidos prontos que ainda não foram marcados.'});
}

const AVISOS={
 sem_hora:'Este problema acontece no chat e na agenda, fora do salão, e eles não guardam a hora em que ele aparece. Por isso não invento um horário: venho ao balcão da recepção, onde a equipe lida com isso, e não mexo na hora da simulação.',
 fila:'Neste dia simulado ninguém ficou esperando, então não há fila para mostrar.',
 falta:'Neste dia simulado ninguém faltou, então não há cadeira vazia para mostrar.',
 atraso:'Neste dia simulado ninguém chegou atrasado, então não há o que mostrar na entrada.',
 vazio:'Neste dia simulado não achei uma hora livre para mostrar.'
};

export function alvoDoProblema(assunto,model,plan){
 const modo=modoDoTipo(assunto.tipo);
 const unidade=unidadeDoAssunto(assunto);
 const buscas={fila:picoDeFila,falta:picoDeFalta,atraso:picoDeAtraso,vazio:horaVazia};
 const achado=model?.jobs?.length&&buscas[modo]?buscas[modo](model,plan,unidade):null;
 if(achado)return achado;
 const u=unidade??unidadesDe(model??{jobs:[]},null)[0]??Object.keys(units)[0];
 return {tipo:'sem_hora',exata:false,unidade:u,setor:'reception',area:'station',minuto:null,inicio:null,local:'Recepção · '+units[u],legenda:'',aviso:AVISOS[modo==='sem_hora'?'sem_hora':modo]};
}
