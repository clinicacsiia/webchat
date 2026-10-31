-- FLUXOGRAMA: entrada (paciente logado toca em "Meus dados"; JWT do Supabase Auth) -> validação (só conta de paciente: equipe e anônimo recebem erro; a exclusão exige a palavra de confirmação) -> lógica (cópia: reúne conta, cadastro, histórico, pedidos e conversas da PRÓPRIA conta; exclusão: apaga só o login e solta o vínculo, o resto fica com a clínica) -> saída (JSON da cópia ou resumo do que foi apagado e do que continua guardado; um registro sem dado pessoal para a prestação de contas)
-- Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
--
-- POR QUE: a LGPD (art. 18) dá ao paciente o direito de ver e levar uma cópia dos próprios dados e de pedir a exclusão. Antes, isso era feito
-- pela equipe, à mão. NÃO APLICADO ainda no projeto webchat-atendimento.
--
-- DEPENDE de supabase/contas-paciente.sql e supabase/login-paciente.sql (contas_paciente, conversas.conta_id) e de fase7-motor.sql (conversa_anexo).
--
-- O QUE A EXCLUSÃO FAZ (decisão da clínica em 31/10/2026: "apaga só o login"):
--   * apaga a conta de acesso (auth.users) e, em cascata, a linha de contas_paciente (e-mail, nome e telefone da conta, aceite);
--   * solta o vínculo das conversas com a conta (conversas.conta_id passa a nulo);
--   * NÃO apaga cadastro de paciente, pedidos, conversas, mensagens, fotos de pedido nem histórico: a clínica guarda esses registros por
--     obrigação legal e de atendimento. A tela diz isso ao paciente antes de confirmar. Quem quiser mais que isso fala com a clínica.
--   * grava um registro SEM dado pessoal (conta_paciente_evento: tipo, data, se havia cadastro, quantas conversas).
-- QUEM DEVE REVISAR: o texto da tela e a lista do que fica guardado precisam ser revisados pelo jurídico da clínica antes de ligar o login ao público.
--
-- ROLLBACK: drop function public.conta_paciente_meus_dados(), public.conta_paciente_excluir(text); drop table public.conta_paciente_evento;
-- Nenhum comando destrutivo neste arquivo (a exclusão só acontece quando o PACIENTE a pede pela tela). Pode ser aplicado mais de uma vez.

-- 1. Registro de prestação de contas (sem nenhum dado pessoal). Só o administrador lê.
create table if not exists public.conta_paciente_evento (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('copia', 'exclusao')),
  tinha_cadastro boolean not null default false,
  conversas integer not null default 0,
  criado_em timestamptz not null default now()
);
comment on table public.conta_paciente_evento is 'Pedidos dos pacientes pela tela "Meus dados" (cópia dos dados e exclusão da conta). Sem dado pessoal: só tipo, data e contagens.';
alter table public.conta_paciente_evento enable row level security;
revoke all on table public.conta_paciente_evento from anon, authenticated;
grant select on table public.conta_paciente_evento to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conta_paciente_evento' and policyname = 'conta_paciente_evento_select') then
    create policy conta_paciente_evento_select on public.conta_paciente_evento for select using ((select public.papel_atual()) = 'admin');
  end if;
end $$;

-- 2. Cópia dos dados. Só o que pertence à conta de quem pede; nada interno da clínica (notas, triagem, resumo da IA).
create or replace function public.conta_paciente_meus_dados() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := (select auth.uid()); v_cp public.contas_paciente;
  v_cadastro jsonb; v_hist jsonb; v_pedidos jsonb; v_msgs jsonb; v_fotos int; v_conv int;
