// FLUXOGRAMA: entrada (chat_iniciar REAL de supabase/fase6-unidade-e-medico.sql + a seção 2 de supabase/saida-n8n.sql) -> validação (a definição antiga cita o n8n; a transformação recusa o que não reconhece) -> lógica (tira só o bloco do n8n e deixa o resto da função igual; roda duas vezes sem erro; sem reconhecer o bloco, nada muda) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { funcao, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push({ nome, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return e.message ?? String(e); } };
const sql = readFileSync(`${REPO}/supabase/saida-n8n.sql`, 'utf8');
const bloco = sql.match(/do \$\$\ndeclare d text; novo text;[\s\S]*?end \$\$;/)[0];
const ASSIN = 'public.chat_iniciar(text,text,text,text,boolean,text,text,text,text,text,jsonb,text)';

const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin;`);
await db.exec('create table if not exists public.config (chave text primary key, valor text not null default $$$$);');
await db.exec(funcao('fase6-unidade-e-medico.sql', 'chat_iniciar'));
const antes = (await db.query(`select pg_get_functiondef('${ASSIN}'::regprocedure) as d`)).rows[0].d;
registrar('a chat_iniciar de partida cita o n8n (o teste parte da função real)', antes.includes('n8n_webhook_url'));

await db.exec(bloco);
const depois = (await db.query(`select pg_get_functiondef('${ASSIN}'::regprocedure) as d`)).rows[0].d;
registrar('depois da transformação a função não cita mais o n8n', !depois.includes('n8n'));
const linhas = (t) => t.split('\n');
const L0 = linhas(antes), L1 = linhas(depois);
const idx = L0.map((l, i) => (L1.includes(l) ? -1 : i)).filter((i) => i >= 0);
const contiguo = idx.length > 0 && idx[idx.length - 1] - idx[0] === idx.length - 1;
registrar('saiu um único trecho contínuo, que começa na leitura de n8n_webhook_url e termina no "end;" do bloco, e nada novo entrou', contiguo && L0[idx[0]].includes('n8n_webhook_url') && L0[idx[idx.length - 1]].trim() === 'end;' && L0[idx[idx.length - 1] + 1].trim() === 'end if;' && L1.every((l) => L0.includes(l)), `linhas removidas=${idx.length}`);
registrar('o resto da função (cadastro, token e retorno) continua igual', depois.includes('insert into public.conversa_segredo') && depois.includes(`return jsonb_build_object('conversa_id', v_conv, 'token', v_token`) && !idx.some((i) => /insert into|return /.test(L0[i])));
registrar('a assinatura e o modo de segurança continuam iguais', depois.includes('SECURITY DEFINER') && depois.includes('search_path') && depois.includes('p_irmaos_modo text'));
const segunda = await erroDe(() => db.exec(bloco));
registrar('segunda aplicação não faz nada e não dá erro', segunda === null, segunda ?? '');

// Se a função tiver o n8n em outro formato, a transformação deve parar sem mexer.
await db.exec(`drop function ${ASSIN}`);
await db.exec(`create or replace function public.chat_iniciar(p_nome text, p_telefone text, p_email text, p_mensagem text, p_aceite boolean, p_origem text, p_unidade text, p_medico text, p_paciente_tipo text, p_paciente_nome text, p_irmaos jsonb, p_irmaos_modo text)
  returns jsonb language plpgsql as $f$ begin perform 1; -- fala do n8n_webhook_url de um jeito diferente
  return '{}'::jsonb; end $f$;`);
const antesEstranha = (await db.query(`select pg_get_functiondef('${ASSIN}'::regprocedure) as d`)).rows[0].d;
const e = await erroDe(() => db.exec(bloco));
const depoisEstranha = (await db.query(`select pg_get_functiondef('${ASSIN}'::regprocedure) as d`)).rows[0].d;
registrar('formato desconhecido: a migração para com erro claro e a função fica intacta', /não consegui remover o bloco do n8n/.test(e ?? '') && antesEstranha === depoisEstranha, e ?? '');

const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
