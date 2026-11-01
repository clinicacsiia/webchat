// FLUXOGRAMA: entrada (as funções REAIS de supabase/pacientes.sql e do motor em supabase/fase7-motor.sql, mais os arquivos que o remendam, mais supabase/pessoa-unica.sql e pessoa-unica-jornada.sql, num Postgres embutido) -> validação (aplica os arquivos duas vezes; recusa função diferente do esperado; só a equipe usa as funções novas) -> lógica (agrupar com 3 informações, sugerir com 2, recusar contradição, separar; exame em aberto trava o encerramento até alguém fechar; falta vira remarcação pelo chat; cartão do Klingo só se junta com 3 informações) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const lerSql = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
const fase7 = lerSql('fase7-motor.sql');
const convenio = lerSql('correcao-convenio-quem-volta.sql');
const assuntos = lerSql('assuntos-resolvidos.sql');
const remarcar = lerSql('remarcar-qualquer-horario.sql');
const pessoa = lerSql('pessoa-unica.sql');
const pessoaJornada = lerSql('pessoa-unica-jornada.sql');
const seed = fase7.match(/insert into public\.fluxo_texto \(chave, texto, descricao\) values[\s\S]*?on conflict \(chave\) do nothing;/)[0];

const ATENDENTE = '11111111-1111-4111-8111-111111111111';
const MARKETING = '22222222-2222-4222-8222-222222222222';
const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('teste.uid', true), '')::uuid $$;
  create schema extensions;
  create function extensions.unaccent(t text) returns text language sql immutable as $$
    select translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN') $$;
  create table public.agentes (id uuid primary key, nome text, papel text, ativo boolean default true, visto_em timestamptz);
  insert into public.agentes values ('${ATENDENTE}', 'Atendente Teste', 'atendente', true, null), ('${MARKETING}', 'Marketing Teste', 'marketing', true, null);
  create function public.papel_atual() returns text language sql stable security definer as $$ select papel from public.agentes where id = auth.uid() and ativo $$;
  create table public.config (chave text primary key, valor text not null default '');
  create table public.contatos (id uuid primary key default gen_random_uuid(), nome text not null, telefone text not null, email text);
  create table public.conversas (
    id uuid primary key default gen_random_uuid(), contato_id uuid not null references public.contatos(id) on delete cascade,
    status text not null default 'aguardando', agente_id uuid, ultima_mensagem text, nao_lidas_agente int not null default 0,
    criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(), encerrada_em timestamptz,
    ia_ativa boolean not null default true, triagem_resumo text, triagem_urgencia text, alerta_agenda text,
    nome_informado text, email_informado text, unidade_inicial text, medico_preferido text, paciente_tipo text, paciente_nome text,
    irmaos jsonb, irmaos_modo text, irmao_de uuid, motor text not null default 'fluxo', conta_id uuid);
  create table public.conversa_fluxo (conversa_id uuid primary key references public.conversas(id) on delete cascade, passo text, tentativas int not null default 0,
    dados jsonb not null default '{}'::jsonb, iniciado_em timestamptz not null default now(), atualizado_em timestamptz not null default now());
  create table public.fluxo_evento (id bigint generated always as identity primary key, conversa_id uuid, passo text, entrada text, entendido boolean, ms numeric, ms_cliente int);
  create table public.fluxo_texto (chave text primary key, texto text not null, descricao text);
  ${seed}
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid references public.conversas(id) on delete cascade, autor text, texto text, opcoes jsonb, criado_em timestamptz default now());
  create table public.pre_agendamentos (id uuid primary key default gen_random_uuid(), conversa_id uuid not null unique references public.conversas(id) on delete cascade,
    tipo text, procedimento text, plano text, unidade text, profissional text, paciente jsonb not null default '{}'::jsonb,
    status text not null default 'rascunho', paciente_id uuid, identidade text, etapa text, data_desejada text, hora_desejada text, escolha_horario jsonb,
    criado_em timestamptz default now(), atualizado_em timestamptz default now());
  create table public.pre_agendamento_itens (id bigint generated always as identity primary key, conversa_id uuid not null references public.conversas(id) on delete cascade,
    modalidade text, regiao text, regiao_nome text, lado text, procedimento_id int, procedimento text, quantidade int not null default 1, ativo boolean not null default true);
  -- Stubs do que está fora do assunto
  create function public.paciente_conferir(p uuid) returns jsonb language sql as $$ select jsonb_build_object('situacao', 'novo') $$;
  create function public.paciente_historico_para_ia(p uuid) returns jsonb language sql as $$ select jsonb_build_object('liberado', false, 'ultimas', '[]'::jsonb) $$;
  create table public.paciente_historico (id bigint generated always as identity primary key, paciente_id uuid, exames jsonb, cancelado boolean default false, ocorreu_em timestamp, criado_em timestamptz default now(), plano text, unidade text, profissional text);
  create function public.pre_pendencia_anterior(p uuid) returns uuid language sql as $$ select null::uuid $$;
  create table public.catalogo_plano (operadora text, ativo boolean default true);
  insert into public.catalogo_plano values ('UNIMED'), ('BRADESCO');
  create function public.fluxo_procs(p uuid) returns integer[] language sql as $$ select null::integer[] $$;
  create function public.agenda_grupos(p integer[]) returns jsonb language sql as $$ select '[]'::jsonb $$;
  create function public.fluxo_medicos(p uuid) returns text[] language sql as $$ select null::text[] $$;
  create function public.fluxo_rotulo_item(p_conversa uuid, p_proc integer, p_nome text, p_mod text) returns text language sql as $$ select coalesce(initcap(lower(p_nome)), p_mod) $$;
  create function public.fluxo_pre(p_conversa uuid, p_dados jsonb, p_pronto boolean default false) returns jsonb language plpgsql as $$
  begin
    update public.pre_agendamentos set plano = coalesce(nullif(p_dados ->> 'plano', ''), plano), etapa = coalesce(p_dados ->> 'etapa', etapa) where conversa_id = p_conversa;
    return '{}'::jsonb;
  end $$;
  ${funcao('fase4-paciente-que-volta.sql', 'pre_reaproveitar')}
  ${['norm_nome', 'fone_chave', 'data_ou_nula', 'nome_confere'].map((n) => funcao('pacientes.sql', n)).join('\n')}
  ${['fluxo_t', 'fluxo_norm', 'fluxo_ler_data', 'fluxo_equipe_online', 'fluxo_ctx', 'fluxo_dizer', 'fluxo_escolha', 'fluxo_set', 'fluxo_nota', 'fluxo_resumo', 'fluxo_transferir',
      'fluxo_proximo', 'fluxo_perguntar', 'fluxo_aplicar', 'fluxo_ler_texto', 'fluxo_avancar'].map((n) => funcao('fase7-motor.sql', n)).join('\n')}
