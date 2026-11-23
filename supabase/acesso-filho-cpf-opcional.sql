-- FLUXOGRAMA: entrada (cadastro do acesso rápido: app_pin_criar recebe o responsável e os filhos; depois de entrar, app_pendencias_lista diz o que falta preencher) -> validação (CPF do responsável continua obrigatório e conferido; CPF de filho, SE informado, continua conferido pelos dígitos) -> lógica (CPF do filho deixa de ser obrigatório: sem ele o cadastro nasce e o filho fica com cpf em branco; o histórico do mesmo celular ainda preenche sozinho quando existe; o chat já pergunta CPF e nascimento na hora de marcar quando o filho não tem CPF salvo) -> saída (JSON ok/erro/mensagem; app_pendencias_lista marca o CPF do filho como opcional, então a tela "Falta pouco" obrigatória deixa de travar a entrada por isso)
-- Versão 1.0 — 23/11/2026 / Mudança: Implementação inicial. Decisão do dono (23/11/2026): pais reclamaram de não ter o CPF da criança à mão no cadastro.
--
-- POR QUE: o cadastro recusava (filho_cpf_falta) quem não digitasse o CPF de cada filho, e a tela "Falta pouco" voltava a cobrar a cada entrada. Muita gente não tem o CPF da criança à mão e desistia ou digitava o do responsável (42 de 168 filhos tinham o CPF igual ao do responsável).
-- O QUE NÃO MUDA: CPF do responsável obrigatório; filho com CPF digitado errado continua recusado; o chat continua pedindo CPF + nascimento ao marcar para a criança (Klingo identifica por CPF + nascimento); Meus dados continua permitindo informar o CPF depois.
--
-- ROLLBACK (sem drop; só create or replace): voltar as duas funções à versão do retrato:
--   git show HEAD~:supabase/producao/funcoes/app_pin_criar.sql  e  app_pendencias_lista.sql (rodar o corpo no editor SQL).
-- Pode ser aplicado mais de uma vez.

CREATE OR REPLACE FUNCTION public.app_pin_criar(p_telefone text, p_nome text, p_nascimento text, p_pin text, p_cpf text DEFAULT NULL::text, p_filhos jsonb DEFAULT '[]'::jsonb, p_confianca jsonb DEFAULT NULL::jsonb, p_aparelho text DEFAULT NULL::text, p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')); v_nasc date := public.app_data(p_nascimento);
  v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb); v_f jsonb; v_fd date; v_cpf text := nullif(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), ''); v_fcpf text; v_i integer := 0;
  v_cpfs text[] := '{}'; v_r jsonb; v_pac uuid; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  if v_cpf is not null and not public.fluxo_cpf_ok(v_cpf) then return jsonb_build_object('ok', false, 'erro', 'cpf', 'mensagem', 'Os números do seu CPF não conferem. Confira, por favor.'); end if;
  if v_cpf is null and v_tel ~ '^[1-9]{2}9[0-9]{8}$' and public.app_nome_ok(v_nome) and v_nasc is not null then v_cpf := public.app_cpf_historico(v_tel, v_nome, v_nasc, 'proprio'); end if;
  if v_cpf is null then return jsonb_build_object('ok', false, 'erro', 'cpf_falta', 'mensagem', 'Informe o seu CPF para criar o PIN.'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fd := public.app_data(v_f ->> 'nascimento'); v_fcpf := nullif(regexp_replace(coalesce(v_f ->> 'cpf', ''), '\D', '', 'g'), '');
    if v_fcpf is not null and not public.fluxo_cpf_ok(v_fcpf) then return jsonb_build_object('ok', false, 'erro', 'filho_cpf', 'indice', v_i, 'mensagem', 'Os números do CPF de ' || split_part(coalesce(v_f ->> 'nome', 'filho(a)'), ' ', 1) || ' não conferem.'); end if;
    if v_fcpf is null and v_fd is not null and public.app_nome_ok(v_f ->> 'nome') and v_tel ~ '^[1-9]{2}9[0-9]{8}$' then v_fcpf := public.app_cpf_historico(v_tel, v_f ->> 'nome', v_fd, 'filho'); end if;
    v_cpfs := array_append(v_cpfs, v_fcpf); v_i := v_i + 1;   -- CPF do filho é OPCIONAL (23/11/2026): sem ele fica em branco e o chat pede na hora de marcar
  end loop;
  v_r := public.app_cadastrar(p_telefone, p_nome, p_nascimento, p_pin, v_filhos, p_confianca, p_aparelho);
  if coalesce((v_r ->> 'ok')::boolean, false) is not true then return v_r; end if;
  select id into v_pac from public.app_paciente where telefone = v_tel;
  update public.app_paciente set cpf = v_cpf, atualizado_em = now(), email = case when v_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(v_email) <= 200 then v_email else email end where id = v_pac;
  v_i := 0;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_i := v_i + 1;
    update public.app_filho set cpf = v_cpfs[v_i]
     where responsavel_id = v_pac and removido_em is null and public.app_norm(nome) = public.app_norm(v_f ->> 'nome') and nascimento = public.app_data(v_f ->> 'nascimento');
  end loop;
  perform public.app_conferir_cadastro(v_pac);
  return jsonb_build_object('ok', true, 'token', v_r ->> 'token', 'perfil', public.app_perfil_json(v_pac));
end $function$;

CREATE OR REPLACE FUNCTION public.app_pendencias_lista(p_pac uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(t.x order by t.ord, t.x ->> 'nome'), '[]'::jsonb) from (
    select 1 as ord, jsonb_build_object('id', 'eu:cpf', 'pessoa', 'eu', 'nome', a.nome, 'campo', 'cpf', 'opcional', false,
             'pergunta', 'Qual é o seu CPF? Assim o chat não pergunta de novo.') as x
      from public.app_paciente a where a.id = p_pac and a.cpf is null
    union all
    select 2, jsonb_build_object('id', 'eu:email', 'pessoa', 'eu', 'nome', a.nome, 'campo', 'email', 'opcional', true,
             'pergunta', 'Qual é o seu e-mail? (opcional, para a clínica falar com você)')
      from public.app_paciente a where a.id = p_pac and a.email is null
    union all
    select 3, jsonb_build_object('id', f.id::text || ':cpf', 'pessoa', f.id, 'nome', f.nome, 'campo', 'cpf', 'opcional', true,
             'pergunta', 'Qual é o CPF de ' || split_part(f.nome, ' ', 1) || '? (opcional; se a criança não tiver, pode ser o do responsável)')
      from public.app_filho f where f.responsavel_id = p_pac and f.removido_em is null and f.cpf is null
  ) t $function$;
