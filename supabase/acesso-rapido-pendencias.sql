-- FLUXOGRAMA: entrada (o paciente já dentro do acesso rápido, com o PIN digitado: a tela e o chat chamam app_pendencias e app_pendencia_responder com o código do aparelho; a equipe chama painel_app_revisoes) -> validação (aparelho desbloqueado; CPF com dígito verificador; e-mail no formato; só a pessoa do próprio cadastro ou um filho DESTE cadastro) -> lógica (lista o que falta para CADA pessoa: CPF do titular, CPF de cada filho e e-mail; ao receber o CPF confere em silêncio com a base da clínica: sugere o vínculo quando o cadastro bate e MARCA PARA A EQUIPE quando há dúvida) -> saída (ao paciente só "pendências" e "salvo", nunca o que a clínica tem guardado; à equipe, a lista de cadastros em dúvida)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (todo contato que usa o acesso rápido é solicitado a completar o que falta; dúvidas vão para a equipe)
--
-- POR QUE: o dono quer que TODO paciente (não só quem veio de conta antiga) tenha o cadastro completo e, havendo dúvida ou informação pendente, seja
-- solicitado. O celular NÃO é confirmado por SMS: quem sabe o celular, o nome e o nascimento de outra pessoa consegue criar um acesso rápido em nome dela.
-- Por isso NADA da base da clínica (public.pacientes / contatos) é copiado ou mostrado a quem só digitou o celular. O paciente é que informa; o servidor
-- compara em silêncio. Quem entrou por conta antiga (e-mail e senha) já foi tratado em acesso-rapido-conta-antiga.sql.
--
-- O QUE É PERGUNTADO (app_pendencias_lista): CPF do titular, e-mail do titular (opcional), CPF de cada filho. O texto da pergunta é o mesmo exista ou não
-- cadastro na clínica (não dá para descobrir, pela pergunta, se um celular ou CPF já é da clínica).
--
-- O QUE É CONFERIDO EM SILÊNCIO (app_conferir_cadastro, sempre que há CPF novo; o resultado NUNCA volta para o paciente):
--   * CPF bate com UM cadastro da clínica que tem o mesmo celular  -> grava paciente_sugerido_id (sugestão; nunca vínculo sozinho) e limpa a marca;
--   * CPF bate com um cadastro, mas de OUTRO celular               -> marca 'cpf_com_outro_celular' para a equipe;
--   * CPF repetido em mais de um cadastro da clínica               -> marca 'cpf_repetido_na_clinica';
--   * CPF não existe na clínica, mas o celular existe lá           -> marca 'cpf_nao_bate_com_o_celular';
--   * nada na clínica (paciente novo)                              -> sem marca.
--   A equipe vê tudo em painel_app_revisoes() (também os cadastros cujo celular já existe na clínica e ainda não têm vínculo) e resolve com
--   painel_app_revisao_resolver(id).
--
-- SEGURANÇA: as funções do paciente exigem aparelho desbloqueado pelo PIN; nenhuma devolve CPF inteiro, dado da clínica ou o resultado da conferência
-- (senão seria um jeito de testar CPFs: "bateu / não bateu"). As da equipe exigem papel admin ou atendente.
--
-- ROLLBACK (não mexe em nenhuma função existente):
--   drop function if exists public.painel_app_revisao_resolver(uuid), public.painel_app_revisoes(), public.app_pendencia_responder(text, text, text, text),
--     public.app_pendencias(text), public.app_conferir_cadastro(uuid), public.app_pendencias_lista(uuid);
--   alter table public.app_paciente drop column if exists revisar_motivo, drop column if exists revisao_resolvida_em, drop column if exists cadastro_conferido_em;
-- Pode ser aplicado mais de uma vez.

