-- FLUXOGRAMA: entrada (conversa do chat; nome, telefone e e-mail digitados no início + data de nascimento digitada) -> validação (chave config.reaproveitar_cadastro_convidado; cadastros em revisão são ignorados) -> lógica (convidado = sempre "novo", sem reaproveitar cadastro nem histórico; com a chave 'sim' vale a regra anterior: nome E telefone (e e-mail, se o cadastro tem) + data de nascimento; desempate prefere cadastro validado) -> saída (jsonb {situacao, paciente_id, dt_nasc_conferida, ...} ou {situacao: 'novo'})
-- Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
--
-- POR QUE: a data de nascimento era o único segredo real para liberar histórico e reaproveitar cadastro (nome, telefone e e-mail
-- não são verificados), sem limite de tentativas e com resposta visível a quem acerta (ver a auditoria de 31/10/2026).
-- Com o login do paciente, quem precisa de cadastro pré-preenchido ou histórico entra com conta. Quem agenda SEM login passa a ser
-- sempre "paciente novo": o motor não pergunta a data de nascimento, não mostra histórico e não copia pedido anterior.
-- Como todos os pontos de entrada (fluxo_proximo, paciente_historico_para_ia, pre_reaproveitar, ia_pre_agendar, ia_contexto) passam
-- por paciente_conferir, trocar só esta função fecha o caminho do motor 'fluxo' e do motor 'ia'.
--
-- ESTA É A DEFINIÇÃO VIVA DA PRODUÇÃO (copiada de pg_get_functiondef em 31/10/2026), mais as 3 mudanças marcadas com "-- NOVO".
-- Isso também corrige a divergência: a cópia de supabase/pacientes.sql é a versão antiga (regra "2 de 3", sem nome_informado).
--
-- LIGAR DE NOVO (se a recepção precisar do comportamento antigo por algum motivo):
--     update public.config set valor = 'sim' where chave = 'reaproveitar_cadastro_convidado';
-- ROLLBACK COMPLETO: recriar a função sem o bloco "-- NOVO" (a definição anterior está em supabase/correcao-login-nome-telefone-email.sql
-- e no histórico do git, commit 72700ff).
-- Nenhum comando destrutivo. Pode ser aplicado mais de uma vez.

insert into public.config (chave, valor) values ('reaproveitar_cadastro_convidado', 'nao') on conflict (chave) do nothing;

create or replace function public.paciente_conferir(p_conversa uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_ct record; b record; v_dt text; v_conf boolean; v_t int; v_m int; v_sit text;
begin
  -- NOVO: convidado (sem login) nunca reaproveita cadastro nem histórico. Ausente ou diferente de 'sim' = fechado.
  if coalesce((select valor from public.config where chave = 'reaproveitar_cadastro_convidado'), 'nao') <> 'sim' then
    return jsonb_build_object('situacao', 'novo');
  end if;

  select coalesce(c.nome_informado, ct.nome) as nome, ct.telefone, nullif(btrim((case when c.nome_informado is not null then c.email_informado else ct.email end)), '') as email into v_ct
  from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if not found then return jsonb_build_object('situacao', 'novo'); end if;
  if (select c.paciente_tipo from public.conversas c where c.id = p_conversa) = 'filho' then
    v_ct.nome := (select coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), c.paciente_nome) from public.conversas c
                  left join public.pre_agendamentos pa on pa.conversa_id = c.id where c.id = p_conversa);
    if v_ct.nome is null then return jsonb_build_object('situacao', 'novo'); end if;
  end if;

  select q.* into b from (
    select p.id, p.email as p_email, p.validado, p.dt_nasc, p.ultima_visita_em, p.atualizado_em,
           public.nome_confere(v_ct.nome, p.nome) as n_ok,
           coalesce(public.fone_chave(v_ct.telefone) = any(p.telefones), false) as t_ok,
           (v_ct.email is not null and p.email is not null and lower(v_ct.email) = lower(p.email)) as e_ok,
           (v_ct.email is not null and p.email is not null) as e_cmp
    from public.pacientes p
    where p.origem_conversa is distinct from p_conversa
      and not p.revisar   -- NOVO: cadastro marcado para revisão (CPF repetido, data divergente) não serve de base para ninguém
      and (public.fone_chave(v_ct.telefone) = any(p.telefones) or public.nome_confere(v_ct.nome, p.nome)
           or (v_ct.email is not null and lower(v_ct.email) = lower(p.email)))) q
  order by (q.n_ok::int + q.t_ok::int + q.e_ok::int) desc, q.validado desc, q.atualizado_em desc limit 1;   -- NOVO: validado desempata antes do mais recente
  if not found then return jsonb_build_object('situacao', 'novo'); end if;

  v_t := 2 + b.e_cmp::int;
  v_m := b.n_ok::int + b.t_ok::int + b.e_ok::int;
  v_sit := case when b.n_ok and b.t_ok and (b.p_email is null or b.e_ok) then 'completo' else 'novo' end;
  if v_sit = 'novo' then return jsonb_build_object('situacao', 'novo'); end if;

  select paciente ->> 'dt_nasc' into v_dt from public.pre_agendamentos where conversa_id = p_conversa;
  v_conf := case when public.data_ou_nula(v_dt) is not null and b.dt_nasc is not null then public.data_ou_nula(v_dt) = b.dt_nasc else null end;
  return jsonb_build_object('situacao', v_sit, 'paciente_id', b.id,
    'batem', to_jsonb(array_remove(array[case when b.n_ok then 'nome' end, case when b.t_ok then 'telefone' end, case when b.e_ok then 'email' end], null)),
    'diferem', to_jsonb(array_remove(array[case when not b.n_ok then 'nome' end, case when not b.t_ok then 'telefone' end, case when b.e_cmp and not b.e_ok then 'email' end], null)),
    'validado', b.validado, 'dt_nasc_conferida', v_conf, 'ultima_visita_em', b.ultima_visita_em::date);
end $function$;
