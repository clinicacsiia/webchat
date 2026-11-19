// FLUXOGRAMA: entrada (clone da produção + supabase/indicadores-agendado-no-dia.sql; pessoas, pedidos, conferência do Klingo e Jornada INVENTADOS) -> validação (só admin/atendente leem; conversa de teste fora; marcação "Bloqueada" não conta; filtro de tipo respeitado) -> lógica (confere que "agendaram" conta a marcação FEITA no dia ("Agendado Em" = klingo_conferencia.marcado_em), seja qual for o dia da conversa; "procuraram" continua pelo dia da conversa) -> saída (PASS/FAIL por verificação; falha = código de saída 1).
// Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial (pedido do dono: 3 marcações feitas hoje, de conversas de outros dias, apareciam como 0 no card "Agendaram").
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const { db } = await criarBancoProducao();
const { um, como } = ajudantes(db);

const ADM = '00000000-0000-4000-8000-0000000000d1', ANA = '00000000-0000-4000-8000-0000000000d2';
await db.exec(`
  insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'), ('${ANA}', 'ana@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'adm@exemplo.invalid', 'admin', true), ('${ANA}', 'Ana Teste', 'ana@exemplo.invalid', 'atendente', true);
`);
await db.exec(readFileSync(`${REPO}/supabase/indicadores-cinco-numeros.sql`, 'utf8'));      // painel_indicadores_pessoas (não muda)
await db.exec(readFileSync(`${REPO}/supabase/indicadores-agendado-no-dia.sql`, 'utf8'));    // ind_pessoas_periodo nova

