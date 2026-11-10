-- FLUXOGRAMA: entrada (a equipe confirma "este paciente do Klingo é a pessoa desta conversa") -> validação (cadastro existe no Klingo/Jornada; conversa existe; config.vinculo_manual_quem: "equipe" = como hoje, "supervisao" = só supervisão/gerência/TI; trocar um vínculo já existente só com p_substituir e só supervisão/gerência/TI) -> lógica (recusa, sem aviso, ligar DOIS prontuários à mesma pessoa e ligar o mesmo prontuário a DUAS pessoas; devolve o conflito para a tela perguntar) -> saída (pessoa_klingo_confirmar_sup, vinculo_log imutável com antes/depois/quem/quando gravado por gatilho em QUALQUER mudança de pessoa_klingo_vinculo, inclusive o desfazer antigo)
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (AGE-02; AGE-02 do planejamento de 10/11/2026). Padrão: "equipe" (nada muda para quem usa hoje); basta trocar a chave para exigir supervisão.
-- Pré-requisitos: pessoa-unica-jornada.sql (pessoa_klingo_vinculo, pessoa_klingo_confirmar, pessoa_equipe, pessoa_membros), etapa-b-estrutura.sql (org_nivel, org_log_imutavel_trg). Aditivo.
-- EXIGIR SUPERVISÃO: update public.config set valor = 'supervisao' where chave = 'vinculo_manual_quem';
-- ROLLBACK: drop trigger pessoa_klingo_vinculo_log on public.pessoa_klingo_vinculo; drop function public.pessoa_klingo_confirmar_sup(text, uuid, boolean), public.vinculo_log_trg(); (a tabela vinculo_log pode ficar)

insert into public.config (chave, valor) values ('vinculo_manual_quem', 'equipe') on conflict (chave) do nothing;

create table if not exists public.vinculo_log (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  por uuid,
  acao text not null,
  prontuario text,
  conversa_id uuid,
  antes jsonb,
  depois jsonb
);
alter table public.vinculo_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'vinculo_log' and policyname = 'vinculo_log_select') then
    create policy vinculo_log_select on public.vinculo_log for select using ((select public.papel_atual()) = 'admin');
  end if;
end $$;
grant select on public.vinculo_log to authenticated;
create or replace trigger vinculo_log_imutavel before update or delete on public.vinculo_log for each row execute function public.org_log_imutavel_trg();

create or replace function public.vinculo_log_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  begin
    insert into public.vinculo_log (por, acao, prontuario, conversa_id, antes, depois)
    values ((select auth.uid()), case tg_op when 'INSERT' then 'vinculado' when 'UPDATE' then 'alterado' else 'desfeito' end,
            coalesce(new.prontuario, old.prontuario), coalesce(new.conversa_id, old.conversa_id),
            case when tg_op in ('UPDATE', 'DELETE') then jsonb_build_object('conversa_id', old.conversa_id, 'por', old.por, 'em', old.em) end,
            case when tg_op in ('INSERT', 'UPDATE') then jsonb_build_object('conversa_id', new.conversa_id, 'por', new.por, 'em', new.em) end);
  exception when others then null;
  end;
  return null;
end $$;
revoke all on function public.vinculo_log_trg() from public, anon, authenticated;
create or replace trigger pessoa_klingo_vinculo_log after insert or update or delete on public.pessoa_klingo_vinculo for each row execute function public.vinculo_log_trg();

create or replace function public.pessoa_klingo_confirmar_sup(p_prontuario text, p_conversa uuid, p_substituir boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_quem text := coalesce((select valor from public.config where chave = 'vinculo_manual_quem'), 'equipe'); v_nivel text := public.org_nivel(); v_outro text; v_pessoa uuid[]; v_dono uuid;
begin
  perform public.pessoa_equipe();
  if v_quem = 'supervisao' and coalesce(v_nivel, '') not in ('ti', 'gerente', 'supervisor') then
    raise exception 'Este vínculo precisa da supervisão: peça para a supervisão confirmar.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.jornada_paciente where prontuario = p_prontuario) then raise exception 'Paciente não encontrado na Jornada.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = '22023'; end if;
  v_pessoa := public.pessoa_membros(p_conversa);
  -- (a) esta pessoa já tem OUTRO prontuário confirmado?
  select pv.prontuario into v_outro from public.pessoa_klingo_vinculo pv where pv.conversa_id = any (v_pessoa) and pv.prontuario <> p_prontuario and pv.prontuario not like 'n:%' limit 1;
  -- (b) este prontuário já é de OUTRA pessoa?
  select pv.conversa_id into v_dono from public.pessoa_klingo_vinculo pv where pv.prontuario = p_prontuario and not (pv.conversa_id = any (v_pessoa));
  if (v_outro is not null or v_dono is not null) then
    if not coalesce(p_substituir, false) then
      return jsonb_build_object('ok', false, 'conflito', case when v_outro is not null then 'pessoa_ja_tem_outro_prontuario' else 'prontuario_ja_ligado_a_outra_pessoa' end,
                                'atual', v_outro, 'mensagem', 'Já existe um vínculo diferente. A supervisão decide se troca.');
    end if;
    if coalesce(v_nivel, '') not in ('ti', 'gerente', 'supervisor') then raise exception 'Só a supervisão troca um vínculo que já existe.' using errcode = '42501'; end if;
    if v_outro is not null then delete from public.pessoa_klingo_vinculo pv where pv.conversa_id = any (v_pessoa) and pv.prontuario = v_outro; end if;
  end if;
  insert into public.pessoa_klingo_vinculo (prontuario, conversa_id, por) values (p_prontuario, p_conversa, (select auth.uid()))
  on conflict (prontuario) do update set conversa_id = excluded.conversa_id, por = excluded.por, em = now();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.pessoa_klingo_confirmar_sup(text, uuid, boolean) from public, anon;
grant execute on function public.pessoa_klingo_confirmar_sup(text, uuid, boolean) to authenticated;
