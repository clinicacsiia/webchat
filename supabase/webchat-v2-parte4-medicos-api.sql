-- Fluxo: Entrada (conversa; médicos do exame) → Validação (um único exame, API de horários ativa para a conversa, última consulta real à API válida)
--        → Processamento (próximo horário de cada médico = menor oferta da API daquele médico) → Persistência (nenhuma; só lê klingo_oferta/klingo_consulta) → Saída (lista de médicos).
-- Versão 1.0 — 14/11/2026 / Mudança: "próximo horário de cada médico" deixa de ler a grade (agenda_horarios/agenda_ocupacao) e passa a ler SÓ as ofertas devolvidas pela API do Klingo.
--   Sem consulta real (API desligada, fora do ar, vários exames) a lista volta VAZIA (a tela não escreve nada ao lado do médico). Médico sem oferta na janela consultada: proximo = null (a API não devolveu horário).
-- Depende de: webchat-v2-parte1-modos.sql (klingo_ativo, klingo_consulta, klingo_oferta.sombra). NÃO aplicada na produção.
-- Reversão: reaplicar supabase/producao/funcoes/medicos_disponiveis_interno.sql.

create or replace function public.medicos_disponiveis_interno(p_conversa uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_med text[]; v_procs int[]; v_agora timestamp := now() at time zone 'America/Bahia'; v_ult public.klingo_consulta; v_out jsonb; v_n int;
begin
  perform set_config('app.conversa', p_conversa::text, true);
  v_med := public.fluxo_medicos(p_conversa);
  v_procs := public.fluxo_procs(p_conversa);
  if v_procs is null or coalesce(cardinality(v_med), 0) = 0 then return '[]'::jsonb; end if;
  -- a API marca um procedimento por vez: com vários exames não há "próximo horário" confiável
  if cardinality(v_procs) <> 1 then return '[]'::jsonb; end if;
  if not public.klingo_ativo(p_conversa, 'klingo_api_horarios') then return '[]'::jsonb; end if;
  -- só vale se a API respondeu de verdade (lista com ou sem horários); erro, limite, estrutura inválida ou nenhuma consulta = não afirma nada
  select * into v_ult from public.klingo_consulta where conversa_id = p_conversa and modo not in ('sombra', 'monitor') and em > now() - interval '30 minutes' order by id desc limit 1;
  if v_ult.id is null or v_ult.resultado not in ('ok_com_horarios', 'api_sem_horarios', 'todos_filtrados') then return '[]'::jsonb; end if;
  select count(*) into v_n from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora;
  select coalesce(jsonb_agg(jsonb_build_object('nome', m,
           'proximo', (select to_char(min(o.data + o.hora::time), 'YYYY-MM-DD HH24:MI') from public.klingo_oferta o
                        where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora and public.klingo_prof_confere(o.profissional, m)),
           'livres', (select count(*) from public.klingo_oferta o
                        where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora and public.klingo_prof_confere(o.profissional, m)),
           'fonte', 'api_klingo', 'ofertas_na_consulta', v_n) order by m), '[]'::jsonb)
    into v_out from unnest(v_med) m;
  return v_out;
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Ofertas antigas "horario_oferta" (pendência I13): a aceitação conferia a GRADE. Agora só vale se a API ainda tem aquele horário (oferta válida desta conversa),
-- e a escolha grava a chave da oferta (sem ela o pipeline de marcação recusa). Sem oferta da API: "Esse horário acabou de ser ocupado" e segue o fluxo normal (calendário).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
do $m$
declare
  d text := pg_get_functiondef('public.fluxo_aplicar(uuid, text, jsonb)'::regprocedure);
  a1 text := 'declare v_p jsonb; v_n int; v_s jsonb; v_livre boolean := false; v_aviso text;';
  a2 text := E'select true into v_livre from public.agenda_horarios(public.fluxo_procs(p_conversa), (v_s ->> ''data'')::date, (v_s ->> ''data'')::date, null, null, null, ''[]''::jsonb) h where h.hora = v_s ->> ''hora'' limit 1;';
  a3 text := E'''chegada'', coalesce((v_s ->> ''chegada'')::boolean, false))),';
  n integer;
begin
  foreach n in array array[(length(d) - length(replace(d, a1, ''))) / length(a1), (length(d) - length(replace(d, a2, ''))) / length(a2), (length(d) - length(replace(d, a3, ''))) / length(a3)] loop
    if n <> 1 then raise exception 'fluxo_aplicar: trecho esperado não encontrado exatamente uma vez (%)', n; end if;
  end loop;
  d := replace(d, a1, 'declare v_p jsonb; v_n int; v_s jsonb; v_livre boolean := false; v_aviso text; v_chave text;');
  d := replace(d, a2, E'select o.chave into v_chave from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.data = (v_s ->> ''data'')::date and o.hora = v_s ->> ''hora'' and (o.data + o.hora::time) > (now() at time zone ''America/Bahia'') order by o.id limit 1;\n        v_livre := v_chave is not null;   -- v2.1: vale só o que a API ainda oferece (a grade não é vaga)');
  d := replace(d, a3, E'''chegada'', coalesce((v_s ->> ''chegada'')::boolean, false), ''origem'', ''klingo_api'', ''klingo_chave'', v_chave)),');
  execute d;
end $m$;
