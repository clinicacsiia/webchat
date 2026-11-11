-- public.fluxo_leitura(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_leitura(p_conversa uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; c public.conversas; d jsonb; p jsonb; v text[] := '{}'; x text; v_dias text[] := array['dom','seg','ter','qua','qui','sex','sáb'];
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select * into c from public.conversas where id = p_conversa;
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  p := coalesce(d -> 'digitado', '{}'::jsonb);
  select string_agg('• ' || coalesce(public.fluxo_rotulo_item(p_conversa, i.procedimento_id, i.procedimento, i.modalidade), 'o atendente define o exame')
                    || case i.lado when 'D' then ' — lado direito' when 'E' then ' — lado esquerdo' when 'A' then ' — os dois lados' else '' end, E'\n' order by i.id)
    into x from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo;
  if x is not null then v := v || (case when pa.tipo = 'consulta' then 'Consulta:' else 'Exames:' end || E'\n' || x); end if;
  if pa.profissional is not null then v := v || ('Médico: ' || initcap(lower(pa.profissional))); end if;
  v := v || ('Plano: ' || coalesce(initcap(lower(pa.plano)), '—'));
  select string_agg(v_dias[extract(dow from (e ->> 'data')::date)::int + 1] || ' ' || to_char((e ->> 'data')::date, 'DD/MM') || ' às ' || (e ->> 'hora')
                    || coalesce(' — ' || regexp_replace(e ->> 'unidade', '^CLÍNICA DE SAÚDE E IMAGEM - ', 'CSI '), ''), E'\n' order by (e ->> 'grupo')::int)
    into x from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e;
  v := v || ('Horário (previsão): ' || coalesce(x, 'o atendente combina com você'));
  v := v || ('Paciente: ' || coalesce(p ->> 'nome', case when c.paciente_tipo = 'filho' then c.paciente_nome else c.nome_informado end, '—')
             || coalesce(', nascimento ' || (p ->> 'dt_nasc'), ''));
  if d ->> 'mudou' = 'igual' then v := v || 'Cadastro: os mesmos dados da última vez'::text; end if;
  if p ->> 'cpf' is not null then v := v || ('CPF: ' || (p ->> 'cpf')); end if;
  if p ->> 'mae' is not null then v := v || ('Mãe: ' || (p ->> 'mae')); end if;
  if p ->> 'celular' is not null then v := v || ('Celular: ' || (p ->> 'celular')); end if;
  if p ->> 'email' is not null then v := v || ('E-mail: ' || (p ->> 'email')); end if;
  if p ->> 'endereco' is not null or p ->> 'cep' is not null then
    v := v || ('Endereço: ' || concat_ws(', ', p ->> 'endereco', p ->> 'numero', p ->> 'complemento', p ->> 'bairro', p ->> 'cidade', upper(p ->> 'uf'), p ->> 'cep'));
  end if;
  if p ->> 'matricula' is not null then v := v || ('Carteirinha: ' || (p ->> 'matricula') || coalesce(' (validade ' || (p ->> 'validade') || ')', '')); end if;
  return array_to_string(v, E'\n');
end $function$;

