// FLUXOGRAMA: entrada (o retrato da produção + supabase/klingo-pos-marcacao-sozinho.sql; conversas montadas direto no banco, "marcadas sozinhas pelo chat" = pre_agendamentos.agendado_origem 'chat_api') -> validação (texto igual a uma opção do menu faz o mesmo que o botão; texto fora das opções chama a equipe; "Está tudo certo" e a rotina de 2 h encerram mesmo com atendente de OUTRO dia, mas não com atendente DEPOIS da marcação nem em atendimento) -> lógica (fluxo_avancar, fluxo_pos_responder, klingo_operacao_vigiar) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 24/11/2026 / Mudança: primeira versão (conversa de quem marcou sozinho não fica esperando atendente)
// Dados: todos inventados aqui.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q } = ajudantes(db);
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await db.exec(`insert into public.config (chave, valor) values ('motor', 'fluxo') on conflict (chave) do update set valor = 'fluxo'`);
await db.exec(`insert into public.fluxo_texto (chave, texto, descricao) values ('pos_equipe', 'Tudo bem, vou chamar uma pessoa da equipe para te ajudar.', 't'), ('pos_fim', 'Perfeito! Até breve.', 't'), ('pos_menu', 'Posso ajudar em mais alguma coisa?', 't'), ('pos_menu_texto', 'Estou por aqui.', 't') on conflict (chave) do nothing`);
await db.exec(readFileSync(`${REPO}/supabase/klingo-pos-marcacao-sozinho.sql`, 'utf8'));

