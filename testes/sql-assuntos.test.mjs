// FLUXOGRAMA: entrada (as funções REAIS do motor em supabase/fase7-motor.sql + correcao-convenio-quem-volta.sql + supabase/assuntos-resolvidos.sql, num Postgres embutido com stubs só do que está fora do assunto) -> validação (aplica o arquivo duas vezes; recusa função diferente do esperado) -> lógica (Cancelar lista os horários futuros e pede "sim"; Remarcar copia o exame e segue para o calendário; Resultado mostra a orientação só se ela existir; quem não foi identificado ou não tem horário vai para o texto) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const fase7 = readFileSync(`${REPO}/supabase/fase7-motor.sql`, 'utf8');
const convenio = readFileSync(`${REPO}/supabase/correcao-convenio-quem-volta.sql`, 'utf8');
const assuntos = readFileSync(`${REPO}/supabase/assuntos-resolvidos.sql`, 'utf8');
const seed = fase7.match(/insert into public\.fluxo_texto \(chave, texto, descricao\) values[\s\S]*?on conflict \(chave\) do nothing;/)[0];

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create table public.fluxo_texto (chave text primary key, texto text not null, descricao text);
  ${seed}
  create table public.conversas (id uuid primary key default gen_random_uuid(), contato_id uuid, unidade_inicial text, irmao_de uuid, irmaos_modo text);
  create table public.conversa_fluxo (conversa_id uuid primary key, passo text, dados jsonb not null default '{}'::jsonb, tentativas int not null default 0, atualizado_em timestamptz);
  create table public.pre_agendamentos (conversa_id uuid primary key, tipo text, procedimento text, plano text, unidade text, profissional text, status text default 'rascunho', etapa text,
    escolha_horario jsonb, data_desejada text, hora_desejada text, identidade text, atualizado_em timestamptz);
  create table public.pre_agendamento_itens (id bigint generated always as identity primary key, conversa_id uuid, modalidade text, regiao text, regiao_nome text, lado text,
    procedimento_id int, procedimento text, quantidade int, ativo boolean default true);
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, texto text, opcoes jsonb);
  create schema extensions;
  create function extensions.unaccent(t text) returns text language sql immutable as $$
    select translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN') $$;
  create table public.teste_cfg (chave text primary key, valor text);
  create function public.fluxo_ctx(p uuid) returns jsonb language sql as $$ select '{"nome":"Maria","filho":false,"quem":"você","de_quem":"","para_quem":""}'::jsonb $$;
  create function public.paciente_conferir(p uuid) returns jsonb language sql as $$ select jsonb_build_object('paciente_id', '11111111-1111-1111-1111-111111111111', 'dt_nasc_conferida', 'true') $$;
  -- O histórico do teste vem de teste_cfg: 'liberado' e 'ultimas' (JSON).
  create function public.paciente_historico_para_ia(p uuid) returns jsonb language sql as $$
    select jsonb_build_object('liberado', coalesce((select valor from public.teste_cfg where chave = 'liberado'), 'true')::boolean,
                              'ultimas', coalesce((select valor from public.teste_cfg where chave = 'ultimas')::jsonb, '[]'::jsonb)) $$;
  create table public.paciente_historico (id bigint generated always as identity primary key, paciente_id uuid, exames jsonb, cancelado boolean default false, ocorreu_em timestamp, criado_em timestamptz default now(), plano text, unidade text, profissional text);
  create function public.pre_pendencia_anterior(p uuid) returns uuid language sql as $$ select null::uuid $$;
  create function public.fluxo_procs(p uuid) returns integer[] language sql as $$ select null::integer[] $$;
  create function public.agenda_grupos(p integer[]) returns jsonb language sql as $$ select '[]'::jsonb $$;
  create function public.fluxo_medicos(p uuid) returns text[] language sql as $$ select null::text[] $$;
  create function public.fluxo_pre(p_conversa uuid, p_dados jsonb, p_pronto boolean default false) returns jsonb language plpgsql as $$
  begin
    update public.pre_agendamentos set plano = coalesce(nullif(p_dados ->> 'plano', ''), plano), etapa = coalesce(p_dados ->> 'etapa', etapa) where conversa_id = p_conversa;
    return '{}'::jsonb;
  end $$;
  ${funcao('fase4-paciente-que-volta.sql', 'pre_reaproveitar')}
  ${['fluxo_t', 'fluxo_norm', 'fluxo_set', 'fluxo_nota', 'fluxo_dizer', 'fluxo_escolha', 'fluxo_proximo', 'fluxo_perguntar', 'fluxo_aplicar', 'fluxo_ler_texto', 'fluxo_avancar'].map((n) => funcao('fase7-motor.sql', n)).join('\n')}
