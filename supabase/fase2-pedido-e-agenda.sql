-- Fase 2: pedido de exames (mapa do corpo), agenda com horários livres e componentes no chat.
-- JÁ APLICADO no projeto webchat-atendimento (30/10/2026), em partes, pelo MCP. Este arquivo reúne o estado final.
-- Funções já existentes que foram ajustadas (por substituição no banco; os trechos novos estão descritos ao final):
--   mensagem_inserida, chat_listar, ia_contexto, ia_pre_agendar, ia_catalogo.
-- Nenhum comando destrutivo aqui.

-- ===== 1. Modalidade, etapa, componentes =====
create or replace function public.modalidade_de(p_classe text) returns text language sql immutable set search_path to '' as $$
  select case
    when p_classe ilike 'RESSONANCIA%' then 'RM'
    when p_classe ilike 'TOMOGRAFIA%' then 'TC'
    when p_classe ilike 'ULTRASS%' or p_classe ilike 'ULTRASON%' or p_classe ilike 'PROCEDIMENTOS GUIADOS POR USG%' then 'US'
    when p_classe = 'RADIOLOGIA' then 'RX'
    when p_classe = 'MAMOGRAFIA' then 'MAMO'
    when p_classe = 'DENSITOMETRIA' then 'DENSITO'
    when p_classe = 'CONSULTAS' then 'CONSULTA'
    else 'OUTRO' end
$$;
alter table public.catalogo_procedimento add column if not exists modalidade text generated always as (public.modalidade_de(classe)) stored;
create index if not exists catalogo_procedimento_modalidade on public.catalogo_procedimento (modalidade) where ativo;

alter table public.mensagens add column if not exists opcoes jsonb;  -- componente do chat (lista, pedido_exames, calendario)
alter table public.pre_agendamentos add column if not exists etapa text check (etapa in ('pedido','plano','preferencias','data_hora','dados','confirmacao','pronto'));
alter table public.pre_agendamentos add column if not exists data_desejada date;
alter table public.pre_agendamentos add column if not exists hora_desejada text;
alter table public.pre_agendamentos add column if not exists escolha_horario jsonb;