`);
await db.exec(convenio); await db.exec(assuntos); await db.exec(remarcar);

const como = async (uid) => { await db.query(`select set_config('teste.uid', $1, false)`, [uid || '']); };
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const um = async (sql, args = []) => (await q(sql, args))[0];

await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => {
  await db.exec(pessoa); await db.exec(pessoa);
  return { ok: true, detalhe: 'duas aplicações seguidas' };
});

await caso('recusa mexer numa função diferente do esperado (nada é alterado)', async () => {
  await db.exec(`create or replace function public.fluxo_proximo(p_conversa uuid) returns text language sql as $$ select 'x'::text $$`);
  await db.exec(`drop function public.fluxo_proximo(uuid)`);
  await db.exec(`create function public.fluxo_proximo(p_conversa uuid) returns text language sql as $$ select 'x'::text $$`);
  let erro = '';
  try { await db.exec(pessoa); } catch (e) { erro = e.message; }
  await db.exec(`drop function public.fluxo_proximo(uuid)`);
  await db.exec(funcao('fase7-motor.sql', 'fluxo_proximo')); await db.exec(convenio); await db.exec(assuntos); await db.exec(pessoa);
  const def = (await um(`select pg_get_functiondef('public.fluxo_proximo(uuid)'::regprocedure) d`)).d;
  return { ok: /nada foi alterado/.test(erro) && /pos_passo/.test(def), detalhe: erro.split('\n')[0] };
});

// ---------------------------------------------------------------- criação de dados
let seq = 0;
const contato = async (nome, tel, email = null) => (await um(`insert into public.contatos (nome, telefone, email) values ($1, $2, $3) returning id`, [nome, tel, email])).id;
const conversa = async ({ nome, tel = '71988887777', email = null, nasc = null, tipo = null, pacienteNome = null, conta = null, motor = 'fluxo', contatoId = null, minutos = 0 }) => {
  const ct = contatoId || await contato(nome, tel, null);
  const id = (await um(`insert into public.conversas (contato_id, nome_informado, email_informado, paciente_tipo, paciente_nome, conta_id, motor, atualizado_em)
    values ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8)) returning id`, [ct, nome, email, tipo, pacienteNome, conta, motor, minutos])).id;
  if (nasc) await db.query(`insert into public.pre_agendamentos (conversa_id, paciente) values ($1, $2::jsonb) on conflict (conversa_id) do update set paciente = excluded.paciente`, [id, JSON.stringify({ dt_nasc: nasc })]);
  seq++;
  return id;
};
const grupo = async (id) => (await um(`select grupo_id, origem, sinais, confirmado_por from public.conversa_grupo where conversa_id = $1`, [id]));
const juntas = async (a, b) => { const ga = await grupo(a), gb = await grupo(b); return !!ga && !!gb && ga.grupo_id === gb.grupo_id; };

// ---------------------------------------------------------------- 1. agrupar
await caso('mesma pessoa com nome + telefone + e-mail iguais: juntas sozinhas (3 informações)', async () => {
  const a = await conversa({ nome: 'Maria Souza', tel: '71911112222', email: 'maria@x.com' });
  const b = await conversa({ nome: 'maria  souza', tel: '71911112222', email: 'MARIA@x.com' });
  const g = await grupo(b);
  return { ok: await juntas(a, b) && g.origem === 'auto' && g.sinais.includes('nome') && g.sinais.includes('telefone') && g.sinais.includes('email'), detalhe: JSON.stringify(g) };
});

await caso('só nome + telefone (2 informações): NÃO junta; vira sugestão para a equipe', async () => {
  const a = await conversa({ nome: 'Carla Nunes', tel: '71922223333' });
  const b = await conversa({ nome: 'Carla Nunes', tel: '71922223333' });
  await como(ATENDENTE);
  const sug = (await um(`select public.pessoa_sugestoes() r`)).r;
  const par = sug.find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  await como('');
  return { ok: !(await juntas(a, b)) && !!par && par.total === 2 && par.sinais.join() === 'nome,telefone', detalhe: JSON.stringify(par) };
});

await caso('a equipe confirma a sugestão (é a terceira informação): junta e registra quem confirmou', async () => {
  const [a, b] = (await q(`select id from public.conversas where nome_informado = 'Carla Nunes' order by criado_em, id`)).map((r) => r.id);
  await como(ATENDENTE);
  const r = (await um(`select public.pessoa_confirmar($1, $2) r`, [a, b])).r;
  await como('');
  const g = await grupo(a);
  return { ok: r.ok === true && await juntas(a, b) && g.origem === 'equipe' && g.confirmado_por === ATENDENTE, detalhe: JSON.stringify(g) };
});

await caso('telefones diferentes, mas nome + e-mail + nascimento iguais: junta (3 informações, sem o telefone)', async () => {
  const a = await conversa({ nome: 'Pedro Alves Lima', tel: '71933334444', email: 'pedro@x.com', nasc: '1980-05-10' });
  const b = await conversa({ nome: 'Pedro Alves Lima', tel: '71955556666', email: 'pedro@x.com', nasc: '1980-05-10' });
  return { ok: await juntas(a, b), detalhe: JSON.stringify(await grupo(b)) };
});

await caso('nome + telefone + e-mail iguais, mas nascimentos DIFERENTES: não junta e a equipe também não consegue forçar', async () => {
  const a = await conversa({ nome: 'Joana Reis', tel: '71944445555', email: 'joana@x.com', nasc: '1990-01-01' });
  const b = await conversa({ nome: 'Joana Reis', tel: '71944445555', email: 'joana@x.com', nasc: '1991-02-02' });
  await como(ATENDENTE);
  let erro = ''; try { await db.query(`select public.pessoa_confirmar($1, $2)`, [a, b]); } catch (e) { erro = e.message; }
  await como('');
  return { ok: !(await juntas(a, b)) && /contradizem/.test(erro), detalhe: erro };
});

await caso('responsável e filho (mesmo telefone e e-mail) NÃO se juntam: o nome comparado é o do paciente', async () => {
  const mae = await conversa({ nome: 'Lúcia Prado', tel: '71966667777', email: 'lucia@x.com' });
  const filho = await conversa({ nome: 'Lúcia Prado', tel: '71966667777', email: 'lucia@x.com', tipo: 'filho', pacienteNome: 'Davi Prado' });
  const filho2 = await conversa({ nome: 'Lúcia Prado', tel: '71966667777', email: 'lucia@x.com', tipo: 'filho', pacienteNome: 'Davi Prado' });
  return { ok: !(await juntas(mae, filho)) && await juntas(filho, filho2), detalhe: 'mãe separada; as duas conversas do Davi juntas' };
});

await caso('nomes diferentes no mesmo telefone e e-mail (família) não se juntam', async () => {
  const a = await conversa({ nome: 'Rui Matos', tel: '71977778888', email: 'familia@x.com' });
  const b = await conversa({ nome: 'Rita Matos', tel: '71977778888', email: 'familia@x.com' });
  return { ok: !(await juntas(a, b)), detalhe: '' };
});

await caso('o e-mail chega depois: o gatilho junta quando a terceira informação aparece', async () => {
  const a = await conversa({ nome: 'Sônia Cruz', tel: '71988889999', email: 'sonia@x.com' });
  const b = await conversa({ nome: 'Sônia Cruz', tel: '71988889999' });
  const antes = await juntas(a, b);
  await db.query(`update public.conversas set email_informado = 'sonia@x.com' where id = $1`, [b]);
  return { ok: !antes && await juntas(a, b), detalhe: '' };
});

await caso('a data de nascimento chega depois (no pré-agendamento): o gatilho junta', async () => {
  const a = await conversa({ nome: 'Ivo Lopes', tel: '71900001111', nasc: '1970-03-03' });
  const b = await conversa({ nome: 'Ivo Lopes', tel: '71900001111' });
  const antes = await juntas(a, b);
  await db.query(`insert into public.pre_agendamentos (conversa_id, paciente) values ($1, '{"dt_nasc":"1970-03-03"}'::jsonb)`, [b]);
  return { ok: !antes && await juntas(a, b), detalhe: '' };
});

await caso('terceira conversa entra no grupo que já existe', async () => {
  const a = await conversa({ nome: 'Nina Bastos', tel: '71900002222', email: 'nina@x.com' });
  const b = await conversa({ nome: 'Nina Bastos', tel: '71900002222', email: 'nina@x.com' });
  const c = await conversa({ nome: 'Nina Bastos', tel: '71900002222', email: 'nina@x.com' });
  const n = (await um(`select count(distinct grupo_id)::int n, count(*)::int t from public.conversa_grupo where conversa_id = any($1)`, [[a, b, c]]));
  return { ok: n.n === 1 && n.t === 3, detalhe: JSON.stringify(n) };
});

await caso('quem contradiz um membro do grupo não entra, mesmo batendo com os outros', async () => {
  const a = await conversa({ nome: 'Otávio Dias', tel: '71900003333', email: 'ot@x.com', nasc: '1985-07-07' });
  const b = await conversa({ nome: 'Otávio Dias', tel: '71900003333', email: 'ot@x.com' });
  const c = await conversa({ nome: 'Otávio Dias', tel: '71900003333', email: 'ot@x.com', nasc: '1999-09-09' });
  return { ok: await juntas(a, b) && !(await juntas(a, c)) && !(await juntas(b, c)), detalhe: '' };
});

await caso('separar tira UMA conversa, a equipe é a única que pode, e o robô não junta de novo', async () => {
  const a = await conversa({ nome: 'Paulo Vaz', tel: '71900004444', email: 'paulo@x.com' });
  const b = await conversa({ nome: 'Paulo Vaz', tel: '71900004444', email: 'paulo@x.com' });
  await como(MARKETING);
  let negado = ''; try { await db.query(`select public.pessoa_separar($1)`, [b]); } catch (e) { negado = e.message; }
  await como(ATENDENTE);
  await db.query(`select public.pessoa_separar($1)`, [b]);
  await como('');
  await db.query(`select public.pessoa_agrupar_pendentes()`); await db.query(`select public.pessoa_agrupar($1)`, [b]);
  const resto = await grupo(a);
  return { ok: /Só administrador e atendente/.test(negado) && !(await juntas(a, b)) && !resto, detalhe: `negado="${negado.split('\n')[0]}" grupo restante=${JSON.stringify(resto)}` };
});

await caso('recusar uma sugestão a tira da lista e o robô respeita', async () => {
  const a = await conversa({ nome: 'Elisa Moura', tel: '71900005555' });
  const b = await conversa({ nome: 'Elisa Moura', tel: '71900005555' });
  await como(ATENDENTE);
  await db.query(`select public.pessoa_recusar($1, $2)`, [a, b]);
  const sug = (await um(`select public.pessoa_sugestoes() r`)).r;
  await como('');
  return { ok: !sug.some((x) => [x.a, x.b].includes(a)), detalhe: '' };
});

await caso('anônimo e marketing não leem sugestões nem confirmam', async () => {
  const res = [];
  for (const uid of ['', MARKETING]) {
    await como(uid);
    for (const sql of [`select public.pessoa_sugestoes()`, `select public.pessoa_confirmar(gen_random_uuid(), gen_random_uuid())`, `select public.agendamento_fechar(gen_random_uuid(), 'compareceu')`]) {
      try { await db.query(sql); res.push('passou'); } catch (e) { res.push(/Só administrador e atendente/.test(e.message) ? 'negado' : e.message); }
    }
  }
  await como('');
  return { ok: res.every((x) => x === 'negado'), detalhe: res.join() };
});

await caso('um erro na rotina de agrupar NUNCA atrapalha o chat (a conversa é criada mesmo assim)', async () => {
  await db.exec(`alter function public.pessoa_ficha(uuid) rename to pessoa_ficha_ok; create function public.pessoa_ficha(uuid) returns jsonb language plpgsql as $$ begin raise exception 'quebrou'; end $$;`);
  let erro = '', id = null;
  try { id = await conversa({ nome: 'Teste Falha', tel: '71900006666' }); } catch (e) { erro = e.message; }
  await db.exec(`drop function public.pessoa_ficha(uuid); alter function public.pessoa_ficha_ok(uuid) rename to pessoa_ficha;`);
  return { ok: !erro && !!id, detalhe: erro };
});

await caso('as conversas do grupo vêm da mais recente para a mais antiga', async () => {
  const a = await conversa({ nome: 'Vera Lins', tel: '71900007777', email: 'vera@x.com', minutos: 60 });
  const b = await conversa({ nome: 'Vera Lins', tel: '71900007777', email: 'vera@x.com', minutos: 5 });
  const c = await conversa({ nome: 'Vera Lins', tel: '71900007777', email: 'vera@x.com', minutos: 30 });
  const m = (await um(`select public.pessoa_membros($1) r`, [a])).r;
  return { ok: m.join() === [b, c, a].join(), detalhe: '' };
});

// ---------------------------------------------------------------- 2. exame em aberto
const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const marcado = async (conv, data, hora = '09:00') => {
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento) values ($1, 'RM', 'JOELHO', 'Joelho', 'D', 10, 'RESSONANCIA DO JOELHO')`, [conv]);
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, plano, unidade, status, escolha_horario, identidade, paciente)
    values ($1, 'exame', 'RESSONANCIA DO JOELHO', 'UNIMED', 'CSI', 'agendado', $2::jsonb, 'nova', '{"nome":"X","dt_nasc":"1980-01-01"}'::jsonb)
    on conflict (conversa_id) do update set status = 'agendado', plano = 'UNIMED', unidade = 'CSI', escolha_horario = excluded.escolha_horario, tipo = 'exame'`, [conv, JSON.stringify([{ grupo: 1, data, hora, unidade: 'CSI' }])]);
};
const abertos = async (conv) => q(`select * from public.v_agendamento_aberto where conversa_id = $1`, [conv]);

await caso('exame marcado sem desfecho aparece EM ABERTO; "passou" só quando o horário ficou para trás', async () => {
  const a = await conversa({ nome: 'Exame Futuro', tel: '71911000001' }); await marcado(a, amanha);
  const b = await conversa({ nome: 'Exame Passado', tel: '71911000002' }); await marcado(b, ontem);
  const fa = (await abertos(a))[0], fb = (await abertos(b))[0];
  return { ok: fa && fb && fa.passou === false && fb.passou === true && /RESSONANCIA/.test(fb.exames), detalhe: `futuro.passou=${fa && fa.passou} passado.passou=${fb && fb.passou}` };
});

await caso('encerrar com exame em aberto é recusado para o painel; o sistema (sem login) não é barrado', async () => {
  const a = await conversa({ nome: 'Trava Um', tel: '71911000003' }); await marcado(a, amanha);
  await como(ATENDENTE);
  let erro = ''; try { await db.query(`update public.conversas set status = 'encerrada' where id = $1`, [a]); } catch (e) { erro = e.message; }
  await como('');
  const ainda = (await um(`select status from public.conversas where id = $1`, [a])).status;
  await db.query(`update public.conversas set status = 'encerrada' where id = $1`, [a]);
  const depois = (await um(`select status from public.conversas where id = $1`, [a])).status;
  await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [a]);
  return { ok: /EXAME_EM_ABERTO/.test(erro) && ainda === 'aguardando' && depois === 'encerrada', detalhe: erro.split('\n')[0] };
});

await caso('o exame em aberto numa conversa do grupo também trava as outras conversas da mesma pessoa', async () => {
  const a = await conversa({ nome: 'Grupo Trava', tel: '71911000004', email: 'g@x.com' }); await marcado(a, amanha);
  const b = await conversa({ nome: 'Grupo Trava', tel: '71911000004', email: 'g@x.com' });
  await como(ATENDENTE);
  let erro = ''; try { await db.query(`update public.conversas set status = 'encerrada' where id = $1`, [b]); } catch (e) { erro = e.message; }
  await como('');
  return { ok: await juntas(a, b) && /EXAME_EM_ABERTO/.test(erro), detalhe: erro.split('\n')[0] };
});

await caso('a equipe fecha como "compareceu": sai da lista de abertos e o encerramento é liberado; fechar duas vezes é recusado', async () => {
  const a = await conversa({ nome: 'Fecha Compareceu', tel: '71911000005' }); await marcado(a, ontem);
  await como(ATENDENTE);
  await db.query(`select public.agendamento_fechar($1, 'compareceu')`, [a]);
  let dobro = ''; try { await db.query(`select public.agendamento_fechar($1, 'compareceu')`, [a]); } catch (e) { dobro = e.message; }
  await db.query(`update public.conversas set status = 'encerrada' where id = $1`, [a]);
  await como('');
  const f = await um(`select desfecho, origem, por, remarcacao from public.agendamento_fechamento where conversa_id = $1`, [a]);
  return { ok: (await abertos(a)).length === 0 && f.desfecho === 'compareceu' && f.origem === 'equipe' && f.por === ATENDENTE && f.remarcacao === null && /Não há exame em aberto/.test(dobro), detalhe: JSON.stringify(f) };
});

await caso('desfecho inventado é recusado', async () => {
  const a = await conversa({ nome: 'Fecha Errado', tel: '71911000006' }); await marcado(a, ontem);
  await como(ATENDENTE);
  let erro = ''; try { await db.query(`select public.agendamento_fechar($1, 'sumiu')`, [a]); } catch (e) { erro = e.message; }
  await como('');
  return { ok: /inválido|check/i.test(erro) && (await abertos(a)).length === 1, detalhe: erro.split('\n')[0] };
});

await caso('falta: vira remarcação pendente; a equipe resolve como "feita"; resolver duas vezes é recusado', async () => {
  const a = await conversa({ nome: 'Faltou Um', tel: '71911000007' }); await marcado(a, ontem);
  await como(ATENDENTE);
  await db.query(`select public.agendamento_fechar($1, 'faltou')`, [a]);
  const pend = await um(`select * from public.v_remarcacao_pendente where conversa_id = $1`, [a]);
  await db.query(`select public.agendamento_remarcacao_resolver($1, 'feita')`, [pend.fechamento_id]);
  let dobro = ''; try { await db.query(`select public.agendamento_remarcacao_resolver($1, 'feita')`, [pend.fechamento_id]); } catch (e) { dobro = e.message; }
  await como('');
  const depois = await q(`select * from public.v_remarcacao_pendente where conversa_id = $1`, [a]);
  return { ok: pend.remarcacao === 'pendente' && depois.length === 0 && /já foi resolvida/.test(dobro), detalhe: JSON.stringify(pend) };
});

// ---------------------------------------------------------------- 3. perguntar ao paciente pelo chat
const ultima = async (id) => um(`select autor, texto, opcoes from public.mensagens where conversa_id = $1 order by id desc limit 1`, [id]);
const fluxo = async (id) => um(`select passo, dados from public.conversa_fluxo where conversa_id = $1`, [id]);
const conv = async (id) => um(`select status, ia_ativa, agente_id, triagem_resumo from public.conversas where id = $1`, [id]);
const botao = async (id, passo, valor) => db.query(`select public.fluxo_avancar($1, $2::jsonb)`, [id, JSON.stringify({ passo, valor })]);
const digitar = async (id, texto) => db.query(`select public.fluxo_avancar($1, $2::jsonb)`, [id, JSON.stringify({ texto })]);
const mensagens = async (id) => (await q(`select texto from public.mensagens where conversa_id = $1 order by id`, [id])).map((r) => r.texto);

await caso('"Perguntar ao paciente": a pergunta com 4 botões vai para a conversa MAIS RECENTE do grupo e devolve o controle ao assistente', async () => {
  const velha = await conversa({ nome: 'Pergunta Um', tel: '71922000001', email: 'p1@x.com', minutos: 120 }); await marcado(velha, ontem);
  const nova = await conversa({ nome: 'Pergunta Um', tel: '71922000001', email: 'p1@x.com', minutos: 1 });
  await db.query(`update public.conversas set status = 'em_atendimento', agente_id = $2, ia_ativa = false where id = $1`, [nova, ATENDENTE]);
  await como(ATENDENTE);
  const r = (await um(`select public.agendamento_perguntar($1, 'fechar') r`, [velha])).r;
  await como('');
  const m = await ultima(nova), c = await conv(nova), f = await fluxo(nova);
  return { ok: r.canal === 'botoes' && r.conversa_id === nova && m.opcoes.passo === 'exame_aberto' && m.opcoes.itens.map((i) => i.valor).join() === 'compareceu,faltei,cancelar,remarcar'
           && /Pergunta/.test(m.texto) && /Ressonancia Do Joelho|RESSONANCIA/i.test(m.texto) && c.status === 'aguardando' && c.ia_ativa === true && c.agente_id === null && f.passo === 'exame_aberto' && !(await ultima(velha)),
           detalhe: JSON.stringify({ r, texto: m.texto }) };
});

await caso('paciente toca "Fui e fiz o exame": exame fechado pelo paciente, agradece e avisa a equipe', async () => {
  const a = await conversa({ nome: 'Compareceu Chat', tel: '71922000002' }); await marcado(a, ontem);
  await como(ATENDENTE); await db.query(`select public.agendamento_perguntar($1, 'fechar')`, [a]); await como('');
  await botao(a, 'exame_aberto', 'compareceu');
  const f = await um(`select desfecho, origem from public.agendamento_fechamento where conversa_id = $1`, [a]);
  const c = await conv(a), msgs = await mensagens(a);
  return { ok: f.desfecho === 'compareceu' && f.origem === 'paciente' && (await abertos(a)).length === 0 && msgs.some((t) => /Obrigado por avisar/.test(t)) && c.ia_ativa === false && /COMPARECEU/.test(c.triagem_resumo || ''),
           detalhe: JSON.stringify({ f, resumo: c.triagem_resumo }) };
});

await caso('paciente toca "Quero cancelar": fecha como cancelou e entrega à equipe o pedido pronto', async () => {
  const a = await conversa({ nome: 'Cancela Chat', tel: '71922000003' }); await marcado(a, amanha);
  await como(ATENDENTE); await db.query(`select public.agendamento_perguntar($1, 'fechar')`, [a]); await como('');
  await botao(a, 'exame_aberto', 'cancelar');
  const f = await um(`select desfecho, origem from public.agendamento_fechamento where conversa_id = $1`, [a]);
  const c = await conv(a);
  return { ok: f.desfecho === 'cancelou' && f.origem === 'paciente' && c.ia_ativa === false && /CANCELAR/.test(c.triagem_resumo || ''), detalhe: c.triagem_resumo };
});

await caso('falta pelo chat: "Não consegui ir" fecha como faltou e já oferece remarcar; "Sim" COPIA o pedido e segue pelo roteiro normal', async () => {
  const a = await conversa({ nome: 'Faltei Chat', tel: '71922000004', email: 'f4@x.com', minutos: 100 }); await marcado(a, ontem);
  const dest = await conversa({ nome: 'Faltei Chat', tel: '71922000004', email: 'f4@x.com', minutos: 1 });
  await como(ATENDENTE); await db.query(`select public.agendamento_perguntar($1, 'fechar')`, [a]); await como('');
  await botao(dest, 'exame_aberto', 'faltei');
  const f1 = await um(`select desfecho, origem, remarcacao from public.agendamento_fechamento where conversa_id = $1`, [a]);
  const m1 = await ultima(dest), p1 = (await fluxo(dest)).passo;
  await botao(dest, 'remarcar_falta', 'sim');
  const f2 = await um(`select remarcacao, remarcacao_conversa from public.agendamento_fechamento where conversa_id = $1`, [a]);
  const itens = await q(`select procedimento_id, lado from public.pre_agendamento_itens where conversa_id = $1 and ativo`, [dest]);
  const pre = await um(`select status, plano, escolha_horario from public.pre_agendamentos where conversa_id = $1`, [dest]);
  const fl = await fluxo(dest);
  const msgs = await mensagens(dest);
  return { ok: f1.desfecho === 'faltou' && f1.origem === 'paciente' && f1.remarcacao === 'pendente' && /remarcar agora/.test(m1.texto) && p1 === 'remarcar_falta'
           && f2.remarcacao === 'aceita' && f2.remarcacao_conversa === dest && itens.length === 1 && itens[0].procedimento_id === 10 && pre.status === 'rascunho' && pre.plano === 'UNIMED' && pre.escolha_horario === null
           && fl.passo !== 'remarcar_falta' && fl.passo !== 'motivo' && fl.passo !== 'exame' && msgs.some((t) => /mesmo pedido/.test(t)),
           detalhe: JSON.stringify({ f1, f2, passo: fl.passo, itens: itens.length }) };
});

await caso('quando o novo pré-agendamento vira "agendado", a remarcação aceita no chat fica FEITA sozinha', async () => {
  const dest = (await um(`select conversa_id from public.agendamento_fechamento where remarcacao = 'aceita' limit 1`)).conversa_id;
  const destino = (await um(`select remarcacao_conversa r from public.agendamento_fechamento where remarcacao = 'aceita' limit 1`)).r;
  await db.query(`update public.pre_agendamentos set status = 'agendado' where conversa_id = $1`, [destino]);
  const f = await um(`select remarcacao from public.agendamento_fechamento where conversa_id = $1`, [dest]);
  return { ok: f.remarcacao === 'feita', detalhe: f.remarcacao };
});

await caso('"Quero remarcar para outro dia" (antes da data): fecha como remarcou e vai direto para o novo horário, sem perguntar de novo', async () => {
  const a = await conversa({ nome: 'Remarca Chat', tel: '71922000005' }); await marcado(a, amanha);
  await como(ATENDENTE); await db.query(`select public.agendamento_perguntar($1, 'fechar')`, [a]); await como('');
  await botao(a, 'exame_aberto', 'remarcar');
  const f = await um(`select desfecho, remarcacao from public.agendamento_fechamento where conversa_id = $1`, [a]);
  const fl = await fluxo(a), pre = await um(`select status, escolha_horario from public.pre_agendamentos where conversa_id = $1`, [a]);
  return { ok: f.desfecho === 'remarcou' && f.remarcacao === 'aceita' && fl.passo !== 'remarcar_falta' && pre.status === 'rascunho' && pre.escolha_horario === null, detalhe: JSON.stringify({ f, passo: fl.passo, pre }) };
});

await caso('"Prefiro falar com um atendente" e "Não quero remarcar" avisam a equipe e registram a decisão', async () => {
  const a = await conversa({ nome: 'Atendente Falta', tel: '71922000006' }); await marcado(a, ontem);
  const b = await conversa({ nome: 'Nao Quer Falta', tel: '71922000007' }); await marcado(b, ontem);
  await como(ATENDENTE);
  for (const x of [a, b]) { await db.query(`select public.agendamento_fechar($1, 'faltou')`, [x]); await db.query(`select public.agendamento_perguntar($1, 'remarcar')`, [x]); }
  await como('');
  const p1 = (await ultima(a)).opcoes.passo;
  await botao(a, 'remarcar_falta', 'atendente'); await botao(b, 'remarcar_falta', 'nao');
  const fa = await um(`select remarcacao from public.agendamento_fechamento where conversa_id = $1`, [a]);
  const fb = await um(`select remarcacao from public.agendamento_fechamento where conversa_id = $1`, [b]);
  const ca = await conv(a), cb = await conv(b);
  return { ok: p1 === 'remarcar_falta' && fa.remarcacao === 'pedida' && fb.remarcacao === 'recusada' && ca.ia_ativa === false && cb.ia_ativa === false && /atendente/.test(ca.triagem_resumo) && /NÃO quer/.test(cb.triagem_resumo),
           detalhe: JSON.stringify({ fa, fb }) };
});

await caso('quem DIGITA em vez de tocar também é entendido ("não fui", "quero cancelar", "fui sim")', async () => {
  const res = [];
  for (const [txt, esperado] of [['não fui', 'faltou'], ['quero cancelar', 'cancelou'], ['fui sim, deu tudo certo', 'compareceu'], ['quero remarcar', 'remarcou']]) {
    const a = await conversa({ nome: 'Digita ' + txt, tel: '7192' + String(2000100 + res.length) }); await marcado(a, ontem);
    await como(ATENDENTE); await db.query(`select public.agendamento_perguntar($1, 'fechar')`, [a]); await como('');
    await digitar(a, txt);
    res.push((await um(`select desfecho from public.agendamento_fechamento where conversa_id = $1`, [a]))?.desfecho + '/' + esperado);
  }
  return { ok: res.every((r) => r.split('/')[0] === r.split('/')[1]), detalhe: res.join() };
});

await caso('texto que não dá para entender repete a pergunta e não fecha nada', async () => {
  const a = await conversa({ nome: 'Nao Entende', tel: '71922000099' }); await marcado(a, ontem);
  await como(ATENDENTE); await db.query(`select public.agendamento_perguntar($1, 'fechar')`, [a]); await como('');
  await digitar(a, 'blablabla');
  return { ok: (await abertos(a)).length === 1 && (await fluxo(a)).passo === 'exame_aberto' && (await ultima(a)).opcoes?.passo === 'exame_aberto', detalhe: '' };
});

await caso('conversa SEM o motor automático: vai uma mensagem de texto (canal "mensagem") e nada muda no resto', async () => {
  const a = await conversa({ nome: 'Sem Motor', tel: '71922000098', motor: 'ia' }); await marcado(a, ontem);
  await como(ATENDENTE);
  const r = (await um(`select public.agendamento_perguntar($1, 'fechar') r`, [a])).r;
  await como('');
  const m = await ultima(a), c = await conv(a);
  return { ok: r.canal === 'mensagem' && m.opcoes === null && /em aberto/.test(m.texto) && c.ia_ativa === true && !(await um(`select 1 from public.conversa_fluxo where conversa_id = $1`, [a])), detalhe: m.texto };
});

await caso('"Perguntar" sem exame em aberto (ou sem remarcação pendente) é recusado', async () => {
  const a = await conversa({ nome: 'Nada Aberto', tel: '71922000097' });
  await como(ATENDENTE);
  const erros = [];
  for (const modo of ['fechar', 'remarcar']) { try { await db.query(`select public.agendamento_perguntar($1, $2)`, [a, modo]); erros.push('passou'); } catch (e) { erros.push(e.message.split('\n')[0]); } }
  await como('');
  return { ok: /Não há exame em aberto/.test(erros[0]) && /Não há remarcação pendente/.test(erros[1]), detalhe: erros.join(' | ') };
});

await caso('o pedido copiado NÃO sobrescreve um pedido que o paciente já está montando na conversa nova', async () => {
  const a = await conversa({ nome: 'Nao Sobrescreve', tel: '71922000096', email: 'ns@x.com', minutos: 100 }); await marcado(a, ontem);
  const dest = await conversa({ nome: 'Nao Sobrescreve', tel: '71922000096', email: 'ns@x.com', minutos: 1 });
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, procedimento_id, procedimento, lado) values ($1, 'US', 77, 'ULTRASSOM', 'N')`, [dest]);
  await como(ATENDENTE); await db.query(`select public.agendamento_fechar($1, 'faltou')`, [a]); await db.query(`select public.agendamento_perguntar($1, 'remarcar')`, [a]); await como('');
  await botao(dest, 'remarcar_falta', 'sim');
  const itens = await q(`select procedimento_id from public.pre_agendamento_itens where conversa_id = $1 and ativo order by id`, [dest]);
  const fl = await fluxo(dest);
  return { ok: itens.length === 1 && itens[0].procedimento_id === 77 && fl.dados.refazer === 'pedido', detalhe: `itens=${itens.map((i) => i.procedimento_id)} refazer=${fl.dados.refazer}` };
});

