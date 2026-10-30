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
 'O paciente escolheu a DESENVOAR: atendimento PEDIÁTRICO (crianças e adolescentes).'
 || ' PEDIDO: não use o mapa do corpo. Pergunte o motivo em UMA lista de escolha única: "Consulta" (pediatria, puericultura, retorno ou especialista), "Exame (por exemplo eletroencefalograma)" e "Outro". Se for consulta, envie opcoes {"tipo":"pedido_consulta"}: o paciente escolhe o tipo de consulta (pediatria, puericultura, teleconsulta, neuropediatria, endocrinologia, gastroenterologia, ortopedia) com os dados do cadastro; é isso que libera o calendário. Exame (EEG): registre o pedido pelas palavras dele e diga que o atendente agenda (o calendário ainda não cobre esse exame). Se descrever sintoma, ajude só a escolher o tipo de consulta, sem diagnosticar; na dúvida, pediatria.'
 || ' MÉDICO: se inicio.medico_preferido vier preenchido, registre em profissional e NÃO pergunte de novo; se o médico dele não faz o que foi pedido (confira em agenda), avise com delicadeza e ofereça outro da mesma especialidade. Se vier vazio, não pergunte médico (o paciente já disse que tanto faz).'
 || ' UNIDADE: já é a DESENVOAR; registre unidade "DESENVOAR" e pule a pergunta de unidade na etapa preferencias (pergunte só o período do dia).'),
