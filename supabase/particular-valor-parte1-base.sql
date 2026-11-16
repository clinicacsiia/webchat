-- FLUXOGRAMA: entrada (paciente escolheu o plano PARTICULAR; o exame/consulta está no pedido)
--   -> validação (o preço vem da API do Klingo, GET /preco, plano Particular; guardado em klingo_preco_api por até 12 h; valor vazio ou zero = "sem preço")
--   -> lógica (passo novo `valor` entre "Está tudo certo" e o envio: com preço de TODOS os itens mostra o valor em destaque e pergunta se concorda; sem preço avisa que a assistência passa o valor e pergunta se o paciente quer saber)
--   -> saída (concordou = segue como hoje, inclusive a marcação automática; recusou = vai para o atendente com aviso de que RECUSOU o valor; sem preço e quer saber = pendência da equipe responder o valor; em NENHUM dos dois últimos casos o chat cadastra no Klingo)
-- Versão 1.0 — 16/11/2026 / Mudança: pedido do dono (paciente Particular precisa ver o valor antes de marcar). Parte 1: tabela de preços da API, chave, textos e funções de apoio.
-- Interruptor: config.particular_valor_modo = sim | nao (nasce `nao`; ligado só depois da parte 2 e dos testes). `nao` = tudo como antes.
-- Sem "drop": a ferramenta de migração pede confirmação para comandos que parecem destrutivos e expira em 60 s.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'particular_valor_modo';  (desliga na hora). Para remover: recriar fluxo_proximo, fluxo_perguntar, fluxo_aplicar, fluxo_ler_texto, fluxo_finalizar e klingo_pode_marcar a partir de supabase/producao/funcoes/ (versão anterior) e depois apagar as funções particular_valor_* , klingo_preco_gravar e a tabela klingo_preco_api.

-- ===== Parte 1a: tabela e chave =====
create table if not exists public.klingo_preco_api (
  procedimento_id integer not null,
  plano_id integer not null,
  valor numeric(12,2),                 -- nulo = a API respondeu sem valor
  consultado_em timestamptz not null default now(),
  primary key (procedimento_id, plano_id)
);
alter table public.klingo_preco_api enable row level security;
revoke all on public.klingo_preco_api from public, anon, authenticated;
comment on table public.klingo_preco_api is 'Preço devolvido pela API do Klingo (GET /preco) por exame e plano. Sem dado de paciente. Só as funções particular_valor_* e klingo_preco_gravar leem ou escrevem.';

insert into public.config (chave, valor) values ('particular_valor_modo', 'nao') on conflict (chave) do nothing;

-- ===== Parte 1b: textos do motor (editáveis em Configurações) =====
insert into public.fluxo_texto (chave, texto, descricao) values
 ('valor', E'Antes de marcar, confira o valor do atendimento Particular:\n{itens}\n\nValor total: {total}\n\nÉ o valor da tabela Particular da clínica. A forma de pagamento é combinada com a recepção. Você concorda com o valor e quer marcar?',
  'Particular: valor mostrado antes de marcar. {itens} = linhas por exame, {total} = valor total'),
 ('valor_sem', E'Para o atendimento Particular, este valor não aparece aqui no chat, mas a nossa assistência pode te passar o preço. Você quer que a equipe te informe o valor?',
  'Particular: a API não trouxe o preço'),
 ('valor_recusado_equipe', E'Tudo bem, não vou marcar agora. Já avisei a nossa equipe que o valor não serviu para você. Um atendente vai falar com você por aqui para ver outras opções.',
  'Particular: paciente recusou o valor'),
 ('valor_quer_equipe', E'Anotado! A nossa equipe vai te informar o valor aqui na conversa, e só marcamos depois que você concordar com ele.',
  'Particular sem preço: paciente quer saber o valor'),
 ('valor_dispensou_equipe', E'Anotado! Seu pedido foi para a nossa equipe, que confirma tudo com você antes de marcar.',
  'Particular sem preço: paciente não pediu o valor agora')
on conflict (chave) do nothing;

-- ===== Parte 1c: funções de apoio (todas só do service_role) =====
create or replace function public.particular_plano_id() returns integer
 language sql stable security definer set search_path to ''
as $f$
  select coalesce((select m.plano_id::int from public.klingo_plano_map m where public.norm_chave(m.operadora) = 'PARTICULAR' order by m.plano_id limit 1), 1)
$f$;

create or replace function public.klingo_preco_gravar(p_linhas jsonb) returns integer
 language plpgsql security definer set search_path to ''
as $f$
declare r jsonb; n int := 0; v_val numeric;
begin
  for r in select * from jsonb_array_elements(case when jsonb_typeof(p_linhas) = 'array' then p_linhas else '[]'::jsonb end) loop
    if (r ->> 'id') ~ '^\d+$' and (r ->> 'plano') ~ '^\d+$' then
      v_val := case when (r ->> 'valor') ~ '^\d+(\.\d+)?$' and (r ->> 'valor')::numeric > 0 and (r ->> 'valor')::numeric < 100000 then (r ->> 'valor')::numeric else null end;
      insert into public.klingo_preco_api (procedimento_id, plano_id, valor, consultado_em)
      values ((r ->> 'id')::int, (r ->> 'plano')::int, v_val, now())
      on conflict (procedimento_id, plano_id) do update set valor = excluded.valor, consultado_em = excluded.consultado_em;
      n := n + 1;
    end if;
  end loop;
  return n;
