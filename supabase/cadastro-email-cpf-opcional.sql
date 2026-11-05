-- FLUXOGRAMA: entrada (formulários do chat: dados_ident e dados_contato) -> validação (CPF só é conferido se vier preenchido; e-mail com formato válido) -> lógica (CPF deixa de ser obrigatório; o e-mail entra no formulário de contato já preenchido com o do início da conversa) -> saída (paciente.email no pré-agendamento e linha "E-mail" na leitura de volta)
-- Aplicado no banco em 05/11/2026 como patch (replace sobre a definição viva). ROLLBACK: reaplicar fase7-motor.sql.
-- Observação: no banco o CPF estava 'obrigatorio', true (o fase7-motor.sql já dizia false); agora os dois batem.

-- Parte 1: fluxo_perguntar
do $p$ declare d text; d2 text;
begin
  d := pg_get_functiondef('public.fluxo_perguntar(uuid,text,text)'::regprocedure);
  if position('''email'', ''rotulo''' in d) > 0 then return; end if;
  d2 := replace(d, $a$'tipo', 'cpf', 'obrigatorio', true$a$, $a$'tipo', 'cpf', 'obrigatorio', false$a$);
  d2 := replace(d2, $a$'tipo', 'tel', 'obrigatorio', false, 'valor', v_dig ->> 'telefone')));$a$,
    $a$'tipo', 'tel', 'obrigatorio', false, 'valor', v_dig ->> 'telefone'),
      jsonb_build_object('nome', 'email', 'rotulo', 'E-mail', 'tipo', 'email', 'obrigatorio', true,
        'valor', coalesce(v_dig ->> 'email', (select coalesce(nullif(btrim(c.email_informado), ''), ct2.email) from public.contatos ct2 where ct2.id = c.contato_id)))));$a$);
  if d2 = d then raise exception 'nada mudou em fluxo_perguntar'; end if;
  execute d2;
end $p$;

-- Parte 2: fluxo_aplicar
do $p$ declare d text; d2 text;
begin
  d := pg_get_functiondef('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure);
  if position('''email''' in d) > 0 then return; end if;
  d2 := replace(d, $a$array['celular','telefone']$a$, $a$array['celular','telefone','email']$a$);
  d2 := replace(d2, $a$elsif k in ('celular', 'telefone') then$a$,
    $a$elsif k = 'email' then
        x := lower(x);
        if x !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_err := array_append(v_err, 'o e-mail'::text); continue; end if;
      elsif k in ('celular', 'telefone') then$a$);
  if d2 = d then raise exception 'nada mudou em fluxo_aplicar'; end if;
  execute d2;
end $p$;

-- Parte 3: fluxo_leitura
do $p$ declare d text; d2 text;
begin
  d := pg_get_functiondef('public.fluxo_leitura(uuid)'::regprocedure);
  if position('E-mail: ' in d) > 0 then return; end if;
  d2 := replace(d, $a$if p ->> 'celular' is not null then v := v || ('Celular: ' || (p ->> 'celular')); end if;$a$,
    $a$if p ->> 'celular' is not null then v := v || ('Celular: ' || (p ->> 'celular')); end if;
  if p ->> 'email' is not null then v := v || ('E-mail: ' || (p ->> 'email')); end if;$a$);
  if d2 = d then raise exception 'nada mudou em fluxo_leitura'; end if;
  execute d2;
end $p$;