// ---------------------------------------------------------------- 4. Jornada (Klingo)
await db.exec(`
  create function public.jornada_pode() returns boolean language sql stable as $$ select auth.uid() is not null $$;
  create table public.jornada_paciente (prontuario text primary key, nome text, fone_chave text);
  create table public.jornada_card (id bigint generated always as identity primary key, paciente_chave text not null, data_ref date not null, unidade text default '', coluna text not null default 'a_confirmar',
    conversa_id uuid references public.conversas(id), arquivado_em timestamptz);
  create table public.jornada_exame (id bigint generated always as identity primary key, card_id bigint references public.jornada_card(id), procedimento text, status text);
  insert into public.config values ('ia_segredo', 'segredo-de-teste');
`);
await db.exec(pessoaJornada); await db.exec(pessoaJornada);
const marca = async (tel) => (await um(`select encode(sha256(convert_to(right(regexp_replace($1, '\\D', '', 'g'), 8) || 'segredo-de-teste', 'UTF8')), 'hex') h`, [tel])).h;
const cartaoKlingo = async (pront, nome, tel, dia, coluna = 'a_confirmar', status = 'agendado') => {
  await db.query(`insert into public.jornada_paciente values ($1, $2, $3) on conflict do nothing`, [pront, nome, await marca(tel)]);
  const id = (await um(`insert into public.jornada_card (paciente_chave, data_ref, coluna) values ($1, $2, $3) returning id`, [pront, dia, coluna])).id;
  await db.query(`insert into public.jornada_exame (card_id, procedimento, status) values ($1, 'ULTRASSOM ABDOME', $2)`, [id, status]);
  return id;
};
const pessoaDe = async (card) => { await como(ATENDENTE); const r = await um(`select * from public.jornada_pessoas() where card_id = $1`, [card]); await como(''); return r; };

