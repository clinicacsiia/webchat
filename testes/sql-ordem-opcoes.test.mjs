// FLUXOGRAMA: entrada (clone da produção + supabase/ordem-das-opcoes.sql) -> validação (pesos ordenam motivo, plano e assunto; sem peso mantém a ordem de sempre; médico e confirmar não mudam;
//   rodar duas vezes não liga duas vezes; paciente anônimo não lê nem executa nada) -> saída (PASS/FAIL).
// Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial. Dados: todos inventados aqui.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const { db } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
const SQL = readFileSync(`${REPO}/supabase/ordem-das-opcoes.sql`, 'utf8');
await db.exec(`insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2')
  on conflict (chave) do update set valor = excluded.valor`);
// 1) ANTES: o motivo sai na ordem de sempre (Exame, Consulta, Outro assunto)
const iniciar = async (nome, tel) => { await anonimo(); const r = (await q(`select public.chat_iniciar(p_nome => $1, p_telefone => $2, p_email => 'x@exemplo.invalid', p_aceite => true, p_paciente_tipo => 'proprio') r`, [nome, tel]))[0].r; await como(''); return r; };
const motivoDe = (r) => (r.respostas.at(-1).opcoes.itens || []).map((i) => i.valor).join(',');
const antes = await iniciar('Antes Teste', '71985000001');
const ordemAntes = motivoDe(antes);
await db.exec(SQL);
const depois = await iniciar('Depois Teste', '71985000002');
const ordemDepois = motivoDe(depois);
registrar('motivo: antes "exame,consulta,assunto"; depois a Consulta vem primeiro', ordemAntes === 'exame,consulta,assunto' && ordemDepois === 'consulta,exame,assunto', `${ordemAntes} -> ${ordemDepois}`);
// 2) plano e assunto pela função (mesma que o motor chama)
const ord = async (passo, itens) => (await q(`select public.fluxo_ordenar($1, $2::jsonb) r`, [passo, JSON.stringify(itens.map((v) => ({ valor: v, rotulo: v })))]))[0].r.map((i) => i.valor).join(',');
const plano = await ord('plano', ['Particular', 'AMIL', 'CASSI', 'SULAMERICA', 'ZETA NOVO', 'BRADESCO SAUDE', 'ALFA NOVO', 'CENTRAL NACIONAL UNIMED']);
registrar('plano: por peso; os sem peso vão para o fim na ordem original', plano === 'SULAMERICA,BRADESCO SAUDE,CENTRAL NACIONAL UNIMED,AMIL,Particular,CASSI,ZETA NOVO,ALFA NOVO', plano);
const assunto = await ord('assunto', ['Remarcar', 'Cancelar', 'Resultado de exame', 'Dúvida', 'Reclamação', 'Outro']);
registrar('assunto: "Outro" e "Remarcar" primeiro, o resto na ordem de sempre', assunto === 'Outro,Remarcar,Cancelar,Resultado de exame,Dúvida,Reclamação', assunto);
registrar('passo sem peso (médico) não muda de ordem', await ord('medico', ['', 'DR B', 'DRA A']) === ',DR B,DRA A');
registrar('lista vazia ou nula volta lista vazia', (await q(`select public.fluxo_ordenar('plano', null) r`))[0].r.length === 0 && (await q(`select public.fluxo_ordenar('plano', '[]'::jsonb) r`))[0].r.length === 0);
// 3) rodar de novo não liga duas vezes e não perde peso
await db.exec(SQL);
const n = (await q(`select (length(d) - length(replace(d, 'fluxo_ordenar', ''))) / length('fluxo_ordenar') n from (select pg_get_functiondef('public.fluxo_perguntar(uuid,text,text)'::regprocedure) d) x`))[0].n;
registrar('a função fluxo_perguntar chama a ordenação UMA vez, mesmo rodando o arquivo duas vezes', Number(n) === 1, `chamadas=${n}`);
// 4) mudar o peso muda a ordem (é assim que o ciclo de melhoria atualiza)
await db.exec(`update public.fluxo_opcao_ordem set peso = 1000 where passo = 'plano' and valor = 'amil'`);
registrar('atualizar um peso muda a ordem sem mexer no código', (await ord('plano', ['SULAMERICA', 'AMIL', 'CASSI'])).startsWith('AMIL,SULAMERICA'));
// 5) segurança: paciente (anon) e equipe logada não leem a tabela nem executam a função
await anonimo();
let leu = null, rodou = null;
try { leu = (await db.query(`select count(*) from public.fluxo_opcao_ordem`)).rows[0].count; } catch (e) { leu = 'negado'; }
try { rodou = (await db.query(`select public.fluxo_ordenar('plano', '[]'::jsonb)`)).rows.length; } catch (e) { rodou = 'negado'; }
await como('');
registrar('paciente anônimo não lê a tabela de pesos nem executa fluxo_ordenar', leu === 'negado' && rodou === 'negado', `leu=${leu}; rodou=${rodou}`);
const ok = resultados.every(Boolean); console.log(`\n${resultados.filter(Boolean).length} de ${resultados.length} verificações passaram.`); process.exit(ok ? 0 : 1);
