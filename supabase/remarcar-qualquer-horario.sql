-- Remarcar: qualquer horário da lista segue sozinho pelo chat. Escrito em 31/10/2026; Aplicado no projeto webchat-atendimento em 31/10/2026.
-- Antes: só o horário de índice 0 da lista (o de data mais distante, porque a lista é da data mais nova para a mais velha) era copiado e seguia para o
--   convênio e o calendário; escolher qualquer outro horário ("Remarcar Ultrassom de 10/11") mandava o paciente para o atendente.
-- Agora: o exame do horário ESCOLHIDO é copiado (pre_reaproveitar aceita 'ultimo:N', N = posição na lista de paciente_historico_para_ia.ultimas) e o
--   convênio anterior vem desse mesmo horário. Se a cópia não for possível (pedido já com exames, paciente não conferido), continua indo para a equipe.
-- Ordem de aplicação: depois de assuntos-resolvidos.sql. Cada trecho trocado tem de aparecer UMA vez, senão o arquivo para sem alterar nada. Pode ser reaplicado.

create or replace function pg_temp.remendar(p_funcao regprocedure, p_marca text, p_de text[], p_para text[]) returns text
language plpgsql as $$
declare d text; d2 text; i int; n int;
begin
  d := pg_get_functiondef(p_funcao);
  if position(p_marca in d) > 0 then return 'já aplicado: ' || p_funcao::text; end if;
  d2 := d;
  for i in 1 .. array_length(p_de, 1) loop
    n := (length(d2) - length(replace(d2, p_de[i], ''))) / length(p_de[i]);
    if n <> 1 then
      raise exception '% : o trecho % aparece % vez(es); nada foi alterado.', p_funcao::text, i, n;
    end if;
    d2 := replace(d2, p_de[i], p_para[i]);
  end loop;
  execute d2;
  return 'aplicado: ' || p_funcao::text;
end $$;

-- 1. pre_reaproveitar: 'ultimo:N' copia o exame do N-ésimo horário da lista (0 = o primeiro). 'ultimo' continua igual ao 'ultimo:0'.
select pg_temp.remendar('public.pre_reaproveitar(uuid,text)'::regprocedure, 'v_off',
  array[E'declare v_conf jsonb; v_pid uuid; v_ex jsonb; v_orig uuid; v_n int;',
        E'  if p_origem = ''ultimo'' then\n',
        E'jsonb_array_length(h.exames) > 0',
        E'desc limit 1;'],
  array[E'declare v_conf jsonb; v_pid uuid; v_ex jsonb; v_orig uuid; v_n int; v_off int := 0;',
        E'  if p_origem ~ ''^ultimo(:[0-9])?$'' then\n    v_off := coalesce(nullif(substr(p_origem, 8), ''''), ''0'')::int;\n',
        E'(v_off > 0 or jsonb_array_length(h.exames) > 0)',
        E'desc limit 1 offset v_off;']);

-- 2. Remarcar: copia o horário escolhido (não só o primeiro) e guarda o convênio DELE.
select pg_temp.remendar('public.fluxo_assunto_aplicar(uuid,text,text)'::regprocedure, '''ultimo:''',
  array[E'(f ->> ''idx'')::int = 0 and public.pre_reaproveitar(p_conversa, ''ultimo'')',
        E'-> ''ultimas'' -> 0 ->> ''plano'';'],
  array[E'public.pre_reaproveitar(p_conversa, ''ultimo:'' || (f ->> ''idx''))',
        E'-> ''ultimas'' -> (f ->> ''idx'')::int ->> ''plano'';']);