('csi', 'CLÍNICA DE SAÚDE E IMAGEM - CSI', 'CSI', 'Exames e consultas', 'exame_consulta', 2,
 'O paciente escolheu a unidade CSI: EXAMES e CONSULTAS. Se a primeira mensagem não deixar claro, pergunte em UMA lista de escolha única: "Consulta", "Exame de imagem (ressonância, tomografia, ultrassom, raio-X, mamografia, densitometria)" ou "Outro exame".'
 || ' Exame de imagem: use o MAPA DO CORPO. Consulta: envie opcoes {"tipo":"pedido_consulta"} (o paciente escolhe o tipo de consulta; é isso que libera o calendário). Registre unidade "CLÍNICA DE SAÚDE E IMAGEM - CSI" e não pergunte a unidade de novo.'
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

-- Quem será atendido: o próprio paciente ou um filho(a) (quem conversa é o responsável).
-- Um responsável com vários filhos abre UMA conversa por criança: cada uma tem seu pré-agendamento, seus horários
-- (a regra "mesmo paciente em dois lugares" vale por criança) e seu cadastro.
alter table public.conversas add column if not exists paciente_tipo text not null default 'proprio' check (paciente_tipo in ('proprio', 'filho'));
alter table public.conversas add column if not exists paciente_nome text;
comment on column public.conversas.paciente_tipo is 'proprio = quem conversa é o paciente; filho = quem conversa é o responsável e o paciente é a criança/adolescente (nome em paciente_nome).';
comment on column public.conversas.paciente_nome is 'Nome da criança, informado no formulário quando paciente_tipo = filho. Nome, telefone e e-mail do formulário continuam sendo os do responsável.';

-- Mais de um filho: uma conversa por criança, ligadas em fila.
--  irmaos: nomes dos filhos que AINDA faltam depois desta criança; irmaos_modo: como o responsável quer agendar:
--    'um_de_cada_vez' = cada criança com o seu pedido, do zero;
--    'juntos'         = o pedido (consulta/exames, plano, unidade, médico) é copiado para a criança seguinte e o calendário
--                       sugere o horário logo depois do da anterior.
--  irmao_de: conversa da criança anterior (de onde vem a cópia e o horário de referência).
alter table public.conversas add column if not exists irmaos jsonb not null default '[]'::jsonb;
alter table public.conversas add column if not exists irmaos_modo text check (irmaos_modo in ('um_de_cada_vez', 'juntos'));
alter table public.conversas add column if not exists irmao_de uuid references public.conversas (id) on delete set null;
comment on column public.conversas.irmaos is 'Nomes dos outros filhos que ainda faltam agendar depois desta criança (máx. 5).';

create table if not exists public.atendimento_tipo (
  chave text primary key check (chave in ('proprio', 'filho')),
  instrucao text not null
);
alter table public.atendimento_tipo enable row level security;
comment on table public.atendimento_tipo is 'Instrução da IA conforme quem será atendido (próprio ou filho). Vai em ia_contexto().inicio.instrucao_paciente. Sem policy: só funções security definer.';
insert into public.atendimento_tipo (chave, instrucao) values
('proprio', 'Quem conversa é o próprio paciente. Chame-o pelo primeiro nome (campo nome) já na primeira resposta.'),
('filho', 'ATENÇÃO: quem conversa é o RESPONSÁVEL e o paciente é o FILHO(A) (criança ou adolescente).'
 || ' TRATAMENTO: chame o responsável pelo primeiro nome (campo nome) e a criança pelo primeiro nome dela (inicio.paciente_nome) o tempo todo. Já na primeira resposta cumprimente os dois, por exemplo: "Olá, Maria! Vamos agendar para o Lucas." (sem presumir o gênero da criança: se não souber, escreva "para Lucas"). Se paciente_nome vier vazio, pergunte o nome da criança antes de qualquer outra coisa.'
 || ' DADOS: o nome, o telefone e o e-mail do formulário são do RESPONSÁVEL. No campo paciente registre os dados da CRIANÇA: nome (use inicio.paciente_nome; se o responsável der o nome completo, use o completo), data de nascimento, sexo e nome da mãe. O celular do responsável vai em celular. Peça também o nome do responsável se ainda não souber; não invente parentesco.'
 || ' CPF: peça o da criança; se ela não tiver, aceite o do responsável e escreva no resumo que o CPF é do responsável. Carteirinha do convênio: a da criança. Idade: confira idade_min/idade_max do procedimento com a idade da CRIANÇA.'
 || ' UMA CRIANÇA POR CONVERSA: nunca misture dados de duas crianças.'
 || ' OUTROS FILHOS: se inicio.irmaos_que_faltam não for vazio, o responsável já informou que também vai agendar para os outros (irmaos_modo "um_de_cada_vez": cada criança com o seu pedido; "juntos": o mesmo pedido para todas, com horários em sequência). Atenda a criança desta conversa e, ao final (etapa pronto), avise pelo nome: "Agora vamos para o Pedro. É só tocar em "Agendar para Pedro" aqui embaixo." No modo "juntos", diga que o pedido (consulta, plano e unidade) será copiado e que o calendário vai sugerir o horário logo depois do de Lucas. Se irmaos_que_faltam for vazio e o responsável falar de outro filho, diga que dá para tocar nos três pontinhos e escolher "Agendar para outro filho(a)".'
 || ' ESTA CONVERSA VEIO DE UM IRMÃO (inicio.irmao_anterior preenchido): se pedido_copiado_do_irmao for true, o pedido já está em pre_agendamento e pedido_itens: confirme em uma frase ("Copiei o pedido de Lucas para Pedro") e siga direto para o calendário (etapa data_hora) e depois os dados da criança; não refaça o pedido. Se for false, comece o pedido do zero.'
 || ' Emergência pediátrica (febre alta em bebê pequeno, falta de ar, convulsão, desidratação, sangue nas fezes ou no vômito, qualquer sinal grave): oriente ligar 192 (SAMU) ou ir ao pronto-socorro, urgencia "alta" e transferir true.')
on conflict (chave) do update set instrucao = excluded.instrucao;

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
                                               p_unidade text default null, p_medico text default null,
                                               p_paciente_tipo text default 'proprio', p_paciente_nome text default null,
                                               p_irmaos jsonb default null, p_irmaos_modo text default null)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_tel text; v_contato uuid; v_conv uuid; v_token text; v_url text;
  v_nome text; v_msg text; v_recentes int; v_uni text; v_med text; v_tipo text; v_pnome text; v_irm jsonb := '[]'::jsonb; v_modo text;