-- ===== 2. Partes do corpo (mapa) e itens do pedido =====
create table if not exists public.catalogo_regiao (
  codigo text primary key, nome text not null, grupo text not null, tem_lado boolean not null default false, ordem integer not null, padrao text not null
);
alter table public.catalogo_regiao enable row level security;
-- padrao = expressão regular sobre o nome do exame (sem acento, maiúsculas, sem o trecho "NÃO INCLUI ...").
-- Articulações genéricas ("RM ARTICULAR") entram em ombro/cotovelo/punho/quadril/joelho/tornozelo só quando o nome não cita uma articulação específica.
insert into public.catalogo_regiao (codigo, nome, grupo, tem_lado, ordem, padrao) values
 ('cranio','Cabeça / crânio','cabeca',false,1,'CRANI|ENCEFAL|CEREBR|SELA TURCICA|SELA TURSICA|HIPOFISE|TRACTOGRAF|NEURONAVEG|TURSICA|\mTEMPORAIS\M|FONTANELA'),
 ('face','Face / seios da face','cabeca',false,2,'FACE|SEIOS|ORBITA|\mATM\M|TEMPOROMANDIB|OSSOS TEMPORAIS|MASTOIDE|MAXILAR|MANDIBUL|ADENOIDES|CAVUM|ARCADA|PERIAPICAL|INTERPROXIMAL|ZIGOMATIC|DENTAL|DENTASCAN|GLOBO OCULAR|MONOCULAR|BUCAL|LINGUA'),
 ('pescoco','Pescoço / tireoide','cabeca',false,3,'PESCOCO|TIREOID|LARING|FARING|PAROTID|SALIVAR|TRAQUEIA|CAROTID|CERVICAIS|SUBCLAVIA|JUGULAR|ESOFAGO|DEGLUT'),
 ('ombro','Ombro','braco',true,4,'OMBRO|ESCAPUL|CLAVICUL|MANGUITO|^(?!.*(INCLUI|CLAVIC|ACROMIO|UMERAL|OMBRO|ESCAPUL|COTOVELO|PUNHO|\mMAOS?\M|JOELHO|QUADRIL|COXO|SACROILIAC|\mBACIA\M|TORNOZELO|TIBIOTARS|TEMPOROMANDIB|\mATM\M|\mPES?\M))(?=.*(ARTICULA|ARTRO))'),
 ('braco','Braço','braco',true,5,'\mBRACO\M|MEMBRO SUPERIOR|UMERO|MMSS|MEMBROS SUPERIORES'),
 ('cotovelo','Cotovelo','braco',true,6,'COTOVELO|^(?!.*(INCLUI|CLAVIC|ACROMIO|UMERAL|OMBRO|ESCAPUL|COTOVELO|PUNHO|\mMAOS?\M|JOELHO|QUADRIL|COXO|SACROILIAC|\mBACIA\M|TORNOZELO|TIBIOTARS|TEMPOROMANDIB|\mATM\M|\mPES?\M))(?=.*(ARTICULA|ARTRO))'),
 ('antebraco','Antebraço','braco',true,7,'ANTEBRACO|MEMBRO SUPERIOR|MMSS|MEMBROS SUPERIORES'),
 ('punho_mao','Punho / mão','braco',true,8,'PUNHO|\mMAOS?\M|DEDO|CARPO|POLEGAR|ESCAFOIDE|IDADE OSSEA|^(?!.*(INCLUI|CLAVIC|ACROMIO|UMERAL|OMBRO|ESCAPUL|COTOVELO|PUNHO|\mMAOS?\M|JOELHO|QUADRIL|COXO|SACROILIAC|\mBACIA\M|TORNOZELO|TIBIOTARS|TEMPOROMANDIB|\mATM\M|\mPES?\M))(?=.*(ARTICULA|ARTRO))'),
 ('mama','Mama','tronco',true,9,'MAMA|MAMOGRAF|MAMARI|AXILA'),
 ('torax','Tórax / coração','tronco',false,10,'TORAX|PULMON|MEDIASTIN|COSTELA|ESTERNO|CORACAO|CARDIAC|CARDIOL|CORONAR|ECOCARDIO|ECODOPPLERCARDIO|CARDIOGRAMA|TRANSTORAC|TRANSESOF|AORTA TORAC|PLEURA|BRONCO'),
 ('coluna_cervical','Coluna cervical','coluna',false,11,'COLUNA CERVICAL|\mCERVICAL\M|COLUNA(?!.*(CERVICAL|LOMBAR|LOMBO|TORACICA|DORSAL|SACR))'),
 ('coluna_toracica','Coluna torácica (dorsal)','coluna',false,12,'COLUNA TORACICA|COLUNA DORSAL|\mDORSAL\M|COLUNA(?!.*(CERVICAL|LOMBAR|LOMBO|TORACICA|DORSAL|SACR))'),
 ('coluna_lombar','Coluna lombar / sacro','coluna',false,13,'LOMBAR|LOMBO|SACRA|SACRO|COCCIX|COLUNA(?!.*(CERVICAL|LOMBAR|LOMBO|TORACICA|DORSAL|SACR))'),
 ('abdome','Abdome','tronco',false,14,'ABDOM|FIGADO|PANCREAS|\mBACO\M|\mRINS?\M|RENAL|RENAIS|VIAS BILIARES|COLANGIO|ESTOMAGO|INTESTIN|ENTERO|APENDIC|VESICULA|RETROPERIT|ADRENAL|AORTA|VEIA CAVA|ILIACA|VISCERAIS|HEPATIC|URINARI|UROGRAFIA|UROTOMO|NEFRO|ENEMA|COLONIC|COLONOSCOPIA|DELGADO|CLISTER|TRANSITO'),
 ('pelve','Pelve / órgãos pélvicos','tronco',false,15,'PELVE|PELVIC|PELVI|PROSTAT|UTERO|OVAR|ENDOVAGINAL|ENDORRETAL|TRANSVAGINAL|ESCROT|TESTIC|PENIS|PENIAN|BEXIGA|OBSTETR|GESTA|FETAL|TRANSLUCENCIA|VAGINAL|MORFOLOG|TRANSRETAL|PERINEAL|\mANAL\M|PERIANAL|DEFECO|URETRO|HISTERO|INGUINAL'),
 ('quadril','Quadril / bacia','perna',true,16,'QUADRIL|COXOFEMORAL|COXO FEMORAL|\mBACIA\M|SACROILIAC|^(?!.*(INCLUI|CLAVIC|ACROMIO|UMERAL|OMBRO|ESCAPUL|COTOVELO|PUNHO|\mMAOS?\M|JOELHO|QUADRIL|COXO|SACROILIAC|\mBACIA\M|TORNOZELO|TIBIOTARS|TEMPOROMANDIB|\mATM\M|\mPES?\M))(?=.*(ARTICULA|ARTRO))'),
 ('coxa','Coxa','perna',true,17,'\mCOXA\M|FEMUR|MEMBRO INFERIOR|MMII|MEMBROS INFERIORES'),
 ('joelho','Joelho','perna',true,18,'JOELHO|PATELA|MENISC|^(?!.*(INCLUI|CLAVIC|ACROMIO|UMERAL|OMBRO|ESCAPUL|COTOVELO|PUNHO|\mMAOS?\M|JOELHO|QUADRIL|COXO|SACROILIAC|\mBACIA\M|TORNOZELO|TIBIOTARS|TEMPOROMANDIB|\mATM\M|\mPES?\M))(?=.*(ARTICULA|ARTRO))'),
 ('perna','Perna','perna',true,19,'\mPERNA\M|TIBIA|FIBULA|PANTURRILHA|MEMBRO INFERIOR|MMII|MEMBROS INFERIORES'),
 ('tornozelo_pe','Tornozelo / pé','perna',true,20,'TORNOZELO|ANTEPE|\mPES?\M|CALCANE|PLANTAR|^(?!.*(INCLUI|CLAVIC|ACROMIO|UMERAL|OMBRO|ESCAPUL|COTOVELO|PUNHO|\mMAOS?\M|JOELHO|QUADRIL|COXO|SACROILIAC|\mBACIA\M|TORNOZELO|TIBIOTARS|TEMPOROMANDIB|\mATM\M|\mPES?\M))(?=.*(ARTICULA|ARTRO))')
on conflict (codigo) do update set nome = excluded.nome, grupo = excluded.grupo, tem_lado = excluded.tem_lado, ordem = excluded.ordem, padrao = excluded.padrao;

create table if not exists public.pre_agendamento_itens (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas(id) on delete cascade,
  modalidade text, regiao text, regiao_nome text,
  lado text check (lado in ('D','E','A','N')),   -- D direito, E esquerdo, A ambos, N não se aplica: sempre o que o paciente escolheu
  procedimento_id integer, procedimento text,
  quantidade integer not null default 1 check (quantidade between 1 and 4),
  ativo boolean not null default true,
  criado_em timestamptz not null default now()
);
create index if not exists pre_agendamento_itens_conversa on public.pre_agendamento_itens (conversa_id) where ativo;
alter table public.pre_agendamento_itens enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pre_agendamento_itens' and policyname = 'pre_agendamento_itens_select') then
    create policy pre_agendamento_itens_select on public.pre_agendamento_itens for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