await caso('Jornada: cartão do Klingo com nome + telefone (2 informações) NÃO se junta; mostra a sugestão', async () => {
  const c = await conversa({ nome: 'Klara Souza', tel: '71933000001', email: 'k@x.com' });
  const card = await cartaoKlingo('P100', 'KLARA SOUZA', '71933000001', '2026-12-10');
  const p = await pessoaDe(card);
  return { ok: p.pessoa === 'k:P100' && p.conversa_id === null && p.sugestao === c, detalhe: JSON.stringify(p) };
});

await caso('Jornada: + marcação feita no chat para o MESMO DIA (3 informações): junta sozinho', async () => {
  const c = await conversa({ nome: 'Lia Souza', tel: '71933000002', email: 'l@x.com' }); await marcado(c, '2026-12-11');
  const card = await cartaoKlingo('P101', 'LIA SOUZA', '71933000002', '2026-12-11');
  const p = await pessoaDe(card);
  const g = (await pessoaDe((await um(`insert into public.jornada_card (paciente_chave, data_ref, coluna, conversa_id) values ('conv:x', '2026-12-11', 'agendado', $1) returning id`, [c])).id));
  return { ok: p.pessoa.startsWith('g:') && p.conversa_id === c && g.pessoa === p.pessoa, detalhe: JSON.stringify({ klingo: p.pessoa, chat: g.pessoa }) };
});

