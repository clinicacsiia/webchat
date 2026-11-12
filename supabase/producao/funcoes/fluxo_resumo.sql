-- public.fluxo_resumo(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_resumo(p_conversa uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; d jsonb; v text[] := '{}'; x text;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb);
  select string_agg(coalesce(public.fluxo_rotulo_item(p_conversa, i.procedimento_id, i.procedimento, i.modalidade), i.modalidade) || case i.lado when 'D' then ' (D)' when 'E' then ' (E)' when 'A' then ' (ambos)' else '' end, ' + ' order by i.id)
    into x from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo;
  if x is not null then v := v || ('Pedido: ' || x); end if;
  if pa.plano is not null then v := v || ('Plano: ' || pa.plano); end if;
  if pa.profissional is not null then v := v || ('Médico: ' || pa.profissional); end if;
  select string_agg(to_char((e ->> 'data')::date, 'DD/MM') || ' ' || (e ->> 'hora') || coalesce(' ' || regexp_replace(e ->> 'unidade', '^CLÍNICA DE SAÚDE E IMAGEM - ', ''), ''), '; ' order by (e ->> 'grupo')::int)
    into x from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e;
  if x is not null then v := v || ('Horário escolhido (previsão): ' || x); end if;
  if pa.identidade is not null then v := v || ('Cadastro: ' || case pa.identidade when 'conferida' then 'paciente conhecido, data de nascimento conferida'
      when 'divergente' then 'data de nascimento NÃO conferiu' when 'atualizar' then 'conhecido, atualizar dados' when 'aguardando' then 'aguardando conferência' else 'paciente novo' end); end if;
  if d ->> 'assunto' is not null then v := v || ('Assunto: ' || (d ->> 'assunto') || coalesce(' — ' || (d ->> 'assunto_texto'), '')); end if;
  select 'Marcação automática: ' || o.estado || coalesce(' (' || o.codigo || ')', '') || coalesce(' — voucher ' || o.voucher_id, '') into x   -- klingo-auto
    from public.klingo_operacao o where o.conversa_id = p_conversa order by o.criado_em desc limit 1;
  if x is not null then v := v || x; end if;
  select string_agg(n, ' | ') into x from jsonb_array_elements_text(coalesce(d -> 'notas', '[]'::jsonb)) n;
  if x is not null then v := v || ('Observações: ' || x); end if;
  return array_to_string(v, E'\n');
end $function$;

