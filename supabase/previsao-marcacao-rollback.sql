-- ROLLBACK do canal "Previsão de marcação" (17/11/2026). Apaga TUDO o que ele criou, inclusive o pré-cadastro (as pessoas registradas). As conversas e os contatos que já nasceram
-- da previsão NÃO são apagados (são conversas normais do painel). Comandos com `drop`/`delete`: o conector do Supabase pede confirmação; rode no editor SQL do painel:
-- https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new
-- Para só PARAR (sem apagar nada): update public.config set valor = 'nao' where chave = 'previsao_marcacao_modo';

select cron.unschedule('pmarc-cadastrar') where exists (select 1 from cron.job where jobname = 'pmarc-cadastrar');

drop function if exists public.pmarc_vigiar();
drop function if exists public.pmarc_disparar(text, jsonb);
drop function if exists public.pmarc_estado_gravar(text, jsonb, text);
drop function if exists public.pmarc_enriquecer_lote(jsonb);
drop function if exists public.pmarc_lote(jsonb);
drop function if exists public.painel_pmarc_estado();
drop function if exists public.painel_pmarc_link_enviado(uuid);
drop function if exists public.painel_pmarc_conversa(uuid);
drop function if exists public.painel_pmarc_lista(text, text, integer, integer);
drop function if exists public.painel_pmarc_resumo();
drop function if exists public.pmarc_enviar(text, text);
drop function if exists public.pmarc_mensagens(text, bigint);
drop function if exists public.pmarc_responder(text, jsonb);
drop function if exists public.pmarc_novo(text, text, date, text);
drop function if exists public.pmarc_identificar(text, date);
drop function if exists public.pmarc_abrir(text);
drop function if exists public.pmarc_conversa_garantir(uuid, uuid);
drop function if exists public.pmarc_vista(uuid);
drop function if exists public.pmarc_itens(text);
drop function if exists public.pmarc_texto(text);
drop function if exists public.pmarc_ligada();
drop function if exists public.pmarc_classificar(text);
drop function if exists public.pmarc_tipo(text);
drop function if exists public.pmarc_telefone(text);
drop table if exists public.pmarc_estado;
drop table if exists public.pmarc_tentativa;
drop table if exists public.pmarc_pessoa;
delete from public.config where chave like 'previsao\_marcacao\_%' escape '\';
