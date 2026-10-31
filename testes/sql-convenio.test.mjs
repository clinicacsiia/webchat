// FLUXOGRAMA: entrada (as funções REAIS do motor em supabase/fase7-motor.sql e fase4-paciente-que-volta.sql + supabase/correcao-convenio-quem-volta.sql, num Postgres embutido com tabelas mínimas e stubs só do que está fora do assunto) -> validação (aplica a correção duas vezes) -> lógica (convênio da vez anterior vira pergunta, resposta sim/não por botão e por texto, correção do plano tira a carteirinha só se o convênio mudou, trocar a consulta refaz o horário) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const fase7 = readFileSync(`${REPO}/supabase/fase7-motor.sql`, 'utf8');
const correcao = readFileSync(`${REPO}/supabase/correcao-convenio-quem-volta.sql`, 'utf8');
const seed = fase7.match(/insert into public\.fluxo_texto \(chave, texto, descricao\) values[\s\S]*?on conflict \(chave\) do nothing;/)[0];

const db = new PGlite();
await db.exec(`
  create table public.fluxo_texto (chave text primary key, texto text not null, descricao text);
  ${seed}
  create table public.conversas (id uuid primary key default gen_random_uuid(), contato_id uuid, unidade_inicial text, irmao_de uuid, irmaos_modo text);
  create table public.conversa_fluxo (conversa_id uuid primary key, passo text, dados jsonb not null default '{}'::jsonb, tentativas int not null default 0, atualizado_em timestamptz);
  create table public.pre_agendamentos (conversa_id uuid primary key, tipo text, procedimento text, plano text, unidade text, profissional text, status text default 'rascunho', etapa text,
    escolha_horario jsonb, data_desejada text, hora_desejada text, identidade text, atualizado_em timestamptz);
  create table public.pre_agendamento_itens (id bigint generated always as identity primary key, conversa_id uuid, modalidade text, regiao text, regiao_nome text, lado text,
    procedimento_id int, procedimento text, quantidade int, ativo boolean default true);
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, texto text, opcoes jsonb);
  create table public.catalogo_procedimento (id int primary key, nome text, ativo boolean default true);
  create table public.paciente_historico (id bigint generated always as identity primary key, paciente_id uuid, exames jsonb, cancelado boolean default false, ocorreu_em timestamp, criado_em timestamptz default now(), plano text);
  -- Stubs do que está fora do assunto (o motor real chama estas funções). O unaccent do Supabase vira um translate equivalente.
  create schema extensions;
  create function extensions.unaccent(t text) returns text language sql immutable as $$
    select translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN') $$;
  create table public.teste_cfg (chave text primary key, valor text);
  create function public.fluxo_ctx(p uuid) returns jsonb language sql as $$ select '{"nome":"Maria","filho":false,"quem":"você","de_quem":"","para_quem":""}'::jsonb $$;
  create function public.paciente_conferir(p uuid) returns jsonb language sql as $$ select jsonb_build_object('paciente_id', '11111111-1111-1111-1111-111111111111', 'dt_nasc_conferida', 'true') $$;
  create function public.paciente_historico_para_ia(p uuid) returns jsonb language sql as $$
    select jsonb_build_object('liberado', true, 'ultimas', jsonb_build_array(jsonb_build_object('plano', (select valor from public.teste_cfg where chave = 'plano_historico'), 'exames', '[]'::jsonb))) $$;
  create function public.pre_pendencia_anterior(p uuid) returns uuid language sql as $$ select (select valor from public.teste_cfg where chave = 'conversa_antiga')::uuid $$;
  create function public.fluxo_procs(p uuid) returns integer[] language sql as $$ select null::integer[] $$;
  create function public.agenda_grupos(p integer[]) returns jsonb language sql as $$ select '[]'::jsonb $$;
  create function public.fluxo_medicos(p uuid) returns text[] language sql as $$ select null::text[] $$;
  create function public.fluxo_pre(p_conversa uuid, p_dados jsonb, p_pronto boolean default false) returns jsonb language plpgsql as $$
  begin
    update public.pre_agendamentos set plano = coalesce(nullif(p_dados ->> 'plano', ''), plano), etapa = coalesce(p_dados ->> 'etapa', etapa) where conversa_id = p_conversa;
    return '{}'::jsonb;
  end $$;
  ${['fluxo_t', 'fluxo_norm', 'fluxo_set', 'fluxo_nota', 'fluxo_dizer', 'fluxo_escolha', 'fluxo_proximo', 'fluxo_perguntar', 'fluxo_aplicar', 'fluxo_ler_texto', 'fluxo_avancar'].map((n) => funcao('fase7-motor.sql', n)).join('\n')}
  ${funcao('fase4-paciente-que-volta.sql', 'pre_reaproveitar')}
`);

