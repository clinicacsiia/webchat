-- FLUXOGRAMA: entrada (o paciente do acesso rápido, com o PIN já digitado, abre "Acompanhe seus pedidos"; o chat vincula cada conversa do aparelho ao cadastro; a rotina do Klingo atualiza a Jornada a cada 30 s)
--   -> validação (aparelho conhecido e desbloqueado; a conversa só vincula com o par id + token e com o celular do cadastro; cada ação confere que a conversa é do cadastro)
--   -> lógica (lista os pedidos de quem tem acesso rápido + filhos, com o passo de cada exame; compara a "assinatura" do que a pessoa já viu com a de agora para o balão de novidades; ações Conversa / Ver / Cancelar / Remarcar / Resultado abrem a conversa certa, sem repetir regra: reaproveitam chat_nova_conversa, chat_responder e o fluxo pós-agendamento; resultado entregue pela equipe fica guardado à parte)
--   -> saída (JSON para a tela; nada de CPF, e-mail ou telefone; o código da conversa só sai na ação "abrir", para quem está com o PIN)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (acompanhar pedidos, novidades, ações e resultados)
--
-- DEPENDE DE: acesso-rapido-paciente.sql (app_*), acesso-rapido-chat.sql (app_chat_dados), webchat-v2-parte5-pos-agendamento.sql (fluxo Cancelar/Remarcar/Resultado), jornada (jornada_card/jornada_exame, atualizados do Klingo a cada 30 s).
--
-- PRIVACIDADE: celular não é confirmado (decisão do dono: nada de SMS). Por isso NADA da clínica aparece para quem só digitou um celular:
--   só entram na lista as conversas que o aparelho PROVOU ter (id + token da conversa, e o celular do contato igual ao do cadastro). Pedido antigo de outro aparelho não aparece sozinho.
--   O código da conversa (token) só sai na ação app_pedido_acao, que exige o PIN dos últimos 30 minutos e a conversa já vinculada.
--
-- RESULTADO DE EXAME: o Klingo (relatório C #14026) só diz se o laudo está pronto, sem link nem senha. A equipe entrega DENTRO da conversa (arquivo ou link).
--   * estado do resultado por exame: aguardando (exame feito, laudo ainda não visto como pronto) -> disponivel (relatório C diz que o laudo está pronto; só com config.app_resultado_vigia = 'sim')
--     -> solicitado (o paciente pediu pelo botão; a conversa é aberta já no assunto "Resultado de exame") -> entregue (a equipe mandou arquivo ou link na conversa; fica guardado e a rotina não confere mais).
--   * a vigia (Edge Function app-resultados-vigiar) nasce DESLIGADA: nunca foi provada com um laudo real.
--
-- ROLLBACK (nada de outras tabelas é alterado):
--   drop trigger if exists app_resultado_arquivo_trg on public.conversa_anexo; drop trigger if exists app_resultado_mensagem_trg on public.mensagens;
--   drop function if exists public.app_pedidos(text, boolean), public.app_pedido_visto(text, uuid), public.app_pedido_acao(text, uuid, text, bigint), public.app_conversa_vincular(text, uuid, text),
--     public.app_resultado_arquivo(text, uuid), public.app_pedido_dados(uuid, uuid), public.app_resultados_json(uuid), public.app_resultados_a_conferir(integer), public.app_resultado_disponivel(jsonb),
--     public.app_resultados_disparar(), public.painel_resultado_entregue(uuid), public.app_resultado_entregar_trg();
--   select cron.unschedule('app-resultados-vigia');
--   drop table if exists public.app_resultado; drop table if exists public.app_conversa;
--   delete from public.config where chave = 'app_resultado_vigia';
-- COMO APLICAR (limite de 60 s do conector e confirmação nos comandos com drop/delete): em SEIS partes, na ordem das seções 1 a 7 (1; 2; 3+4; 5; 6; 7). Este arquivo não tem comando destrutivo.
-- Pode ser aplicado mais de uma vez.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Tabelas (RLS ligada e nenhuma regra: só as funções abaixo leem e gravam, como o resto de app_*)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.app_conversa (
  paciente_id uuid not null references public.app_paciente(id) on delete cascade,
  conversa_id uuid not null references public.conversas(id) on delete cascade,
  pessoa_nome text,                       -- quem é o paciente da conversa (o titular ou o filho), como foi digitado no chat
  eu boolean not null default true,       -- true = o próprio titular
  visto_sig text,                         -- assinatura do que a pessoa já viu (balão de novidades)
  visto_em timestamptz,
  criado_em timestamptz not null default now(),
  primary key (paciente_id, conversa_id)
);
create index if not exists app_conversa_conversa_idx on public.app_conversa (conversa_id);
alter table public.app_conversa enable row level security;
revoke all on public.app_conversa from public, anon, authenticated;
comment on table public.app_conversa is 'Conversas que o aparelho provou ter (id + token + celular do cadastro). Só as funções app_* leem. Guarda a assinatura do que o paciente já viu (balão de novidades).';

create table if not exists public.app_resultado (
  id uuid primary key default gen_random_uuid(),
  paciente_id uuid not null references public.app_paciente(id) on delete cascade,
  conversa_id uuid not null references public.conversas(id) on delete cascade,   -- a conversa do pedido
  exame_id bigint not null,                                                      -- jornada_exame.id
  estado text not null default 'aguardando' check (estado in ('aguardando', 'disponivel', 'solicitado', 'entregue')),
  conversa_resultado_id uuid references public.conversas(id) on delete set null,  -- onde o paciente pediu (e onde a equipe entrega)
  conferido_em timestamptz,
  disponivel_em timestamptz,
  solicitado_em timestamptz,
  entregue_em timestamptz,
  anexo_id bigint,                        -- conversa_anexo.id (arquivo entregue pela equipe), se houve arquivo
  mensagem_id bigint,                     -- mensagem com o link, se a entrega foi por texto
  criado_em timestamptz not null default now(),
  unique (paciente_id, conversa_id, exame_id)
);
create index if not exists app_resultado_entrega_idx on public.app_resultado (conversa_resultado_id) where estado = 'solicitado';
alter table public.app_resultado enable row level security;
revoke all on public.app_resultado from public, anon, authenticated;
comment on table public.app_resultado is 'Estado do resultado de cada exame feito. Entregue = a equipe mandou o arquivo ou o link na conversa; a partir daí o sistema não confere mais o Klingo e o resultado fica na lista "Resultados" do paciente.';

insert into public.config (chave, valor) values ('app_resultado_vigia', 'nao') on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Os pedidos de um cadastro (todas as conversas vinculadas), com o passo de cada exame
--    ok: 1 pedido, 2 marcado, 3 confirmado, 4 chegou, 5 exame feito. excecao: cancelado | faltou. 0 = pedido ainda não concluído.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_pedido_dados(p_pac uuid, p_conversa uuid default null) returns jsonb
language sql stable security definer set search_path to ''
as $f$
  with base as (
    select ac.conversa_id, ac.pessoa_nome, ac.eu, ac.visto_sig, c.status as cstatus, c.criado_em, pa.tipo as pre_tipo, pa.status as pre_status,
           pa.procedimento as pre_proc, pa.escolha_horario as pre_hor, pa.unidade as pre_unidade
      from public.app_conversa ac
      join public.conversas c on c.id = ac.conversa_id
      left join public.pre_agendamentos pa on pa.conversa_id = c.id
     where ac.paciente_id = p_pac and (p_conversa is null or ac.conversa_id = p_conversa)
  ), jor as (
    select b.conversa_id, e.id as exame_id, e.procedimento as nome, e.unidade,
           to_char(e.agendado_para at time zone 'America/Bahia', 'YYYY-MM-DD') as data, to_char(e.agendado_para at time zone 'America/Bahia', 'HH24:MI') as hora,
           case when e.status in ('cancelado', 'faltou') then null
                when e.status = 'atendido' then 5
                when e.status = 'pedido' then 1
                when jc.coluna in ('chegou', 'em_atendimento') then 4
                when e.status = 'confirmado' or lower(coalesce(e.confirm_status, '')) = 'confirmado' then 3
                else 2 end as ok,
           case when e.status in ('cancelado', 'faltou') then e.status end as excecao
      from base b
      join public.jornada_card jc on jc.conversa_id = b.conversa_id
      join public.jornada_exame e on e.card_id = jc.id
     where e.status <> 'remarcado'
  ), pre as (   -- pedido que o chat montou e o Klingo ainda não devolveu (ou nunca devolverá): itens do próprio pedido
    select b.conversa_id, null::bigint as exame_id, coalesce(nullif(i.procedimento, ''), nullif(b.pre_proc, ''), 'Atendimento') as nome, b.pre_unidade as unidade,
           b.pre_hor -> 0 ->> 'data' as data, b.pre_hor -> 0 ->> 'hora' as hora,
           case b.pre_status when 'agendado' then 2 when 'pronto' then 1 else 0 end as ok,
           case when b.pre_status = 'cancelado' then 'cancelado' end as excecao
      from base b
      left join public.pre_agendamento_itens i on i.conversa_id = b.conversa_id and i.ativo
     where not exists (select 1 from jor j where j.conversa_id = b.conversa_id)
       and b.pre_status in ('rascunho', 'pronto', 'agendado', 'cancelado')
       and (b.pre_status <> 'rascunho' or b.criado_em > now() - interval '14 days')
       and (i.id is not null or b.pre_proc is not null)
  ), todos as (
    select * from jor union all select * from pre
  ), com_res as (
    select t.*, case when t.ok = 5 then coalesce(r.estado, 'aguardando') end as res, r.id as res_id, r.conversa_resultado_id as res_conv
      from todos t
      left join public.app_resultado r on r.paciente_id = p_pac and r.conversa_id = t.conversa_id and t.exame_id is not null and r.exame_id = t.exame_id
  ), por_conversa as (
    select b.*,
           coalesce(jsonb_agg(jsonb_build_object('id', x.exame_id, 'nome', x.nome, 'unidade', x.unidade, 'data', x.data, 'hora', x.hora, 'ok', x.ok, 'excecao', x.excecao,
                                                 'resultado', x.res, 'resultado_id', x.res_id, 'resultado_conversa', x.res_conv) order by x.data nulls last, x.hora nulls last, x.nome) filter (where x.nome is not null), '[]'::jsonb) as exames,
           md5(coalesce(string_agg(coalesce(x.exame_id::text, 'p') || ':' || x.ok || ':' || coalesce(x.excecao, '') || ':' || coalesce(x.data, '') || coalesce(x.hora, '') || ':' || coalesce(x.res, ''),
                                   '|' order by x.exame_id nulls last, x.nome) filter (where x.ok >= 2 or x.excecao is not null), '')) as sig
      from base b left join com_res x on x.conversa_id = b.conversa_id
     group by b.conversa_id, b.pessoa_nome, b.eu, b.visto_sig, b.cstatus, b.criado_em, b.pre_tipo, b.pre_status, b.pre_proc, b.pre_hor, b.pre_unidade
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'conversa', conversa_id, 'pessoa', pessoa_nome, 'eu', eu, 'aberta', cstatus <> 'encerrada', 'criado_em', criado_em, 'tipo', pre_tipo, 'pre_status', pre_status,
           'exames', exames, 'sig', sig, 'novo', visto_sig is not null and visto_sig <> sig) order by criado_em desc), '[]'::jsonb)
    from por_conversa where jsonb_array_length(exames) > 0
