-- public.painel_pmarc_conversa(p_id uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_pmarc_conversa(p_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_conv uuid;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe abre a conversa.' using errcode = '42501'; end if;
  if not exists (select 1 from public.pmarc_pessoa where id = p_id) then raise exception 'Pessoa não encontrada.' using errcode = 'P0002'; end if;
  v_conv := public.pmarc_conversa_garantir(p_id, (select auth.uid()));
  if v_conv is null then raise exception 'Sem celular para abrir a conversa. Anote o celular com a pessoa por telefone.' using errcode = '22023'; end if;
  return v_conv;
end $function$;

