-- FLUXOGRAMA: entrada (o paciente do acesso rápido, com o PIN ativo, toca em "Fazer check-in" na página /minha-vez/)
--   -> validação (aparelho conhecido e desbloqueado pelo PIN, o mesmo teste de todas as funções app_*; sem PIN ou aparelho vencido volta "bloqueado"/"sessao" e a tela pede o PIN)
--   -> lógica (usa o nome, o e-mail e o celular do CADASTRO do acesso rápido; se a pessoa já está na fila de hoje devolve a mesma linha em vez de duplicar;
--              respeita o mesmo limite diário de check-ins sem conta que a função checkin_publico; NÃO pergunta senha: o PIN já provou quem é)
--   -> saída (JSON igual ao do checkin_publico: situação da fila + ticket, mais "ok": true; nada de CPF)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (defeito: o check-in de um toque chamava checkin_publico, que ao achar conta com o mesmo e-mail e celular pedia a SENHA da conta antiga, mesmo com o PIN ativo)
--
-- DEPENDE DE: acesso-rapido-paciente.sql (app_aparelho_validar, app_erro_json, app_paciente), fila (fila_chegada, fila_situacao_linha, fila_dia, fila_posicao), fone_digitos, fone_chave.
--
-- POR QUE UMA FUNÇÃO NOVA E NÃO MEXER NA checkin_publico:
--   checkin_publico é a porta aberta ao público SEM identidade (só nome, e-mail e celular digitados): por isso, quando acha uma conta com o mesmo e-mail e celular, ela pede a senha em vez de
--   confiar. Quem entrou pelo celular + PIN já foi identificado pelo servidor; esta função confia no PIN e não no que a tela manda.
--
-- ROLLBACK: drop function if exists public.app_checkin(text);   (a tela volta a chamar checkin_publico se a versão anterior do minha-vez/index.html for republicada)
-- COMO APLICAR (limite de 60 s do conector): uma parte só (create or replace + permissões). Pode ser aplicado mais de uma vez.

create or replace function public.app_checkin(p_token text) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare
  s record; a public.app_paciente%rowtype; r public.fila_chegada%rowtype;
  v_nome text; v_email text; v_fone text; v_max int; v_senha int;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  if not found then return public.app_erro_json('sessao'); end if;

  v_nome := left(coalesce(nullif(regexp_replace(btrim(coalesce(a.nome, '')), '\s+', ' ', 'g'), ''), 'Paciente'), 120);
  v_email := nullif(lower(btrim(coalesce(a.email, ''))), '');
  v_fone := public.fone_digitos(a.telefone);

  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  select * into r from public.fila_chegada
   where status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())
     and lower(btrim(nome)) = lower(v_nome) and public.fone_chave(telefone) is not distinct from public.fone_chave(v_fone)
   order by chegou_em limit 1;
  if r.id is not null then
    return jsonb_build_object('ok', true) || public.fila_situacao_linha(r) || jsonb_build_object('ticket', r.ticket);
  end if;

  select coalesce(nullif(valor, '')::int, 300) into v_max from public.config where chave = 'checkin_sem_login_max_dia';
  if (select count(*) from public.fila_chegada where conta_id is null and origem = 'paciente' and public.fila_dia(chegou_em) = public.fila_dia(now())) >= coalesce(v_max, 300) then
    raise exception 'Muitos check-ins agora. Avise a recepção.' using errcode = '54000';
  end if;
  select coalesce(max(senha), 0) + 1 into v_senha from public.fila_chegada where public.fila_dia(chegou_em) = public.fila_dia(now());
  insert into public.fila_chegada (nome, senha, origem, email, telefone, pede_senha)
  values (v_nome, v_senha, 'paciente', v_email, v_fone, false) returning * into r;
  return jsonb_build_object('ok', true) || public.fila_situacao_linha(r) || jsonb_build_object('ticket', r.ticket);
end $f$;

revoke all on function public.app_checkin(text) from public;
grant execute on function public.app_checkin(text) to anon, authenticated;