end $$;

-- Exames de uma modalidade e parte do corpo ('todos' = todos; 'outros' = os que não casam com nenhuma parte). Tira acréscimos,
-- pacotes e contrastes do menu, ignora o trecho "NÃO INCLUI ..." do nome e descarta nomes truncados duplicados.
create or replace function public.catalogo_exames_regiao(p_modalidade text, p_regiao text)
returns table (id integer, nome text, unilateral boolean, bilateral boolean, marcacoes_90d integer)
language sql stable security definer set search_path to '' as $$
  with base as (
    select p.id, p.nome, p.demanda_90d, regexp_replace(public.norm_nome(p.nome), 'NAO INCLUI.*$', '') as chave
    from public.catalogo_procedimento p
    where p.ativo and p.modalidade = p_modalidade
      and public.norm_nome(p.nome) !~ 'ACRESCENTAR|\mPCTE\M|PACOTE|\mCONTRASTE\M|RECONSTRUCAO|PLANEJAMENTO|PUNCAO|BIOPSIA|DRENAGEM|AMNIOCENTESE|RADIOCIRURGIA|SEDACAO|ADICIONAL'
      and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')
  ), sel as (
    select b.* from base b where
      case when p_regiao = 'todos' then true
           when p_regiao = 'outros' then not exists (select 1 from public.catalogo_regiao r where b.chave ~ r.padrao)
           else exists (select 1 from public.catalogo_regiao r where r.codigo = p_regiao and b.chave ~ r.padrao) end
  )
  select s.id, s.nome, s.nome ~* 'UNILATERAL', s.nome ~* 'BILATERAL', coalesce(s.demanda_90d, 0)
  from sel s
  where not exists (select 1 from sel s2 where s2.id <> s.id and length(s2.nome) > length(s.nome) and s2.nome like s.nome || '%')
  order by coalesce(s.demanda_90d, 0) desc, s.nome limit 24
$$;
revoke all on function public.catalogo_exames_regiao(text, text) from public, anon, authenticated;
grant execute on function public.catalogo_exames_regiao(text, text) to service_role;

create or replace function public.chat_valida(p_conversa uuid, p_token text) returns void language plpgsql stable security definer set search_path to '' as $$
begin
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
end $$;
revoke all on function public.chat_valida(uuid, text) from public, anon, authenticated;
grant execute on function public.chat_valida(uuid, text) to service_role;

create or replace function public.chat_corpo(p_conversa uuid, p_token text) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r jsonb;
begin
  perform public.chat_valida(p_conversa, p_token);
  with mods(codigo, nome, mapa, ordem) as (values
    ('RM', 'Ressonância magnética', true, 1), ('TC', 'Tomografia', true, 2), ('US', 'Ultrassom', true, 3),
    ('RX', 'Raio-X', true, 4), ('MAMO', 'Mamografia', false, 5), ('DENSITO', 'Densitometria óssea', false, 6)),
  regs as (select codigo from public.catalogo_regiao union all select 'outros')
  select jsonb_build_object(
    'modalidades', (select jsonb_agg(jsonb_build_object('codigo', m.codigo, 'nome', m.nome, 'mapa', m.mapa,
        'regioes', coalesce((select jsonb_agg(g.codigo) from (select rg.codigo from regs rg
                              where exists (select 1 from public.catalogo_exames_regiao(m.codigo, rg.codigo))) g), '[]'::jsonb),
        'total', (select count(*) from public.catalogo_exames_regiao(m.codigo, 'todos'))) order by m.ordem) from mods m),
    'regioes', (select jsonb_agg(jsonb_build_object('codigo', codigo, 'nome', nome, 'tem_lado', tem_lado, 'grupo', grupo) order by ordem) from public.catalogo_regiao))
  into r;
  return r;
end $$;
revoke all on function public.chat_corpo(uuid, text) from public;
grant execute on function public.chat_corpo(uuid, text) to anon, authenticated;

create or replace function public.chat_exames(p_conversa uuid, p_token text, p_modalidade text, p_regiao text) returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_modalidade not in ('RM','TC','US','RX','MAMO','DENSITO') then raise exception 'Modalidade inválida.' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'unilateral', e.unilateral, 'bilateral', e.bilateral))
                   from public.catalogo_exames_regiao(p_modalidade, coalesce(nullif(p_regiao, ''), 'todos')) e), '[]'::jsonb);
end $$;
revoke all on function public.chat_exames(uuid, text, text, text) from public;
grant execute on function public.chat_exames(uuid, text, text, text) to anon, authenticated;

