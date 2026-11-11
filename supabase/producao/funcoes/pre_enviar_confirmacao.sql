-- public.pre_enviar_confirmacao(p_pre uuid)
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.pre_enviar_confirmacao(p_pre uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  pa public.pre_agendamentos; v_ex text; v_hr text; v_prep text; v_txt text;
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
begin
  select * into pa from public.pre_agendamentos where id = p_pre and confirmacao_enviada_em is null for update;
  if not found then return; end if;
  select string_agg('• ' || case i.modalidade when 'RM' then 'Ressonância magnética' when 'TC' then 'Tomografia' when 'US' then 'Ultrassom' when 'RX' then 'Raio-X'
                                  when 'MAMO' then 'Mamografia' when 'DENSITO' then 'Densitometria óssea' else i.modalidade end
        || coalesce(' — ' || i.regiao_nome, '')
        || case i.lado when 'D' then ' (lado direito)' when 'E' then ' (lado esquerdo)' when 'A' then ' (os dois lados)' else '' end
        || ': ' || coalesce(i.procedimento, 'exame a definir') || case when i.quantidade > 1 then ' ×' || i.quantidade else '' end, E'\n' order by i.id)
    into v_ex from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo;
  v_ex := coalesce(v_ex, '• ' || coalesce(pa.procedimento, pa.especialidade, 'Atendimento'));
  select string_agg('• ' || v_dias[extract(dow from (e ->> 'data')::date)::int + 1] || ', ' || to_char((e ->> 'data')::date, 'DD/MM')
        || case when coalesce((e ->> 'chegada')::boolean, false) then ', por ordem de chegada a partir das ' else ' às ' end || (e ->> 'hora')
        || coalesce(' — ' || regexp_replace(e ->> 'unidade', '^CLÍNICA DE SAÚDE E IMAGEM - ', ''), ''), E'\n' order by (e ->> 'data'), (e ->> 'hora'))
    into v_hr from jsonb_array_elements(pa.escolha_horario) e;
  select string_agg('• ' || p.nome || ': ' || case when length(btrim(p.preparo)) > 1200 then left(btrim(p.preparo), 1200) || ' […] (a equipe passa o restante)' else btrim(p.preparo) end, E'\n' order by p.nome) into v_prep
    from public.catalogo_procedimento p
    where p.id in (select i.procedimento_id from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is not null)
      and nullif(btrim(p.preparo), '') is not null;
  v_txt := 'Boa notícia: sua marcação foi confirmada no sistema da clínica.' || E'\n\nExames:\n' || v_ex || E'\n\nQuando e onde:\n' || coalesce(v_hr, '—')
    || case when v_prep is not null then E'\n\nPreparo (conforme o cadastro da clínica):\n' || v_prep else E'\n\nSe houver preparo, a equipe passa as orientações.' end
    || E'\n\nSe precisar remarcar ou cancelar, é só responder aqui.';
  insert into public.mensagens (conversa_id, autor, texto) values (pa.conversa_id, 'agente', left(v_txt, 4000));
  update public.pre_agendamentos set confirmacao_enviada_em = now() where id = pa.id;
end $function$;

