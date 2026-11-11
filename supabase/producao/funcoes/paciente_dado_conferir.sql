-- public.paciente_dado_conferir(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.paciente_dado_conferir(p_conversa uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa record; pc record; v_cpf text; v_dif jsonb := '{}'::jsonb; v_fone text; v_email text; v_nasc date;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if not found or jsonb_typeof(pa.paciente) <> 'object' then return 0; end if;
  v_cpf := nullif(regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g'), '');
  if v_cpf is null or length(v_cpf) <> 11 then return 0; end if;
  select * into pc from public.pacientes where regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = v_cpf order by atualizado_em desc limit 1;
  if not found then
    select * into pc from public.pacientes where id = pa.paciente_id and nullif(cpf, '') is not null;
    if found then
      insert into public.paciente_aviso (conversa_id, tipo, detalhe) values (p_conversa, 'cpf_diferente', jsonb_build_object('paciente_id', pc.id))
        on conflict (conversa_id, tipo) where resolvido_em is null do nothing;
    end if;
    return 0;
  end if;
  v_fone := public.fone_chave(pa.paciente ->> 'celular'); v_email := lower(nullif(btrim(pa.paciente ->> 'email'), '')); v_nasc := public.data_ou_nula(pa.paciente ->> 'dt_nasc');
  if v_email is not null and v_email is distinct from lower(pc.email) then v_dif := v_dif || jsonb_build_object('email', jsonb_build_object('cadastro', pc.email, 'novo', v_email)); end if;
  if v_nasc is not null and v_nasc is distinct from pc.dt_nasc then v_dif := v_dif || jsonb_build_object('dt_nasc', jsonb_build_object('cadastro', pc.dt_nasc, 'novo', v_nasc)); end if;
  if v_fone is not null and not (v_fone = any (pc.telefones)) then v_dif := v_dif || jsonb_build_object('telefone', jsonb_build_object('novo', v_fone)); end if;
  if v_dif = '{}'::jsonb then return 0; end if;
  insert into public.paciente_aviso (conversa_id, tipo, detalhe) values (p_conversa, 'dado_diferente', jsonb_build_object('paciente_id', pc.id, 'campos', v_dif))
    on conflict (conversa_id, tipo) where resolvido_em is null do nothing;
  return 1;
end $function$;

