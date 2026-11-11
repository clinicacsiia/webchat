// FLUXOGRAMA: entrada (origem_limpa e a transformação de supabase/origem-limpa.sql sobre a chat_iniciar REAL de fase6-unidade-e-medico.sql) -> validação (valores sujos do relatório de teste, vazios e longos) -> lógica (só letras, números, - e _; corta no primeiro caractere inválido; troca a gravação em chat_iniciar; roda duas vezes sem erro) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { funcao, REPO } from './stubs-supabase.mjs';

let falhas = 0;
const registrar = (nome, ok, detalhe = '') => { if (!ok) falhas++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const sql = readFileSync(`${REPO}/supabase/origem-limpa.sql`, 'utf8');
const secao = (n) => sql.split(/^-- ===== /m).find((s) => s.startsWith(`${n}.`)).replace(/^.*\n/, '');
const ASSIN = 'public.chat_iniciar(text,text,text,text,boolean,text,text,text,text,text,jsonb,text)';

const db = new PGlite();
await db.exec(`create role anon nologin; create role authenticated nologin;`);
await db.exec(secao(1));
const limpa = async (v) => (await db.query('select public.origem_limpa($1) as r', [v])).rows[0].r;

registrar('qrcode**](https://clinicacsiia.github.io/webchat/?origem=qrcode) vira qrcode', (await limpa('qrcode**](https://clinicacsiia.github.io/webchat/?origem=qrcode)')) === 'qrcode');
registrar("qrcode**] vira qrcode", (await limpa('qrcode**]')) === 'qrcode');
registrar('valor limpo não muda (letras, números, - e _)', (await limpa('Instagram-bio_2')) === 'Instagram-bio_2');
registrar('vazio, espaços e nulo viram nulo', (await limpa('')) === null && (await limpa('   ')) === null && (await limpa(null)) === null);
registrar('começando por símbolo vira nulo', (await limpa('**qrcode')) === null);
registrar('limite de 40 caracteres', (await limpa('a'.repeat(100))).length === 40);

await db.exec(funcao('fase6-unidade-e-medico.sql', 'chat_iniciar'));
const antes = (await db.query(`select pg_get_functiondef('${ASSIN}'::regprocedure) as d`)).rows[0].d;
await db.exec(secao(2));
const depois = (await db.query(`select pg_get_functiondef('${ASSIN}'::regprocedure) as d`)).rows[0].d;
registrar('chat_iniciar passa a gravar public.origem_limpa(p_origem)', !antes.includes('origem_limpa') && depois.includes('public.origem_limpa(p_origem)') && !depois.includes('left(btrim(coalesce(p_origem'));
let erro = null; try { await db.exec(secao(2)); } catch (e) { erro = e.message; }
registrar('segunda aplicação não dá erro', erro === null, erro ?? '');

process.exit(falhas ? 1 : 0);
