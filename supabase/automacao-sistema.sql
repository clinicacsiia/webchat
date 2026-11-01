-- FLUXOGRAMA: entrada (o Klingo muda o status de um exame; alguém chega pelo QR code e entra na fila) -> validação (o cartão do Klingo precisa bater em 3 informações com a conversa: nome, marca do telefone, mesmo dia; só equipe lê a identificação) -> lógica (status do exame no Klingo fecha na hora o exame em aberto da conversa e encerra a conversa resolvida; quem entra na fila é identificado sozinho: paciente já cadastrado, novo ou "talvez", conversas dele, exames em aberto e exames do Klingo) -> saída (gatilhos em jornada_exame, RPC fila_identificar_todos para a aba Fila)
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
-- Pré-requisitos: pessoa-unica.sql e pessoa-unica-jornada.sql (agendamento_conferir_klingo, v_agendamento_aberto), pacientes.sql, fila-chegada.sql, checkin-sem-login.sql. Aditivo e idempotente. Nenhum comando destrutivo.
--
-- ROLLBACK: drop trigger jornada_exame_conferir_ins on public.jornada_exame; drop trigger jornada_exame_conferir_upd on public.jornada_exame; drop function public.jornada_exame_conferir_ins(), public.jornada_exame_conferir_upd(), public.fila_identificar_todos();
--   (a rotina de 10 minutos 'agendamento-klingo' continua como rede de segurança)

-- 1) Status mudou no Klingo -> confere na hora (a rotina de 10 min fica como reserva). Erro aqui nunca pode derrubar a leitura do Klingo.
create or replace function public.jornada_exame_conferir_ins() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if exists (select 1 from n where n.status in ('atendido', 'faltou', 'cancelado', 'remarcado')) then
    begin perform public.agendamento_conferir_klingo(); exception when others then null; end;
  end if;
  return null;
end $$;
create or replace function public.jornada_exame_conferir_upd() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if exists (select 1 from n join o on o.id = n.id where n.status is distinct from o.status and n.status in ('atendido', 'faltou', 'cancelado', 'remarcado')) then
    begin perform public.agendamento_conferir_klingo(); exception when others then null; end;
  end if;
  return null;
end $$;
revoke all on function public.jornada_exame_conferir_ins(), public.jornada_exame_conferir_upd() from public, anon, authenticated;
create or replace trigger jornada_exame_conferir_ins after insert on public.jornada_exame referencing new table as n for each statement execute function public.jornada_exame_conferir_ins();
create or replace trigger jornada_exame_conferir_upd after update on public.jornada_exame referencing old table as o new table as n for each statement execute function public.jornada_exame_conferir_upd();

-- 2) Quem entrou na fila hoje: o sistema já diz quem é.
--   situacao: 'cadastrado' (telefone ou e-mail E nome batem com um paciente), 'talvez' (telefone ou e-mail batem mas o nome não: família?), 'novo' (nada bate)
--   conversas: conversas do chat da mesma pessoa (nome + telefone); abertos: exames marcados pelo chat que ninguém fechou ainda (pendente = o horário já passou)
--   klingo: exames de hoje no Klingo da mesma pessoa (nome + marca do telefone), só o nome do exame e o status
create or replace function public.fila_identificar_todos() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r record; v_sal text; v_fh text; v_fone text; v_sit text; v_pac record; v_out jsonb := '[]'::jsonb; v_conv jsonb; v_aber jsonb; v_kl jsonb;
begin
  perform public.fila_equipe_ok();
  select valor into v_sal from public.config where chave = 'ia_segredo';
  for r in
    select f.id, f.nome, f.email, f.telefone, f.conta_id, cp.nome as conta_nome, cp.telefone as conta_tel, cp.email as conta_email
      from public.fila_chegada f left join public.contas_paciente cp on cp.id = f.conta_id
     where f.status in ('aguardando', 'chamado') and public.fila_dia(f.chegou_em) = public.fila_dia(now())
  loop
    v_fone := public.fone_chave(coalesce(r.telefone, r.conta_tel));
    v_fh := case when v_fone is not null then encode(sha256(convert_to(right(regexp_replace(coalesce(r.telefone, r.conta_tel, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex') end;
    v_pac := null; v_sit := 'novo';
    select p.id, p.nome, public.nome_confere(p.nome, coalesce(r.conta_nome, r.nome)) as nome_ok into v_pac
      from public.pacientes p
     where (v_fone is not null and v_fone = any (p.telefones)) or (coalesce(r.email, r.conta_email, '') <> '' and lower(p.email) = lower(coalesce(r.email, r.conta_email)))
     order by public.nome_confere(p.nome, coalesce(r.conta_nome, r.nome)) desc, p.ultima_visita_em desc limit 1;
    if v_pac.id is not null then v_sit := case when v_pac.nome_ok then 'cadastrado' else 'talvez' end; end if;

    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status) order by x.atualizado_em desc), '[]'::jsonb) into v_conv
      from (select cv.id, cv.status, cv.atualizado_em from public.conversas cv join public.contatos ct on ct.id = cv.contato_id
             where v_fone is not null and public.fone_chave(ct.telefone) = v_fone and public.nome_confere(public.pessoa_ficha(cv.id) ->> 'nome', coalesce(r.conta_nome, r.nome))
             order by cv.atualizado_em desc limit 5) x;
    select coalesce(jsonb_agg(jsonb_build_object('conversa_id', a.conversa_id, 'exames', a.exames, 'pendente', a.passou) order by a.quando), '[]'::jsonb) into v_aber
      from public.v_agendamento_aberto a where a.conversa_id in (select (e ->> 'id')::uuid from jsonb_array_elements(v_conv) e);
    select coalesce(jsonb_agg(jsonb_build_object('nome', e.procedimento, 'status', e.status) order by e.id), '[]'::jsonb) into v_kl
      from public.jornada_card c join public.jornada_paciente jp on jp.prontuario = c.paciente_chave join public.jornada_exame e on e.card_id = c.id
     where c.arquivado_em is null and c.data_ref = public.fila_dia(now()) and c.paciente_chave not like 'conv:%' and c.paciente_chave not like 'manual:%'
       and v_fh is not null and jp.fone_chave = v_fh and public.nome_confere(jp.nome, coalesce(r.conta_nome, r.nome));
    v_out := v_out || jsonb_build_object('id', r.id, 'situacao', v_sit, 'paciente_nome', v_pac.nome, 'conversas', v_conv, 'abertos', v_aber, 'klingo', v_kl);
  end loop;
  return v_out;
end $$;
revoke all on function public.fila_identificar_todos() from public, anon;
grant execute on function public.fila_identificar_todos() to authenticated;