await caso('Jornada: telefone parecido mas NOME diferente (família) nunca se junta nem é sugerido', async () => {
  await conversa({ nome: 'Marta Dias', tel: '71933000003' });
  const card = await cartaoKlingo('P102', 'JOAO DIAS', '71933000003', '2026-12-12');
  const p = await pessoaDe(card);
  return { ok: p.pessoa === 'k:P102' && p.sugestao === null, detalhe: JSON.stringify(p) };
});

await caso('Jornada: a equipe confirma "É a mesma pessoa" e o cartão se junta; desfazer separa de novo', async () => {
  const c = await conversa({ nome: 'Nara Costa', tel: '71933000004' });
  const card = await cartaoKlingo('P103', 'NARA COSTA', '71933000004', '2026-12-13');
  const antes = await pessoaDe(card);
  await como(ATENDENTE); await db.query(`select public.pessoa_klingo_confirmar('P103', $1)`, [c]); await como('');
  const junto = await pessoaDe(card);
  await como(ATENDENTE); await db.query(`select public.pessoa_klingo_desfazer('P103')`); await como('');
  const depois = await pessoaDe(card);
  return { ok: antes.pessoa === 'k:P103' && junto.pessoa.startsWith('g:') && junto.conversa_id === c && depois.pessoa === 'k:P103', detalhe: `${antes.pessoa} > ${junto.pessoa} > ${depois.pessoa}` };
});