let seq = 0;
// conversa "marcada sozinha": aguardando, assistente conduzindo, passo pos_menu
async function conversa({ humano = null, marcouHa = '5 minutes', status = 'aguardando' } = {}) {
  seq++;
  const ct = (await q(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Teste ' + seq, '7197' + String(3000000 + seq)]))[0].id;
  const c = (await q(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa, motor, primeiro_humano_em) values ($1, $2, $3, true, 'fluxo', ${humano ? `now() + interval '${humano}'` : 'null'}) returning id`, [ct, 'Teste ' + seq, status]))[0].id;
  await q(`insert into public.conversa_segredo (conversa_id) values ($1) on conflict do nothing`, [c]);
  await q(`insert into public.conversa_fluxo (conversa_id, passo, dados) values ($1, 'pos_menu', '{}'::jsonb) on conflict (conversa_id) do update set passo = 'pos_menu'`, [c]);
  await q(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, agendado_origem, agendado_auto_em, klingo_marcacoes, escolha_horario)
           values ($1, 'consulta', 'CONSULTA', 'agendado', 'chat_api', now() - interval '${marcouHa}', array['29${seq}'], '[{"data":"2030-12-14","hora":"14:45","procedimento":"CONSULTA","unidade":"DESENVOAR","profissional":"EXEMPLO"}]'::jsonb)`, [c]);
  await q(`insert into public.mensagens (conversa_id, autor, texto) values ($1, 'cliente', 'Ver a minha marcação')`, [c]);
  if (marcouHa.includes('hours')) await q(`update public.mensagens set criado_em = now() - interval '${marcouHa}' where conversa_id = $1`, [c]);
  return c;
}
const estado = async (c) => (await q(`select status, ia_ativa, motivo_encerramento, encerramento_origem, triagem_resumo, (select passo from public.conversa_fluxo where conversa_id = id) passo from public.conversas where id = $1`, [c]))[0];
const texto = async (c, t) => { await q(`select public.fluxo_avancar($1, $2::jsonb)`, [c, JSON.stringify({ texto: t })]); return estado(c); };

await caso('texto "Ver minha marcação": mostra a marcação e segue com o assistente', async () => {
  const c = await conversa(); const e = await texto(c, 'Ver minha marcação');
  const ult = (await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' order by criado_em desc limit 1`, [c]))[0];
  return { ok: e.ia_ativa === true && e.status === 'aguardando' && /Sua marcação/.test(ult.texto), detalhe: ult.texto.slice(0, 40) };
});
await caso('texto fora das opções: chama a equipe e anota o que o paciente escreveu', async () => {
  const c = await conversa(); const e = await texto(c, 'Posso levar meu acompanhante?');
  return { ok: e.ia_ativa === false && /fora das opções/.test(e.triagem_resumo || '') && /acompanhante/.test(e.triagem_resumo), detalhe: String(e.triagem_resumo).slice(0, 90) };
});
await caso('texto "Obrigada!": encerra como agendado/sistema', async () => {
  const c = await conversa(); const e = await texto(c, 'Obrigada!');
  return { ok: e.status === 'encerrada' && e.motivo_encerramento === 'agendado' && e.encerramento_origem === 'sistema', detalhe: `${e.status}/${e.motivo_encerramento}` };
});
await caso('texto "obrigada, quero remarcar": remarcar ganha, NÃO encerra', async () => {
  const c = await conversa(); const e = await texto(c, 'obrigada, quero remarcar');
  return { ok: e.status !== 'encerrada', detalhe: `${e.status}/${e.ia_ativa}/${e.passo}` };
});
await caso('texto longo (mais de 60 letras) com "ok" no começo vai para a equipe (não é "tudo certo")', async () => {
  const c = await conversa(); const e = await texto(c, 'ok mas na verdade preciso mudar o nome do paciente que está errado');
  return { ok: e.ia_ativa === false && e.status !== 'encerrada', detalhe: `${e.status}/${e.ia_ativa}` };
});
await caso('pedido de atendente continua indo para a equipe (regra que já existia)', async () => {
  const c = await conversa(); const e = await texto(c, 'quero falar com atendente');
  return { ok: e.ia_ativa === false, detalhe: `${e.ia_ativa}` };
});
await caso('"Está tudo certo": encerra quem teve atendente OUTRO dia; não encerra se a equipe entrou DEPOIS da marcação', async () => {
  const a = await conversa({ humano: '-1 day' }), b = await conversa({ humano: '1 second' });
  await q(`select public.fluxo_pos_responder($1, 'fim')`, [a]); await q(`select public.fluxo_pos_responder($1, 'fim')`, [b]);
  const ea = await estado(a), eb = await estado(b);
  return { ok: ea.status === 'encerrada' && eb.status !== 'encerrada', detalhe: `antigo=${ea.status}; depois=${eb.status}` };
});
await caso('rotina de 2 h: encerra quem ficou quieto (mesmo com atendente de outro dia); não toca em atendente depois, em atendimento nem em quem marcou há pouco', async () => {
  const a = await conversa({ humano: '-2 days', marcouHa: '3 hours' }), b = await conversa({ humano: '-1 hour', marcouHa: '3 hours' });
  const c = await conversa({ humano: '-5 days', marcouHa: '3 hours', status: 'em_atendimento' }), d = await conversa();
  const sem = await conversa({ marcouHa: '3 hours' });
  await q(`select public.klingo_operacao_vigiar()`);
  const s = []; for (const x of [a, b, c, d, sem]) s.push((await estado(x)).status);
  return { ok: s[0] === 'encerrada' && s[1] !== 'encerrada' && s[2] === 'em_atendimento' && s[3] !== 'encerrada' && s[4] === 'encerrada', detalhe: s.join(',') };
});
await caso('reversão: o rollback devolve as 3 funções ao estado do retrato', async () => {
  await db.exec(readFileSync(`${REPO}/supabase/klingo-pos-marcacao-sozinho-rollback.sql`, 'utf8'));
  const c = await conversa(); const e = await texto(c, 'Posso levar meu acompanhante?');
  return { ok: e.ia_ativa === true, detalhe: `volta ao menu: ia_ativa=${e.ia_ativa}` };
});

const falhou = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhou} de ${resultados.length} verificações passaram.`);
process.exit(falhou ? 1 : 0);
