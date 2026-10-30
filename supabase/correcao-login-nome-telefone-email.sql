-- Correção: nome + telefone + e-mail do início do chat funcionam como um LOGIN. JÁ APLICADO (30/10/2026) no projeto webchat-atendimento.
-- Antes: bastavam 2 de 3 campos para reaproveitar um cadastro ("parcial"), o pedido pela metade era buscado só pelo telefone (contato) e o
-- histórico era ligado ao paciente só por telefone + nome. Quem usava o telefone de outra pessoa podia ver ou herdar dados dela.
-- Agora só há reaproveitamento quando nome E telefone batem e, se o cadastro tem e-mail, o e-mail também bate. Qualquer outra combinação
-- é paciente novo (não vê nada do outro). Depois disso a IA ainda pede a data de nascimento (segundo fator) antes de usar qualquer dado.
-- Cada bloco falha sem alterar nada se o ponto de substituição não for encontrado. Sem comandos destrutivos.

-- 1. paciente_conferir: só "completo" ou "novo".
do $$
declare d text; d2 text;
  a1 text := 'select p.id, p.validado, p.dt_nasc,';
  a2 text := 'v_sit := case when v_m = v_t then ''completo'' when v_m >= 2 then ''parcial'' else ''novo'' end;';
begin
  d := pg_get_functiondef('public.paciente_conferir(uuid)'::regprocedure);
  if position('p_email' in d) > 0 then return; end if;
  if length(d) - length(replace(d, a1, '')) <> length(a1) or length(d) - length(replace(d, a2, '')) <> length(a2) then
    raise exception 'paciente_conferir: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, a1, 'select p.id, p.email as p_email, p.validado, p.dt_nasc,');
  d2 := replace(d2, a2, 'v_sit := case when b.n_ok and b.t_ok and (b.p_email is null or b.e_ok) then ''completo'' else ''novo'' end;');
  execute d2;
end $$;

-- 2. Pedido pela metade: só de conversa da MESMA pessoa (mesmo nome e mesmo e-mail), não de qualquer um que usou o telefone.
create or replace function public.pre_pendencia_anterior(p_conversa uuid) returns uuid
language sql stable security definer set search_path to '' as $$
  select pa.conversa_id
  from public.conversas atual
  join public.contatos ca on ca.id = atual.contato_id
  join public.conversas c2 on c2.contato_id = atual.contato_id and c2.id <> atual.id
  join public.contatos cb on cb.id = c2.contato_id
  join public.pre_agendamentos pa on pa.conversa_id = c2.id
  where atual.id = p_conversa and pa.status in ('rascunho','pronto') and pa.atualizado_em > now() - interval '7 days'
    and public.nome_confere(coalesce(atual.nome_informado, ca.nome), coalesce(c2.nome_informado, cb.nome))
    and lower(coalesce(nullif(btrim(case when atual.nome_informado is not null then atual.email_informado else ca.email end), ''), ''))
      = lower(coalesce(nullif(btrim(case when c2.nome_informado is not null then c2.email_informado else cb.email end), ''), ''))
    and exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is not null)
  order by pa.atualizado_em desc limit 1
$$;
revoke all on function public.pre_pendencia_anterior(uuid) from public, anon, authenticated;

-- 3. Gatilho do histórico: achar o paciente por telefone + nome + e-mail (quando o cadastro tem e-mail).
do $$
declare d text; d2 text; alvo text := 'and public.nome_confere(coalesce(c.nome_informado, ct.nome), p.nome)';
begin
  d := pg_get_functiondef('public.pre_agendamento_historico_trg()'::regprocedure);
  if position('c.email_informado' in d) > 0 then return; end if;
  if length(d) - length(replace(d, alvo, '')) <> length(alvo) then raise exception 'pre_agendamento_historico_trg: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, alvo, alvo || ' and (p.email is null or lower(p.email) = lower(coalesce(nullif(btrim(case when c.nome_informado is not null then c.email_informado else ct.email end), ''''), '''')))');
  execute d2;
end $$;

-- 4. Conversa nova (nome_informado preenchido) só usa o e-mail digitado nela: sem e-mail digitado não herda o do contato antigo.
-- (Aplicado como patch: em paciente_conferir e pre_agendamento_historico_trg, 'coalesce(c.email_informado, ct.email)' virou
--  '(case when c.nome_informado is not null then c.email_informado else ct.email end)'; os trechos acima já refletem isso.)