alter table public.app_paciente add column if not exists revisar_motivo text check (revisar_motivo is null or revisar_motivo in ('cpf_com_outro_celular', 'cpf_repetido_na_clinica', 'cpf_nao_bate_com_o_celular'));
alter table public.app_paciente add column if not exists revisao_resolvida_em timestamptz;
alter table public.app_paciente add column if not exists cadastro_conferido_em timestamptz;
comment on column public.app_paciente.revisar_motivo is 'Dúvida na conferência com a base da clínica (só a equipe vê). Nunca vai para a tela do paciente.';
comment on column public.app_paciente.revisao_resolvida_em is 'Quando a equipe deu a dúvida por resolvida (esconde também o aviso "celular já existe na clínica sem vínculo").';
comment on column public.app_paciente.cadastro_conferido_em is 'Última vez que o CPF foi conferido com a base da clínica; se atualizado_em for mais novo, confere de novo.';

-- Interno: o que falta para o titular e para cada filho.
create or replace function public.app_pendencias_lista(p_pac uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(t.x order by t.ord, t.x ->> 'nome'), '[]'::jsonb) from (
    select 1 as ord, jsonb_build_object('id', 'eu:cpf', 'pessoa', 'eu', 'nome', a.nome, 'campo', 'cpf', 'opcional', false,
             'pergunta', 'Qual é o seu CPF? Assim o chat não pergunta de novo.') as x
      from public.app_paciente a where a.id = p_pac and a.cpf is null
    union all
    select 2, jsonb_build_object('id', 'eu:email', 'pessoa', 'eu', 'nome', a.nome, 'campo', 'email', 'opcional', true,
             'pergunta', 'Qual é o seu e-mail? (opcional, para a clínica falar com você)')
      from public.app_paciente a where a.id = p_pac and a.email is null
    union all
    select 3, jsonb_build_object('id', f.id::text || ':cpf', 'pessoa', f.id, 'nome', f.nome, 'campo', 'cpf', 'opcional', false,
             'pergunta', 'Qual é o CPF de ' || split_part(f.nome, ' ', 1) || '? (se a criança não tiver, o do responsável)')
      from public.app_filho f where f.responsavel_id = p_pac and f.removido_em is null and f.cpf is null
  ) t $$;

-- Interno: compara o CPF do titular com a base da clínica e deixa a marca para a equipe. Não devolve nada.
create or replace function public.app_conferir_cadastro(p_pac uuid) returns void language plpgsql security definer set search_path to '' as $$
declare
  a public.app_paciente%rowtype; v_fmt text; v_n integer; v_id uuid; v_mesmo_celular boolean; v_celular_na_base boolean; v_motivo text;
begin
  select * into a from public.app_paciente where id = p_pac for update;
  if not found or a.cpf is null then return; end if;
  v_fmt := substr(a.cpf, 1, 3) || '.' || substr(a.cpf, 4, 3) || '.' || substr(a.cpf, 7, 3) || '-' || substr(a.cpf, 10, 2);
  select count(*), (array_agg(p.id))[1], coalesce(bool_or(p.telefones && array[a.telefone, '55' || a.telefone]), false)
    into v_n, v_id, v_mesmo_celular from public.pacientes p where p.cpf = a.cpf or p.cpf = v_fmt;
  v_celular_na_base := exists (select 1 from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]);
  if v_n = 1 and v_mesmo_celular then v_motivo := null;
  elsif v_n = 1 then v_motivo := 'cpf_com_outro_celular';
  elsif v_n > 1 then v_motivo := 'cpf_repetido_na_clinica';
  elsif v_celular_na_base then v_motivo := 'cpf_nao_bate_com_o_celular';
  end if;
  update public.app_paciente set
    paciente_sugerido_id = case when v_n = 1 and v_mesmo_celular then coalesce(paciente_sugerido_id, v_id) else paciente_sugerido_id end,
    revisar_motivo = v_motivo,
    revisao_resolvida_em = case when v_motivo is distinct from revisar_motivo then null else revisao_resolvida_em end,
    cadastro_conferido_em = now()
  where id = p_pac;
end $$;

