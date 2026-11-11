-- public.novo_usuario()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.novo_usuario()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_primeiro boolean; v_email text := lower(btrim(coalesce(new.email, ''))); v_papel text; v_nome text;
begin
  v_nome := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''), nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'Sem nome');
  select not exists (select 1 from public.agentes) into v_primeiro;
  if v_primeiro then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, 'admin', true);
    return new;
  end if;
  if v_email <> '' then
    update public.equipe_convites set usado_em = now() where email = v_email and usado_em is null returning papel into v_papel;
  end if;
  if v_papel is not null then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, v_papel, false);
  elsif coalesce(new.raw_user_meta_data ->> 'origem', '') = 'equipe'
     or coalesce((select valor from public.config where chave = 'cadastro_equipe_sem_convite'), 'nao') = 'sim' then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, 'atendente', false);
  else
    insert into public.contas_paciente (id, email) values (new.id, new.email) on conflict (id) do nothing;
  end if;
  return new;
end $function$;

