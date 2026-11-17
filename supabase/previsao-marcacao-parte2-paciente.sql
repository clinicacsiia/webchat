-- FLUXOGRAMA: entrada (a página previsao/index.html chama estas funções com o código do link, ou com celular + nascimento) -> validação (interruptor `previsao_marcacao_modo`; código existe; limite de tentativas; NADA aqui barra o paciente por conteúdo: texto estranho é guardado e marcado para revisão)
--   -> lógica (a resposta "não sei"/"seguimos" vale como resposta e a conversa segue; o que a pessoa digitar é anotado; a conversa com a equipe só é criada quando a pessoa responde ou escreve, com o robô do chat DESLIGADO)
--   -> saída (jsonb com a previsão, as mensagens e o aviso de que a previsão será vista e confirmada pelo webchat, WhatsApp e telefone) | ROLLBACK: previsao-marcacao-rollback.sql
-- Versão 1.0 — 17/11/2026 / Mudança: primeira versão (Webchat de Previsão de marcação).
--
-- Quem chama: `anon` (paciente sem login) nas 6 funções públicas; as internas são só do banco (service_role). O paciente NÃO passa pelo PIN do acesso rápido (ele nunca criou PIN):
-- a credencial é o código secreto do link (24 letras e números) ou celular + nascimento, com limite de tentativas. Quem tem o link vê só a previsão daquela pessoa.

-- ---------- ajudantes puros ----------
create or replace function public.pmarc_telefone(p_texto text) returns text
language sql immutable set search_path = '' as $$
  select case
    when length(d) in (10, 11) then d
    when length(d) in (12, 13) and left(d, 2) = '55' then substr(d, 3)
  end
  from (select regexp_replace(coalesce(p_texto, ''), '\D', '', 'g') as d) x
$$;

create or replace function public.pmarc_tipo(p_procedimento text) returns text
language sql immutable set search_path = '' as $$
  select case when lower(coalesce(p_procedimento, '')) ~ '^\s*(consulta|retorno|teleconsulta)' then 'consulta' else 'exame' end
$$;

