// FLUXOGRAMA: entrada (os 3 arquivos SQL do login em supabase/) -> validação (todos existem e terminam com quebra de linha) -> lógica (concatena na ordem de aplicação com o cabeçalho de aviso) -> saída (supabase/aplicar-login-paciente.sql, o arquivo único que se cola no SQL Editor)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
// Uso: node gerar-instalador.mjs   (o teste sql-login.test.mjs confere que o instalador bate com os 3 arquivos)
import { readFileSync, writeFileSync } from 'node:fs';
import { REPO } from './stubs-supabase.mjs';

const ARQUIVOS = ['contas-paciente.sql', 'protecao-identidade.sql', 'login-paciente.sql'];
const CABECALHO = `-- INSTALADOR ÚNICO — LOGIN DO PACIENTE (gerado; NÃO edite este arquivo: edite os 3 de baixo e rode "node testes/gerar-instalador.mjs").
-- Cole tudo de uma vez no Supabase > SQL Editor > Run. Pode rodar mais de uma vez sem estragar nada.
-- Contém, em ordem: contas-paciente.sql, protecao-identidade.sql, login-paciente.sql.
-- Depois de rodar, siga docs/login-paciente-passo-a-passo.md. O login do paciente nasce DESLIGADO (config.login_paciente = 'nao').
-- ============================================================================================================================

`;
const corpo = ARQUIVOS.map((a) => readFileSync(`${REPO}/supabase/${a}`, 'utf8')).join('\n');
writeFileSync(`${REPO}/supabase/aplicar-login-paciente.sql`, CABECALHO + corpo);
console.log(`supabase/aplicar-login-paciente.sql gerado (${(CABECALHO + corpo).split('\n').length} linhas).`);