-- Grava o pedido (vários exames; lado D/E/A) validando tudo no servidor, e manda o resumo ao chat como mensagem do paciente.
create or replace function public.chat_pedido_salvar(p_conversa uuid, p_token text, p_itens jsonb) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  it jsonb; v_pid int; v_pnome text; v_reg record; v_mod text; v_lado text; v_qtd int; v_reg_nome text; v_lado_txt text;
  v_linhas text[] := '{}'; v_nomes text[] := '{}'; v_n int := 0; v_msg bigint; v_txt text; v_modnome text;
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 or jsonb_array_length(p_itens) > 12 then
    raise exception 'Pedido inválido.' using errcode = '22023';
  end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
  for it in select * from jsonb_array_elements(p_itens) loop
    v_mod := upper(coalesce(it ->> 'modalidade', ''));
    if v_mod not in ('RM','TC','US','RX','MAMO','DENSITO') then raise exception 'Modalidade inválida.' using errcode = '22023'; end if;
    v_modnome := case v_mod when 'RM' then 'Ressonância magnética' when 'TC' then 'Tomografia' when 'US' then 'Ultrassom' when 'RX' then 'Raio-X'
                            when 'MAMO' then 'Mamografia' else 'Densitometria óssea' end;
    select * into v_reg from public.catalogo_regiao where codigo = it ->> 'regiao';
    v_reg_nome := coalesce(v_reg.nome, case when it ->> 'regiao' = 'outros' then 'Outros exames' else null end);
    v_lado := upper(coalesce(nullif(it ->> 'lado', ''), 'N'));
    if found and v_reg.tem_lado then
      if v_lado not in ('D','E','A') then raise exception 'Informe o lado (direito, esquerdo ou ambos) de: %.', v_reg.nome using errcode = '22023'; end if;
    else
      v_lado := 'N';
    end if;
    v_pid := null; v_pnome := null;
    if nullif(it ->> 'procedimento_id', '') is not null then
      select p.id, p.nome into v_pid, v_pnome from public.catalogo_procedimento p
       where p.id = (it ->> 'procedimento_id')::int and p.ativo and p.modalidade = v_mod;
      if v_pid is null then raise exception 'Exame não encontrado no cadastro.' using errcode = '22023'; end if;
      if v_lado in ('D','E') and v_pnome ~* 'BILATERAL' then
        raise exception 'O exame "%" é feito nos dois lados. Escolha "ambos os lados".', v_pnome using errcode = '22023';
      end if;
    end if;
    v_qtd := case when v_lado = 'A' and (v_pnome is null or v_pnome !~* 'BILATERAL') then 2 else 1 end;
    insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
    values (p_conversa, v_mod, nullif(it ->> 'regiao', ''), v_reg_nome, v_lado, v_pid, v_pnome, v_qtd);
    v_n := v_n + 1;
    v_lado_txt := case v_lado when 'D' then ' (lado direito)' when 'E' then ' (lado esquerdo)' when 'A' then ' (os dois lados)' else '' end;
    v_linhas := v_linhas || ('• ' || v_modnome || case when v_reg_nome is not null then ' — ' || v_reg_nome else '' end || v_lado_txt || ': '
                             || coalesce(v_pnome, 'exame a definir com o atendente')
                             || case when v_qtd > 1 then ' (' || v_qtd || ' unidades, uma de cada lado)' else '' end);
    v_nomes := v_nomes || coalesce(v_pnome, v_modnome || ' ' || coalesce(v_reg_nome, ''));
  end loop;
  insert into public.pre_agendamentos as pa (conversa_id, tipo, procedimento, etapa, paciente, status)
  values (p_conversa, 'exame', left(array_to_string(v_nomes, ' + '), 160), 'plano', '{}'::jsonb, 'rascunho')
  on conflict (conversa_id) do update set tipo = 'exame', procedimento = excluded.procedimento,
    etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end, atualizado_em = now()
  where pa.status not in ('agendado','cancelado');
  v_txt := left('Pedido de exames:' || E'\n' || array_to_string(v_linhas, E'\n'), 3900);
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end,
    agente_id = case when status = 'encerrada' then null else agente_id end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'itens', v_n, 'mensagem_id', v_msg);
end $$;
revoke all on function public.chat_pedido_salvar(uuid, text, jsonb) from public;
grant execute on function public.chat_pedido_salvar(uuid, text, jsonb) to anon, authenticated;

-- ===== 3. Agenda: regras, ocupação e horários livres =====
create table if not exists public.agenda_regra_duracao (modalidade text primary key, minutos integer not null check (minutos between 5 and 240));
insert into public.agenda_regra_duracao (modalidade, minutos) values ('RM', 30), ('TC', 20), ('US', 20), ('RX', 10), ('MAMO', 20), ('DENSITO', 20) on conflict (modalidade) do nothing;
alter table public.agenda_regra_duracao enable row level security;
create table if not exists public.agenda_modalidade_local (modalidade text primary key, local_padrao text not null);
insert into public.agenda_modalidade_local (modalidade, local_padrao) values ('RM','SALA DE RM'), ('TC','SALA DE TC'), ('RX','RAIO X'), ('MAMO','MAMOGRAFIA'), ('DENSITO','DENSITOMETRIA') on conflict (modalidade) do nothing;
alter table public.agenda_modalidade_local enable row level security;

create table if not exists public.agenda_ocupacao (
  inicio timestamp not null, profissional text not null, unidade text not null,
  fonte text not null default 'marcada' check (fonte in ('marcada','bloqueada')),
  qtd integer not null default 1, procedimento text, reserva_min integer, local text,
  visto_em timestamptz not null default now(),
  primary key (inicio, profissional, unidade, fonte)
);
create index if not exists agenda_ocupacao_inicio on public.agenda_ocupacao (inicio);
alter table public.agenda_ocupacao enable row level security;
create table if not exists public.agenda_ocupacao_meta (id integer primary key default 1 check (id = 1), valido_desde timestamptz, atualizado_em timestamptz, linhas integer);
insert into public.agenda_ocupacao_meta (id) values (1) on conflict (id) do nothing;
alter table public.agenda_ocupacao_meta enable row level security;