$f$;
revoke all on function public.app_pedido_dados(uuid, uuid) from public, anon, authenticated;

-- Resultados já entregues (ficam guardados à parte; a rotina não confere mais o Klingo para eles)
create or replace function public.app_resultados_json(p_pac uuid) returns jsonb
language sql stable security definer set search_path to ''
as $f$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'pessoa', ac.pessoa_nome, 'eu', ac.eu, 'nome', e.procedimento, 'data_exame', to_char(e.agendado_para at time zone 'America/Bahia', 'YYYY-MM-DD'),
           'entregue_em', r.entregue_em, 'tem_arquivo', r.anexo_id is not null, 'arquivo_nome', x.nome, 'conversa', r.conversa_resultado_id) order by r.entregue_em desc), '[]'::jsonb)
    from public.app_resultado r
    join public.app_conversa ac on ac.paciente_id = r.paciente_id and ac.conversa_id = r.conversa_id
    left join public.jornada_exame e on e.id = r.exame_id
    left join public.conversa_anexo x on x.id = r.anexo_id
   where r.paciente_id = p_pac and r.estado = 'entregue'
$f$;
revoke all on function public.app_resultados_json(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. Vincular a conversa do aparelho ao cadastro (o chat chama sozinho para as conversas guardadas no celular)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_conversa_vincular(p_token text, p_conversa uuid, p_conv_token text) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record; a public.app_paciente%rowtype; c public.conversas; v_tel text; v_eu boolean;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  begin perform public.chat_valida(p_conversa, p_conv_token);
  exception when others then return jsonb_build_object('ok', false, 'erro', 'conversa'); end;
  select * into a from public.app_paciente where id = s.o_pac;
  select * into c from public.conversas where id = p_conversa;
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g') into v_tel from public.contatos ct where ct.id = c.contato_id;
  if v_tel is distinct from a.telefone then return jsonb_build_object('ok', false, 'erro', 'celular'); end if;
  v_eu := coalesce(c.paciente_tipo, 'proprio') = 'proprio';
  insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu)
  values (a.id, c.id, case when v_eu then a.nome else coalesce(nullif(btrim(c.paciente_nome), ''), 'Filho(a)') end, v_eu)
  on conflict (paciente_id, conversa_id) do nothing;
  -- o que já existe quando a conversa entra NÃO conta como novidade: só o que mudar depois
  update public.app_conversa ac set visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(a.id, c.id)) e limit 1), md5('')), visto_em = now()
   where ac.paciente_id = a.id and ac.conversa_id = c.id and ac.visto_sig is null;
  return jsonb_build_object('ok', true);
