-- public.chat_avaliar(p_conversa uuid, p_token text, p_nota_atendimento numeric, p_nota_site numeric, p_canal text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_avaliar(p_conversa uuid, p_token text, p_nota_atendimento numeric, p_nota_site numeric, p_canal text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c record; n integer;
begin
  perform public.chat_valida(p_conversa, p_token);
  if coalesce((select valor from public.config where chave = 'avaliacao_ativa'), 'nao') <> 'sim' then raise exception 'A avaliação não está disponível no momento.' using errcode = '22023'; end if;
  if p_nota_atendimento is null or p_nota_site is null or p_nota_atendimento <> trunc(p_nota_atendimento) or p_nota_site <> trunc(p_nota_site)
     or p_nota_atendimento not between 0 and 10 or p_nota_site not between 0 and 10 then
    raise exception 'Escolha uma nota de 0 a 10 nas duas perguntas.' using errcode = '22023';
  end if;
  if p_canal is null or p_canal not in ('WhatsApp', 'Instagram', 'Google') then raise exception 'Escolha por onde você nos conheceu.' using errcode = '22023'; end if;
  select status, encerrada_em, motivo_encerramento into c from public.conversas where id = p_conversa;
  if c.status is distinct from 'encerrada' or c.encerrada_em is null then raise exception 'Só é possível avaliar depois do encerramento do atendimento.' using errcode = '22023'; end if;
  if c.motivo_encerramento = 'nao_respondido' or not exists (select 1 from public.mensagens m where m.conversa_id = p_conversa and (m.opcoes ->> 'tipo') = 'despedida' and (m.opcoes ->> 'encerrada_em')::timestamptz = c.encerrada_em) then
    raise exception 'Este atendimento não tem convite para avaliação.' using errcode = '22023';
  end if;
  insert into public.avaliacao_atendimento (conversa_id, encerrada_em, nota_atendimento, nota_site, canal)
  values (p_conversa, c.encerrada_em, p_nota_atendimento::smallint, p_nota_site::smallint, p_canal) on conflict (conversa_id, encerrada_em) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'nova', n = 1);
end $function$;

