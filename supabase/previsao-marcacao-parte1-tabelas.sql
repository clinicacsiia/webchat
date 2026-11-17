-- FLUXOGRAMA: entrada (nada; é a base do canal "Previsão de marcação") -> validação (tabelas novas, sem tocar em nenhuma tabela que já existe) -> lógica (uma pessoa por chave da Jornada: prontuário ou "n:" + marca de nome e telefone; o que o paciente respondeu fica em colunas e em `informado`) -> saída (2 tabelas fechadas, textos e interruptor em `config`) | ROLLBACK: previsao-marcacao-rollback.sql
-- Versão 1.0 — 17/11/2026 / Mudança: primeira versão (Webchat de Previsão de marcação, `previsao/index.html`).
--
-- O QUE É: um segundo webchat, separado do chat de marcação. A clínica já tem a marcação no Klingo (relatório #14359, lido a cada 30 s para a Jornada). Este canal registra
-- TODA pessoa com marcação aberta (pré-cadastro), mostra a ela a PREVISÃO do que está marcado e abre uma conversa que a atendente responde no painel.
-- Regra do dono (17/11/2026): "não sei" e "seguimos" NÃO bloqueiam; nada barra o paciente pela confirmação de que é uma previsão; anota-se o que houver e avisa-se que a
-- previsão será vista e confirmada pelo webchat, WhatsApp e telefone.
--
-- PRIVACIDADE: `pmarc_pessoa` guarda nome, celular, telefone, e-mail e nascimento de quem tem marcação (vindos do Klingo) e o que a própria pessoa digitar. NÃO guarda o CPF
-- do Klingo (só `tem_cpf`). Fechada: RLS ligada, sem política e sem permissão de tabela para anon e authenticated; só as funções `pmarc_*` e `painel_pmarc_*` leem e gravam.
-- O contato (tabela `contatos`, vista pelo marketing) SÓ é criado quando a pessoa abre o canal e escreve ou responde; o pré-cadastro por si só não vira contato.
--
-- Interruptor: `previsao_marcacao_modo` ('nao' = nada funciona para o público e a leitura do Klingo não grava; 'sim' = ligado). Nasce 'nao'.

insert into public.config (chave, valor) values
  ('previsao_marcacao_modo', 'nao'),
  ('previsao_marcacao_aviso', 'Importante: esta é uma PREVISÃO de marcação. Ela ainda vai ser vista e confirmada pela nossa equipe, pelo webchat, pelo WhatsApp e por telefone.'),
  ('previsao_marcacao_final', 'Anotamos o que você nos contou. A previsão vai ser vista e confirmada pela nossa equipe pelo webchat, pelo WhatsApp e por telefone. Se quiser, pode escrever aqui a qualquer momento.'),
  ('previsao_marcacao_novos_max_hora', '60')
on conflict (chave) do nothing;

create table if not exists public.pmarc_pessoa (
  id uuid primary key default gen_random_uuid(),
  chave text not null unique,
  codigo text not null unique default left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 24),
  nome text,
  celular text,
  telefone text,
  email text,
  nascimento date,
  tem_cpf boolean not null default false,
  primeira_vez boolean,
  origem text not null default 'klingo',
  resposta text,
  respondeu_em timestamptz,
  informado jsonb not null default '{}'::jsonb,
  primeiro_acesso_em timestamptz,
  ultimo_acesso_em timestamptz,
  aceitou_lgpd_em timestamptz,
  link_enviado_em timestamptz,
  link_enviado_por uuid,
  contato_id uuid references public.contatos (id) on delete set null,
  conversa_id uuid references public.conversas (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint pmarc_pessoa_origem_check check (origem in ('klingo', 'espontaneo')),
  constraint pmarc_pessoa_resposta_check check (resposta is null or resposta in ('sim', 'nao', 'nao_sei'))
);
comment on table public.pmarc_pessoa is 'Pré-cadastro do canal Previsão de marcação: uma linha por pessoa com marcação aberta no Klingo (chave = a da Jornada) ou que chegou sozinha (origem espontaneo). Fechada: só as funções pmarc_* e painel_pmarc_*.';
comment on column public.pmarc_pessoa.codigo is 'Código secreto do link pessoal (24 letras e números). Quem tem o link vê a previsão desta pessoa; a equipe o vê no painel.';
comment on column public.pmarc_pessoa.informado is 'O que a pessoa digitou: nome, celular, e-mail, cpf, observação, correções. Guardado como veio (sem barrar), com marca de revisão quando parece errado.';
create index if not exists pmarc_pessoa_celular_idx on public.pmarc_pessoa (celular) where celular is not null;
create index if not exists pmarc_pessoa_telefone_idx on public.pmarc_pessoa (telefone) where telefone is not null;
create index if not exists pmarc_pessoa_conversa_idx on public.pmarc_pessoa (conversa_id) where conversa_id is not null;
alter table public.pmarc_pessoa enable row level security;
revoke all on public.pmarc_pessoa from anon, authenticated;

-- Limite de tentativas de achar a previsão pelo celular + nascimento (guarda só uma marca do celular, nunca o número).
create table if not exists public.pmarc_tentativa (
  id bigint generated always as identity primary key,
  marca text not null,
  tipo text not null,
  quando timestamptz not null default now()
);
comment on table public.pmarc_tentativa is 'Tentativas de achar a previsão sem o link (marca do celular + tipo). Serve só para limitar adivinhação; apagada em poucas horas.';
create index if not exists pmarc_tentativa_idx on public.pmarc_tentativa (marca, tipo, quando);
alter table public.pmarc_tentativa enable row level security;
revoke all on public.pmarc_tentativa from anon, authenticated;
