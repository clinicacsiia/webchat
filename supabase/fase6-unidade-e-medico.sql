-- Fase 6: unidade e médico de preferência perguntados logo no início do chat.
--
-- O que muda:
--  * unidade_config: as unidades que o paciente escolhe no início, o tipo de atendimento de cada uma
--    (fluxo) e o texto de instrução que a IA recebe. Ajustar o atendimento de uma unidade = editar a tabela,
--    sem mexer no prompt do n8n.
--  * conversas.unidade_inicial / medico_preferido: o que o paciente escolheu no formulário.
--  * chat_opcoes_inicio(): lista pública (unidades e, de cada uma, os médicos com consulta na agenda vigente).
--  * chat_iniciar: ganha p_unidade e p_medico (a escolha é gravada ANTES da primeira mensagem, para a IA
--    já responder sabendo onde o paciente quer ser atendido).
--  * ia_contexto: devolve 'inicio' (unidade, fluxo, instrução e médico de preferência).
--  * ia_catalogo: com a unidade escolhida, só procura exames e agenda dessa unidade.
--  * chat_horarios: o médico de preferência vira filtro do calendário; se ele não tiver horário para o
--    pedido, o calendário mostra os outros e avisa.
--
-- Aditivo e seguro para rodar de novo. Aplicar ANTES de publicar o index.html novo.
-- O comando drop da assinatura antiga de chat_iniciar está no fim do arquivo (pede confirmação humana no Supabase).

-- ===== 1. Unidades e tipo de atendimento =====
create table if not exists public.unidade_config (
  chave      text primary key,
  catalogo   text not null,             -- nome exato da unidade no Klingo (catalogo_agenda.unidade)
  rotulo     text not null,             -- como aparece para o paciente
  descricao  text not null,             -- linha de apoio no formulário
  fluxo      text not null check (fluxo in ('pediatria', 'exame_consulta')),
  instrucao  text not null,             -- vai para a IA em ia_contexto().inicio.instrucao
  ordem      integer not null default 0,
  ativo      boolean not null default true
);
alter table public.unidade_config enable row level security;
comment on table public.unidade_config is 'Unidades escolhidas no início do chat. fluxo = tipo de atendimento previsto (pediatria | exame_consulta); instrucao é lida pela IA. Sem policy: só funções security definer acessam.';

insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, ordem, instrucao) values
('desenvoar', 'DESENVOAR', 'Desenvoar', 'Atendimento pediátrico (crianças e adolescentes)', 'pediatria', 1,
 'O paciente escolheu a DESENVOAR: atendimento PEDIÁTRICO. Quem será atendido é uma criança ou adolescente, e quem conversa costuma ser o responsável.'
 || ' PEDIDO: não use o mapa do corpo. Pergunte o motivo em UMA lista de escolha única, usando só o que existir em procedimentos/especialidades_com_agenda da DESENVOAR: consulta de pediatria (rotina, puericultura, retorno, dúvida), consulta com especialista (neuropediatria, endocrinologia, gastroenterologia, ortopedia) ou exame (por exemplo eletroencefalograma), mais "Outro". Se descrever sintoma, ajude só a escolher o tipo de consulta, sem diagnosticar; na dúvida, pediatria.'
 || ' MÉDICO: se inicio.medico_preferido vier preenchido, registre em profissional e NÃO pergunte de novo; se o médico dele não faz o que foi pedido (confira em agenda), avise com delicadeza e ofereça outro da mesma especialidade. Se vier vazio, não pergunte médico (o paciente já disse que tanto faz).'
 || ' UNIDADE: já é a DESENVOAR; registre unidade "DESENVOAR" e pule a pergunta de unidade na etapa preferencias (pergunte só o período do dia).'
 || ' DADOS: o paciente é a CRIANÇA. Na identificação peça nome completo e data de nascimento DA CRIANÇA, sexo e nome da mãe; depois o nome e o celular do responsável. Se a criança não tiver CPF, aceite o CPF do responsável e diga no resumo que o CPF é do responsável. Carteirinha do convênio é a da criança.'
 || ' Emergência pediátrica (febre alta em bebê pequeno, falta de ar, convulsão, desidratação, sangue nas fezes ou vômitos, qualquer sinal grave): oriente ligar 192 (SAMU) ou ir ao pronto-socorro, urgencia "alta" e transferir true.'),