-- "não sei", "seguimos" e parecidos = nao_sei; "sim/certo/ok" = sim; "não/errado/diferente" = nao; qualquer outra coisa = nulo (a conversa segue do mesmo jeito).
create or replace function public.pmarc_classificar(p_texto text) returns text
language sql immutable set search_path = '' as $$
  with t as (
    select ' ' || regexp_replace(lower(translate(btrim(coalesce(p_texto, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn')), '[^a-z0-9]+', ' ', 'g') || ' ' as x)
  select case
    when x ~ ' (nao sei|n sei|nn sei|sei la|nao lembro|nao tenho certeza|nao tenho ideia|nao faco ideia|seguimos|segue|seguir|pode seguir|vamos seguir|tanto faz|talvez|depois vejo) ' then 'nao_sei'
    when x ~ ' (nao|errado|errada|incorreto|incorreta|diferente|outro|outra) ' then 'nao'
    when x ~ ' (sim|certo|certa|correto|correta|isso|confirmo|confirmado|ok|exato|exatamente) ' then 'sim'
  end
  from t
$$;

create or replace function public.pmarc_ligada() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select valor from public.config where chave = 'previsao_marcacao_modo'), 'nao') = 'sim'
$$;

create or replace function public.pmarc_texto(p_chave text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim((select valor from public.config where chave = p_chave)), ''),
    case p_chave
      when 'previsao_marcacao_aviso' then 'Importante: esta é uma PREVISÃO de marcação. Ela ainda vai ser vista e confirmada pela nossa equipe, pelo webchat, pelo WhatsApp e por telefone.'
      when 'previsao_marcacao_final' then 'Anotamos o que você nos contou. A previsão vai ser vista e confirmada pela nossa equipe pelo webchat, pelo WhatsApp e por telefone. Se quiser, pode escrever aqui a qualquer momento.'
    end)
$$;

-- Marcações abertas (agendado ou confirmado) a partir de 3 horas atrás, da Jornada (relatório #14359 lido a cada 30 s). Cancelada, remarcada e já atendida não entram.
create or replace function public.pmarc_itens(p_chave text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('quando', x.agendado_para, 'procedimento', x.procedimento, 'unidade', x.unidade,
           'tipo', public.pmarc_tipo(x.procedimento), 'status', x.status, 'confirmacao', x.confirm_status) order by x.agendado_para), '[]'::jsonb)
  from (
    select e.agendado_para, e.procedimento, e.unidade, e.status, e.confirm_status
    from public.jornada_exame e join public.jornada_card c on c.id = e.card_id
    where c.paciente_chave = p_chave and e.status in ('agendado', 'confirmado') and e.agendado_para >= now() - interval '3 hours'
    order by e.agendado_para limit 30
  ) x
$$;

-- ---------- o que a página recebe ----------
create or replace function public.pmarc_vista(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.pmarc_pessoa; v_tok text; v_nome text; v_faltam jsonb := '[]'::jsonb;
begin
  select * into p from public.pmarc_pessoa where id = p_id;
  if not found then return null; end if;
  if p.conversa_id is not null then select token into v_tok from public.conversa_segredo where conversa_id = p.conversa_id; end if;
  v_nome := coalesce(nullif(btrim(p.informado ->> 'nome'), ''), nullif(btrim(p.nome), ''), '');
  if public.pmarc_telefone(coalesce(p.informado ->> 'celular', p.celular, p.telefone)) is null then v_faltam := v_faltam || '"celular"'::jsonb; end if;
  if coalesce(nullif(btrim(p.informado ->> 'email'), ''), nullif(btrim(p.email), '')) is null then v_faltam := v_faltam || '"email"'::jsonb; end if;
  if p.nascimento is null and coalesce(p.informado ->> 'nascimento', '') = '' then v_faltam := v_faltam || '"nascimento"'::jsonb; end if;
  if not p.tem_cpf and coalesce(p.informado ->> 'cpf', '') = '' then v_faltam := v_faltam || '"cpf"'::jsonb; end if;
  return jsonb_build_object(
    'ok', true, 'codigo', p.codigo,
    'primeiro_nome', initcap(split_part(lower(v_nome), ' ', 1)),
    'resposta', p.resposta, 'respondeu', p.respondeu_em is not null,
    'itens', public.pmarc_itens(p.chave), 'faltam', v_faltam,
    'aviso', public.pmarc_texto('previsao_marcacao_aviso'), 'final', public.pmarc_texto('previsao_marcacao_final'),
    'conversa', case when p.conversa_id is not null and v_tok is not null then jsonb_build_object('id', p.conversa_id, 'token', v_tok) end);
end $$;

-- ---------- conversa com a equipe (robô do chat DESLIGADO) ----------
-- Cria o contato e a conversa na primeira vez. O motor do chat (`fluxo_*`) só age com `ia_ativa`; aqui nasce desligado, então ninguém é perguntado nem barrado por robô:
-- a atendente responde no painel como em qualquer conversa. Sem celular não há como criar o contato: devolve nulo e a página pede o celular.
create or replace function public.pmarc_conversa_garantir(p_id uuid, p_por uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.pmarc_pessoa; v_tel text; v_nome text; v_email text; v_contato uuid; v_conv uuid; v_n integer; v_prox jsonb; v_resumo text;
begin
  select * into p from public.pmarc_pessoa where id = p_id for update;
  if not found then return null; end if;
  if p.conversa_id is not null and exists (select 1 from public.conversas where id = p.conversa_id) then return p.conversa_id; end if;
  v_tel := coalesce(public.pmarc_telefone(p.informado ->> 'celular'), public.pmarc_telefone(p.celular), public.pmarc_telefone(p.telefone));
  if v_tel is null then return null; end if;
  v_nome := left(coalesce(nullif(btrim(p.informado ->> 'nome'), ''), nullif(btrim(p.nome), ''), 'Paciente sem nome'), 120);
  if char_length(v_nome) < 2 then v_nome := 'Paciente sem nome'; end if;
  v_email := coalesce(nullif(btrim(p.informado ->> 'email'), ''), nullif(btrim(p.email), ''));
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 200) then v_email := null; end if;

  insert into public.contatos (nome, telefone, email, origem, aceitou_lgpd_em)
  values (v_nome, v_tel, v_email, 'previsao', p.aceitou_lgpd_em)
  on conflict (telefone) do update set ultimo_contato_em = now(), email = coalesce(public.contatos.email, excluded.email),
    aceitou_lgpd_em = coalesce(public.contatos.aceitou_lgpd_em, excluded.aceitou_lgpd_em)
  returning id into v_contato;

  v_prox := public.pmarc_itens(p.chave);
  v_n := jsonb_array_length(v_prox);
  v_resumo := 'PREVISÃO DE MARCAÇÃO (canal separado, sem robô). ' ||
    case when v_n = 0 then 'Não há marcação aberta no Klingo para esta pessoa.'
         else v_n || ' marcação(ões) aberta(s) no Klingo; a primeira: ' || (v_prox -> 0 ->> 'procedimento') || ' em ' ||
              to_char(((v_prox -> 0 ->> 'quando')::timestamptz) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || '.' end ||
    ' Ainda NÃO é confirmação: a previsão precisa ser vista e confirmada pela equipe (webchat, WhatsApp e telefone). Veja o botão Previsão para os detalhes.';

  insert into public.conversas (contato_id, nome_informado, email_informado, triagem_resumo)
  values (v_contato, v_nome, v_email, v_resumo) returning id into v_conv;
  update public.conversas set ia_ativa = false where id = v_conv;
  insert into public.conversa_segredo (conversa_id) values (v_conv);
  if p_por is not null then
    -- aberta pela atendente: já fica com ela e ninguém está esperando resposta
    update public.conversas set status = 'em_atendimento', agente_id = p_por, cliente_aguarda_desde = null where id = v_conv;
  end if;
  update public.pmarc_pessoa set conversa_id = v_conv, contato_id = v_contato, atualizado_em = now() where id = p.id;
  return v_conv;
end $$;

-- ---------- 1) abrir pelo link ----------
create or replace function public.pmarc_abrir(p_codigo text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.pmarc_pessoa;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, ''));
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  update public.pmarc_pessoa set primeiro_acesso_em = coalesce(primeiro_acesso_em, now()), ultimo_acesso_em = now() where id = p.id;
  return public.pmarc_vista(p.id);
end $$;

-- ---------- 2) achar a previsão sem o link: celular + nascimento ----------
create or replace function public.pmarc_identificar(p_celular text, p_nascimento date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tel text; v_marca text; v_sal text; v_lista jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_tel := public.pmarc_telefone(p_celular);
  if v_tel is null then return jsonb_build_object('ok', false, 'motivo', 'celular_invalido'); end if;
  select valor into v_sal from public.config where chave = 'ia_segredo';
  v_marca := encode(sha256(convert_to(v_tel || coalesce(v_sal, ''), 'UTF8')), 'hex');
  delete from public.pmarc_tentativa where quando < now() - interval '6 hours';
  if (select count(*) from public.pmarc_tentativa where marca = v_marca and tipo = 'identificar' and quando > now() - interval '1 hour') >= 8 then
    return jsonb_build_object('ok', false, 'motivo', 'muitas_tentativas');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('codigo', x.codigo, 'primeiro_nome', initcap(split_part(lower(coalesce(nullif(btrim(x.nome), ''), '')), ' ', 1)))), '[]'::jsonb)
    into v_lista
  from (select codigo, nome from public.pmarc_pessoa
         where p_nascimento is not null and nascimento = p_nascimento and (celular = v_tel or telefone = v_tel) order by criado_em limit 5) x;
  if jsonb_array_length(v_lista) = 0 then
    insert into public.pmarc_tentativa (marca, tipo) values (v_marca, 'identificar');
    return jsonb_build_object('ok', true, 'achou', false);
  end if;
  return jsonb_build_object('ok', true, 'achou', true, 'pessoas', v_lista);
end $$;

-- ---------- 3) quem não achou a previsão: entra assim mesmo ----------
create or replace function public.pmarc_novo(p_nome text, p_celular text, p_nascimento date default null, p_texto text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tel text; v_nome text; v_max integer; v_id uuid; v_codigo text; v_obs text;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_tel := public.pmarc_telefone(p_celular);
  if v_tel is null then return jsonb_build_object('ok', false, 'motivo', 'celular_invalido'); end if;
  v_nome := left(btrim(coalesce(p_nome, '')), 120);
  v_obs := nullif(left(btrim(coalesce(p_texto, '')), 1000), '');
  -- o mesmo celular volta para o mesmo pré-cadastro espontâneo
  select codigo into v_codigo from public.pmarc_pessoa where origem = 'espontaneo' and celular = v_tel order by criado_em limit 1;
  if v_codigo is null then
    v_max := coalesce((select case when valor ~ '^[0-9]+$' then valor::int end from public.config where chave = 'previsao_marcacao_novos_max_hora'), 60);
    if (select count(*) from public.pmarc_pessoa where origem = 'espontaneo' and criado_em > now() - interval '1 hour') >= v_max then
      return jsonb_build_object('ok', false, 'motivo', 'muitos');
    end if;
    insert into public.pmarc_pessoa (chave, nome, celular, nascimento, origem, informado, primeiro_acesso_em, ultimo_acesso_em)
    values ('p:' || replace(gen_random_uuid()::text, '-', ''), nullif(v_nome, ''), v_tel, p_nascimento, 'espontaneo',
            jsonb_strip_nulls(jsonb_build_object('observacao', v_obs, 'nome_revisar', case when char_length(v_nome) < 2 then true end)), now(), now())
    returning id, codigo into v_id, v_codigo;
  else
    select id into v_id from public.pmarc_pessoa where codigo = v_codigo;
    update public.pmarc_pessoa set ultimo_acesso_em = now(), nascimento = coalesce(nascimento, p_nascimento) where id = v_id;
  end if;
  return public.pmarc_vista(v_id);
end $$;

-- ---------- 4) responder à previsão e deixar os dados ----------
-- p_dados: { resposta: 'sim'|'nao'|'nao_sei', texto, observacao, nome, celular, email, cpf, nascimento (AAAA-MM-DD) }. Tudo opcional. NADA aqui recusa o paciente por conteúdo.
create or replace function public.pmarc_responder(p_codigo text, p_dados jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.pmarc_pessoa; d jsonb := case when jsonb_typeof(p_dados) = 'object' then p_dados else '{}'::jsonb end;
  v_resp text; v_info jsonb; v_txt text; v_obs text; v_conv uuid; v_msg text; v_cel text; v_email text; v_cpf text; v_nasc date; v_nome text; v_primeira boolean;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;

  v_txt := nullif(left(btrim(coalesce(d ->> 'texto', '')), 1000), '');
  v_resp := coalesce(nullif(d ->> 'resposta', ''), public.pmarc_classificar(v_txt));
  if v_resp is not null and v_resp not in ('sim', 'nao', 'nao_sei') then v_resp := public.pmarc_classificar(v_resp); end if;
  v_obs := nullif(left(btrim(coalesce(d ->> 'observacao', '')), 1000), '');
  v_info := p.informado;

  v_nome := nullif(left(btrim(coalesce(d ->> 'nome', '')), 120), '');
  if v_nome is not null then v_info := v_info || jsonb_build_object('nome', v_nome); end if;
  if nullif(btrim(coalesce(d ->> 'celular', '')), '') is not null then
    v_cel := public.pmarc_telefone(d ->> 'celular');
    if v_cel is not null then v_info := v_info || jsonb_build_object('celular', v_cel);
    else v_info := v_info || jsonb_build_object('celular_digitado', left(regexp_replace(d ->> 'celular', '[^0-9+() -]', '', 'g'), 20), 'celular_revisar', true); end if;
  end if;
  if nullif(btrim(coalesce(d ->> 'email', '')), '') is not null then
    v_email := left(lower(btrim(d ->> 'email')), 200);
    v_info := v_info || jsonb_build_object('email', v_email) || case when v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then jsonb_build_object('email_revisar', false) else jsonb_build_object('email_revisar', true) end;
  end if;
  if nullif(btrim(coalesce(d ->> 'cpf', '')), '') is not null then
    v_cpf := left(regexp_replace(d ->> 'cpf', '\D', '', 'g'), 14);
    v_info := v_info || jsonb_build_object('cpf', v_cpf, 'cpf_revisar', char_length(v_cpf) <> 11);
  end if;
  if nullif(btrim(coalesce(d ->> 'nascimento', '')), '') is not null then
    begin
      v_nasc := (d ->> 'nascimento')::date;
      if v_nasc between date '1900-01-01' and current_date then
        if p.nascimento is null then p.nascimento := v_nasc; else v_info := v_info || jsonb_build_object('nascimento', v_nasc, 'nascimento_revisar', v_nasc <> p.nascimento); end if;
      else v_info := v_info || jsonb_build_object('nascimento_digitado', left(d ->> 'nascimento', 20), 'nascimento_revisar', true); end if;
    exception when others then
      v_info := v_info || jsonb_build_object('nascimento_digitado', left(d ->> 'nascimento', 20), 'nascimento_revisar', true);
    end;
  end if;
  if v_obs is not null then v_info := v_info || jsonb_build_object('observacao', v_obs); end if;

  update public.pmarc_pessoa set
    informado = v_info, nascimento = p.nascimento, aceitou_lgpd_em = coalesce(aceitou_lgpd_em, now()),
    resposta = coalesce(v_resp, resposta), respondeu_em = case when v_resp is not null then now() else respondeu_em end,
    primeiro_acesso_em = coalesce(primeiro_acesso_em, now()), ultimo_acesso_em = now(), atualizado_em = now()
  where id = p.id;

  v_conv := public.pmarc_conversa_garantir(p.id);
  if v_conv is not null then
    v_msg := 'Previsão de marcação: ' || case v_resp when 'sim' then 'a pessoa disse que está certo.' when 'nao' then 'a pessoa disse que tem algo diferente.'
                                              when 'nao_sei' then 'a pessoa não sabe / pediu para seguir (nada foi barrado).' else 'a pessoa deixou os dados abaixo.' end
      || case when v_txt is not null and nullif(d ->> 'resposta', '') is null then E'\nDisse: ' || v_txt else '' end
      || case when v_obs is not null then E'\nObservação: ' || v_obs else '' end
      || case when v_nome is not null then E'\nNome: ' || v_nome else '' end
      || case when v_cel is not null then E'\nCelular: ' || v_cel when d ->> 'celular' is not null and btrim(d ->> 'celular') <> '' then E'\nCelular (conferir): ' || left(d ->> 'celular', 20) else '' end
      || case when v_email is not null then E'\nE-mail: ' || v_email else '' end
      || case when v_cpf is not null then E'\nCPF: ' || v_cpf else '' end
      || case when v_nasc is not null then E'\nNascimento: ' || to_char(v_nasc, 'DD/MM/YYYY') else '' end;
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
    update public.conversas set triagem_resumo = regexp_replace(coalesce(triagem_resumo, ''), '\s*Resposta à previsão:.*$', '') ||
      ' Resposta à previsão: ' || case coalesce(v_resp, p.resposta) when 'sim' then 'está certo' when 'nao' then 'tem algo diferente' when 'nao_sei' then 'não sei / seguimos (não bloquear)' else 'sem resposta ainda' end || '.'
      where id = v_conv;
    if coalesce(v_info ->> 'final_em', '') = '' then
      insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'agente', public.pmarc_texto('previsao_marcacao_final'));
      update public.pmarc_pessoa set informado = informado || jsonb_build_object('final_em', now()) where id = p.id;
    end if;
  end if;
  return public.pmarc_vista(p.id) || jsonb_build_object('sem_celular', v_conv is null);