create or replace function public.agenda_ocupacao_atualizar(p_linhas jsonb, p_execucao timestamptz default null, p_finalizar boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_n integer := 0; v_tot integer;
begin
  if p_linhas is not null and jsonb_typeof(p_linhas) = 'array' and jsonb_array_length(p_linhas) > 0 then
    insert into public.agenda_ocupacao as o (inicio, profissional, unidade, fonte, qtd, procedimento, reserva_min, local, visto_em)
    select x.inicio, public.norm_nome(x.profissional), public.norm_nome(x.unidade), coalesce(nullif(x.fonte, ''), 'marcada'), greatest(coalesce(x.qtd, 1), 1), left(x.procedimento, 160),
      (select rg.minutos from public.catalogo_procedimento p join public.agenda_regra_duracao rg on rg.modalidade = p.modalidade
        where p.ativo and public.norm_nome(p.nome) = public.norm_nome(x.procedimento) limit 1),
      (select a.local from public.catalogo_agenda a
        where public.norm_nome(a.profissional) = public.norm_nome(x.profissional) and public.norm_nome(a.unidade) = public.norm_nome(x.unidade)
          and a.dia_num = extract(dow from x.inicio)::int and x.inicio::time >= a.hora_ini::time and x.inicio::time < a.hora_fim::time limit 1),
      now()
    from (select distinct on (inicio, profissional, unidade, fonte) * from jsonb_to_recordset(p_linhas)
            as t(inicio timestamp, profissional text, unidade text, fonte text, qtd integer, procedimento text)
          where inicio is not null and profissional is not null and unidade is not null
          order by inicio, profissional, unidade, fonte) x
    on conflict (inicio, profissional, unidade, fonte) do update set
      qtd = excluded.qtd, procedimento = excluded.procedimento, reserva_min = excluded.reserva_min, local = excluded.local, visto_em = now();
    get diagnostics v_n = row_count;
  end if;
  if p_finalizar then
    update public.agenda_ocupacao_meta set valido_desde = coalesce(p_execucao, now()), atualizado_em = now(),
      linhas = (select count(*) from public.agenda_ocupacao where visto_em >= coalesce(p_execucao, now())) where id = 1;
  end if;
  select linhas into v_tot from public.agenda_ocupacao_meta where id = 1;
  return jsonb_build_object('gravadas', v_n, 'vigentes', v_tot);
end $$;
revoke all on function public.agenda_ocupacao_atualizar(jsonb, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.agenda_ocupacao_atualizar(jsonb, timestamptz, boolean) to service_role;

-- Horários livres para um conjunto de exames. Regras:
--  * a sala/profissional precisa fazer TODOS os exames (e, para RM/TC/RX..., estar na sala certa: agenda_modalidade_local);
--  * tempo reservado por exame = agenda_regra_duracao (ex.: RM 30 min), senão o tempo da agenda; dois exames somam;
--  * precisa de blocos seguidos livres dentro da janela da grade; marcados (agenda_ocupacao) bloqueiam o profissional e a sala;
--  * mostra um horário por bloco de 20 ou 30 min (30 quando o exame reservado é maior que o tempo da agenda); "chegada" (duração <= 5) vira uma janela;
--  * respeita antecedência mínima (padrão 120 min) e exclui horários já escolhidos para outros exames do mesmo paciente (p_excluir).
create or replace function public.agenda_horarios(
  p_procs integer[], p_de date, p_ate date, p_unidade text default null, p_profissional text default null,
  p_periodo text default null, p_excluir jsonb default '[]'::jsonb, p_antecedencia_min integer default 120)
returns table (data date, hora text, unidade text, local text, profissional text, duracao_min integer, chegada boolean)
language plpgsql stable security definer set search_path to '' as $$
#variable_conflict use_column
declare
  v_agora timestamp := (now() at time zone 'America/Bahia');
  v_valido timestamptz;
  v_n integer;
begin
  select m.valido_desde into v_valido from public.agenda_ocupacao_meta m where m.id = 1;
  select count(distinct x) into v_n from unnest(p_procs) x;
  if coalesce(v_n, 0) = 0 or p_de is null or p_ate is null or p_ate - p_de > 62 then return; end if;

  return query
  with grade as (
    select a.unidade, a.local, a.profissional, a.dia_num, a.hora_ini, a.hora_fim, a.duracao_min, a.vig_ini, a.vig_fim
    from public.catalogo_agenda a
    join public.catalogo_procedimento pm on pm.id = a.procedimento_id
    left join public.agenda_modalidade_local ml on ml.modalidade = pm.modalidade
    where a.procedimento_id = any(p_procs) and (ml.local_padrao is null or a.local ~* ml.local_padrao) and a.profissional !~* 'teste' and a.vig_fim >= p_de and a.vig_ini <= p_ate
      and (p_unidade is null or public.norm_nome(a.unidade) = public.norm_nome(p_unidade))
      and (p_profissional is null or public.norm_nome(a.profissional) = public.norm_nome(p_profissional))
    group by a.unidade, a.local, a.profissional, a.dia_num, a.hora_ini, a.hora_fim, a.duracao_min, a.vig_ini, a.vig_fim
    having count(distinct a.procedimento_id) = v_n
  ), janelas as (
    select g.*, d.dia::date as dia, (d.dia::date + g.hora_ini::time) as ini_ts, (d.dia::date + g.hora_fim::time) as fim_ts,
           (g.duracao_min <= 5) as e_chegada,
           (select sum(coalesce(rg.minutos, greatest(g.duracao_min, 10))) from unnest(p_procs) u(id)
              join public.catalogo_procedimento p on p.id = u.id left join public.agenda_regra_duracao rg on rg.modalidade = p.modalidade)::int as need
    from grade g
    join generate_series(p_de, p_ate, interval '1 day') d(dia) on extract(dow from d.dia)::int = g.dia_num and d.dia::date between g.vig_ini and g.vig_fim
    where not (g.duracao_min <= 5 and (g.hora_fim::time - g.hora_ini::time) < interval '60 minutes')
  ), nativos as (
    select j.unidade, j.local, j.profissional, j.dia, j.hora_ini, j.hora_fim, j.duracao_min, j.need, j.fim_ts, s.t
    from janelas j
    cross join lateral generate_series(j.ini_ts, j.fim_ts - make_interval(mins => j.duracao_min), make_interval(mins => j.duracao_min)) s(t)
    where not j.e_chegada
  ), estado as (
    select n.*, not exists (
        select 1 from public.agenda_ocupacao o
        where o.unidade = public.norm_nome(n.unidade) and (v_valido is null or o.visto_em >= v_valido)
          and (o.profissional = public.norm_nome(n.profissional) or (o.local is not null and o.local = n.local))
          and o.inicio < n.t + make_interval(mins => n.duracao_min)
          and o.inicio + make_interval(mins => coalesce(o.reserva_min, n.duracao_min)) > n.t) as livre
    from nativos n
  ), validos as (
    select e.* from estado e
    where e.livre
      and e.t + make_interval(mins => e.need) <= e.fim_ts
      and e.t > v_agora + make_interval(mins => p_antecedencia_min)
      and not exists (select 1 from estado e2
                      where e2.unidade = e.unidade and e2.local is not distinct from e.local and e2.profissional = e.profissional and e2.dia = e.dia
                        and e2.hora_ini = e.hora_ini and e2.hora_fim = e.hora_fim and not e2.livre
                        and e2.t < e.t + make_interval(mins => e.need) and e2.t + make_interval(mins => e2.duracao_min) > e.t)
      and not exists (select 1 from jsonb_to_recordset(p_excluir) x(data date, hora text, min integer)
                      where (x.data + x.hora::time) < e.t + make_interval(mins => e.need) and (x.data + x.hora::time) + make_interval(mins => x.min) > e.t)
      and (p_periodo is null or (p_periodo = 'manha' and e.t::time < time '12:00') or (p_periodo = 'tarde' and e.t::time >= time '12:00' and e.t::time < time '18:00')
           or (p_periodo = 'noite' and e.t::time >= time '18:00'))
  ), blocos as (
    select distinct on (v.unidade, v.local, v.profissional, v.dia,
             floor((extract(hour from v.t) * 60 + extract(minute from v.t)) /
               (case when v.need > v.duracao_min then (case when v.need <= 20 then 20 else 30 end) else greatest(v.duracao_min, 15) end)))
      v.dia, to_char(v.t, 'HH24:MI') as hora, v.unidade, v.local, v.profissional, v.need as duracao_min, false as chegada, v.t
    from validos v
    order by v.unidade, v.local, v.profissional, v.dia,
             floor((extract(hour from v.t) * 60 + extract(minute from v.t)) /
               (case when v.need > v.duracao_min then (case when v.need <= 20 then 20 else 30 end) else greatest(v.duracao_min, 15) end)), v.t
  ), chegadas as (
    select j.dia, to_char(j.ini_ts, 'HH24:MI') as hora, j.unidade, j.local, j.profissional, 0 as duracao_min, true as chegada, j.ini_ts as t
    from janelas j
    where j.e_chegada and j.fim_ts > v_agora + make_interval(mins => p_antecedencia_min)
      and (p_periodo is null or (p_periodo = 'manha' and j.ini_ts::time < time '12:00') or (p_periodo = 'tarde' and j.ini_ts::time >= time '12:00' and j.ini_ts::time < time '18:00')
           or (p_periodo = 'noite' and j.ini_ts::time >= time '18:00'))
  )
  select u.dia, u.hora, u.unidade, u.local, u.profissional, u.duracao_min::int, u.chegada
  from (select b.dia, b.hora, b.unidade, b.local, b.profissional, b.duracao_min, b.chegada, b.t from blocos b
        union all select c.dia, c.hora, c.unidade, c.local, c.profissional, c.duracao_min, c.chegada, c.t from chegadas c) u
  order by u.dia, u.hora, u.profissional;
end $$;
revoke all on function public.agenda_horarios(integer[], date, date, text, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.agenda_horarios(integer[], date, date, text, text, text, jsonb, integer) to service_role;

create or replace function public.agenda_cobre(p_procs integer[]) returns boolean language sql stable security definer set search_path to '' as $$
  select exists (
    select 1 from public.catalogo_agenda a
    join public.catalogo_procedimento pm on pm.id = a.procedimento_id
    left join public.agenda_modalidade_local ml on ml.modalidade = pm.modalidade
    where a.procedimento_id = any(p_procs) and a.vig_fim >= current_date and a.profissional !~* 'teste'
      and (ml.local_padrao is null or a.local ~* ml.local_padrao)
    group by a.unidade, a.local, a.profissional
    having count(distinct a.procedimento_id) = (select count(distinct x) from unnest(p_procs) x))
$$;
revoke all on function public.agenda_cobre(integer[]) from public, anon, authenticated;
grant execute on function public.agenda_cobre(integer[]) to service_role;

-- Divide os exames em grupos que cabem no mesmo lugar e na mesma sequência (ex.: RM na Sala de RM; ultrassom no consultório).
create or replace function public.agenda_grupos(p_procs integer[]) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_g jsonb := '[]'::jsonb; p int; i int; v_cand int[]; v_placed boolean; v_len int;
begin
  foreach p in array coalesce(p_procs, '{}') loop
    v_placed := false; v_len := jsonb_array_length(v_g);
    for i in 0 .. v_len - 1 loop
      select array_agg(x::int) into v_cand from jsonb_array_elements_text(v_g -> i -> 'procs') x;
      v_cand := v_cand || p;
      if public.agenda_cobre(v_cand) then
        v_g := jsonb_set(v_g, array[i::text, 'procs'], to_jsonb(v_cand)); v_placed := true; exit;
      end if;
    end loop;
    if not v_placed then v_g := v_g || jsonb_build_array(jsonb_build_object('procs', jsonb_build_array(p))); end if;
  end loop;
  return v_g;
end $$;
revoke all on function public.agenda_grupos(integer[]) from public, anon, authenticated;
grant execute on function public.agenda_grupos(integer[]) to service_role;

create or replace function public.chat_horarios(p_conversa uuid, p_token text, p_grupo integer default 1, p_de date default null, p_ate date default null,
  p_unidade text default null, p_periodo text default null, p_excluir jsonb default '[]'::jsonb) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_de date := coalesce(p_de, current_date); v_ate date; v_meta timestamptz; v_dias jsonb; v_unid jsonb; v_sem int; v_escolhas jsonb; v_jan jsonb;
begin
  perform public.chat_valida(p_conversa, p_token);
  v_ate := least(coalesce(p_ate, v_de + 30), v_de + 45);
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  select count(*) into v_sem from public.pre_agendamento_itens where conversa_id = p_conversa and ativo and procedimento_id is null;
  if v_procs is null then
    return jsonb_build_object('grupos', '[]'::jsonb, 'sem_exame', v_sem, 'dias', '[]'::jsonb, 'aviso', 'Escolha o exame primeiro para ver os horários.');
  end if;
  v_grupos := public.agenda_grupos(v_procs);
  select jsonb_agg(jsonb_build_object('indice', t.ord, 'procs', t.g -> 'procs',
      'nomes', (select jsonb_agg(distinct p.nome) from jsonb_array_elements_text(t.g -> 'procs') x join public.catalogo_procedimento p on p.id = x::int)) order by t.ord)
    into v_grupos from jsonb_array_elements(v_grupos) with ordinality t(g, ord);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;
  select escolha_horario into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  select m.atualizado_em into v_meta from public.agenda_ocupacao_meta m where m.id = 1;

  with h as (select * from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, null, p_periodo,
        coalesce(p_excluir, '[]'::jsonb) || coalesce((select jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'min', coalesce((e ->> 'min')::int, 30)))
          from jsonb_array_elements(coalesce(v_escolhas, '[]'::jsonb)) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1)), '[]'::jsonb))),
  um as (select distinct on (h.data, h.hora) h.* from h order by h.data, h.hora, h.profissional)
  select coalesce(jsonb_agg(jsonb_build_object('data', d.data, 'slots', d.slots) order by d.data), '[]'::jsonb) into v_dias
  from (select um.data, jsonb_agg(jsonb_build_object('hora', um.hora, 'unidade', um.unidade, 'profissional', um.profissional, 'local', um.local, 'min', um.duracao_min, 'chegada', um.chegada) order by um.hora) slots
        from um group by um.data) d;
  select coalesce(jsonb_agg(distinct a.unidade), '[]'::jsonb) into v_unid from public.catalogo_agenda a
    where a.procedimento_id = any(v_procs) and a.vig_fim >= current_date and a.profissional !~* 'teste';
  select coalesce(jsonb_object_agg(j.dia_num::text, jsonb_build_object('ini', j.ini, 'fim', j.fim, 'passo', j.passo)), '{}'::jsonb) into v_jan from (
    select a.dia_num, min(a.hora_ini) as ini, max(a.hora_fim) as fim, min(a.duracao_min) filter (where a.duracao_min > 5) as passo
    from public.catalogo_agenda a join public.catalogo_procedimento pm on pm.id = a.procedimento_id
    left join public.agenda_modalidade_local ml on ml.modalidade = pm.modalidade
    where a.procedimento_id = any(v_procs) and a.vig_fim >= v_de and a.vig_ini <= v_ate and a.profissional !~* 'teste'
      and (ml.local_padrao is null or a.local ~* ml.local_padrao) and (a.duracao_min > 5 or a.hora_fim::time - a.hora_ini::time >= interval '60 minutes')
      and (p_unidade is null or public.norm_nome(a.unidade) = public.norm_nome(p_unidade))
    group by a.dia_num) j;
  return jsonb_build_object('janelas', v_jan, 'grupos', v_grupos, 'grupo', greatest(p_grupo, 1), 'de', v_de, 'ate', v_ate, 'dias', v_dias, 'unidades', v_unid,
    'escolhas', coalesce(v_escolhas, '[]'::jsonb), 'sem_exame', v_sem, 'atualizado_em', v_meta,
    'aviso', case when v_meta is null then 'Horários calculados pela grade de atendimento; o atendente confirma a disponibilidade.'
                  when v_meta < now() - interval '60 minutes' then 'Os horários podem ter mudado nos últimos minutos; o atendente confirma.' else null end);