('csi', 'CLÍNICA DE SAÚDE E IMAGEM - CSI', 'CSI', 'Exames e consultas', 'exame_consulta', 2,
 'O paciente escolheu a unidade CSI: EXAMES e CONSULTAS. Se a primeira mensagem não deixar claro, pergunte em UMA lista de escolha única: "Consulta", "Exame de imagem (ressonância, tomografia, ultrassom, raio-X, mamografia, densitometria)" ou "Outro exame".'
 || ' Exame de imagem: use o MAPA DO CORPO. Consulta: use lista com as especialidades de especialidades_com_agenda da CSI. Registre unidade "CLÍNICA DE SAÚDE E IMAGEM - CSI" e não pergunte a unidade de novo.'
 || ' MÉDICO: em consulta, se inicio.medico_preferido vier preenchido, registre em profissional e não pergunte de novo (confira em agenda se ele atende a especialidade; se não, avise e ofereça outro). Em exame de imagem o profissional não é escolhido pelo paciente.'),
('rmtc', 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC', 'CSI RM/TC', 'Ressonância e tomografia', 'exame_consulta', 3,
 'O paciente escolheu a unidade CSI RM/TC: ressonância magnética e tomografia (e exames desse tipo). Vá direto ao MAPA DO CORPO, sem perguntar se é consulta. Se pedir consulta ou outro tipo de exame, explique com delicadeza que nesta unidade o atendimento é de ressonância e tomografia, e ofereça a unidade CSI ou deixe o atendente orientar.'
 || ' Registre unidade "CLÍNICA DE SAÚDE E IMAGEM - RM/TC" e não pergunte a unidade de novo. Não há escolha de médico nesta unidade.')
on conflict (chave) do update set
  catalogo = excluded.catalogo, rotulo = excluded.rotulo, descricao = excluded.descricao,
  fluxo = excluded.fluxo, instrucao = excluded.instrucao, ordem = excluded.ordem;

-- ===== 2. Escolha gravada na conversa =====
alter table public.conversas add column if not exists unidade_inicial text references public.unidade_config (chave);
alter table public.conversas add column if not exists medico_preferido text;
comment on column public.conversas.unidade_inicial is 'Unidade escolhida no formulário inicial (null = "não sei"). Chave de unidade_config.';
comment on column public.conversas.medico_preferido is 'Médico de preferência escolhido no formulário (nome exato da agenda do Klingo). null = sem preferência.';

-- ===== 3. Médicos de cada unidade =====
-- Só quem tem consulta na agenda vigente; fora recursos que não são médico para o paciente escolher
-- (eletrocardiograma, eletroencefalograma, anestesiologia) e agenda de teste.
create or replace function public.unidade_medicos(p_chave text)
returns table (nome text, especialidade text)
language sql stable security definer set search_path to '' as $$
  select a.profissional, string_agg(distinct initcap(lower(a.especialidade)), ' / ' order by initcap(lower(a.especialidade)))
  from public.unidade_config u
  join public.catalogo_agenda a on a.unidade = u.catalogo
  join public.catalogo_procedimento p on p.id = a.procedimento_id
  where u.chave = p_chave and u.ativo
    and p.classe = 'CONSULTAS'
    and a.vig_fim >= current_date
    and a.profissional !~* '(teste|^eletro)'
    and coalesce(a.especialidade, '') !~* 'anestesi'
  group by a.profissional
  order by a.profissional;
$$;