end $f$;
revoke all on function public.app_conversa_vincular(text, uuid, text) from public;
grant execute on function public.app_conversa_vincular(text, uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 4. A lista da tela e o balão. p_renova = false: o recarregamento automático NÃO estende os 30 minutos do PIN (senão a tela aberta nunca travaria).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_pedidos(p_token text, p_renova boolean default true) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record; a public.app_paciente%rowtype; v_dados jsonb; v_trava timestamptz;
begin
  select * into s from public.app_aparelho_validar(p_token, p_renova);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not p_renova then
    select desbloqueada_ate into v_trava from public.app_aparelho where id = s.o_aparelho;
    if v_trava is null or v_trava < now() then return public.app_erro_json('bloqueado'); end if;
  end if;
  select * into a from public.app_paciente where id = s.o_pac;
  v_dados := public.app_pedido_dados(a.id);
  return jsonb_build_object('ok', true,
    'nome', a.nome, 'telefone_final', right(a.telefone, 4), 'email_salvo', a.email is not null,
    'pessoas', jsonb_build_array(jsonb_build_object('nome', a.nome, 'eu', true)) || coalesce((select jsonb_agg(jsonb_build_object('nome', f.nome, 'eu', false) order by f.criado_em, f.id)
                from public.app_filho f where f.responsavel_id = a.id and f.removido_em is null), '[]'::jsonb),
    'pedidos', v_dados,
    'novidades', (select count(*) from jsonb_array_elements(v_dados) e where (e ->> 'novo')::boolean),
    'resultados', public.app_resultados_json(a.id));
end $f$;
revoke all on function public.app_pedidos(text, boolean) from public;
grant execute on function public.app_pedidos(text, boolean) to anon, authenticated;

-- Só o número do balão (o chat chama; não estende o PIN). Sem PIN ativo devolve "bloqueado" e o chat só esconde o balão.
create or replace function public.app_pedidos_contagem(p_token text) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare r jsonb;
begin
  r := public.app_pedidos(p_token, false);
  if (r ->> 'ok')::boolean is not true then return r; end if;
  return jsonb_build_object('ok', true, 'novidades', (r ->> 'novidades')::int);
end $f$;
revoke all on function public.app_pedidos_contagem(text) from public;
grant execute on function public.app_pedidos_contagem(text) to anon, authenticated;

-- "Visto": a pessoa abriu o pedido. p_conversa nulo = marca todos.
create or replace function public.app_pedido_visto(p_token text, p_conversa uuid default null) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  update public.app_conversa ac set visto_em = now(),
         visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(ac.paciente_id, ac.conversa_id)) e limit 1), md5(''))
   where ac.paciente_id = s.o_pac and (p_conversa is null or ac.conversa_id = p_conversa);
  return jsonb_build_object('ok', true);