await db.query(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 1, 'agendamento', 'klingo') on conflict (id) do nothing`);
const card = (await um(`insert into public.jornada_card (paciente_chave, data_ref, coluna) values ('teste-dia', current_date, 'agendado') returning id`)).id;
let seq = 0;
// dias = quantos dias atrás abriu o chat; marcadoHa = quantos dias atrás a marcação foi FEITA (null = sem marcação); status = status do Klingo; je = status na Jornada.
const pessoa = async ({ tipo = 'consulta', m = null, marcadoHa = 0, status = 'Aberta', origem = null, je = null, humano = false, teste = false, dias = 0, semPedido = false } = {}) => {
  seq++;
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Paciente Teste ' + seq, '7197' + (5000000 + seq)])).id;
  const conv = (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa, teste, criado_em) values ($1, $2, 'em_atendimento', false, $3, now() - ($4 || ' days')::interval) returning id`, [ct, 'Paciente Teste ' + seq, teste, String(dias)])).id;
  if (!semPedido) await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, etapa, klingo_marcacoes, agendado_origem) values ($1, $2, 'PROCEDIMENTO TESTE', $3, 'pronto', $4, $5)`, [conv, tipo, m ? 'agendado' : 'rascunho', m ? [m] : null, origem]);
  if (m) await db.query(`insert into public.klingo_conferencia (m, marcado_em, status_klingo, conversa_id, ligacao) values ($1, (now() at time zone 'America/Sao_Paulo')::date - $2::int, $3, $4, $5)`, [m, marcadoHa, status, conv, semPedido ? 'telefone_nome' : 'pedido']);
  if (m && je) await db.query(`insert into public.jornada_exame (card_id, marcacao_id, status, procedimento, agendado_para) values ($1, $2, $3, 'PROCEDIMENTO TESTE', now())`, [card, 'm' + m, je]);
  if (humano) {
    await db.query(`insert into public.mensagens (conversa_id, autor, texto, agente_id) values ($1, 'agente', 'oi', $2)`, [conv, ANA]);
    await db.query(`update public.conversas set agente_id = $2 where id = $1`, [conv, ANA]);
  }
  return conv;
};
await db.exec(`delete from public.klingo_conferencia; delete from public.mensagens; delete from public.pre_agendamentos; delete from public.conversas;`);
await pessoa({ tipo: 'consulta', humano: true });                                                            // A: abriu o chat hoje, atendida, não marcou
await pessoa({ tipo: 'exame', m: '9000001', origem: 'chat_api' });                                           // B: chat de hoje, exame marcado hoje pelo robô, sem atendente
await pessoa({ tipo: 'consulta', m: '9000002', origem: 'reconhecido', dias: 3, humano: true });              // C: CHAT DE HÁ 3 DIAS, marcação feita HOJE (o caso do dono)
await pessoa({ tipo: 'consulta', m: '9000003', origem: 'reconhecido', dias: 3, marcadoHa: 3 });              // D: chat de há 3 dias, marcação feita há 3 dias (não é de hoje)
await pessoa({ tipo: 'consulta', m: '9000004', origem: 'reconhecido', status: 'Bloqueada' });                // E: "Bloqueada" não é agendamento
await pessoa({ tipo: 'exame', m: '9000005', origem: 'chat_api', teste: true });                              // F: conversa de teste fica fora
await pessoa({ tipo: 'consulta', m: '9000006', semPedido: true, dias: 2 });                                   // G: ligada por telefone e nome (sem pedido), marcação de hoje
await pessoa({ tipo: 'exame', m: '9000007', origem: 'equipe', je: 'faltou', dias: 1 });                       // H: marcada hoje, a Jornada diz que faltou
await pessoa({ tipo: 'consulta', m: '9000008', origem: 'equipe', je: 'cancelado', dias: 1 });                 // I: marcada hoje, a Jornada diz que cancelou
await pessoa({ tipo: 'consulta', m: '9000009', origem: 'equipe', status: 'Cancelada', je: 'remarcado' });     // J: Klingo mostra "Cancelada" (remarcada): agendou, mas não conta como cancelou

const hoje = `(now() at time zone 'America/Sao_Paulo')::date`;
const ler = async (args) => { await como(ADM); try { return (await um(`select public.painel_indicadores_pessoas(${args}) as r`)).r; } finally { await como(null); } };
const igual = (a, b) => Object.keys(b).every((k) => a[k] === b[k]);

await caso('hoje: conta a marcação feita hoje de conversa de outro dia (pessoa C)', async () => {
  const a = (await ler(`${hoje}, ${hoje}`)).atual;
  // procuraram: A, B, E, J abriram o chat hoje (F é teste; C, D, G, H, I abriram em outros dias). agendaram: B, C, G, H, I, J (E é Bloqueada, D marcou há 3 dias, F é teste). agendaram_da_coorte (conta antiga, só para o funil): B, E, J = chat de hoje com marcação de qualquer dia.
  const esp = { procuraram: 4, agendaram: 6, agendaram_da_coorte: 3, agendaram_conversa_anterior: 4, robo: 1, robo_sem_atendente: 1, faltaram: 1, cancelaram: 1, faltaram_ou_cancelaram: 2 };
  return { ok: igual(a, esp), detalhe: JSON.stringify(a) };
});
await caso('"Bloqueada" não conta; conversa de teste fica fora; remarcada (Cancelada no Klingo) conta como agendou e não como cancelou', async () => {
  const a = (await ler(`${hoje}, ${hoje}`)).atual;
  return { ok: a.agendaram === 6 && a.cancelaram === 1, detalhe: `agendaram=${a.agendaram} cancelaram=${a.cancelaram}` };
});
await caso('o administrador pode incluir a conversa de teste', async () => {
  const a = (await ler(`${hoje}, ${hoje}, null, true`)).atual;
  return { ok: a.agendaram === 7 && a.robo === 2, detalhe: JSON.stringify(a) };
});
await caso('período de 7 dias soma as marcações feitas em cada dia (D entra)', async () => {
  const a = (await ler(`${hoje} - 6, ${hoje}`)).atual;
  return { ok: a.agendaram === 7, detalhe: `agendaram=${a.agendaram}` };
});
await caso('só o dia de 3 dias atrás: conta só a marcação feita naquele dia (pessoa D)', async () => {
  const a = (await ler(`${hoje} - 3, ${hoje} - 3`)).atual;
  return { ok: a.agendaram === 1 && a.procuraram === 2, detalhe: JSON.stringify(a) };
});
await caso('só exames: conta só marcação de pedido de exame (B e H); sem pedido não entra', async () => {
  const a = (await ler(`${hoje}, ${hoje}, null, false, 'exame'`)).atual;
  return { ok: a.agendaram === 2 && a.robo === 1 && a.faltaram === 1, detalhe: JSON.stringify(a) };
});
await caso('só consultas: C, G (sem pedido) fica de fora com filtro de tipo, I e J entram', async () => {
  const a = (await ler(`${hoje}, ${hoje}, null, false, 'consulta'`)).atual;
  return { ok: a.agendaram === 3 && a.cancelaram === 1, detalhe: JSON.stringify(a) };
});
await caso('o período anterior também é calculado pelo dia da marcação (ontem: ninguém marcou)', async () => {
  const r = await ler(`${hoje}, ${hoje}`);
  return { ok: r.anterior && r.anterior.agendaram === 0, detalhe: JSON.stringify(r.anterior) };
});
await caso('sem login (anônimo) é recusado', async () => {
  await como(null);
  try { await um(`select public.painel_indicadores_pessoas(${hoje}, ${hoje}) as r`); return { ok: false, detalhe: 'não recusou' }; }
  catch (e) { return { ok: /administrador e atendente/.test(e.message), detalhe: String(e.message).slice(0, 80) }; }
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