create or replace function public.chat_opcoes_inicio() returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'chave', u.chave, 'catalogo', u.catalogo, 'rotulo', u.rotulo, 'descricao', u.descricao, 'fluxo', u.fluxo,
    'medicos', coalesce((select jsonb_agg(jsonb_build_object('nome', m.nome, 'especialidade', m.especialidade) order by m.nome)
                         from public.unidade_medicos(u.chave) m), '[]'::jsonb)
  ) order by u.ordem), '[]'::jsonb)
  from public.unidade_config u where u.ativo;
$$;
grant execute on function public.chat_opcoes_inicio() to anon, authenticated;

-- Paciente desiste do médico escolhido (botão "Ver horários de outros médicos" no calendário).
create or replace function public.chat_medico_limpar(p_conversa uuid, p_token text) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  perform public.chat_valida(p_conversa, p_token);
  update public.conversas set medico_preferido = null where id = p_conversa;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.chat_medico_limpar(uuid, text) to anon, authenticated;

-- ===== 4. chat_iniciar com unidade e médico =====
create or replace function public.chat_iniciar(p_nome text, p_telefone text, p_email text default null, p_mensagem text default null,
                                               p_aceite boolean default false, p_origem text default null,
                                               p_unidade text default null, p_medico text default null)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_tel text; v_contato uuid; v_conv uuid; v_token text; v_url text;
  v_nome text; v_msg text; v_recentes int; v_uni text; v_med text;
begin
  if not coalesce(p_aceite, false) then
    raise exception 'Aceite a política de privacidade para continuar.' using errcode = '22023';
  end if;
  v_nome := btrim(coalesce(p_nome, ''));
  if char_length(v_nome) < 2 then
    raise exception 'Informe seu nome.' using errcode = '22023';
  end if;
  v_tel := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then
    raise exception 'Informe um telefone válido com DDD.' using errcode = '22023';
  end if;
  v_msg := btrim(coalesce(p_mensagem, ''));
  if char_length(v_msg) > 4000 then
    raise exception 'Mensagem muito longa.' using errcode = '22023';
  end if;

  -- Unidade e médico: só valores que existem (o formulário nunca manda texto livre).
  if nullif(btrim(coalesce(p_unidade, '')), '') is not null then
    select u.chave into v_uni from public.unidade_config u where u.chave = btrim(p_unidade) and u.ativo;
    if v_uni is null then raise exception 'Unidade inválida.' using errcode = '22023'; end if;
  end if;
  if nullif(btrim(coalesce(p_medico, '')), '') is not null then
    if v_uni is null then raise exception 'Escolha a unidade para indicar o médico.' using errcode = '22023'; end if;
    select m.nome into v_med from public.unidade_medicos(v_uni) m where m.nome = btrim(p_medico);
    if v_med is null then raise exception 'Médico não encontrado nesta unidade.' using errcode = '22023'; end if;
  end if;

  select c.id into v_contato from public.contatos c where c.telefone = v_tel;
  if v_contato is not null then
    select count(*) into v_recentes from public.conversas
    where contato_id = v_contato and criado_em > now() - interval '1 hour';
    if v_recentes >= 5 then
      raise exception 'Muitas tentativas. Tente novamente em alguns minutos.' using errcode = '54000';
    end if;
  end if;

  insert into public.contatos (nome, telefone, email, origem, aceitou_lgpd_em)
  values (left(v_nome, 120), v_tel, nullif(left(btrim(coalesce(p_email, '')), 200), ''),
          nullif(left(btrim(coalesce(p_origem, '')), 100), ''), now())
  on conflict (telefone) do update set
    ultimo_contato_em = now(),
    email = coalesce(public.contatos.email, excluded.email),
    aceitou_lgpd_em = coalesce(public.contatos.aceitou_lgpd_em, now())
  returning id into v_contato;

  insert into public.conversas (contato_id, nome_informado, email_informado, unidade_inicial, medico_preferido)
  values (v_contato, left(v_nome, 120), nullif(left(btrim(coalesce(p_email, '')), 200), ''), v_uni, v_med)
  returning id into v_conv;
  insert into public.conversa_segredo (conversa_id) values (v_conv) returning token into v_token;

  if v_msg <> '' then
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
  end if;

  select valor into v_url from public.config where chave = 'n8n_webhook_url';
  if coalesce(v_url, '') <> '' then
    begin
      perform net.http_post(
        url := v_url,
        body := jsonb_build_object(
          'evento', 'nova_conversa', 'conversa_id', v_conv, 'nome', v_nome,
          'telefone', v_tel, 'email', nullif(btrim(coalesce(p_email, '')), ''),
          'mensagem', v_msg, 'origem', p_origem, 'criado_em', now()),
        headers := '{"Content-Type":"application/json"}'::jsonb);
    exception when others then null;
    end;
  end if;

  return jsonb_build_object('conversa_id', v_conv, 'token', v_token);