end $f$;
revoke all on function public.app_pedido_visto(text, uuid) from public;
grant execute on function public.app_pedido_visto(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 5. Ações do pedido. p_acao: conversa | ver | remarcar | cancelar | resultado
--    conversa  -> só devolve o código da conversa do pedido (a tela abre o chat nela)
--    ver / remarcar / cancelar / resultado:
--       conversa do pedido ABERTA  -> manda a mensagem do paciente nela (a equipe ou o chat respondem lá); devolve a mesma conversa
--       conversa ENCERRADA         -> abre uma conversa nova (chat_nova_conversa), responde sozinho CPF + nascimento com os dados do cadastro,
--                                     escolhe "Outro assunto" e o assunto (Minhas marcações / Remarcar / Cancelar / Resultado de exame) como se o paciente tivesse tocado
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_pedido_acao(p_token text, p_conversa uuid, p_acao text, p_exame bigint default null) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare
  s record; a public.app_paciente%rowtype; c public.conversas; ac public.app_conversa%rowtype; v_tok text; v_tel text; v_email text;
  v_exame record; v_item text; v_texto text; v_assunto text; v_nova jsonb; v_id uuid; v_ntok text; v_passo text; v_antes text; v_i int; v_dir boolean := false;
begin
  if p_acao not in ('conversa', 'ver', 'remarcar', 'cancelar', 'resultado') then return jsonb_build_object('ok', false, 'erro', 'acao', 'mensagem', 'Ação inválida.'); end if;
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into ac from public.app_conversa where paciente_id = s.o_pac and conversa_id = p_conversa;
  if not found then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Não encontrei este pedido neste cadastro.'); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  select * into c from public.conversas where id = p_conversa;
  select token into v_tok from public.conversa_segredo where conversa_id = p_conversa;
  if c.id is null or v_tok is null then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Esta conversa não está mais disponível.'); end if;

  if p_acao = 'conversa' then
    return jsonb_build_object('ok', true, 'conversa', c.id, 'token', v_tok, 'aberta', c.status <> 'encerrada', 'tipo', coalesce(c.paciente_tipo, 'proprio'), 'paciente_nome', c.paciente_nome,
                              'irmaos', coalesce(c.irmaos, '[]'::jsonb), 'irmaos_modo', c.irmaos_modo);
  end if;

  if p_acao = 'resultado' then
    select e.id, e.procedimento, to_char(e.agendado_para at time zone 'America/Bahia', 'DD/MM/YYYY') as dia into v_exame
      from public.jornada_exame e join public.jornada_card jc on jc.id = e.card_id
     where e.id = p_exame and jc.conversa_id = p_conversa and e.status = 'atendido';
    if not found then return jsonb_build_object('ok', false, 'erro', 'exame', 'mensagem', 'Este exame ainda não aparece como realizado.'); end if;
    v_item := v_exame.procedimento || coalesce(' (feito em ' || v_exame.dia || ')', '');
  else
    v_item := coalesce((select e.procedimento || coalesce(' do dia ' || to_char(e.agendado_para at time zone 'America/Bahia', 'DD/MM/YYYY'), '')
                          from public.jornada_exame e join public.jornada_card jc on jc.id = e.card_id
                         where jc.conversa_id = p_conversa and e.id = p_exame), 'o meu pedido');
  end if;
  v_texto := case p_acao
    when 'resultado' then 'Quero receber o resultado do exame: ' || v_item || '.'
    when 'cancelar' then 'Quero cancelar: ' || v_item || '.'
    when 'remarcar' then 'Quero remarcar: ' || v_item || '.'
    else 'Quero ver as minhas marcações.' end;
  v_assunto := case p_acao when 'resultado' then 'Resultado de exame' when 'cancelar' then 'Cancelar' when 'remarcar' then 'Remarcar' else 'Minhas marcações' end;

  -- conversa ainda aberta: o paciente "escreve" nela; ninguém é encerrado, ninguém perde o atendimento
  if c.status <> 'encerrada' then
    begin perform public.chat_enviar(c.id, v_tok, v_texto);
    exception when others then return jsonb_build_object('ok', false, 'erro', 'enviar', 'mensagem', 'Não foi possível enviar agora. Abra a conversa e escreva por lá.', 'conversa', c.id, 'token', v_tok); end;
    if p_acao = 'resultado' then
      insert into public.app_resultado (paciente_id, conversa_id, exame_id, estado, solicitado_em, conversa_resultado_id)
      values (a.id, c.id, v_exame.id, 'solicitado', now(), c.id)
      on conflict (paciente_id, conversa_id, exame_id) do update set estado = case when public.app_resultado.estado = 'entregue' then 'entregue' else 'solicitado' end,
        solicitado_em = now(), conversa_resultado_id = excluded.conversa_resultado_id;
    end if;
    return jsonb_build_object('ok', true, 'conversa', c.id, 'token', v_tok, 'aberta', true, 'enviada', true, 'tipo', coalesce(c.paciente_tipo, 'proprio'), 'paciente_nome', c.paciente_nome,
                              'irmaos', coalesce(c.irmaos, '[]'::jsonb), 'irmaos_modo', c.irmaos_modo);
  end if;

  -- conversa encerrada: abre uma nova, do mesmo paciente, já no assunto
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), coalesce(c.email_informado, ct.email, a.email) into v_tel, v_email from public.contatos ct where ct.id = c.contato_id;
  v_nova := public.chat_nova_conversa(c.id, v_tok, coalesce(nullif(btrim(c.nome_informado), ''), a.nome), v_tel, v_email, true, true, 'acompanhar', null, null,
                                      coalesce(c.paciente_tipo, 'proprio'), c.paciente_nome, null, null, null, null);
  v_id := (v_nova ->> 'conversa_id')::uuid; v_ntok := v_nova ->> 'token';
  insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu, visto_sig, visto_em) values (a.id, v_id, ac.pessoa_nome, ac.eu, md5(''), now()) on conflict do nothing;

  for v_i in 1..8 loop   -- responde como se o paciente tivesse tocado; para sozinho no primeiro passo que depende dele
    select passo into v_passo from public.conversa_fluxo where conversa_id = v_id;
    exit when v_passo is null or v_passo is not distinct from v_antes;
    v_antes := v_passo;
    begin
      if v_passo in ('cpf_nasc', 'cpf_confirma', 'identidade') then
        exit when coalesce((public.app_chat_dados(p_token, v_id, v_ntok) ->> 'respondeu')::int, 0) = 0;
      elsif v_passo = 'motivo' then perform public.chat_responder(v_id, v_ntok, 'motivo', to_jsonb('assunto'::text), 'Outro assunto', null);
      elsif v_passo = 'assunto' then perform public.chat_responder(v_id, v_ntok, 'assunto', to_jsonb(v_assunto), v_texto, null); v_dir := true;
      elsif v_passo = 'resultado_situacao' and p_acao = 'resultado' then perform public.chat_responder(v_id, v_ntok, 'resultado_situacao', to_jsonb('acesso'::text), 'Receber o link ou a senha do resultado', null);
      elsif v_passo = 'resultado_orientacao' and p_acao = 'resultado' then perform public.chat_responder(v_id, v_ntok, 'resultado_orientacao', to_jsonb('equipe'::text), 'Chamar a equipe agora', null); exit;
      else exit; end if;
    exception when others then exit; end;
  end loop;

  if p_acao = 'resultado' then
    insert into public.app_resultado (paciente_id, conversa_id, exame_id, estado, solicitado_em, conversa_resultado_id)
    values (a.id, p_conversa, v_exame.id, 'solicitado', now(), v_id)
    on conflict (paciente_id, conversa_id, exame_id) do update set estado = case when public.app_resultado.estado = 'entregue' then 'entregue' else 'solicitado' end,
      solicitado_em = now(), conversa_resultado_id = excluded.conversa_resultado_id;
  end if;
  select passo into v_passo from public.conversa_fluxo where conversa_id = v_id;
  return jsonb_build_object('ok', true, 'conversa', v_id, 'token', v_ntok, 'aberta', true, 'nova', true, 'dirigida', v_dir, 'passo', v_passo, 'tipo', coalesce(c.paciente_tipo, 'proprio'),
                            'paciente_nome', c.paciente_nome, 'irmaos', '[]'::jsonb, 'irmaos_modo', null);