end $$;
revoke all on function public.chat_horarios(uuid, text, integer, date, date, text, text, jsonb) from public;
grant execute on function public.chat_horarios(uuid, text, integer, date, date, text, text, jsonb) to anon, authenticated;

-- Grava a escolha do paciente conferindo DE NOVO se o horário ainda está livre e sem choque com os outros exames dele.
create or replace function public.chat_horario_escolher(p_conversa uuid, p_token text, p_grupo integer, p_data date, p_hora text, p_unidade text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_row record; v_escolhas jsonb; v_outros jsonb; v_novo jsonb; v_total int; v_feitos int; v_txt text; v_msg bigint;
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_data is null or p_hora !~ '^\d{2}:\d{2}$' or p_data < current_date or p_data > current_date + 60 then raise exception 'Data inválida.' using errcode = '22023'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  if v_procs is null then raise exception 'Escolha o exame primeiro.' using errcode = '22023'; end if;
  v_grupos := public.agenda_grupos(v_procs);
  v_total := jsonb_array_length(v_grupos);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;
  select coalesce(escolha_horario, '[]'::jsonb) into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  v_escolhas := coalesce(v_escolhas, '[]'::jsonb);
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_outros from jsonb_array_elements(v_escolhas) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1);
  select * into v_row from public.agenda_horarios(v_procs, p_data, p_data, p_unidade, null, null,
        (select coalesce(jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'min', coalesce((e ->> 'min')::int, 30))), '[]'::jsonb) from jsonb_array_elements(v_outros) e))
      h where h.hora = p_hora order by h.profissional limit 1;
  if v_row.hora is null then raise exception 'Esse horário acabou de ficar indisponível. Escolha outro, por favor.' using errcode = 'P0002'; end if;
  v_novo := jsonb_build_object('grupo', greatest(p_grupo, 1), 'data', p_data, 'hora', v_row.hora, 'unidade', v_row.unidade, 'profissional', v_row.profissional,
                               'local', v_row.local, 'min', v_row.duracao_min, 'chegada', v_row.chegada);
  v_escolhas := v_outros || jsonb_build_array(v_novo);
  v_feitos := jsonb_array_length(v_escolhas);
  update public.pre_agendamentos set escolha_horario = v_escolhas,
    data_desejada = (select (e ->> 'data')::date from jsonb_array_elements(v_escolhas) e order by (e ->> 'grupo')::int limit 1),
    hora_desejada = (select e ->> 'hora' from jsonb_array_elements(v_escolhas) e order by (e ->> 'grupo')::int limit 1),
    unidade = coalesce(unidade, v_row.unidade),
    etapa = case when v_feitos >= v_total then 'dados' else 'data_hora' end, atualizado_em = now()
  where conversa_id = p_conversa and status not in ('agendado','cancelado');
  v_txt := format('Escolhi %s, %s/%s%s%s. (Sei que é uma previsão e que o atendente confirma o dia e o horário.)',
    v_dias[extract(dow from p_data)::int + 1], to_char(p_data, 'DD'), to_char(p_data, 'MM'),
    case when v_row.chegada then ', por ordem de chegada a partir das ' || v_row.hora else ' às ' || v_row.hora end,
    case when v_row.unidade is not null then ' — ' || v_row.unidade else '' end);
  if v_total > 1 then v_txt := format('Horário %s de %s: %s', greatest(p_grupo, 1), v_total, v_txt); end if;
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'restantes', greatest(v_total - v_feitos, 0), 'escolha', v_novo, 'mensagem_id', v_msg);
end $$;
revoke all on function public.chat_horario_escolher(uuid, text, integer, date, text, text) from public;
grant execute on function public.chat_horario_escolher(uuid, text, integer, date, text, text) to anon, authenticated;

