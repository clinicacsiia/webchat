-- FLUXOGRAMA: entrada (paciente cria a conta informando nome, telefone, e-mail, senha e data de nascimento; confirma o e-mail; o chat chama conta_paciente_vincular com o JWT dele) -> validação (só conta de paciente logada; e-mail da conta CONFIRMADO; no máximo 5 tentativas por hora; uma tentativa por cadastro de conta) -> lógica (procura em pacientes UM cadastro em que e-mail, telefone, nome e data de nascimento batem juntos, que não esteja em revisão nem ligado a outra conta; se achar exatamente um, liga a conta a ele) -> saída (contas_paciente.paciente_id preenchido e resultado 'vinculado', ou 'nao_encontrado' / 'bloqueado' / 'email_nao_confirmado' / 'nada_pendente' / 'ja_vinculado'; a data de nascimento digitada sai do cadastro do login depois da tentativa)
-- Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
--
-- DEPENDE de supabase/contas-paciente.sql, protecao-identidade.sql e login-paciente.sql (e de pacientes.sql: fone_chave, nome_confere, data_ou_nula).
--
-- POR QUE: até aqui a conta só se ligava ao cadastro CRIADO pela própria conversa. Quem já é paciente da clínica (cadastro vindo do Klingo
-- ou de atendimentos anteriores) ficava sem vínculo e a equipe tinha de ligar à mão. Agora o paciente se identifica no cadastro da conta e o
-- banco confere com o que a clínica já tem.
--
-- REGRAS (todas juntas, nenhuma sozinha basta):
--   1. O e-mail da conta precisa estar CONFIRMADO (auth.users.email_confirmed_at). Ele é a prova de que a pessoa controla o e-mail do cadastro.
--   2. O e-mail confirmado precisa ser o e-mail guardado no cadastro do paciente. Cadastro sem e-mail nunca é ligado sozinho (a equipe liga).
--   3. Telefone (com DDD, sem o nono dígito/DDI na comparação), nome (mesma regra do paciente_conferir) e data de nascimento batem.
--   4. Exatamente UM cadastro atende às regras acima; cadastro em revisão (revisar) ou já ligado a outra conta fica de fora.
--   5. No máximo 5 tentativas por hora por conta; cada cadastro de conta faz uma tentativa (a data digitada é apagada depois).
-- A resposta não revela dado do cadastro: só se ligou ou não. Quem não é achado continua podendo agendar normalmente (como conta sem cadastro).
-- ROLLBACK: drop function public.conta_paciente_vincular(); (as colunas novas podem ficar). Nenhum comando destrutivo neste arquivo.
-- Pode ser aplicado mais de uma vez.

alter table public.contas_paciente add column if not exists vinculo_tentativas int not null default 0;
alter table public.contas_paciente add column if not exists vinculo_ultima_em timestamptz;
alter table public.contas_paciente add column if not exists vinculado_em timestamptz;
alter table public.contas_paciente add column if not exists vinculo_metodo text;
comment on column public.contas_paciente.vinculo_metodo is 'Como a conta foi ligada ao cadastro: vazio = pela conversa logada ou pela equipe; ''email+telefone+nome+nascimento'' = conta_paciente_vincular.';

create or replace function public.conta_paciente_vincular() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_cp record; v_u record; v_meta jsonb; v_dt date; v_nome text; v_tel text; v_ids uuid[]; v_res text;
begin
  select * into v_cp from public.contas_paciente where id = v_uid for update;
  if v_uid is null or not found then raise exception 'Entre na sua conta para ligar o cadastro.' using errcode = '42501'; end if;
  if v_cp.paciente_id is not null then return jsonb_build_object('resultado', 'ja_vinculado'); end if;

  select u.email, u.email_confirmed_at, coalesce(u.raw_user_meta_data, '{}'::jsonb) as meta into v_u from auth.users u where u.id = v_uid;
  v_meta := v_u.meta;
  if nullif(btrim(coalesce(v_meta ->> 'dt_nasc', '')), '') is null then return jsonb_build_object('resultado', 'nada_pendente'); end if;
  -- sem e-mail confirmado nada é conferido nem apagado: a tentativa vale quando a pessoa confirmar
  if v_u.email_confirmed_at is null then return jsonb_build_object('resultado', 'email_nao_confirmado'); end if;

  -- limite: 5 tentativas por hora
  if v_cp.vinculo_ultima_em is null or v_cp.vinculo_ultima_em < now() - interval '1 hour' then v_cp.vinculo_tentativas := 0; end if;
  if v_cp.vinculo_tentativas >= 5 then
    update auth.users set raw_user_meta_data = raw_user_meta_data - 'dt_nasc' where id = v_uid;
    return jsonb_build_object('resultado', 'bloqueado');
  end if;
  update public.contas_paciente set vinculo_tentativas = v_cp.vinculo_tentativas + 1, vinculo_ultima_em = now() where id = v_uid;

  v_dt := public.data_ou_nula(v_meta ->> 'dt_nasc');
  v_nome := coalesce(nullif(btrim(v_meta ->> 'nome'), ''), v_cp.nome);
  v_tel := coalesce(nullif(btrim(v_meta ->> 'telefone'), ''), v_cp.telefone);

  if v_dt is not null and v_nome is not null and v_tel is not null and nullif(btrim(coalesce(v_u.email, '')), '') is not null then
    select array_agg(p.id) into v_ids
      from public.pacientes p
     where not p.revisar
       and p.dt_nasc is not null and p.dt_nasc = v_dt
       and p.email is not null and lower(btrim(p.email)) = lower(btrim(v_u.email))
       and public.fone_chave(v_tel) = any(p.telefones)
       and public.nome_confere(v_nome, p.nome)
       and not exists (select 1 from public.contas_paciente o where o.paciente_id = p.id and o.id <> v_uid);
  end if;

  if coalesce(cardinality(v_ids), 0) = 1 then
    update public.contas_paciente set paciente_id = v_ids[1], vinculado_em = now(), vinculo_tentativas = 0,
           vinculo_metodo = 'email+telefone+nome+nascimento' where id = v_uid;
    v_res := 'vinculado';
  else
    v_res := 'nao_encontrado';
  end if;

  -- a data de nascimento digitada não fica guardada no login
  update auth.users set raw_user_meta_data = raw_user_meta_data - 'dt_nasc' where id = v_uid;
  return jsonb_build_object('resultado', v_res);
end $$;
revoke all on function public.conta_paciente_vincular() from public, anon;
grant execute on function public.conta_paciente_vincular() to authenticated;