const nova = async (extra = {}) => {
  const id = (await db.query(`insert into public.conversas default values returning id`)).rows[0].id;
  await db.query(`insert into public.conversa_fluxo (conversa_id, dados) values ($1, $2::jsonb)`, [id, JSON.stringify(extra.dados || {})]);
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, plano, unidade, escolha_horario) values ($1, 'exame', $2, $3, $4::jsonb)`,
    [id, extra.plano ?? null, extra.unidade ?? null, extra.horario ? JSON.stringify(extra.horario) : null]);
  // Conversa já no meio do pedido (identidade vista, motivo e exame escolhidos), salvo quando o caso quer começar do zero.
  if (extra.vazia !== true) {
    await db.query(`update public.conversa_fluxo set dados = dados || '{"identidade_feita": true, "atalho_feito": true, "motivo": "exame"}'::jsonb where conversa_id = $1`, [id]);
    await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, quantidade) values ($1, 'RM', 'JOELHO', 'Joelho', 'D', 1)`, [id]);
  }
  return id;
};
const dados = async (id) => (await db.query(`select dados from public.conversa_fluxo where conversa_id = $1`, [id])).rows[0].dados;
const pre = async (id) => (await db.query(`select * from public.pre_agendamentos where conversa_id = $1`, [id])).rows[0];
const proximo = async (id) => (await db.query(`select public.fluxo_proximo($1) r`, [id])).rows[0].r;
const aplicar = async (id, passo, valor) => (await db.query(`select public.fluxo_aplicar($1, $2, $3::jsonb) r`, [id, passo, JSON.stringify(valor)])).rows[0].r;
const ler = async (id, passo, texto) => (await db.query(`select public.fluxo_ler_texto($1, $2, $3) r`, [id, passo, texto])).rows[0].r;

// Antes da correção: o defeito existe de verdade (prova que o teste enxerga o problema).
await caso('ANTES da correção: o pedido pela metade copia o convênio da conversa antiga em silêncio', async () => {
  const antiga = await nova({ plano: 'UNIMED', vazia: true });
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, quantidade) values ($1, 'RM', 'JOELHO', 'Joelho', 'D', 1)`, [antiga]);
  await db.query(`insert into public.teste_cfg values ('conversa_antiga', $1) on conflict (chave) do update set valor = excluded.valor`, [antiga]);
  const c = await nova({ vazia: true });
  const r = (await db.query(`select public.pre_reaproveitar($1, 'pendente') r`, [c])).rows[0].r;
  const p = await pre(c);
  return { ok: r === true && p.plano === 'UNIMED', detalhe: `reaproveitou=${r}, plano copiado=${p.plano}` };
});

await caso('a correção aplica sem erro e pode ser aplicada de novo', async () => {
  await db.exec(correcao); await db.exec(correcao);
  return { ok: true, detalhe: 'duas aplicações seguidas sem erro' };
});

await caso('a correção recusa mexer numa função diferente do esperado (nada é alterado)', async () => {
  await db.exec(`create or replace function public.fluxo_proximo(p_conversa uuid) returns text language sql as $$ select 'x'::text $$`);
  let erro = '';
  try { await db.exec(correcao); } catch (e) { erro = e.message; }
  await db.exec(funcao('fase7-motor.sql', 'fluxo_proximo')); await db.exec(correcao);   // restaura a função real e reaplica
  return { ok: /nada foi alterado/.test(erro), detalhe: erro.split('\n')[0] };
});

await caso('DEPOIS: o pedido pela metade NÃO copia o convênio, mas copia a unidade, e guarda o convênio antigo como pergunta', async () => {
  const antiga = await nova({ plano: 'BRADESCO SAUDE', unidade: 'CSI', vazia: true });
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, quantidade) values ($1, 'RM', 'JOELHO', 'Joelho', 'D', 1)`, [antiga]);
  await db.query(`update public.teste_cfg set valor = $1 where chave = 'conversa_antiga'`, [antiga]);
  const c = await nova({ vazia: true });
  const r = await aplicar(c, 'atalho', 'pendente');
  const p = await pre(c); const d = await dados(c);
  return { ok: r.ok === true && p.plano === null && p.unidade === 'CSI' && d.plano_anterior === 'BRADESCO SAUDE' && (await proximo(c)) === 'plano_confirma',
           detalhe: `plano=${p.plano}, unidade=${p.unidade}, anterior=${d.plano_anterior}` };
});

