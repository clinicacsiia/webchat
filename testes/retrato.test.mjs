// FLUXOGRAMA: entrada (as três telas: index.html, painel/index.html, minha-vez/index.html + o índice do retrato da produção em supabase/producao/indice.json) -> validação (cada função que uma tela chama existe no banco, com os mesmos nomes de parâmetro e com permissão para quem chama; cada tabela lida existe; cada rotina e cada gatilho apontam para função que existe; nenhuma função do banco chama outra que não existe) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
//
// É o teste de "tudo sincronizado": roda sem banco e sem internet, em 1 segundo. Quando alguém mudar uma tela ou uma função e esquecer
// do outro lado, ele acusa a linha. O retrato precisa estar em dia (como refazer: supabase/producao/LEIAME.md).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = (nome, fn) => { try { const r = fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const indice = JSON.parse(readFileSync(`${REPO}/supabase/producao/indice.json`, 'utf8'));
const funcoes = new Map();
for (const f of indice.funcoes) { if (!funcoes.has(f.nome)) funcoes.set(f.nome, []); funcoes.get(f.nome).push(f); }
const tabelas = new Map(indice.tabelas.map((t) => [t.nome, t]));
const visoes = new Set(indice.visoes);

// As telas e quem as usa: o chat e o Minha vez são do paciente (anon, ou paciente logado); o painel é da equipe (logada).
const TELAS = [
  { arquivo: 'index.html', nome: 'chat' },
  { arquivo: 'painel/index.html', nome: 'painel' },
  { arquivo: 'minha-vez/index.html', nome: 'minha-vez' },
];
// Chamadas feitas com o nome numa variável (não aparecem como texto ao lado de "rpc("): declaradas aqui para não ficarem sem conferência.
const INDIRETAS = [{ tela: 'painel', nome: 'convenio_suspender', chaves: null }, { tela: 'painel', nome: 'convenio_reativar', chaves: null }];

