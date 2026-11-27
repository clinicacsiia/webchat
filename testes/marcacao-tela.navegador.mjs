// FLUXOGRAMA: entrada (a tela de marcação por etapas — a do PILOTO na raiz e a do TESTE em painel/testedowebchat — num navegador de verdade, com a integração SIMULADA: horários, médicos e planos inventados)
//   -> validação (médicos: o plano sem médico credenciado cai para os médicos da consulta; entram os do cadastro mesmo sem horário; calendário só com dias reais)
//   -> lógica (calendário em verde com filtros, "dia mais próximo", passar de dia e de mês; sem horário a tela segue com período e dias; pop-up de ciência com UM toque e regra de 24 h)
//   -> saída (casos PASS/FAIL, para as duas telas)
// Versão 1.0 — 27/11/2026 / Mudança: Implementação inicial.
// Dados: tudo inventado neste arquivo. Nenhuma chamada de rede real: a integração (CSI_SIM) é uma simulação.
import http from 'node:http';
import fs from 'node:fs';
import { chromium } from './mock-chat.mjs';
import { REPO } from './banco-producao.mjs';

const MOCK = `
const MED=[{id:'1',nome:'Alexandre Magno Teixeira Medeiros'},{id:'2',nome:'Livia Nascimento Sena'},{id:'3',nome:'Vanessa Reis'}];
function dias(){const out=[];const base=new Date(2026,10,30);[0,1,3,4,7,8,10,14,15,21,33].forEach(n=>{const d=new Date(base);d.setDate(d.getDate()+n);const iso=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');out.push({data:iso,horarios:[{hora:'08:00',min:480,profissional:'Livia Nascimento Sena',unidade:'Desenvoar'},{hora:'09:30',min:570,profissional:'Vanessa Reis',unidade:'Desenvoar'},{hora:'14:00',min:840,profissional:'Vanessa Reis',unidade:'Desenvoar'}]});});return out;}
window.chamadas=[];
window.CSI_SIM={CATALOGO:[{id:'c-1132'}],config:()=>({prazo_pre_horas:24,antecedencia_horas:24,exigir_carteirinha:true,politica:['x']}),
 medicosCadastro:async()=>[{nome:'Maiana Maria Lessa Pinto Pitta'},{nome:'Vanessa Reis'}], catalogo:async()=>[], convenios:async()=>[], planos:async()=>({itens:[],total:0}),
 medicos:async(p,pag)=>{chamadas.push(['medicos',pag]);return /AMOR/i.test(pag)?{estado:'sem_horarios',lista:[]}:{estado:'com_horarios',lista:MED.map(m=>({...m,horarios:5}))};},
 disponibilidade:async({pagador})=>{chamadas.push(['disp',pagador]);return /AMOR/i.test(pagador)||window.SEM?{dias:[],antecedenciaHoras:24}:{dias:dias(),antecedenciaHoras:24};},
 marcar:async()=>({}),iso:()=>'',solicitacoes:()=>[],solicitacaoAtualizar:()=>null};
`;
const PAGINA = (dir, css, js) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${dir}${css}"></head><body style="margin:0"><script>${MOCK}</script><script src="/${dir}${js}"></script></body></html>`;
const VARIANTES = [
  { nome: 'piloto (raiz)', dir: '', P: 'mt', chave: 'csi_marc_estado_v1' },
  { nome: 'teste (painel/testedowebchat)', dir: 'painel/testedowebchat/', P: 'marc', chave: 'teste_marc_estado_v1' },
];

const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  const m = u.match(/^\/__pagina\/(\d)$/);
  if (m) { const v = VARIANTES[+m[1]]; r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(PAGINA(v.dir, 'marcacao.css', 'marcacao.js')); return; }
  const f = REPO + u; if (!f.startsWith(REPO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); r.end(fs.readFileSync(f));
}).listen(0);
const port = srv.address().port;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const ok = [], falhas = [];
const ident = { tipo: 'filho', nome: 'Resp Teste', nomeCrianca: 'Crianca Teste', telefone: '71999990000', email: 'a@b.c' };