await caso('DEPOIS: "Repetir o último exame" também pergunta o convênio da última visita', async () => {
  await db.query(`insert into public.teste_cfg values ('plano_historico', 'UNIMED') on conflict (chave) do update set valor = excluded.valor`);
  await db.query(`insert into public.paciente_historico (paciente_id, exames, plano) values ('11111111-1111-1111-1111-111111111111', '[{"modalidade":"RM","parte_do_corpo":"Joelho","lado":"D","quantidade":1}]'::jsonb, 'UNIMED')`);
  const c = await nova({ vazia: true });
  const r = await aplicar(c, 'atalho', 'ultimo');
  const p = await pre(c); const d = await dados(c);
  return { ok: r.ok === true && p.plano === null && d.plano_anterior === 'UNIMED' && (await proximo(c)) === 'plano_confirma', detalhe: `plano=${p.plano}, anterior=${d.plano_anterior}` };
});

await caso('sem convênio na vez anterior, segue a lista de sempre (sem pergunta nova)', async () => {
  await db.query(`update public.teste_cfg set valor = null where chave = 'plano_historico'`);
  const c = await nova({ vazia: true });
  await aplicar(c, 'atalho', 'ultimo');
  return { ok: (await proximo(c)) === 'plano', detalhe: `próximo=${await proximo(c)}` };
});

await caso('a pergunta aparece com dois botões grandes e o nome do convênio em letras normais', async () => {
  const c = await nova({ dados: { plano_anterior: 'BRADESCO SAUDE' } });
  await db.query(`select public.fluxo_perguntar($1, 'plano_confirma', null)`, [c]);
  const m = (await db.query(`select texto, opcoes from public.mensagens where conversa_id = $1`, [c])).rows[0];
  const rot = m.opcoes.itens.map((i) => i.rotulo).join(' | ');
  const etapa = (await pre(c)).etapa;
  return { ok: m.texto === 'Da última vez o atendimento foi pelo convênio Bradesco Saude. É assim também agora?' && rot === 'Sim, é o mesmo | Não, mudou' && m.opcoes.passo === 'plano_confirma' && etapa === 'plano',
           detalhe: `${m.texto} / ${rot} / etapa=${etapa}` };
});

await caso('particular na vez anterior: "foi particular"', async () => {
  const c = await nova({ dados: { plano_anterior: 'Particular' } });
  await db.query(`select public.fluxo_perguntar($1, 'plano_confirma', null)`, [c]);
  const m = (await db.query(`select texto from public.mensagens where conversa_id = $1`, [c])).rows[0];
  return { ok: m.texto === 'Da última vez o atendimento foi particular. É assim também agora?', detalhe: m.texto };
});

await caso('"Sim, é o mesmo": grava o convênio, apaga a pergunta e segue adiante', async () => {
  const c = await nova({ dados: { plano_anterior: 'UNIMED' } });
  const r = await aplicar(c, 'plano_confirma', 'sim');
  const p = await pre(c); const d = await dados(c); const prox = await proximo(c);
  return { ok: r.ok === true && p.plano === 'UNIMED' && d.plano_anterior === null && prox !== 'plano' && prox !== 'plano_confirma', detalhe: `plano=${p.plano}, próximo=${prox}` };
});

await caso('"Não, mudou": não grava nada, apaga a pergunta e abre a lista de convênios', async () => {
  const c = await nova({ dados: { plano_anterior: 'UNIMED' } });
  const r = await aplicar(c, 'plano_confirma', 'nao');
  const p = await pre(c); const d = await dados(c);
  return { ok: r.ok === true && p.plano === null && d.plano_anterior === null && (await proximo(c)) === 'plano', detalhe: `plano=${p.plano}, próximo=${await proximo(c)}` };
});

await caso('resposta inválida na pergunta nova é recusada (nada muda)', async () => {
  const c = await nova({ dados: { plano_anterior: 'UNIMED' } });
  const r = await aplicar(c, 'plano_confirma', 'talvez');
  return { ok: r.ok === false && (await dados(c)).plano_anterior === 'UNIMED', detalhe: JSON.stringify(r) };
});

await caso('quem digita em vez de tocar também é entendido', async () => {
  const c = await nova({ dados: { plano_anterior: 'UNIMED' } });
  const casos = { 'sim': 'sim', 'Sim, é o mesmo': 'sim', 'é o mesmo': 'sim', 'continua': 'sim', 'não mudou': 'sim', 'nada mudou': 'sim',
                  'não': 'nao', 'não, mudou': 'nao', 'mudou': 'nao', 'troquei de plano': 'nao', 'não é o mesmo': 'nao', 'banana': null };
  const erros = [];
  for (const [txt, esp] of Object.entries(casos)) {
    const v = await ler(c, 'plano_confirma', txt);
    if (v !== esp) erros.push(`"${txt}" -> ${v}`);
  }
  return { ok: erros.length === 0, detalhe: erros.join('; ') || `${Object.keys(casos).length} frases` };
});