end $function$;
grant execute on function public.chat_iniciar(text, text, text, text, boolean, text, text, text) to anon, authenticated;

-- ===== 5. ia_contexto: devolve 'inicio' =====
create or replace function public.ia_contexto(p_segredo text, p_conversa uuid)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_seg text; r jsonb;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then
    raise exception 'Não autorizado.' using errcode = '28000';
  end if;
  select jsonb_build_object(
    'ia_ativa', c.ia_ativa and c.status = 'aguardando'
                and coalesce((select valor from public.config where chave = 'ia_ativa'), 'sim') = 'sim',
    'status', c.status,
    'nome', coalesce(c.nome_informado, ct.nome), 'telefone', ct.telefone, 'origem', ct.origem,
    'inicio', coalesce(
      (select jsonb_build_object('unidade', u.rotulo, 'unidade_catalogo', u.catalogo, 'fluxo', u.fluxo,
                                 'medico_preferido', c.medico_preferido, 'instrucao', u.instrucao)
       from public.unidade_config u where u.chave = c.unidade_inicial),
      jsonb_build_object('unidade', null, 'unidade_catalogo', null, 'fluxo', 'indefinido', 'medico_preferido', null,
        'instrucao', 'O paciente não soube dizer a unidade. As unidades são: DESENVOAR (atendimento pediátrico), CLÍNICA DE SAÚDE E IMAGEM - CSI (exames e consultas) e CLÍNICA DE SAÚDE E IMAGEM - RM/TC (ressonância e tomografia). Descubra o que ele precisa e SUGIRA a unidade (criança ou adolescente: DESENVOAR; ressonância ou tomografia: RM/TC; outros exames e consultas: CSI), em uma lista de escolha única, antes da etapa preferencias.')),
    'pedido_itens', coalesce((select jsonb_agg(jsonb_build_object('modalidade', i.modalidade, 'parte_do_corpo', i.regiao_nome, 'lado', case i.lado when 'D' then 'direito' when 'E' then 'esquerdo' when 'A' then 'ambos' else null end, 'exame', i.procedimento, 'quantidade', i.quantidade) order by i.id) from public.pre_agendamento_itens i where i.conversa_id = c.id and i.ativo), '[]'::jsonb),
    'paciente_conhecido', (public.paciente_conferir(c.id) - 'paciente_id'),
    'historico_paciente', public.paciente_historico_para_ia(c.id),
    'pre_agendamento', (select to_jsonb(pa) - 'id' - 'conversa_id' - 'criado_em' - 'atualizado_em' - 'klingo_paciente_id' - 'paciente_id'
                        from public.pre_agendamentos pa where pa.conversa_id = c.id),
    'mensagens', coalesce((
      select jsonb_agg(jsonb_build_object('autor', m.autor, 'texto', m.texto) order by m.id)
      from (select * from public.mensagens where conversa_id = c.id and autor in ('cliente','agente')
            order by id desc limit 40) m), '[]'::jsonb))
  into r
  from public.conversas c join public.contatos ct on ct.id = c.contato_id
  where c.id = p_conversa;
  return r;