end $f$;
revoke all on function public.app_pedido_acao(text, uuid, text, bigint) from public;
grant execute on function public.app_pedido_acao(text, uuid, text, bigint) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 6. Resultado entregue: a equipe manda um arquivo ou um link na conversa onde o paciente pediu -> fica "entregue" e guardado
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_resultado_entregar_trg() returns trigger
language plpgsql security definer set search_path to ''
as $f$
begin
  if tg_table_name = 'conversa_anexo' then
    if new.tipo = 'equipe_arquivo' then
      update public.app_resultado set estado = 'entregue', entregue_em = now(), anexo_id = new.id where conversa_resultado_id = new.conversa_id and estado = 'solicitado';
    end if;
  elsif new.autor = 'agente' and new.agente_id is not null and new.texto ~* 'https?://' then
    update public.app_resultado set estado = 'entregue', entregue_em = now(), mensagem_id = new.id where conversa_resultado_id = new.conversa_id and estado = 'solicitado';
  end if;
  return new;
exception when others then return new;   -- nunca impede a equipe de enviar a mensagem
end $f$;
revoke all on function public.app_resultado_entregar_trg() from public, anon, authenticated;
create or replace trigger app_resultado_arquivo_trg after insert on public.conversa_anexo for each row execute function public.app_resultado_entregar_trg();
create or replace trigger app_resultado_mensagem_trg after insert on public.mensagens for each row execute function public.app_resultado_entregar_trg();

