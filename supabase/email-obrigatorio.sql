-- E-mail obrigatório no início do chat (nome + telefone + e-mail são o "login" do paciente).
-- Altera a chat_iniciar existente via pg_get_functiondef + replace; falha se o trecho não for encontrado.
do $$
declare
  v_def text;
  v_novo text;
  v_alvo constant text := E'  v_msg := btrim(coalesce(p_mensagem, \'\'));';
begin
  v_def := pg_get_functiondef(to_regprocedure('public.chat_iniciar(text,text,text,text,boolean,text,text,text,text,text,jsonb,text)'));
  if position('Informe um e-mail válido' in v_def) > 0 then return; end if;
  v_novo := replace(v_def, v_alvo,
    E'  if btrim(coalesce(p_email, \'\')) !~ \'^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$\' then\n'
    || E'    raise exception \'Informe um e-mail válido.\' using errcode = \'22023\';\n'
    || E'  end if;\n' || v_alvo);
  if v_novo = v_def then raise exception 'Trecho de chat_iniciar não encontrado; ajuste o script.'; end if;
  execute v_novo;
end $$;