const estadoConfirmacao = { plano: 'UNIMED', horario: [{ unidade: 'CSI', data: '2026-11-10', hora: '08:00' }],
  dados: { mudou: 'igual', g_ident: true, g_contato: true, g_endereco: true, g_carteira: true, confirmado: true,
           digitado: { celular: '73999999999', matricula: '0001234', validade: '2027-01-31' } } };

await caso('Corrigir o plano e escolher OUTRO convênio: a carteirinha e a validade saem, o resto fica e a carteirinha é pedida de novo', async () => {
  const c = await nova(estadoConfirmacao);
  await aplicar(c, 'confirmar', 'plano');
  const meio = await pre(c);
  const r = await aplicar(c, 'plano', 'BRADESCO SAUDE');
  const p = await pre(c); const d = await dados(c);
  return { ok: meio.plano === null && p.plano === 'BRADESCO SAUDE' && d.digitado.matricula === undefined && d.digitado.validade === undefined && d.digitado.celular === '73999999999'
             && d.g_carteira === false && d.confirmado === false && d.plano_trocado_de === null && (await proximo(c)) === 'dados_carteira' && r.ok === true,
           detalhe: `digitado=${JSON.stringify(d.digitado)}, g_carteira=${d.g_carteira}, próximo=${await proximo(c)}` };
});

await caso('com horário já escolhido: o horário fica, a pessoa é avisada e o atendente recebe uma nota', async () => {
  const c = await nova(estadoConfirmacao);
  await aplicar(c, 'confirmar', 'plano');
  const r = await aplicar(c, 'plano', 'BRADESCO SAUDE');
  const p = await pre(c); const d = await dados(c);
  const nota = (d.notas || []).join(' ');
  return { ok: p.escolha_horario?.length === 1 && /atendente confere se o horário/.test(r.aviso || '') && /Convênio trocado de UNIMED para BRADESCO SAUDE/.test(nota), detalhe: `${r.aviso} | ${nota}` };
});

await caso('sem horário escolhido: o aviso fala só da carteirinha', async () => {
  const c = await nova({ ...estadoConfirmacao, horario: null });
  await aplicar(c, 'confirmar', 'plano');
  const r = await aplicar(c, 'plano', 'BRADESCO SAUDE');
  return { ok: r.aviso === 'Convênio atualizado. Vou pedir o número da carteirinha de novo.' && !((await dados(c)).notas || []).length, detalhe: r.aviso };
});

await caso('Corrigir o plano e escolher o MESMO convênio: nada é apagado e nada é perguntado de novo', async () => {
  const c = await nova(estadoConfirmacao);
  await aplicar(c, 'confirmar', 'plano');
  const r = await aplicar(c, 'plano', 'unimed');
  const d = await dados(c);
  return { ok: d.digitado.matricula === '0001234' && d.g_carteira === true && r.aviso === undefined && (await proximo(c)) === 'confirmar', detalhe: `matricula=${d.digitado.matricula}, próximo=${await proximo(c)}` };
});

await caso('escolher o convênio pela primeira vez (sem correção) não apaga nem avisa nada', async () => {
  const c = await nova({ dados: { digitado: { matricula: '999' } } });
  const r = await aplicar(c, 'plano', 'UNIMED');
  return { ok: (await dados(c)).digitado.matricula === '999' && r.aviso === undefined && (await pre(c)).plano === 'UNIMED', detalhe: JSON.stringify(r) };
});

await caso('convênio digitado fora da lista na correção: carteirinha sai e vale o aviso de "convênio fora da lista"', async () => {
  const c = await nova(estadoConfirmacao);
  await aplicar(c, 'confirmar', 'plano');
  const r = await aplicar(c, 'plano', { outro: 'Plano da Empresa X' });
  const d = await dados(c);
  return { ok: d.digitado.matricula === undefined && d.g_carteira === false && /Plano da Empresa X/.test(r.aviso || ''), detalhe: r.aviso };
});

await caso('a pergunta de convênio guardada de antes não reaparece depois que a pessoa escolhe outro convênio na lista', async () => {
  const c = await nova({ dados: { plano_anterior: 'UNIMED' } });
  await aplicar(c, 'plano', 'AMIL');
  return { ok: (await dados(c)).plano_anterior === null && (await pre(c)).plano === 'AMIL', detalhe: '' };
});

await caso('trocar a CONSULTA também refaz o horário (antes só o exame refazia)', async () => {
  const def = (await db.query(`select pg_get_functiondef('public.fluxo_avancar(uuid,jsonb)'::regprocedure) d`)).rows[0].d;
  return { ok: /escolha_horario is not null and status = 'rascunho';\s+-- convenio-quem-volta/.test(def) && !/v_texto like 'Pedido de exames:%' and escolha_horario/.test(def), detalhe: 'condição "só exame" removida' };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