-- ===== 4. Resposta da IA com componente =====
create or replace function public.ia_responder_v2(p_segredo text, p_conversa uuid, p_texto text, p_resumo text default null, p_urgencia text default null, p_transferir boolean default false, p_opcoes jsonb default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_seg text; v_ok boolean; v_op jsonb;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select (ia_ativa and status = 'aguardando') into v_ok from public.conversas where id = p_conversa for update;
  if not coalesce(v_ok, false) then return jsonb_build_object('enviada', false); end if;
  if p_opcoes is not null and jsonb_typeof(p_opcoes) = 'string' then begin p_opcoes := (p_opcoes #>> '{}')::jsonb; exception when others then p_opcoes := null; end; end if;
  v_op := case when p_opcoes is not null and jsonb_typeof(p_opcoes) = 'object' and p_opcoes ->> 'tipo' in ('lista','pedido_exames','calendario')
                    and length(p_opcoes::text) <= 6000 then p_opcoes else null end;
  if btrim(coalesce(p_texto, '')) <> '' then
    insert into public.mensagens (conversa_id, autor, texto, opcoes) values (p_conversa, 'agente', left(btrim(p_texto), 4000), v_op);
  end if;
  update public.conversas set
    triagem_resumo = coalesce(nullif(left(btrim(coalesce(p_resumo, '')), 1000), ''), triagem_resumo),
    triagem_urgencia = coalesce(case when p_urgencia in ('baixa','media','alta') then p_urgencia end, triagem_urgencia),
    ia_ativa = case when p_transferir then false else ia_ativa end
  where id = p_conversa;
  return jsonb_build_object('enviada', true);
end $$;
revoke all on function public.ia_responder_v2(text, uuid, text, text, text, boolean, jsonb) from public;
grant execute on function public.ia_responder_v2(text, uuid, text, text, text, boolean, jsonb) to anon, authenticated;

-- ===== 5. Ajustes em funções existentes (feitos por substituição no banco) =====
--  mensagem_inserida: o aviso instantâneo (realtime.send) passa a levar  'opcoes', new.opcoes
--  chat_listar:       cada mensagem passa a trazer  'opcoes', m.opcoes
--  ia_contexto:       devolve 'pedido_itens' (modalidade, parte_do_corpo, lado direito/esquerdo/ambos, exame, quantidade)
--                     e 'paciente_conhecido' (ver pacientes.sql); pre_agendamento sai sem paciente_id
--  ia_pre_agendar:    grava a 'etapa' enviada pela IA (p_dados->>'etapa') e a conferência de identidade (ver pacientes.sql)
--  ia_catalogo:       nas etapas dados/confirmacao/pronto devolve só unidades (sem procedimentos, agenda, planos e preços)
-- Agendamento automático: cron 'agenda-ocupacao' */10 8-23,0,1 * * *  ->  {"agenda":"ocupacao"} na Edge Function sync-catalogo-klingo.