end $function$;

-- ===== 6. ia_catalogo e chat_horarios: alterados por substituição (como as demais correções do projeto) =====
-- Cada substituição confere que achou o trecho; se a função mudou e o trecho sumiu, o script para com erro.
create or replace function pg_temp.sub(p_texto text, p_de text, p_para text) returns text language plpgsql as $$
begin
  if position(p_de in p_texto) = 0 then raise exception 'Trecho não encontrado: %', left(p_de, 80); end if;
  return replace(p_texto, p_de, p_para);
end $$;

do $do$
declare v_def text; v_new text;
begin
  -- ia_catalogo: com unidade escolhida, só procedimentos e agenda dessa unidade.
  v_def := pg_get_functiondef('public.ia_catalogo(text,uuid)'::regprocedure);
  if position('v_uni' in v_def) = 0 then
    v_new := pg_temp.sub(v_def, E'declare\n  v_etapa text;', E'declare\n  v_uni text; v_etapa text;');
    v_new := pg_temp.sub(v_new, 'select pa.etapa into v_etapa from public.pre_agendamentos pa where pa.conversa_id = p_conversa;',
      'select pa.etapa into v_etapa from public.pre_agendamentos pa where pa.conversa_id = p_conversa;'
      || E'\n  select u.catalogo into v_uni from public.conversas c join public.unidade_config u on u.chave = c.unidade_inicial where c.id = p_conversa;');
    v_new := pg_temp.sub(v_new, 'from public.catalogo_procedimento p where p.ativo and p.busca @@ v_q',
      'from public.catalogo_procedimento p where p.ativo and p.busca @@ v_q'
      || E'\n          and (v_uni is null or exists (select 1 from public.catalogo_agenda ua where ua.procedimento_id = p.id and ua.unidade = v_uni and ua.vig_fim >= current_date and ua.profissional !~* ''teste''))');
    v_new := pg_temp.sub(v_new, 'and a.profissional !~* ''teste'') d', 'and a.profissional !~* ''teste'' and (v_uni is null or a.unidade = v_uni)) d');
    execute v_new;
  end if;

  -- chat_horarios: médico de preferência filtra o calendário, com volta para "qualquer médico".
  v_def := pg_get_functiondef('public.chat_horarios(uuid,text,integer,date,date,text,text,jsonb)'::regprocedure);
  if position('v_pref' in v_def) = 0 then
    v_new := pg_temp.sub(v_def, 'v_titulo text; v_jan jsonb;', 'v_titulo text; v_jan jsonb; v_pref text; v_med text; v_med_sem boolean := false;');
    v_new := pg_temp.sub(v_new, 'with h as (select * from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, null, p_periodo,',
      E'select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;\n'
      || E'  v_med := v_pref;\n'
      || E'  if v_med is not null and not exists (select 1 from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, v_med, p_periodo, ''[]''::jsonb)) then\n'
      || E'    v_med := null; v_med_sem := true;\n'
      || E'  end if;\n'
      || E'  with h as (select * from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, v_med, p_periodo,');
    v_new := pg_temp.sub(v_new, '''sem_exame'', v_sem, ''atualizado_em'', v_meta,',
      '''sem_exame'', v_sem, ''medico_preferido'', v_pref, ''medico_filtrando'', v_med is not null, ''medico_sem_horario'', v_med_sem, ''atualizado_em'', v_meta,');
    execute v_new;
  end if;
end $do$;

-- ===== 7. Limpeza (rodar depois, por pessoa: o Supabase pede confirmação em "drop") =====
-- A assinatura antiga de 6 parâmetros precisa sair, senão chamadas com 6 argumentos ficam ambíguas:
-- drop function public.chat_iniciar(text, text, text, text, boolean, text);