-- O que ainda falta para este cadastro (titular e filhos). Confere o CPF de novo se ele mudou (por exemplo, digitado no chat).
create or replace function public.app_pendencias(p_token text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare s record; a public.app_paciente%rowtype;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  if a.cpf is not null and (a.cadastro_conferido_em is null or a.cadastro_conferido_em < a.atualizado_em) then perform public.app_conferir_cadastro(a.id); end if;
  return jsonb_build_object('ok', true, 'pendencias', public.app_pendencias_lista(s.o_pac));
end $$;

-- Responde uma pendência: p_pessoa = 'eu' ou o id de um filho; p_campo = 'cpf' (qualquer pessoa) ou 'email' (só 'eu'). p_valor vazio não grava nada.
create or replace function public.app_pendencia_responder(p_token text, p_pessoa text, p_campo text, p_valor text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; v_cpf text; v_email text; v_id uuid;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if p_campo = 'cpf' then
    v_cpf := regexp_replace(coalesce(p_valor, ''), '\D', '', 'g');
    if not public.fluxo_cpf_ok(v_cpf) then return jsonb_build_object('ok', false, 'erro', 'cpf', 'mensagem', 'Os números do CPF não conferem. Confira, por favor.'); end if;
    if p_pessoa = 'eu' then
      update public.app_paciente set cpf = v_cpf, atualizado_em = now() where id = s.o_pac and cpf is null;
      perform public.app_conferir_cadastro(s.o_pac);
    elsif coalesce(p_pessoa, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      update public.app_filho set cpf = v_cpf where id = p_pessoa::uuid and responsavel_id = s.o_pac and removido_em is null and cpf is null returning id into v_id;
      if v_id is null then return jsonb_build_object('ok', false, 'erro', 'pessoa', 'mensagem', 'Pessoa não encontrada no seu cadastro.'); end if;
    else
      return jsonb_build_object('ok', false, 'erro', 'pessoa', 'mensagem', 'Pessoa não encontrada no seu cadastro.');
    end if;
  elsif p_campo = 'email' and p_pessoa = 'eu' then
    v_email := lower(btrim(coalesce(p_valor, '')));
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 200 then
      return jsonb_build_object('ok', false, 'erro', 'email', 'mensagem', 'Esse e-mail não parece certo. Confira, por favor.');
    end if;
    update public.app_paciente set email = v_email, atualizado_em = now() where id = s.o_pac and email is null;
  else
    return jsonb_build_object('ok', false, 'erro', 'campo', 'mensagem', 'Não foi possível salvar.');
  end if;
  return jsonb_build_object('ok', true, 'pendencias', public.app_pendencias_lista(s.o_pac), 'perfil', public.app_perfil_json(s.o_pac));
end $$;

-- Equipe: cadastros do acesso rápido com dúvida (marcados na conferência) ou cujo celular já existe na clínica sem vínculo. Sem CPF inteiro.
create or replace function public.painel_app_revisoes() returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as revisões.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(r order by r ->> 'criado_em' desc) from (
    select jsonb_build_object('id', a.id, 'nome', a.nome, 'celular', a.telefone, 'nascimento', a.nascimento, 'cpf_mascara', public.app_cpf_mascara(a.cpf),
      'motivo', coalesce(a.revisar_motivo, 'celular_na_base_sem_vinculo'),
      'cadastros_com_o_celular', (select count(*) from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]),
      'criado_em', a.criado_em) as r
    from public.app_paciente a
    where a.revisar_motivo is not null
       or (a.paciente_sugerido_id is null and a.revisao_resolvida_em is null and exists (select 1 from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]))
    order by a.criado_em desc limit 300) x), '[]'::jsonb);
end $$;

create or replace function public.painel_app_revisao_resolver(p_id uuid) returns integer language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe resolve as revisões.' using errcode = '42501'; end if;
  update public.app_paciente set revisar_motivo = null, revisao_resolvida_em = now() where id = p_id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.app_pendencias_lista(uuid), public.app_conferir_cadastro(uuid), public.app_pendencias(text), public.app_pendencia_responder(text, text, text, text),
  public.painel_app_revisoes(), public.painel_app_revisao_resolver(uuid) from public, anon, authenticated;
grant execute on function public.app_pendencias(text), public.app_pendencia_responder(text, text, text, text) to anon, authenticated;
grant execute on function public.painel_app_revisoes(), public.painel_app_revisao_resolver(uuid) to authenticated;