`);
await db.exec(convenio);
// Daqui em diante pre_reaproveitar é um stub controlável (a cópia real do pedido já é testada em test:convenio).
const STUB = `
  drop function public.pre_reaproveitar(uuid, text);
  create function public.pre_reaproveitar(p uuid, o text) returns boolean language plpgsql as $$
  begin
    if coalesce((select valor from public.teste_cfg where chave = 'reaproveita'), 'true') <> 'true' then return false; end if;
    insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, quantidade) values (p, 'RM', 'JOELHO', 'Joelho', 'D', 1);
    return true;
  end $$;
`;
await db.exec(STUB);

const cfg = async (chave, valor) => db.query(`insert into public.teste_cfg values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
const futuro = (quando, exame = 'RM', lado = 'direito') => ({ futuro: true, quando, plano: 'UNIMED', exames: [{ modalidade: exame, exame: exame === 'RM' ? 'RESSONANCIA DO JOELHO' : 'ULTRASSOM', lado }] });
const passado = { futuro: false, quando: '01/01/2026', plano: 'UNIMED', exames: [{ modalidade: 'RM', exame: 'RESSONANCIA DO JOELHO' }] };

const nova = async (dados = {}) => {
  const id = (await db.query(`insert into public.conversas default values returning id`)).rows[0].id;
  await db.query(`insert into public.conversa_fluxo (conversa_id, dados) values ($1, $2::jsonb)`, [id, JSON.stringify({ identidade_feita: true, atalho_feito: true, motivo: 'assunto', ...dados })]);
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo) values ($1, 'exame')`, [id]);
  return id;
};
const dados = async (id) => (await db.query(`select dados from public.conversa_fluxo where conversa_id = $1`, [id])).rows[0].dados;
const proximo = async (id) => (await db.query(`select public.fluxo_proximo($1) r`, [id])).rows[0].r;
const aplicar = async (id, passo, valor) => (await db.query(`select public.fluxo_aplicar($1, $2, $3::jsonb) r`, [id, passo, JSON.stringify(valor)])).rows[0].r;
const ler = async (id, passo, texto) => (await db.query(`select public.fluxo_ler_texto($1, $2, $3) r`, [id, passo, texto])).rows[0].r;
const perguntar = async (id, passo) => { await db.query(`select public.fluxo_perguntar($1, $2)`, [id, passo]); return (await db.query(`select texto, opcoes from public.mensagens where conversa_id = $1 order by id desc limit 1`, [id])).rows[0]; };

await caso('ANTES do arquivo: Cancelar vai direto para "Conte em poucas palavras"', async () => {
  const c = await nova({ assunto: 'Cancelar' });
  return { ok: (await proximo(c)) === 'assunto_texto', detalhe: `próximo=${await proximo(c)}` };
});

await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => {
  await db.exec(assuntos); await db.exec(assuntos);
  return { ok: true, detalhe: 'duas aplicações seguidas' };
});

await caso('recusa mexer numa função diferente do esperado (nada é alterado)', async () => {
  await db.exec(`create or replace function public.fluxo_proximo(p_conversa uuid) returns text language sql as $$ select 'x'::text $$`);
  let erro = '';
  try { await db.exec(assuntos); } catch (e) { erro = e.message; }
  await db.exec(funcao('fase7-motor.sql', 'fluxo_proximo'));
  await db.exec(`drop function public.pre_reaproveitar(uuid, text);\n${funcao('fase4-paciente-que-volta.sql', 'pre_reaproveitar')}`); await db.exec(convenio); await db.exec(assuntos); await db.exec(STUB);
  return { ok: /nada foi alterado/.test(erro), detalhe: erro.split('\n')[0] };
});

await cfg('liberado', 'true');
await cfg('ultimas', JSON.stringify([futuro('10/11/2026'), futuro('20/11/2026', 'US', 'ambos'), passado]));

await caso('Cancelar: lista só os horários FUTUROS, com "Não é nenhum destes" no fim', async () => {
  const c = await nova({ assunto: 'Cancelar' });
  const p = await proximo(c); const m = await perguntar(c, p);
  const rot = m.opcoes.itens.map((i) => i.rotulo);
  return { ok: p === 'assunto_qual' && rot.length === 3 && /Ressonancia Do Joelho \(direito\) — 10\/11\/2026/.test(rot[0]) && rot[2] === 'Não é nenhum destes' && /cancelar/.test(m.texto), detalhe: JSON.stringify(rot) };
});

await caso('Cancelar: escolher o horário pede o "sim"; "sim" entrega o pedido pronto (qual exame e dia) e transfere', async () => {
  const c = await nova({ assunto: 'Cancelar' });
  const r1 = await aplicar(c, 'assunto_qual', 'i1');
  const p = await proximo(c); const m = await perguntar(c, p);
  const r2 = await aplicar(c, 'assunto_confirma', 'sim');
  const d = await dados(c);
  return { ok: r1.ok === true && p === 'assunto_confirma' && /Ultrassom \(ambos\) de 20\/11\/2026/.test(m.texto) && r2.transferir === true && /^Cancelar Ultrassom \(ambos\) de 20\/11\/2026$/.test(d.assunto_texto),
           detalhe: `${m.texto} | texto=${d.assunto_texto}` };
});

await caso('Cancelar: "não, voltar" cai no texto livre sem transferir', async () => {
  const c = await nova({ assunto: 'Cancelar' });
  await aplicar(c, 'assunto_qual', 'i0'); const r = await aplicar(c, 'assunto_confirma', 'nao');
  return { ok: r.ok === true && !r.transferir && (await proximo(c)) === 'assunto_texto', detalhe: `próximo=${await proximo(c)}` };
});

await caso('Cancelar: "Não é nenhum destes" vai para o texto livre', async () => {
  const c = await nova({ assunto: 'Cancelar' });
  await aplicar(c, 'assunto_qual', 'nenhum');
  return { ok: (await proximo(c)) === 'assunto_texto', detalhe: '' };
});

await caso('valor inventado ou fora da lista é recusado', async () => {
  const c = await nova({ assunto: 'Cancelar' });
  const a = await aplicar(c, 'assunto_qual', 'i7'); const b = await aplicar(c, 'assunto_qual', 'qualquer coisa'); const e = await aplicar(c, 'assunto_confirma', 'talvez');
  return { ok: a.ok === false && b.ok === false && e.ok === false, detalhe: '' };
});

await caso('Remarcar o horário mais recente: copia o exame, deixa a pergunta do convênio e segue pelo fluxo normal (sem transferir)', async () => {
  const c = await nova({ assunto: 'Remarcar' });
  const r = await aplicar(c, 'assunto_qual', 'i0');
  const d = await dados(c);
  return { ok: r.ok === true && !r.transferir && /novo horário/.test(r.aviso) && d.motivo === 'exame' && d.plano_anterior === 'UNIMED' && /REMARCAÇÃO de .*10\/11\/2026/.test((d.notas || [])[0] || '') && (await proximo(c)) === 'plano_confirma',
           detalhe: `próximo=${await proximo(c)} notas=${JSON.stringify(d.notas)}` };
});

await caso('Remarcar outro horário da lista (não o mais recente): vai para a equipe dizendo qual', async () => {
  const c = await nova({ assunto: 'Remarcar' });
  const r = await aplicar(c, 'assunto_qual', 'i1'); const d = await dados(c);
  return { ok: r.transferir === true && d.assunto_texto === 'Remarcar Ultrassom (ambos) de 20/11/2026', detalhe: d.assunto_texto };
});

await caso('Remarcar: se o exame não puder ser copiado, vai para a equipe (não trava)', async () => {
  await cfg('reaproveita', 'false');
  const c = await nova({ assunto: 'Remarcar' });
  const r = await aplicar(c, 'assunto_qual', 'i0');
  await cfg('reaproveita', 'true');
  return { ok: r.transferir === true, detalhe: JSON.stringify(r) };
});

await caso('sem exame marcado para o futuro: Remarcar e Cancelar seguem para o texto livre', async () => {
  await cfg('ultimas', JSON.stringify([passado]));
  const a = await nova({ assunto: 'Remarcar' }); const b = await nova({ assunto: 'Cancelar' });
  const ok = (await proximo(a)) === 'assunto_texto' && (await proximo(b)) === 'assunto_texto';
  await cfg('ultimas', JSON.stringify([futuro('10/11/2026'), futuro('20/11/2026', 'US', 'ambos'), passado]));
  return { ok, detalhe: '' };
});

await caso('paciente não identificado (data de nascimento não conferida): nada é listado', async () => {
  await cfg('liberado', 'false');
  const c = await nova({ assunto: 'Cancelar' });
  const ok = (await proximo(c)) === 'assunto_texto';
  await cfg('liberado', 'true');
  return { ok, detalhe: '' };
});

const textoPadrao = (await db.query(`select texto from public.fluxo_texto where chave = 'resultado_orientacao'`)).rows[0].texto;
await caso('Resultado de exame com o texto VAZIO (esvaziado pela clínica): continua indo para a equipe', async () => {
  await db.query(`update public.fluxo_texto set texto = '' where chave = 'resultado_orientacao'`);
  const c = await nova({ assunto: 'Resultado de exame' });
  return { ok: (await proximo(c)) === 'assunto_texto', detalhe: '' };
});

await caso('Resultado de exame com o texto padrão: mostra os dois portais e dois botões', async () => {
  await db.query(`update public.fluxo_texto set texto = $1 where chave = 'resultado_orientacao'`, [textoPadrao]);
  const c = await nova({ assunto: 'Resultado de exame' });
  const p = await proximo(c); const m = await perguntar(c, p);
  return { ok: p === 'assunto_resultado' && /mezzow\.com/.test(m.texto) && /klingo\.app/.test(m.texto) && m.opcoes.itens.map((i) => i.valor).join() === 'resolvido,atendente', detalhe: m.texto };
});

await caso('Resultado: "Resolveu, obrigado" encerra com agradecimento e botão de novo pedido', async () => {
  const c = await nova({ assunto: 'Resultado de exame' });
  const r = await aplicar(c, 'assunto_resultado', 'resolvido');
  const p = await proximo(c); const m = await perguntar(c, p);
  return { ok: r.ok === true && !r.transferir && p === 'assunto_fim' && /Que bom/.test(m.texto) && m.opcoes.tipo === 'nova', detalhe: p };
});

await caso('Resultado: "Preciso de um atendente" segue para o texto livre', async () => {
  const c = await nova({ assunto: 'Resultado de exame' });
  await aplicar(c, 'assunto_resultado', 'atendente');
  return { ok: (await proximo(c)) === 'assunto_texto', detalhe: '' };
});

await caso('digitar: "sim"/"não" no cancelamento e "resolveu"/"não" no resultado', async () => {
  const a = await ler(null, 'assunto_confirma', 'sim'); const b = await ler(null, 'assunto_confirma', 'não, deixa');
  const c = await ler(null, 'assunto_resultado', 'resolveu, obrigada'); const d = await ler(null, 'assunto_resultado', 'não consegui');
  return { ok: a === 'sim' && b === 'nao' && c === 'resolvido' && d === 'atendente', detalhe: [a, b, c, d].join(',') };
});

await caso('Dúvida, Reclamação e Outro continuam indo para a equipe', async () => {
  const out = [];
  for (const a of ['Dúvida', 'Reclamação', 'Outro']) out.push(await proximo(await nova({ assunto: a })));
  return { ok: out.every((x) => x === 'assunto_texto'), detalhe: out.join() };
});

await caso('o texto novo de "assunto" ainda pergunta primeiro "Sobre o que é?"', async () => {
  const c = await nova({ assunto: null });
  return { ok: (await proximo(c)) === 'assunto', detalhe: '' };
});

await caso('depois de "Resolveu", escrever de novo reabre para a equipe (como o pedido pronto)', async () => {
  const def = (await db.query(`select pg_get_functiondef('public.fluxo_avancar(uuid,jsonb)'::regprocedure) d`)).rows[0].d;
  return { ok: /v_passo in \('pronto', 'humano', 'assunto_fim'\)/.test(def), detalhe: '' };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