end $f$;

-- Vale para esta conversa? Chave ligada + plano Particular + não é remarcação de um agendamento que já existe.
create or replace function public.particular_valor_ativo(p_conversa uuid) returns boolean
 language sql stable security definer set search_path to ''
as $f$
  select public.klingo_cfg('particular_valor_modo', 'nao') = 'sim'
     and coalesce((select public.norm_chave(pa.plano) like 'PARTICULAR%' from public.pre_agendamentos pa where pa.conversa_id = p_conversa), false)
     and not coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false)
$f$;

-- Assinatura do que vale o valor: plano + exames (+ quantidade e lado). Mudou o pedido = a resposta do paciente sobre o valor deixa de valer.
create or replace function public.particular_valor_assinatura(p_conversa uuid) returns text
 language sql stable security definer set search_path to ''
as $f$
  select md5(coalesce((select public.norm_chave(pa.plano) from public.pre_agendamentos pa where pa.conversa_id = p_conversa), '') || '|' ||
    coalesce((select string_agg(coalesce(i.procedimento_id::text, 'x') || ':' || coalesce(i.quantidade, 1)::text || ':' || coalesce(i.lado, ''), ',' order by i.procedimento_id nulls last, i.lado nulls first, i.id)
                from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo), ''))
$f$;

-- O valor de tudo o que está no pedido. completo = true só se TODOS os itens têm preço da API (de até 12 h) e nenhum tem dúvida de lado.
create or replace function public.particular_valor_obter(p_conversa uuid) returns jsonb
 language plpgsql stable security definer set search_path to ''
as $f$
declare
  v_plano text; v_pid int := public.particular_plano_id(); r record; v_p numeric; v_tot numeric := 0; v_itens jsonb := '[]'::jsonb;
  v_falta text[] := '{}'; v_n int := 0; v_sem_proc boolean;
begin
  select pa.plano into v_plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa;
  if public.norm_chave(v_plano) is null or public.norm_chave(v_plano) not like 'PARTICULAR%' then return jsonb_build_object('particular', false, 'completo', false); end if;
  v_sem_proc := exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is null);
  for r in
    select i.procedimento_id, coalesce(max(i.procedimento), max(p.nome), '') as nome,
           greatest(sum(coalesce(i.quantidade, 1) * coalesce(public.preco_fator_lado(i.lado, p.nome), 1)), 1)::int as qtd,
           bool_or(i.lado = 'A' and public.preco_fator_lado(i.lado, p.nome) is null) as lado_duvida
      from public.pre_agendamento_itens i
      join public.catalogo_procedimento p on p.id = i.procedimento_id
     where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
     group by i.procedimento_id order by min(i.id)
  loop
    v_n := v_n + 1;
    select k.valor into v_p from public.klingo_preco_api k
     where k.procedimento_id = r.procedimento_id and k.plano_id = v_pid and k.valor > 0 and k.consultado_em > now() - interval '12 hours';
    if v_p is null or r.lado_duvida then v_falta := v_falta || r.nome;
    else
      v_tot := v_tot + v_p * r.qtd;
      v_itens := v_itens || jsonb_build_object('nome', r.nome, 'qtd', r.qtd, 'unitario', v_p, 'subtotal', v_p * r.qtd);
    end if;
  end loop;
  return jsonb_build_object('particular', true, 'completo', v_n > 0 and cardinality(v_falta) = 0 and not v_sem_proc,
                            'total', v_tot, 'itens', v_itens, 'faltando', to_jsonb(v_falta), 'plano_id', v_pid);
end $f$;

-- Pede à API (de forma assíncrona) o preço dos itens que ainda não temos. Nunca atrasa nem derruba a conversa.
create or replace function public.particular_valor_disparar(p_conversa uuid) returns void
 language plpgsql security definer set search_path to ''
as $f$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo(); v_pid int := public.particular_plano_id(); v_ids int[];
begin
  if v_base = '' or v_seg is null or not public.particular_valor_ativo(p_conversa) then return; end if;
  select array_agg(distinct i.procedimento_id) into v_ids from public.pre_agendamento_itens i
   where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
     and not exists (select 1 from public.klingo_preco_api k where k.procedimento_id = i.procedimento_id and k.plano_id = v_pid
                      and ((k.valor is not null and k.consultado_em > now() - interval '12 hours') or (k.valor is null and k.consultado_em > now() - interval '30 minutes')));
  if v_ids is null then return; end if;
  perform net.http_post(url := v_base || 'klingo-preco', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'preco', 'plano', v_pid, 'ids', to_jsonb(v_ids)), timeout_milliseconds := 20000);
exception when others then null;
end $f$;

do $g$ declare f text; begin
  foreach f in array array['particular_plano_id()', 'klingo_preco_gravar(jsonb)', 'particular_valor_ativo(uuid)', 'particular_valor_assinatura(uuid)', 'particular_valor_obter(uuid)', 'particular_valor_disparar(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $g$;