await caso('Jornada: só a equipe lê a pessoa dos cartões; anônimo recebe lista vazia', async () => {
  await como('');
  const r = await q(`select * from public.jornada_pessoas()`);
  return { ok: r.length === 0, detalhe: `${r.length} linhas` };
});

await caso('Jornada: falta no Klingo + paciente ligado ao chat: pede a remarcação pelo chat (pedido refeito do zero)', async () => {
  const c = await conversa({ nome: 'Olga Ramos', tel: '71933000005' });
  const card = await cartaoKlingo('P104', 'OLGA RAMOS', '71933000005', '2026-10-30', 'faltou', 'faltou');
  await como(ATENDENTE); await db.query(`select public.pessoa_klingo_confirmar('P104', $1)`, [c]);
  const r = (await um(`select public.jornada_remarcar_pelo_chat($1) r`, [card])).r;
  await como('');
  const m = await ultima(c), f = await fluxo(c);
  await botao(c, 'remarcar_falta', 'sim');
  const f2 = await fluxo(c);
  return { ok: r.canal === 'botoes' && /Ultrassom Abdome \(30\/10\)/.test(m.texto) && f.passo === 'remarcar_falta' && f2.dados.refazer === 'pedido' && (await fluxo(c)).passo === 'exame', detalhe: `${m.texto} | depois=${f2.passo}` };
});