begin
  v_tipo := coalesce(nullif(btrim(p_paciente_tipo), ''), 'proprio');
  if v_tipo not in ('proprio', 'filho') then raise exception 'Tipo de paciente inválido.' using errcode = '22023'; end if;
  v_pnome := case when v_tipo = 'filho' then nullif(left(btrim(coalesce(p_paciente_nome, '')), 120), '') end;
  if p_irmaos is not null then
    if jsonb_typeof(p_irmaos) <> 'array' then raise exception 'Lista de filhos inválida.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(t.n), '[]'::jsonb) into v_irm
    from (select left(btrim(x), 120) as n from jsonb_array_elements_text(p_irmaos) x where btrim(x) <> '' limit 5) t;
  end if;
  if jsonb_array_length(v_irm) > 0 then
    if v_tipo <> 'filho' then raise exception 'Outros filhos só valem quando o atendimento é para um filho(a).' using errcode = '22023'; end if;
    v_modo := coalesce(nullif(btrim(coalesce(p_irmaos_modo, '')), ''), 'um_de_cada_vez');
    if v_modo not in ('um_de_cada_vez', 'juntos') then raise exception 'Modo de agendamento inválido.' using errcode = '22023'; end if;
  end if;
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
  -- Responsável sem mensagem: a conversa já começa com o nome da criança, e a IA cumprimenta pelos nomes.
  if v_msg = '' and v_tipo = 'filho' and v_pnome is not null then v_msg := 'Olá! Quero agendar para ' || v_pnome || '.'; end if;

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

  insert into public.conversas (contato_id, nome_informado, email_informado, unidade_inicial, medico_preferido, paciente_tipo, paciente_nome, irmaos, irmaos_modo)
  values (v_contato, left(v_nome, 120), nullif(left(btrim(coalesce(p_email, '')), 200), ''), v_uni, v_med, v_tipo, v_pnome, v_irm, v_modo)
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
grant execute on function public.chat_iniciar(text, text, text, text, boolean, text, text, text, text, text, jsonb, text) to anon, authenticated;

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
    'inicio', jsonb_build_object('paciente_tipo', c.paciente_tipo, 'paciente_nome', c.paciente_nome,
      'irmaos_que_faltam', c.irmaos, 'irmaos_modo', c.irmaos_modo,
      'irmao_anterior', (select pc.paciente_nome from public.conversas pc where pc.id = c.irmao_de),
      'pedido_copiado_do_irmao', (c.irmaos_modo = 'juntos' or exists (select 1 from public.conversas o where o.id = c.irmao_de and o.irmaos_modo = 'juntos'))
                                 and c.irmao_de is not null and exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = c.id and i.ativo),
      'instrucao_paciente', (select t.instrucao from public.atendimento_tipo t where t.chave = c.paciente_tipo)) ||
      coalesce(
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
    v_new := pg_temp.sub(v_def, 'v_titulo text; v_jan jsonb;', 'v_titulo text; v_jan jsonb; v_pref text; v_med text; v_med_sem boolean := false; v_sug jsonb;');
    v_new := pg_temp.sub(v_new, 'with h as (select * from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, null, p_periodo,',
      E'select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;\n'
      || E'  v_med := v_pref;\n'
      || E'  if v_med is not null and not exists (select 1 from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, v_med, p_periodo, ''[]''::jsonb)) then\n'
      || E'    v_med := null; v_med_sem := true;\n'
      || E'  end if;\n'
      || E'  with h as (select * from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, v_med, p_periodo,');
    -- "Os dois juntos": sugere, no mesmo dia, o primeiro horário livre logo depois do que o irmão anterior escolheu.
    v_new := pg_temp.sub(v_new, 'select coalesce(jsonb_agg(distinct a.unidade), ''[]''::jsonb) into v_unid',
      E'select jsonb_build_object(''data'', s.data, ''hora'', s.hora, ''unidade'', s.unidade, ''profissional'', s.profissional, ''apos'', pc.paciente_nome) into v_sug\n'
      || E'  from public.conversas c join public.conversas pc on pc.id = c.irmao_de\n'
      || E'  join public.pre_agendamentos pp on pp.conversa_id = pc.id and jsonb_typeof(pp.escolha_horario) = ''array''\n'
      || E'  cross join lateral (select e from jsonb_array_elements(pp.escolha_horario) e where (e ->> ''grupo'')::int = greatest(p_grupo, 1) limit 1) pe\n'
      || E'  cross join lateral (select d.data, sl ->> ''hora'' as hora, sl ->> ''unidade'' as unidade, sl ->> ''profissional'' as profissional\n'
      || E'      from jsonb_to_recordset(v_dias) as d(data date, slots jsonb), jsonb_array_elements(d.slots) sl\n'
      || E'      where d.data = (pe.e ->> ''data'')::date\n'
      || E'        and (sl ->> ''hora'')::time >= (pe.e ->> ''hora'')::time + make_interval(mins => coalesce((pe.e ->> ''min'')::int, 30))\n'
      || E'      order by ((sl ->> ''profissional'') = (pe.e ->> ''profissional'')) desc, sl ->> ''hora'' limit 1) s\n'
      || E'  where c.id = p_conversa and c.irmaos_modo = ''juntos'';\n'
      || E'  select coalesce(jsonb_agg(distinct a.unidade), ''[]''::jsonb) into v_unid');
    v_new := pg_temp.sub(v_new, '''sem_exame'', v_sem, ''atualizado_em'', v_meta,',
      '''sem_exame'', v_sem, ''medico_preferido'', v_pref, ''medico_filtrando'', v_med is not null, ''medico_sem_horario'', v_med_sem, ''sugerido'', v_sug, ''atualizado_em'', v_meta,');
    execute v_new;
  end if;
end $do$;

-- ===== 6b. Filho(a): a identidade é da CRIANÇA, não de quem conversa =====
-- Sem isto, o responsável que já é paciente na clínica casaria com o PRÓPRIO cadastro (nome + telefone + e-mail) e a
-- IA reaproveitaria CPF, endereço e data de nascimento dele no pedido da criança. Com paciente_tipo = 'filho':
--  * paciente_conferir compara o nome da CRIANÇA (o que a IA registrou, ou o digitado no formulário) com o telefone do
--    responsável; sem nome da criança ainda, é paciente novo. Criança que volta (mesmo nome + telefone) é reconhecida
--    e passa pela data de nascimento como qualquer paciente;
--  * pre_pendencia_anterior só oferece "pedido pela metade" de uma conversa do mesmo tipo e, para filho, da MESMA criança
--    (senão o pedido do irmão seria oferecido).
do $do$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.paciente_conferir(uuid)'::regprocedure);
  if position('paciente_tipo' in v_def) = 0 then
    v_new := pg_temp.sub(v_def, E'  if not found then return jsonb_build_object(''situacao'', ''novo''); end if;\n\n  select q.* into b from (',
      E'  if not found then return jsonb_build_object(''situacao'', ''novo''); end if;\n'
      || E'  if (select c.paciente_tipo from public.conversas c where c.id = p_conversa) = ''filho'' then\n'
      || E'    v_ct.nome := (select coalesce(nullif(btrim(pa.paciente ->> ''nome''), ''''), c.paciente_nome) from public.conversas c\n'
      || E'                  left join public.pre_agendamentos pa on pa.conversa_id = c.id where c.id = p_conversa);\n'
      || E'    if v_ct.nome is null then return jsonb_build_object(''situacao'', ''novo''); end if;\n'
      || E'  end if;\n\n  select q.* into b from (');
    execute v_new;
  end if;
end $do$;

create or replace function public.pre_pendencia_anterior(p_conversa uuid)
returns uuid language sql stable security definer set search_path to '' as $function$
  select pa.conversa_id
  from public.conversas atual
  join public.contatos ca on ca.id = atual.contato_id
  join public.conversas c2 on c2.contato_id = atual.contato_id and c2.id <> atual.id
  join public.contatos cb on cb.id = c2.contato_id
  join public.pre_agendamentos pa on pa.conversa_id = c2.id
  where atual.id = p_conversa and pa.status in ('rascunho','pronto') and pa.atualizado_em > now() - interval '7 days'
    and public.nome_confere(coalesce(atual.nome_informado, ca.nome), coalesce(c2.nome_informado, cb.nome))
    and lower(coalesce(nullif(btrim(case when atual.nome_informado is not null then atual.email_informado else ca.email end), ''), ''))
      = lower(coalesce(nullif(btrim(case when c2.nome_informado is not null then c2.email_informado else cb.email end), ''), ''))
    and c2.paciente_tipo = atual.paciente_tipo
    and (atual.paciente_tipo <> 'filho' or public.nome_confere(
          coalesce((select nullif(btrim(x.paciente ->> 'nome'), '') from public.pre_agendamentos x where x.conversa_id = atual.id), atual.paciente_nome),
          coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), c2.paciente_nome)))
    and exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is not null)
  order by pa.atualizado_em desc limit 1
$function$;

-- ===== 6c. Consulta no chat (libera o calendário para consultas) e próximo filho =====
-- Até aqui o pedido só aceitava exames de imagem (RM, TC, US, RX, mamografia, densitometria); sem item no pedido o calendário
-- não abre. Consulta passa a ser um item com modalidade 'CONSULTA'. O paciente vê o tipo de consulta ("Consulta de Pediatria",
-- "Puericultura", "Neuropediatria"...), e o pedido guarda o nome exato do cadastro do Klingo (a conferência automática usa esse nome).
create or replace function public.consultas_da_unidade(p_catalogo text)
returns table (id integer, rotulo text, profissionais integer, medicos text[])
language sql stable security definer set search_path to '' as $$
  with base as (
    select p.id, p.nome, string_agg(distinct initcap(lower(a.especialidade)), ' / ') as esp, array_agg(distinct a.profissional) as meds
    from public.catalogo_procedimento p join public.catalogo_agenda a on a.procedimento_id = p.id
    where p.ativo and p.classe = 'CONSULTAS' and a.vig_fim >= current_date
      and a.profissional !~* '(teste|^eletro)' and coalesce(a.especialidade, '') !~* 'anestesi'
      and (p_catalogo is null or a.unidade = p_catalogo)
    group by p.id, p.nome),
  rot as (
    select b.*, (b.nome ~* '^consulta( medica| médica)?$') as generica, case
      when b.nome ~* '^consulta( medica| médica)?$' then 'Consulta de ' || coalesce(b.esp, 'clínica médica')
      when b.nome ~* 'teleconsulta' then 'Teleconsulta de ' || coalesce(b.esp, 'clínica médica')
      when b.nome ~* '^atendimento ambulatorial em ' then initcap(lower(regexp_replace(b.nome, '^atendimento ambulatorial em ', '', 'i')))
      else initcap(lower(b.nome)) end as rotulo
    from base b)
  -- A consulta genérica ("CONSULTA") some quando uma consulta específica já cobre os mesmos médicos
  -- (ex.: "Consulta de Ortopedia" x "Consulta Ortopediatra"); assim o responsável não vê duas opções iguais.
  select distinct on (r.rotulo) r.id, r.rotulo, cardinality(r.meds), r.meds
  from rot r
  where not (r.generica and exists (select 1 from rot s where not s.generica and r.meds <@ s.meds))
  order by r.rotulo, cardinality(r.meds) desc, r.id;
$$;

create or replace function public.chat_consultas(p_conversa uuid, p_token text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_cat text; v_med text;
begin
  perform public.chat_valida(p_conversa, p_token);
  select u.catalogo, c.medico_preferido into v_cat, v_med
  from public.conversas c left join public.unidade_config u on u.chave = c.unidade_inicial where c.id = p_conversa;
  return jsonb_build_object('medico_preferido', v_med, 'consultas', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'rotulo', x.rotulo, 'do_medico', coalesce(v_med = any(x.medicos), false))
                     order by coalesce(v_med = any(x.medicos), false) desc, x.profissionais desc, x.rotulo)
    from (select * from public.consultas_da_unidade(v_cat) limit 24) x), '[]'::jsonb));
end $$;
grant execute on function public.chat_consultas(uuid, text) to anon, authenticated;

create or replace function public.chat_consulta_salvar(p_conversa uuid, p_token text, p_procedimento_id integer) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_cat text; v_med text; v_c record; v_proc text; v_msg bigint; v_txt text;
begin
  perform public.chat_valida(p_conversa, p_token);
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  if exists (select 1 from public.pre_agendamentos where conversa_id = p_conversa and status in ('agendado','cancelado')) then
    raise exception 'Este pedido já foi concluído. Inicie um novo atendimento.' using errcode = '22023';
  end if;
  select u.catalogo, c.medico_preferido into v_cat, v_med
  from public.conversas c left join public.unidade_config u on u.chave = c.unidade_inicial where c.id = p_conversa;
  select x.id, x.rotulo into v_c from public.consultas_da_unidade(v_cat) x where x.id = p_procedimento_id;
  if v_c.id is null then raise exception 'Consulta não encontrada para esta unidade.' using errcode = '22023'; end if;
  select p.nome into v_proc from public.catalogo_procedimento p where p.id = v_c.id;

  update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null,
    etapa = case when etapa in ('dados','confirmacao') then 'data_hora' else etapa end
    where conversa_id = p_conversa and escolha_horario is not null;
  update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
  insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
  values (p_conversa, 'CONSULTA', null, null, 'N', v_c.id, v_proc, 1);

  insert into public.pre_agendamentos as pa (conversa_id, tipo, procedimento, etapa, paciente, status)
  values (p_conversa, 'consulta', left(v_proc, 160), 'plano', '{}'::jsonb, 'rascunho')
  on conflict (conversa_id) do update set tipo = 'consulta', procedimento = excluded.procedimento,
    etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end, atualizado_em = now()
  where pa.status not in ('agendado','cancelado');

  v_txt := 'Pedido de consulta:' || E'\n' || '• ' || v_c.rotulo || case when v_med is not null then E'\nMédico de preferência: ' || initcap(lower(v_med)) else '' end;
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end,
    agente_id = case when status = 'encerrada' then null else agente_id end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'mensagem_id', v_msg);
end $$;
grant execute on function public.chat_consulta_salvar(uuid, text, integer) to anon, authenticated;

-- Próximo filho: abre a conversa da criança seguinte (mesmo responsável, unidade e médico). No modo "juntos" copia o pedido.
-- Idempotente: um segundo clique devolve a mesma conversa.
create or replace function public.chat_irmao_iniciar(p_origem uuid, p_token text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  o public.conversas; src public.pre_agendamentos; v_prox text; v_resto jsonb; v_recentes int; v_conv uuid; v_token text;
  v_copia boolean := false; v_msg text;
begin
  perform public.chat_valida(p_origem, p_token);
  select * into o from public.conversas where id = p_origem;
  if o.paciente_tipo <> 'filho' or jsonb_array_length(o.irmaos) = 0 then
    raise exception 'Não há outro filho(a) para agendar.' using errcode = '22023';
  end if;
  v_prox := o.irmaos ->> 0;
  v_resto := o.irmaos - 0;

  select c.id, s.token into v_conv, v_token from public.conversas c join public.conversa_segredo s on s.conversa_id = c.id
  where c.irmao_de = p_origem and c.paciente_nome = v_prox order by c.criado_em limit 1;

  if v_conv is null then
    select count(*) into v_recentes from public.conversas where contato_id = o.contato_id and criado_em > now() - interval '1 hour';
    if v_recentes >= 5 then raise exception 'Muitas tentativas. Tente novamente em alguns minutos.' using errcode = '54000'; end if;

    insert into public.conversas (contato_id, nome_informado, email_informado, unidade_inicial, medico_preferido, paciente_tipo, paciente_nome, irmaos, irmaos_modo, irmao_de)
    values (o.contato_id, o.nome_informado, o.email_informado, o.unidade_inicial, o.medico_preferido, 'filho', v_prox, v_resto, o.irmaos_modo, o.id)
    returning id into v_conv;
    insert into public.conversa_segredo (conversa_id) values (v_conv) returning token into v_token;

    select * into src from public.pre_agendamentos where conversa_id = p_origem;
    if o.irmaos_modo = 'juntos' and src.id is not null
       and exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = p_origem and i.ativo) then
      insert into public.pre_agendamentos (conversa_id, tipo, especialidade, procedimento, plano, unidade, profissional, preferencia_horario, paciente, status, etapa)
      values (v_conv, src.tipo, src.especialidade, src.procedimento, src.plano, src.unidade, src.profissional, src.preferencia_horario, '{}'::jsonb, 'rascunho',
              case when src.plano is null then 'plano' else 'data_hora' end);
      insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
      select v_conv, i.modalidade, i.regiao, i.regiao_nome, i.lado, i.procedimento_id, i.procedimento, i.quantidade
      from public.pre_agendamento_itens i where i.conversa_id = p_origem and i.ativo;
      v_copia := true;
    end if;

    v_msg := 'Agora vamos agendar para ' || v_prox
          || case when v_copia then ', com o mesmo pedido de ' || coalesce(o.paciente_nome, 'seu filho(a)') else '' end || '.';
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
  end if;

  return jsonb_build_object('conversa_id', v_conv, 'token', v_token, 'paciente_nome', v_prox, 'irmaos', v_resto, 'irmaos_modo', o.irmaos_modo);
end $$;
grant execute on function public.chat_irmao_iniciar(uuid, text) to anon, authenticated;

-- ===== 7. Funções internas fechadas e limpeza =====
-- Ajudantes que só as funções do chat usam (elas são security definer e continuam funcionando): ninguém de fora chama direto.
revoke all on function public.unidade_medicos(text) from public, anon, authenticated;
revoke all on function public.consultas_da_unidade(text) from public, anon, authenticated;
-- A assinatura antiga de 6 parâmetros precisa sair, senão chamadas com 6 argumentos ficam ambíguas
-- (a nova aceita as mesmas chamadas antigas, pelos valores padrão). Já foi removida no projeto em 30/10/2026:
-- drop function if exists public.chat_iniciar(text, text, text, text, boolean, text);