-- Equipe: entrega por texto sem link (ex.: "retire na recepção") ou conferência manual
create or replace function public.painel_resultado_entregue(p_conversa uuid) returns integer
language plpgsql security definer set search_path to ''
as $f$
declare n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  update public.app_resultado set estado = 'entregue', entregue_em = now() where conversa_resultado_id = p_conversa and estado = 'solicitado';
  get diagnostics n = row_count;
  return n;
end $f$;
revoke all on function public.painel_resultado_entregue(uuid) from public, anon;
grant execute on function public.painel_resultado_entregue(uuid) to authenticated;

-- O paciente baixa o arquivo guardado (PIN dos últimos 30 minutos; só o que é do próprio cadastro)
create or replace function public.app_resultado_arquivo(p_token text, p_id uuid) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record; x record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select x2.mime, x2.dados, x2.nome into x from public.app_resultado r join public.conversa_anexo x2 on x2.id = r.anexo_id
   where r.id = p_id and r.paciente_id = s.o_pac and r.estado = 'entregue';
  if not found then return jsonb_build_object('ok', false, 'erro', 'arquivo', 'mensagem', 'Não há arquivo guardado para este resultado. Abra a conversa para ver o que a equipe enviou.'); end if;
  return jsonb_build_object('ok', true, 'mime', x.mime, 'nome', x.nome, 'base64', encode(x.dados, 'base64'));