await caso('Jornada: falta de quem NÃO tem conversa no chat é recusada com a orientação de ligar', async () => {
  const card = await cartaoKlingo('P105', 'SEM CHAT', '71900009999', '2026-10-30', 'faltou', 'faltou');
  await como(ATENDENTE);
  let erro = ''; try { await db.query(`select public.jornada_remarcar_pelo_chat($1)`, [card]); } catch (e) { erro = e.message; }
  await como('');
  return { ok: /Ligue para oferecer/.test(erro), detalhe: erro.split('\n')[0] };
});

// ---------------------------------------------------------------- 5. O Klingo fecha sozinho o que a equipe não precisa fechar
const exameKlingo = async (card, status) => db.query(`insert into public.jornada_exame (card_id, procedimento, status) values ($1, 'ULTRASSOM ABDOME', $2)`, [card, status]);
const casoKlingo = async (nome, tel, status, { mudaNome = null } = {}) => {
  const c = await conversa({ nome, tel }); await marcado(c, ontem);
  const card = await cartaoKlingo('K' + tel.slice(-6), mudaNome || nome.toUpperCase(), tel, ontem, 'a_confirmar', status);
  await db.query(`select public.agendamento_conferir_klingo()`);
  const f = await um(`select desfecho, origem, remarcacao from public.agendamento_fechamento where conversa_id = $1`, [c]);
  return { c, card, f };
};

await caso('Klingo diz "atendido" no dia (nome + telefone + dia batem): o exame em aberto fecha como compareceu, origem klingo', async () => {
  const r = await casoKlingo('Atendida Klingo', '71944000001', 'atendido');
  return { ok: r.f && r.f.desfecho === 'compareceu' && r.f.origem === 'klingo' && (await abertos(r.c)).length === 0, detalhe: JSON.stringify(r.f) };
});

await caso('Klingo diz que faltou: fecha como faltou e deixa a remarcação PENDENTE para a equipe pedir ao paciente', async () => {
  const r = await casoKlingo('Faltosa Klingo', '71944000002', 'faltou');
  const p = await um(`select remarcacao from public.v_remarcacao_pendente where conversa_id = $1`, [r.c]);
  return { ok: r.f && r.f.desfecho === 'faltou' && r.f.origem === 'klingo' && p && p.remarcacao === 'pendente', detalhe: JSON.stringify(r.f) };
});

await caso('Klingo diz remarcado: fecha como remarcou e a remarcação já está feita; só cancelado: cancelou', async () => {
  const a = await casoKlingo('Remarcada Klingo', '71944000003', 'remarcado');
  const b = await casoKlingo('Cancelada Klingo', '71944000004', 'cancelado');
  return { ok: a.f.desfecho === 'remarcou' && a.f.remarcacao === 'feita' && b.f.desfecho === 'cancelou', detalhe: `${JSON.stringify(a.f)} ${JSON.stringify(b.f)}` };
});

