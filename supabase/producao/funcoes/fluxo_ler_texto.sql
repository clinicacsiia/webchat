-- public.fluxo_ler_texto(p_conversa uuid, p_passo text, p_texto text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_ler_texto(p_conversa uuid, p_passo text, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t text := public.fluxo_norm(p_texto); v_dt date; x text; v_med text[];
  sim boolean := t ~ '^(sim|s|isso|isso mesmo|pode|ok|okay|claro|correto|certo|confirmo|esta certo|ta certo|tudo certo|exato|positivo|uhum|aham)\M';
  nao boolean := t ~ '^(nao|n|negativo|errado|nada disso)\M';
begin
  case p_passo
  when 'identidade' then
    v_dt := public.fluxo_ler_data(p_texto);
    if v_dt is not null then return jsonb_build_object('dt_nasc', v_dt::text); end if;
  when 'motivo' then
    if t ~ '(exame|resson|reson|tomograf|ultras|ultrason|raio|\mrx\M|\mrm\M|\mtc\M|\musg?\M|mamograf|densitom|eletro|\mecg\M|\meeg\M|doppler|ecocard)' then return '"exame"'; end if;
    if t ~ '(consulta|medic|doutor|\mdra?\M|pediatr|cardiolog|ginecolog|ortoped|neuro|endocrin|gastro|urolog|nutri|puericult)' then return '"consulta"'; end if;
    if t ~ '(remarc|cancel|desmarc|resultado|laudo|duvida|reclama)' then return '"assunto"'; end if;
  when 'atalho' then
    if t ~ '(repetir|mesmo|ultimo)' then return '"ultimo"'; end if;
    if t ~ '(continuar|metade|pendente)' then return '"pendente"'; end if;
    if t ~ '(outro|novo|nova|diferente)' then return '"outro"'; end if;
  when 'assunto' then
    if t ~ '(remarc|mudar (o )?(dia|horario))' then return '"Remarcar"'; end if;
    if t ~ '(cancel|desmarc)' then return '"Cancelar"'; end if;
    if t ~ '(resultado|laudo)' then return '"Resultado de exame"'; end if;
    if t ~ '(reclama|sugest)' then return '"Reclamação"'; end if;
    if t ~ '(duvida|pergunta)' then return '"Dúvida"'; end if;
  when 'exame_aberto' then
    if t ~ '(cancel|desmarc)' then return '"cancelar"'; end if;
    if t ~ '(remarc|outro dia|outra data)' then return '"remarcar"'; end if;
    if t ~ '(nao (fui|consegui|pude|compareci|fiz)|faltei|perdi)' then return '"faltei"'; end if;
    if t ~ '(^|\m)(fui|fiz|compareci|realizei|feito)' then return '"compareceu"'; end if;
  when 'remarcar_falta' then
    if t ~ '(atendente|pessoa|humano|ligar)' then return '"atendente"'; end if;
    if nao or t ~ '(nao quero|desisti|deixa)' then return '"nao"'; end if;
    if sim or t ~ '(remarc|quero)' then return '"sim"'; end if;
  when 'assunto_confirma' then
    if sim then return '"sim"'; end if;
    if nao then return '"nao"'; end if;
  when 'assunto_resultado' then
    if sim or t ~ '(resolv|obrigad|valeu|deu certo)' then return '"resolvido"'; end if;
    if nao then return '"atendente"'; end if;
  when 'assunto_texto' then
    return jsonb_build_object('texto', left(btrim(p_texto), 500));
  when 'plano' then
    if t ~ '(particular|sem (plano|convenio)|nao tenho (plano|convenio))' then return '"Particular"'; end if;
    select q.operadora into x from (
      select o.operadora,
             count(*) filter (where t ~ ('\m' || w || '\M')) as acertos,
             count(*) filter (where t ~ ('\m' || w || '\M') and w !~ '^(saude|plano|planos|hospital|seguros|seguro|operadora|central|nacional|assistencia|vida|sa)$') as fortes
      from (select distinct operadora from public.catalogo_plano where coalesce(ativo, true) and operadora !~* '^(teste|particular)$') o
      cross join lateral unnest(string_to_array(regexp_replace(public.fluxo_norm(o.operadora), '[^a-z0-9 ]', ' ', 'g'), ' ')) w
      where length(w) >= 3
      group by o.operadora) q
    where q.fortes > 0 order by q.acertos desc, length(q.operadora) limit 1;
    if x is not null then return to_jsonb(x); end if;
  when 'plano_confirma' then
    if t ~ '(nao (mudou|mudei|mudaram|trocou|troquei)|nada mudou|continua|continuo)' then return '"sim"'; end if;
    if nao or t ~ '(mudou|mudei|mudaram|trocou|troquei|outro|novo|nova|diferente)' then return '"nao"'; end if;
    if sim or t ~ '(mesmo|igual)' then return '"sim"'; end if;
  when 'medico' then
    if t ~ '(tanto faz|qualquer|sem preferencia|nao tenho preferencia|nenhum)' then return '""'; end if;
    v_med := public.fluxo_medicos(p_conversa);
    select m into x from unnest(v_med) m where public.fluxo_norm(m) ~ ('\m' || split_part(t, ' ', 1)) and length(split_part(t, ' ', 1)) >= 3 limit 1;
    if x is not null then return to_jsonb(x); end if;
  when 'mudou' then
    if t ~ '(continua|mesmo|igual|nao mudou|nada mudou)' or nao then return '"igual"'; end if;
    if t ~ '(mudou|mudei|mudaram|novo|nova)' or sim then return '"mudou"'; end if;
  when 'confirmar' then
    if sim then return '"ok"'; end if;
  when 'horario' then
    if t ~ '(nenhum|nao (serve|da|consigo)|outro horario|outra data)' then return '"sem_horario"'; end if;
  else
    null;
  end case;
  return null;
end $function$;