begin
  select * into v_cp from public.contas_paciente where id = v_uid;
  if v_uid is null or not found then raise exception 'Entre na sua conta para ver os seus dados.' using errcode = '42501'; end if;

  select jsonb_build_object('nome', p.nome, 'data_nascimento', p.dt_nasc, 'cpf', p.cpf, 'email', p.email, 'telefones', to_jsonb(p.telefones),
                            'outros_dados', p.dados, 'criado_em', p.criado_em, 'ultima_visita_em', p.ultima_visita_em)
    into v_cadastro from public.pacientes p where p.id = v_cp.paciente_id;

  select coalesce(jsonb_agg(jsonb_build_object('quando', coalesce(h.ocorreu_em::timestamptz, h.criado_em), 'exames', h.exames, 'horarios', h.horarios,
                                               'convenio', h.plano, 'unidade', h.unidade, 'profissional', h.profissional, 'cancelado', h.cancelado)
                           order by coalesce(h.ocorreu_em::timestamptz, h.criado_em) desc), '[]'::jsonb)
    into v_hist from public.paciente_historico h where h.paciente_id = v_cp.paciente_id;

  select coalesce(jsonb_agg(x.o order by x.criado desc), '[]'::jsonb) into v_pedidos from (
    select c.criado_em as criado, jsonb_build_object(
      'iniciado_em', c.criado_em,
      'para', case when c.paciente_tipo = 'filho' then 'filho(a)' else 'a própria pessoa' end,
      'tipo', pa.tipo, 'situacao', pa.status,
      'exames', (select coalesce(jsonb_agg(coalesce(i.procedimento, i.modalidade) || coalesce(' (' || nullif(i.lado, 'N') || ')', '') order by i.id), '[]'::jsonb)
                   from public.pre_agendamento_itens i where i.conversa_id = c.id and i.ativo),
      'convenio', pa.plano, 'unidade', pa.unidade, 'profissional', pa.profissional, 'horarios', pa.escolha_horario,
      'dados_informados', pa.paciente) as o
    from public.conversas c left join public.pre_agendamentos pa on pa.conversa_id = c.id
    where c.conta_id = v_uid order by c.criado_em desc limit 200) x;

  select coalesce(jsonb_agg(jsonb_build_object('quando', m.criado_em, 'quem', case m.autor when 'cliente' then 'você' else 'clínica' end, 'texto', m.texto) order by m.criado_em, m.id), '[]'::jsonb)
    into v_msgs from (
      select m2.* from public.mensagens m2 join public.conversas c on c.id = m2.conversa_id
       where c.conta_id = v_uid and m2.autor in ('cliente', 'agente') order by m2.criado_em desc, m2.id desc limit 5000) m;

  select count(*) into v_fotos from public.conversa_anexo a join public.conversas c on c.id = a.conversa_id where c.conta_id = v_uid;
  select count(*) into v_conv from public.conversas where conta_id = v_uid;

  insert into public.conta_paciente_evento (tipo, tinha_cadastro, conversas) values ('copia', v_cp.paciente_id is not null, v_conv);

  return jsonb_build_object(
    'gerado_em', now(),
    'conta', jsonb_build_object('email', v_cp.email, 'nome', v_cp.nome, 'telefone', v_cp.telefone, 'criada_em', v_cp.criado_em, 'aceitou_lgpd_em', v_cp.aceitou_lgpd_em),
    'cadastro', v_cadastro, 'historico', v_hist, 'pedidos', v_pedidos, 'mensagens', v_msgs,
    'fotos_de_pedido_guardadas', v_fotos,
    'observacao', 'As fotos de pedido médico não vão neste arquivo; para recebê-las, fale com a clínica. Notas internas da equipe não fazem parte dos seus dados.');
end $$;

-- 3. Exclusão da conta (só o login). A palavra de confirmação evita chamada acidental; a tela pede a confirmação com dois toques.
create or replace function public.conta_paciente_excluir(p_confirmacao text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := (select auth.uid()); v_cp public.contas_paciente; v_conv int;
begin
  select * into v_cp from public.contas_paciente where id = v_uid;
  if v_uid is null or not found then raise exception 'Entre na sua conta para apagá-la.' using errcode = '42501'; end if;
  if p_confirmacao is distinct from 'EXCLUIR' then raise exception 'Confirmação ausente: a conta não foi apagada.' using errcode = '22023'; end if;
  select count(*) into v_conv from public.conversas where conta_id = v_uid;
  insert into public.conta_paciente_evento (tipo, tinha_cadastro, conversas) values ('exclusao', v_cp.paciente_id is not null, v_conv);
  delete from auth.users where id = v_uid;   -- contas_paciente sai em cascata; conversas.conta_id vira nulo
  return jsonb_build_object('ok', true, 'continua_guardado', jsonb_build_array('cadastro', 'pedidos', 'conversas', 'historico'));
end $$;

revoke all on function public.conta_paciente_meus_dados(), public.conta_paciente_excluir(text) from public, anon;
grant execute on function public.conta_paciente_meus_dados(), public.conta_paciente_excluir(text) to authenticated;
