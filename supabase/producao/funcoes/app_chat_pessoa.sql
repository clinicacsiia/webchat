-- public.app_chat_pessoa(p_pac uuid, p_conversa uuid, OUT o_erro text, OUT o_eu boolean, OUT o_filho uuid, OUT o_nome text, OUT o_cpf text, OUT o_nasc date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_chat_pessoa(p_pac uuid, p_conversa uuid, OUT o_erro text, OUT o_eu boolean, OUT o_filho uuid, OUT o_nome text, OUT o_cpf text, OUT o_nasc date)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.app_paciente%rowtype; c public.conversas; f public.app_filho%rowtype; v_tel text;
begin
  select * into a from public.app_paciente where id = p_pac;
  select * into c from public.conversas where id = p_conversa;
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g') into v_tel from public.contatos ct where ct.id = c.contato_id;
  if v_tel is distinct from a.telefone then o_erro := 'celular'; return; end if;
  o_eu := coalesce(c.paciente_tipo, 'proprio') = 'proprio';
  if o_eu then o_nome := a.nome; o_cpf := a.cpf; o_nasc := a.nascimento;
  else
    select * into f from public.app_filho where responsavel_id = a.id and removido_em is null and public.app_norm(nome) = public.app_norm(c.paciente_nome) limit 1;
    if not found then o_erro := 'pessoa'; return; end if;
    o_filho := f.id; o_nome := f.nome; o_cpf := f.cpf; o_nasc := f.nascimento;
  end if;
end $function$;