await caso('Klingo ainda "agendado" ou nome diferente (só 2 informações): NÃO fecha nada', async () => {
  const a = await casoKlingo('Ainda Agendada', '71944000005', 'agendado');
  const b = await casoKlingo('Outro Nome', '71944000006', 'atendido', { mudaNome: 'TOTALMENTE DIFERENTE' });
  return { ok: !a.f && !b.f && (await abertos(a.c)).length === 1 && (await abertos(b.c)).length === 1, detalhe: JSON.stringify([a.f, b.f]) };
});

const recente = async (nome, tel, status) => {
  const c = await conversa({ nome, tel }); const hoje = new Date().toISOString().slice(0, 10);
  await marcado(c, hoje, new Date(Date.now() - 20 * 60000).toISOString().slice(11, 16));
  await cartaoKlingo('K' + tel.slice(-6), nome.toUpperCase(), tel, hoje, 'a_confirmar', status);
  await db.query(`select public.agendamento_conferir_klingo()`);
  return c;
};
await caso('Klingo: falta/cancelamento de horário que passou há menos de 1 hora ainda não é conferido', async () => {
  const c = await recente('Recente Klingo', '71944000007', 'faltou');
  return { ok: (await abertos(c)).length === 1, detalhe: '' };
});
await caso('Klingo: "atendido" vale na hora (não espera 1 hora) e a conversa parada se encerra sozinha', async () => {
  const c = await recente('Atendida Agora', '71944000008', 'atendido');
  const cv = await um(`select status, ia_ativa, alerta_agenda from public.conversas where id = $1`, [c]);
  return { ok: (await abertos(c)).length === 0 && cv.status === 'encerrada' && cv.ia_ativa === false, detalhe: JSON.stringify(cv) };
});
await caso('Klingo "atendido" com atendente falando com o paciente: não encerra, deixa o aviso "pode encerrar"', async () => {
  const c = await conversa({ nome: 'Em Atendimento', tel: '71944000009' }); const hoje = new Date().toISOString().slice(0, 10);
  await db.query(`update public.conversas set status = 'em_atendimento' where id = $1`, [c]);
  await marcado(c, hoje, new Date(Date.now() - 20 * 60000).toISOString().slice(11, 16));
  await cartaoKlingo('K000009', 'EM ATENDIMENTO', '71944000009', hoje, 'a_confirmar', 'atendido');
  await db.query(`select public.agendamento_conferir_klingo()`);
  const cv = await um(`select status, alerta_agenda from public.conversas where id = $1`, [c]);
  return { ok: cv.status === 'em_atendimento' && /Pode encerrar/.test(cv.alerta_agenda), detalhe: JSON.stringify(cv) };
});
await caso('Klingo "faltou": fecha o exame mas NÃO encerra a conversa (a remarcação está pendente)', async () => {
  const r = await casoKlingo('Faltosa Aberta', '71944000010', 'faltou');
  const cv = await um(`select status from public.conversas where id = $1`, [r.c]);
  return { ok: r.f.desfecho === 'faltou' && cv.status !== 'encerrada', detalhe: JSON.stringify(cv) };
});

// ---------------------------------------------------------------- 6. Automático: o status do Klingo muda e tudo acompanha na hora
await db.exec(`
  alter table public.jornada_exame add column if not exists confirm_status text; alter table public.jornada_exame add column if not exists operadora text;
  create schema if not exists realtime;
  create table realtime.messages (id bigint generated always as identity primary key, topic text, extension text, event text, payload jsonb, private boolean);
  create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void language plpgsql as $$ begin insert into realtime.messages (topic, extension, event, payload, private) values (topic, 'broadcast', event, payload, private); end $$;
`);
await db.exec(lerSql('jornada-tempo-real.sql')); await db.exec(lerSql('automacao-sistema.sql')); await db.exec(lerSql('automacao-sistema.sql'));
await caso('gatilho: o Klingo muda o exame para atendido -> fecha o exame em aberto e encerra a conversa SEM esperar a rotina', async () => {
  const c = await conversa({ nome: 'Gatilho Automatico', tel: '71944000020' }); const hoje = new Date().toISOString().slice(0, 10);
  await marcado(c, hoje, new Date(Date.now() - 20 * 60000).toISOString().slice(11, 16));
  const card = await cartaoKlingo('K000020', 'GATILHO AUTOMATICO', '71944000020', hoje, 'a_confirmar', 'agendado');
  const antes = (await abertos(c)).length;
  await db.query(`update public.jornada_exame set status = 'atendido' where card_id = $1`, [card]);
  const cv = await um(`select status from public.conversas where id = $1`, [c]);
  return { ok: antes === 1 && (await abertos(c)).length === 0 && cv.status === 'encerrada', detalhe: `antes=${antes} ${JSON.stringify(cv)}` };
});
await caso('gatilho: atualizar o exame sem mudar o status não faz nada (nem aviso em tempo real)', async () => {
  const c = await conversa({ nome: 'Sem Mudanca', tel: '71944000021' }); const hoje = new Date().toISOString().slice(0, 10);
  await marcado(c, hoje, '23:00');
  const card = await cartaoKlingo('K000021', 'SEM MUDANCA', '71944000021', hoje, 'a_confirmar', 'agendado');
  const n0 = (await um(`select count(*)::int n from realtime.messages where event = 'jornada_mudou'`)).n;
  await db.query(`update public.jornada_exame set operadora = 'X' where card_id = $1`, [card]);
  const n1 = (await um(`select count(*)::int n from realtime.messages where event = 'jornada_mudou'`)).n;
  return { ok: n1 === n0 && (await abertos(c)).length === 1, detalhe: `${n0} ${n1}` };
});
await caso('tempo real: mudar o status do exame ou a etapa da visita avisa os portais ("jornada_mudou", sem dado pessoal)', async () => {
  const c = await conversa({ nome: 'Aviso Portal', tel: '71944000022' }); const hoje = new Date().toISOString().slice(0, 10);
  const card = await cartaoKlingo('K000022', 'AVISO PORTAL', '71944000022', hoje, 'a_confirmar', 'agendado');
  const n0 = (await um(`select count(*)::int n from realtime.messages where event = 'jornada_mudou'`)).n;
  await db.query(`update public.jornada_exame set status = 'confirmado' where card_id = $1`, [card]);
  await db.query(`update public.jornada_card set coluna = 'chegou' where id = $1`, [card]);
  const m = await db.query(`select payload::text p from realtime.messages where event = 'jornada_mudou' order by id desc limit 1`);
  const n1 = (await um(`select count(*)::int n from realtime.messages where event = 'jornada_mudou'`)).n;
  return { ok: n1 === n0 + 2 && m.rows[0].p === '{"evento": "jornada_mudou"}', detalhe: `${n0} ${n1} ${m.rows[0].p}` };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