end $f$;
revoke all on function public.app_resultado_arquivo(text, uuid) from public;
grant execute on function public.app_resultado_arquivo(text, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 7. Vigia do resultado (Edge Function app-resultados-vigiar). LIGADA só com config.app_resultado_vigia = 'sim'.
--    Quem confere: exame FEITO (jornada), do cadastro, sem resultado entregue, dos últimos 90 dias, no máximo 1 conferência por exame a cada 30 min.
--    O Klingo diz "laudo pronto" pelo Id do atendimento (relatório C col0 = Id Atendimento do #14359 col1). Prontuário vem da própria Jornada (chave do cartão).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_resultados_a_conferir(p_limite integer default 30) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare v jsonb;
begin
  insert into public.app_resultado (paciente_id, conversa_id, exame_id)
  select ac.paciente_id, ac.conversa_id, e.id
    from public.app_conversa ac
    join public.jornada_card jc on jc.conversa_id = ac.conversa_id
    join public.jornada_exame e on e.card_id = jc.id
   where e.status = 'atendido' and e.agendado_para > now() - interval '90 days'
  on conflict (paciente_id, conversa_id, exame_id) do nothing;
  with alvo as (
    select r.id, e.atendimento_id, jc.paciente_chave as prontuario,
           coalesce(case when ac.eu then ap.nascimento end, (select f.nascimento from public.app_filho f where f.responsavel_id = ap.id and f.removido_em is null
                                                              and public.app_norm(f.nome) = public.app_norm(ac.pessoa_nome) limit 1)) as nascimento
      from public.app_resultado r
      join public.app_conversa ac on ac.paciente_id = r.paciente_id and ac.conversa_id = r.conversa_id
      join public.app_paciente ap on ap.id = r.paciente_id
      join public.jornada_exame e on e.id = r.exame_id
      join public.jornada_card jc on jc.id = e.card_id
     where r.estado = 'aguardando' and e.atendimento_id is not null and e.agendado_para > now() - interval '90 days'
       and jc.paciente_chave !~ '^(conv|manual):' and (r.conferido_em is null or r.conferido_em < now() - interval '30 minutes')
     order by r.conferido_em nulls first limit greatest(1, least(coalesce(p_limite, 30), 60))
  ), marca as (
    update public.app_resultado r set conferido_em = now() from alvo where r.id = alvo.id returning r.id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', alvo.id, 'atendimento', alvo.atendimento_id, 'prontuario', alvo.prontuario, 'nascimento', alvo.nascimento)) filter (where alvo.nascimento is not null), '[]'::jsonb)
    into v from alvo;
  return v;
end $f$;
revoke all on function public.app_resultados_a_conferir(integer) from public, anon, authenticated;

create or replace function public.app_resultado_disponivel(p_ids jsonb) returns integer
language plpgsql security definer set search_path to ''
as $f$
declare n integer;
begin
  update public.app_resultado set estado = 'disponivel', disponivel_em = now()
   where estado = 'aguardando' and id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) x);
  get diagnostics n = row_count;
  return n;
end $f$;
revoke all on function public.app_resultado_disponivel(jsonb) from public, anon, authenticated;

create or replace function public.app_resultados_disparar() returns void
language plpgsql security definer set search_path to ''
as $f$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if coalesce((select valor from public.config where chave = 'app_resultado_vigia'), 'nao') <> 'sim' or not public.app_modo() then return; end if;
  if v_base = '' or v_seg is null then return; end if;
  if not exists (select 1 from public.app_conversa ac join public.jornada_card jc on jc.conversa_id = ac.conversa_id join public.jornada_exame e on e.card_id = jc.id
                  where e.status = 'atendido' and e.agendado_para > now() - interval '90 days' limit 1) then return; end if;
  perform net.http_post(url := v_base || 'app-resultados-vigiar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('limite', 30), timeout_milliseconds := 120000);
exception when others then null;
end $f$;
revoke all on function public.app_resultados_disparar() from public, anon, authenticated;

do $c$
begin
  if to_regnamespace('cron') is not null then
    begin
      perform cron.unschedule('app-resultados-vigia');
    exception when others then null;   -- ainda não existia
    end;
    perform cron.schedule('app-resultados-vigia', '*/10 * * * *', 'select public.app_resultados_disparar()');
  end if;
exception when others then null;   -- ambiente sem pg_cron (clone de teste): a rotina é criada só na produção
end $c$;
