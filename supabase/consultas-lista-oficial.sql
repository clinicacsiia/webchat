-- Lista oficial de consultas do chat (pedido do dono em 19/11/2026):
--   Consulta com pediatra · ortopediatra · endocrinopediatra · cardiopediatra · neuropediatra · gastropediatra
--   + Consulta pediátrica pré-natal (pedido do dono, mesmo dia)
-- Situação antes: o filtro "klingo_so_liberados" (ligado em 13/11/2026) só deixava aparecer o que a API do Klingo oferece
-- (Pediatria, Neurologia, Radiologia); ortopediatra (1474), endocrinopediatra (1470) e gastropediatra (1471) sumiram do chat.
-- Aplicado em partes (a ferramenta de migração expira em 60 s). Idempotente.
--
-- ROLLBACK (no fim do arquivo).

-- ===== Parte 1: consultas que aparecem mesmo sem a API do Klingo (config `consultas_sem_api`, ids separados por vírgula) =====
-- Mesma função de producao/funcoes/klingo_liberado.sql; única mudança: consulta listada em `consultas_sem_api` passa
-- pelo filtro de API (continua valendo idade e sexo). Sem horário da API, o chat diz "Este atendimento é agendado pela nossa equipe" e a atendente marca.
insert into public.config (chave, valor) values ('consultas_sem_api', '416,1470,1471,1474') on conflict (chave) do nothing;

create or replace function public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text) returns boolean
  language plpgsql stable security definer set search_path to ''
as $function$
declare d jsonb; v_nasc date; v_idade integer; v_sexo text; pr record; v_cbos text;
begin
  if public.klingo_cfg('klingo_so_liberados', 'nao') <> 'sim' then return true; end if;
  if p_proc is null then return false; end if;
  if not public.klingo_automatizavel(p_proc, p_tipo)
     and not (p_tipo = 'consulta' and p_proc::text = any (string_to_array(replace(public.klingo_cfg('consultas_sem_api', ''), ' ', ''), ','))) then
    return false;
  end if;
  d := public.klingo_dados_conversa(p_conversa);
  v_nasc := nullif(d ->> 'nascimento', '')::date;
  v_idade := case when v_nasc is null then null else extract(year from age((now() at time zone 'America/Bahia')::date, v_nasc))::integer end;
  v_sexo := upper(left(coalesce(d ->> 'sexo', ''), 1));
  select idade_min, idade_max, sexo into pr from public.catalogo_procedimento where id = p_proc;
  if v_idade is not null and (v_idade < coalesce(pr.idade_min, 0) or v_idade > coalesce(pr.idade_max, 999)) then return false; end if;
  if coalesce(pr.sexo, '') <> '' and v_sexo in ('M', 'F') and upper(left(pr.sexo, 1)) <> v_sexo then return false; end if;
  if p_tipo = 'consulta' and v_idade is not null then
    select e.cbos into v_cbos from public.klingo_especialidade e where e.liberada_api and p_proc = any (e.procedimentos) limit 1;
    if v_cbos is not null and exists (select 1 from public.klingo_profissional m where v_cbos = any (m.cbos))
       and not exists (select 1 from public.klingo_profissional m where v_cbos = any (m.cbos) and (m.idade_max is null or m.idade_max >= v_idade)) then
      return false;
    end if;
  end if;
  return true;
end $function$;

-- ===== Parte 2: nomes e consultas escondidas (mesmo efeito de Painel → Configurações → Consultas oferecidas no chat) =====
insert into public.consulta_config (procedimento_id, oculta, rotulo) values
  (1132, false, 'Consulta com pediatra'),
  (1474, false, 'Consulta com ortopediatra'),
  (1470, false, 'Consulta com endocrinopediatra'),
  (1472, false, 'Consulta com neuropediatra'),
  (1471, false, 'Consulta com gastropediatra'),
  (2100, false, 'Consulta pediátrica pré-natal'),
  (416, false, 'Consulta com cardiopediatra'),   -- só aparece quando a agenda dela existir na Desenvoar (no Klingo)
  (2127, true, null),   -- Teleconsulta de Pediatria (prontidão)
  (2128, true, null),   -- Consulta com Pediatra (Neuro Desenvolvimento)
  (1783, true, null)    -- Puericultura
on conflict (procedimento_id) do update set oculta = excluded.oculta, rotulo = excluded.rotulo, atualizado_em = now();

-- CONSULTA CARDIOPEDIATRICA (416): hoje a agenda dela (Daniela Ladeia, Camila Franzoni) está na CSI, que está desligada no chat.
-- Fica pronta aqui; só aparece quando o Klingo tiver a agenda na unidade DESENVOAR (o catálogo é copiado do Klingo às 03:00).

-- ===== ROLLBACK =====
-- delete from public.consulta_config where procedimento_id in (1132,1474,1470,1472,1471,2100,2127,2128,1783,416);
-- delete from public.config where chave = 'consultas_sem_api';
-- e voltar klingo_liberado para supabase/producao/funcoes/klingo_liberado.sql