for (const [vi, V] of VARIANTES.entries()) {
  const t = (n, c) => { (c ? ok : falhas).push(n); console.log(`${c ? 'PASS' : 'FAIL'}  [${V.nome}] ${n}`); };
  const R = (s) => (typeof s === 'string' ? s.replace(/\.mt-/g, '.' + V.P + '-') : s);
  const estado = (o) => ({ ident, passo: 'medico', hist: ['pagto'], tipo: 'consulta', procId: 'c-1132', procNome: 'Consulta com pediatra', procTipo: 'consulta', procAtivo: true, medico: '', medicoNome: '', preco: null, preparo: '', pagto: 'convenio', convId: 'AMOR SAÚDE', convNome: 'Amor Saúde', plano: 'PERNAMBUES', planoId: '3213', cart: { anexada: false, semAgora: true, foto: '' }, slot: null, semHorario: '', pre: { aceita: '', periodo: '', dias: [], ciencia: null }, regras: false, retorno: false, remarcando: '', ...o });
  async function abrir(passo, extra, sem) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: 'pt-BR' }), pg = await ctx.newPage(); const erros = [];
    pg.on('pageerror', (e) => erros.push(String(e)));
    await pg.addInitScript(([k, e, sem]) => { localStorage.setItem(k, JSON.stringify(e)); if (sem) window.SEM = true; }, [V.chave, estado({ passo, ...extra }), !!sem]);
    await pg.goto(`http://127.0.0.1:${port}/__pagina/${vi}`); await pg.evaluate((i) => window.CSI_MARCACAO.abrir(i), ident); await pg.waitForTimeout(400);
    const p = new Proxy(pg, { get: (alvo, nome) => (['locator', 'click', 'check'].includes(nome) ? (s, ...r) => alvo[nome](R(s), ...r) : typeof alvo[nome] === 'function' ? alvo[nome].bind(alvo) : alvo[nome]) });
    p.erros = erros; return p;
  }
  // 1) Médico de interesse com Amor Saúde + PERNAMBUES: tem de listar os médicos (referência)
  let pg=await abrir('medico');
  t('médico: lista os médicos pela referência', await pg.locator('.mt-op:has-text("Livia Nascimento Sena")').count()===1);
  t('médico: tem nota de referência', await pg.locator('#marcNotaRef').count()===1);
  t('médico: entra o médico só do cadastro (sem horário), sem repetir quem já estava', await pg.locator('.mt-op:has-text("Maiana Maria Lessa Pinto Pitta")').count()===1 && await pg.locator('.mt-op:has-text("Vanessa Reis")').count()===1 && await pg.locator('.mt-op').count()===5);
  t('médico: NÃO diz "agendada pela equipe"', !(await pg.content()).includes('agendada pela equipe'));
  t('médico: chamou convênio e depois Particular', JSON.stringify(await pg.evaluate(()=>chamadas))==='[["medicos","AMOR SAÚDE#3213"],["medicos","Particular"]]');
  await pg.click('.mt-op:has-text("Vanessa Reis")'); await pg.waitForTimeout(150);
  t('médico: escolher marca a opção', await pg.locator('.mt-op[aria-checked=true]:has-text("Vanessa Reis")').count()===1);
  t('sem erro de script', pg.erros.length===0); if(pg.erros.length) console.log(pg.erros);

  // 2) Preferências com calendário em verde
  pg=await abrir('prefer',{medico:'qualquer',medicoNome:'Tanto faz',pre:{aceita:'sim',periodo:'',dias:[],ciencia:{em:new Date().toISOString(),emTexto:'x',fuso:'',aparelho:'Android'}}});
  t('prefer: calendário aparece', await pg.locator('.mt-cal-grade').count()===1);
  t('prefer: mostra o dia verde de novembro', await pg.locator('.mt-cal-dia.livre').count()===1);
  t('prefer: o primeiro dia (30/nov) já vem selecionado', (await pg.locator('#marcDiaSel').innerText()).toLowerCase().includes('30 de novembro'));
  t('prefer: seguiu mostrando período/dia da semana', await pg.locator('text=Dias da semana (opcional)').count()===1);
  await pg.click('[aria-label="Próximo mês"]'); await pg.waitForTimeout(80);
  t('prefer: mês de dezembro tem vários dias verdes', await pg.locator('.mt-cal-dia.livre').count()>=5);
  await pg.click('.mt-cal-dia.livre >> nth=3'); await pg.waitForTimeout(100);
  t('prefer: tocar noutro dia verde seleciona', await pg.locator('.mt-cal-dia.sel').count()===1);
  await pg.click('.mt-hora >> nth=0'); await pg.waitForTimeout(100);
  t('prefer: escolher horário marca', await pg.locator('.mt-hora[aria-checked=true]').count()===1);
  t('prefer: slot guardado', await pg.evaluate((k)=>JSON.parse(localStorage.getItem(k)).slot&&true, V.chave));
  await pg.click('#marcMaisProximo'); await pg.waitForTimeout(100);
  t('prefer: "dia mais próximo" volta ao primeiro dia', (await pg.locator('#marcDiaSel').innerText()).toLowerCase().includes('30 de novembro'));
  await pg.click('[aria-label="Próximo dia com horário"]'); await pg.waitForTimeout(80);
  t('prefer: seta passa para o próximo dia', (await pg.locator('#marcDiaSel').innerText()).toLowerCase().includes('1 de dezembro'));
  await pg.click('.mt-chip:has-text("Tarde")'); await pg.waitForTimeout(80);
  t('prefer: filtro Tarde mantém só horários da tarde', (await pg.locator('.mt-hora').allInnerTexts()).every(x=>x.startsWith('14:00')));
  await pg.waitForTimeout(50);
  t('prefer: passando de dia o calendário já mostra dezembro', (await pg.locator('.mt-cal-topo b').innerText()).toLowerCase().startsWith('dezembro'));
  t('sem erro de script (prefer)', pg.erros.length===0); if(pg.erros.length) console.log(pg.erros);

  // 3) Preferências SEM horário: segue normal (período e dias)
  pg=await abrir('prefer',{medico:'qualquer',pre:{aceita:'sim',periodo:'',dias:[],ciencia:{em:'x',emTexto:'x',fuso:'',aparelho:'A'}}},true);
  t('sem horário: não mostra calendário', await pg.locator('.mt-cal-grade').count()===0);
  t('sem horário: mostra período e dias', await pg.locator('p.sub:text-is("Melhor período")').count()===1 && await pg.locator('text=Dias da semana (opcional)').count()===1);

  // 4) Pop-up de ciência
  pg=await abrir('pre',{pagto:'convenio',plano:'nao_sei',planoId:'',cart:{anexada:false,semAgora:true,foto:''},pre:{aceita:'',periodo:'',dias:[],ciencia:null}});
  await pg.click('.mt-op:has-text("Sim, quero a pré-marcação")'); await pg.waitForTimeout(150);
  t('pop-up abre ao tocar em Sim', await pg.locator('.mt-pop[role=dialog]').count()===1);
  t('pop-up mostra o prazo de 24 horas e que o pedido só segue depois de mandar todos os arquivos', (await pg.locator('.mt-pop').innerText()).includes('24 horas') && (await pg.locator('.mt-pop').innerText()).includes('todos os arquivos'));
  t('pop-up: botão começa desligado', await pg.locator('#marcCiente').isDisabled());
  await pg.check('#marcCienteChk'); t('pop-up: marcar a caixa liga o botão', await pg.locator('#marcCiente').isEnabled());
  await pg.click('#marcCiente'); await pg.waitForTimeout(250);
  t('um toque só: fecha o pop-up', await pg.locator('.mt-pop').count()===0);
  t('um toque só: já avançou para a próxima etapa', (await pg.locator('#marcProg .txt span').first().innerText()).includes('Consulta') || (await pg.locator('h1').first().innerText()).includes('consulta'));
  t('ciência foi gravada', await pg.evaluate((k)=>!!JSON.parse(localStorage.getItem(k)).pre.ciencia, V.chave));
  // voltar do pop-up desfaz o "Sim"
  pg=await abrir('pre',{pagto:'convenio',plano:'nao_sei',planoId:'',pre:{aceita:'',periodo:'',dias:[],ciencia:null}});
  await pg.click('.mt-op:has-text("Sim, quero a pré-marcação")'); await pg.waitForTimeout(100); await pg.keyboard.press('Escape'); await pg.waitForTimeout(100);
  t('Esc fecha o pop-up e desfaz o Sim', await pg.locator('.mt-pop').count()===0 && await pg.locator('.mt-op[aria-checked=true]').count()===0);
}
await browser.close(); srv.close();
console.log(`\n${ok.length} de ${ok.length + falhas.length} passaram`);
process.exit(falhas.length ? 1 : 0);
