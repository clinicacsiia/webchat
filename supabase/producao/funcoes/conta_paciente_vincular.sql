-- public.conta_paciente_vincular()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_vincular()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_cp record; v_u record; v_meta jsonb; v_dt date; v_nome text; v_tel text; v_res text;
  v_n int; v_pid uuid; v_t boolean; v_e boolean; v_batem text[]; v_diferem text[];
begin
  select * into v_cp from public.contas_paciente where id = v_uid for update;
  if v_uid is null or not found then raise exception 'Entre na sua conta para ligar o cadastro.' using errcode = '42501'; end if;
  if v_cp.paciente_id is not null then return jsonb_build_object('resultado', 'ja_vinculado'); end if;

  select u.email, u.email_confirmed_at, coalesce(u.raw_user_meta_data, '{}'::jsonb) as meta into v_u from auth.users u where u.id = v_uid;
  v_meta := v_u.meta;
  if nullif(btrim(coalesce(v_meta ->> 'dt_nasc', '')), '') is null then return jsonb_build_object('resultado', 'nada_pendente'); end if;
  if v_u.email_confirmed_at is null then return jsonb_build_object('resultado', 'email_nao_confirmado'); end if;

  if v_cp.vinculo_ultima_em is null or v_cp.vinculo_ultima_em < now() - interval '1 hour' then v_cp.vinculo_tentativas := 0; end if;
  if v_cp.vinculo_tentativas >= 5 then
    update auth.users set raw_user_meta_data = raw_user_meta_data - 'dt_nasc' where id = v_uid;
    return jsonb_build_object('resultado', 'bloqueado');
  end if;
  update public.contas_paciente set vinculo_tentativas = v_cp.vinculo_tentativas + 1, vinculo_ultima_em = now() where id = v_uid;

  v_dt := public.data_ou_nula(v_meta ->> 'dt_nasc');
  v_nome := coalesce(nullif(btrim(v_meta ->> 'nome'), ''), v_cp.nome);
  v_tel := coalesce(nullif(btrim(v_meta ->> 'telefone'), ''), v_cp.telefone);
  v_res := 'nao_encontrado';

  if v_dt is not null and coalesce(cardinality(string_to_array(public.norm_nome(v_nome), ' ')), 0) >= 2 then
    select r.n, r.id, r.t_ok, r.e_ok into v_n, v_pid, v_t, v_e
      from (select q.*, count(*) over () as n, row_number() over (order by (q.t_ok::int + q.e_ok::int) desc, q.validado desc, q.atualizado_em desc) as rn
              from (select p.id, p.validado, p.atualizado_em,
                           coalesce(public.fone_chave(v_tel) = any(p.telefones), false) as t_ok,
                           (p.email is not null and lower(btrim(p.email)) = lower(btrim(coalesce(v_u.email, '')))) as e_ok
                      from public.pacientes p
                     where not p.revisar and p.dt_nasc = v_dt and public.nome_confere(v_nome, p.nome)
                       and not exists (select 1 from public.contas_paciente o where o.paciente_id = p.id and o.id <> v_uid)) q) r
     where r.rn = 1;

    if v_n > 1 then
      insert into public.vinculo_solicitacoes (conta_id, paciente_id, tipo, batem, diferem, conta_nome, conta_telefone)
      values (v_uid, v_pid, 'verificar', array['nome', 'nascimento', 'cadastro_duplicado'], '{}'::text[], v_nome, v_tel)
      on conflict (conta_id, tipo) where status = 'aberta' do update set paciente_id = excluded.paciente_id, batem = excluded.batem, diferem = excluded.diferem, conta_nome = excluded.conta_nome, conta_telefone = excluded.conta_telefone, criado_em = now();
      v_res := 'em_analise';
    elsif v_n = 1 then
      v_batem := array['nome', 'nascimento'] || case when v_t then array['telefone'] else '{}'::text[] end || case when v_e then array['email'] else '{}'::text[] end;
      v_diferem := case when v_t then '{}'::text[] else array['telefone'] end || case when v_e then '{}'::text[] else array['email'] end;
      if v_t or v_e then
        update public.contas_paciente set paciente_id = v_pid, vinculado_em = now(), vinculo_tentativas = 0,
               vinculo_metodo = case when v_t and v_e then '4 acertos' else '3 acertos' end where id = v_uid;
        v_res := case when v_t and v_e then 'vinculado' else 'vinculado_conferir' end;
        if v_res = 'vinculado_conferir' then
          insert into public.vinculo_solicitacoes (conta_id, paciente_id, tipo, batem, diferem, conta_nome, conta_telefone) values (v_uid, v_pid, 'atualizar', v_batem, v_diferem, v_nome, v_tel)
          on conflict (conta_id, tipo) where status = 'aberta' do update set paciente_id = excluded.paciente_id, batem = excluded.batem, diferem = excluded.diferem, conta_nome = excluded.conta_nome, conta_telefone = excluded.conta_telefone, criado_em = now();
        end if;
      else
        insert into public.vinculo_solicitacoes (conta_id, paciente_id, tipo, batem, diferem, conta_nome, conta_telefone) values (v_uid, v_pid, 'verificar', v_batem, v_diferem, v_nome, v_tel)
        on conflict (conta_id, tipo) where status = 'aberta' do update set paciente_id = excluded.paciente_id, batem = excluded.batem, diferem = excluded.diferem, conta_nome = excluded.conta_nome, conta_telefone = excluded.conta_telefone, criado_em = now();
        v_res := 'em_analise';
      end if;
    end if;
  end if;

  update auth.users set raw_user_meta_data = raw_user_meta_data - 'dt_nasc' where id = v_uid;
  return jsonb_build_object('resultado', v_res);
end $function$;