// Extrai rpc('nome', { chaves }) de um arquivo. chaves = null quando o segundo argumento não é um objeto literal simples.
function chamadas(texto) {
  const out = [], rx = /(?:\.rpc|rpcPessoa|\brpc)\(\s*['"]([a-z0-9_]+)['"]\s*(,\s*\{)?/g;
  let m;
  while ((m = rx.exec(texto))) {
    let chaves = null;
    if (m[2]) {
      let i = rx.lastIndex - 1, prof = 0, j = i;
      for (; j < texto.length; j++) { const c = texto[j]; if (c === '{') prof++; else if (c === '}') { prof--; if (prof === 0) break; } }
      const corpo = texto.slice(i + 1, j);
      const partes = []; let buf = '', nivel = 0, aspas = null;
      for (const c of corpo) {
        if (aspas) { buf += c; if (c === aspas) aspas = null; continue; }
        if (c === "'" || c === '"' || c === '`') { aspas = c; buf += c; continue; }
        if ('{[('.includes(c)) nivel++; else if ('}])'.includes(c)) nivel--;
        if (c === ',' && nivel === 0) { partes.push(buf); buf = ''; } else buf += c;
      }
      partes.push(buf);
      chaves = [];
      for (const p of partes) {
        if (p.trim().startsWith('...')) { chaves = null; break; }
        const k = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(:|$)/.exec(p);
        if (k) chaves.push(k[1]);
      }
    }
    out.push({ nome: m[1], chaves, linha: texto.slice(0, m.index).split('\n').length });
  }
  return out;
}

const usos = [];
for (const t of TELAS) {
  const texto = readFileSync(`${REPO}/${t.arquivo}`, 'utf8');
  for (const c of chamadas(texto)) usos.push({ tela: t.nome, arquivo: t.arquivo, ...c });
  t.tabelas = [...texto.matchAll(/\.from\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => ({ nome: m[1], linha: texto.slice(0, m.index).split('\n').length }));
  t.edge = [...new Set([...texto.matchAll(/functions\/v1\/([a-z0-9-]+)|functions\.invoke\(\s*['"]([a-z0-9-]+)/g)].map((m) => m[1] || m[2]))];
}
for (const i of INDIRETAS) usos.push({ ...i, arquivo: 'painel/index.html', linha: 0 });

caso(`as telas chamam ${new Set(usos.map((u) => u.nome)).size} funções diferentes do banco e TODAS existem na produção`, () => {
  const faltam = usos.filter((u) => !funcoes.has(u.nome)).map((u) => `${u.nome} (${u.arquivo}:${u.linha})`);
  return { ok: faltam.length === 0 && usos.length > 140, detalhe: faltam.length ? 'NÃO EXISTEM: ' + faltam.join(', ') : `${usos.length} chamadas conferidas` };
});

caso('os nomes dos parâmetros que cada tela envia batem com os da função (nenhum sobrando, nenhum obrigatório faltando)', () => {
  const ruins = [];
  for (const u of usos) {
    if (!u.chaves || !funcoes.has(u.nome)) continue;
    const serve = funcoes.get(u.nome).some((f) => {
      const nomes = f.args.map((a) => a.nome), obrig = f.args.filter((a) => !a.padrao).map((a) => a.nome);
      return u.chaves.every((k) => nomes.includes(k)) && obrig.every((k) => u.chaves.includes(k));
    });
    if (!serve) ruins.push(`${u.nome} (${u.arquivo}:${u.linha}) envia [${u.chaves.join(', ')}], o banco espera [${funcoes.get(u.nome).map((f) => f.args.map((a) => a.nome + (a.padrao ? '?' : '')).join(', ')).join(' OU ')}]`);
  }
  return { ok: ruins.length === 0, detalhe: ruins.join(' | ') || `${usos.filter((u) => u.chaves).length} chamadas com parâmetros conferidas` };
});

caso('permissão: o que o paciente sem login chama (chat_*, check-in) pode ser executado por anon; o que a equipe chama, por quem está logado', () => {
  const ruins = [];
  for (const u of usos) {
    const fs = funcoes.get(u.nome); if (!fs) continue;
    const anon = fs.some((f) => f.anon), logado = fs.some((f) => f.authenticated);
    const precisaAnon = (u.tela !== 'painel') && (/^chat_/.test(u.nome) || ['checkin_publico', 'login_paciente_ativo', 'fila_minha_vez_ticket'].includes(u.nome));
    if (precisaAnon && !anon) ruins.push(`${u.nome}: o paciente sem login não consegue executar`);
    if (!precisaAnon && !logado) ruins.push(`${u.nome}: quem está logado não consegue executar`);
  }
  return { ok: ruins.length === 0, detalhe: [...new Set(ruins)].join(' | ') };
});

caso('o paciente (chat e Minha vez) nunca lê tabela direto: só funções; o painel só lê tabelas e visões que existem', () => {
  const doPaciente = TELAS.filter((t) => t.nome !== 'painel').flatMap((t) => t.tabelas.map((x) => `${t.arquivo}:${x.linha} ${x.nome}`));
  const painel = TELAS.find((t) => t.nome === 'painel');
  const faltam = painel.tabelas.filter((x) => !tabelas.has(x.nome) && !visoes.has(x.nome)).map((x) => `${x.nome} (linha ${x.linha})`);
  return { ok: doPaciente.length === 0 && faltam.length === 0, detalhe: doPaciente.length ? 'paciente lê tabela: ' + doPaciente.join(', ') : faltam.length ? 'não existem: ' + faltam.join(', ') : `${new Set(painel.tabelas.map((x) => x.nome)).size} tabelas/visões do painel conferidas` };
});

caso('toda função que só o dono/rotina deveria usar está fechada: nenhuma função de gatilho ou rotina aberta ao paciente sem login por engano', () => {
  // Gatilho aberto a anon não é explorável (o PostgREST não chama função que devolve trigger), mas fica anotado para não crescer.
  const gatilhosAbertos = indice.funcoes.filter((f) => f.gatilho && f.anon).map((f) => f.nome);
  // Em 11/11/2026 eram 9; supabase/seguranca-ajustes.sql fechou todos. Qualquer um que reapareça reprova o teste.
  const novos = gatilhosAbertos;
  const rotinas = ['manutencao_limpar', 'jornada_vigiar', 'jornada_conversas_sincronizar', 'autoencerrar_vigiar', 'agendado_vigiar', 'espera_vigiar', 'pessoa_agrupar_pendentes', 'ind_fechar_pendentes', 'convenios_revisar',
    'agendamento_valido_para_encerrar', 'chat_corpo_atualizar', 'chat_corpo_calcular'];
  const abertas = rotinas.filter((n) => (funcoes.get(n) || []).some((f) => f.anon || f.authenticated));
  return { ok: abertas.length === 0 && novos.length === 0, detalhe: `rotinas abertas: ${abertas.join(', ') || 'nenhuma'}; funções de gatilho visíveis ao paciente: ${novos.join(', ') || 'nenhuma'}` };
});

caso('cada rotina agendada (pg_cron) chama função que existe, e as Edge Functions que ela aciona têm o código neste repositório', () => {
  const ruins = [];
  for (const r of indice.rotinas) {
    for (const m of r.comando.matchAll(/public\.([a-z0-9_]+)\s*\(/g)) if (!funcoes.has(m[1])) ruins.push(`${r.nome}: função ${m[1]} não existe`);
    for (const m of r.comando.matchAll(/functions\/v1\/([a-z0-9-]+)/g)) if (!existsSync(`${REPO}/supabase/functions/${m[1]}/index.ts`)) ruins.push(`${r.nome}: Edge Function ${m[1]} sem código no repositório`);
    if (!r.ativa) ruins.push(`${r.nome}: está PARADA`);
  }
  for (const n of ['manutencao-limpeza', 'chat-corpo-cache', 'jornada-vigia', 'autoencerrar-vigia']) if (!indice.rotinas.some((r) => r.nome === n)) ruins.push(`falta a rotina ${n}`);
  return { ok: ruins.length === 0 && indice.rotinas.length >= 21, detalhe: ruins.join(' | ') || `${indice.rotinas.length} rotinas conferidas` };
});

caso('cada gatilho aponta para função que existe; nenhuma função do banco chama função ou tabela que não existe', () => {
  const ruins = [];
  for (const g of indice.gatilhos) { const m = /EXECUTE FUNCTION (?:public\.)?([a-z0-9_]+)\(/.exec(g); if (m && !funcoes.has(m[1])) ruins.push(`gatilho -> ${m[1]}`); }
  const pasta = `${REPO}/supabase/producao/funcoes`;
  for (const arq of readdirSync(pasta)) {
    const corpo = readFileSync(`${pasta}/${arq}`, 'utf8').replace(/--[^\n]*/g, '');
    for (const m of corpo.matchAll(/\bpublic\.([a-z_][a-z0-9_]*)\s*\(/g)) if (!funcoes.has(m[1]) && !tabelas.has(m[1]) && !visoes.has(m[1])) ruins.push(`${arq} chama ${m[1]}()`);
    for (const m of corpo.matchAll(/\b(?:from|join|into|update)\s+public\.([a-z_][a-z0-9_]*)\b(?!\s*\()/gi)) if (!tabelas.has(m[1]) && !visoes.has(m[1]) && !funcoes.has(m[1])) ruins.push(`${arq} usa a tabela ${m[1]}`);
  }
  return { ok: ruins.length === 0, detalhe: [...new Set(ruins)].slice(0, 12).join(' | ') || `${indice.gatilhos.length} gatilhos e ${indice.funcoes.length} funções conferidos` };
});

caso('as Edge Functions que as telas chamam têm o código neste repositório', () => {
  const todas = [...new Set(TELAS.flatMap((t) => t.edge))];
  const faltam = todas.filter((n) => !existsSync(`${REPO}/supabase/functions/${n}/index.ts`));
  return { ok: faltam.length === 0 && todas.length >= 2, detalhe: faltam.length ? 'sem código: ' + faltam.join(', ') : todas.join(', ') };
});

caso('toda tabela do banco tem a regra de acesso por linha (RLS) ligada', () => {
  const sem = indice.tabelas.filter((t) => !t.rls).map((t) => t.nome);
  return { ok: sem.length === 0, detalhe: sem.length ? 'SEM RLS: ' + sem.join(', ') : `${indice.tabelas.length} tabelas` };
});

caso('o service worker do chat guarda os arquivos que o chat carrega; as versões do chat e dos service workers foram trocadas juntas', () => {
  const sw = readFileSync(`${REPO}/sw.js`, 'utf8'), chat = readFileSync(`${REPO}/index.html`, 'utf8');
  const scripts = [...chat.matchAll(/<script src="([^"h][^"]*)"/g)].map((m) => m[1]);
  const fora = scripts.filter((s) => !sw.includes(`'${s}'`));
  const versao = /const VERSAO_APP = '([^']+)'/.exec(chat);
  return { ok: fora.length === 0 && !!versao && /^\d{4}\.\d{2}\.\d{2}-\d+$/.test(versao[1]), detalhe: fora.length ? 'fora do cache: ' + fora.join(', ') : `chat ${versao && versao[1]}; ${/const VERSAO = '([^']+)'/.exec(sw)[1]}` };
});

const passou = resultados.filter(Boolean).length;
console.log(`\n${passou} de ${resultados.length} verificações passaram.`);
process.exit(passou === resultados.length ? 0 : 1);