end $$;

-- ---------- 5) mensagens da conversa (a página consulta a cada poucos segundos) ----------
create or replace function public.pmarc_mensagens(p_codigo text, p_apos bigint default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.pmarc_pessoa;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, ''));
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  if p.conversa_id is null then return jsonb_build_object('ok', true, 'mensagens', '[]'::jsonb); end if;
  return jsonb_build_object('ok', true, 'mensagens', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'criado_em', m.criado_em,
             'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id)
    from public.mensagens m left join public.agentes ag on ag.id = m.agente_id
    where m.conversa_id = p.conversa_id and m.id > coalesce(p_apos, 0) and m.excluida_em is null), '[]'::jsonb));
end $$;

-- ---------- 6) escrever para a equipe ----------
create or replace function public.pmarc_enviar(p_codigo text, p_texto text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.pmarc_pessoa; v_txt text; v_conv uuid; v_class text; v_id bigint; c public.conversas;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_txt := left(btrim(coalesce(p_texto, '')), 4000);
  if v_txt = '' then return jsonb_build_object('ok', false, 'motivo', 'texto_vazio'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  v_conv := public.pmarc_conversa_garantir(p.id);
  if v_conv is null then return jsonb_build_object('ok', false, 'motivo', 'sem_celular'); end if;
  if (select count(*) from public.mensagens where conversa_id = v_conv and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    return jsonb_build_object('ok', false, 'motivo', 'muitas_mensagens');
  end if;
  select * into c from public.conversas where id = v_conv;
  if c.status = 'encerrada' then
    update public.conversas set status = 'aguardando', agente_id = null where id = v_conv;
    -- reabrir religa o robô e apaga o resumo: aqui o robô continua desligado e o resumo volta
    update public.conversas set ia_ativa = false, triagem_resumo = c.triagem_resumo where id = v_conv;
  end if;
  insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_txt) returning id into v_id;
  -- "não sei", "seguimos"... também valem como resposta à previsão (e a pessoa recebe o aviso final uma única vez)
  v_class := public.pmarc_classificar(v_txt);
  update public.pmarc_pessoa set aceitou_lgpd_em = coalesce(aceitou_lgpd_em, now()), ultimo_acesso_em = now(), atualizado_em = now(),
    resposta = case when resposta is null and v_class is not null then v_class else resposta end,
    respondeu_em = case when resposta is null and v_class is not null then now() else respondeu_em end
  where id = p.id;
  if coalesce(p.informado ->> 'final_em', '') = '' then
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'agente', public.pmarc_texto('previsao_marcacao_final'));
    update public.pmarc_pessoa set informado = informado || jsonb_build_object('final_em', now()) where id = p.id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- ---------- permissões ----------
do $$
declare f text;
begin
  foreach f in array array[
    'pmarc_telefone(text)', 'pmarc_tipo(text)', 'pmarc_classificar(text)', 'pmarc_ligada()', 'pmarc_texto(text)', 'pmarc_itens(text)', 'pmarc_vista(uuid)',
    'pmarc_conversa_garantir(uuid, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array[
    'pmarc_abrir(text)', 'pmarc_identificar(text, date)', 'pmarc_novo(text, text, date, text)', 'pmarc_responder(text, jsonb)', 'pmarc_mensagens(text, bigint)', 'pmarc_enviar(text, text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end $$;
