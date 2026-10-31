// FLUXOGRAMA: entrada (sentinela.js carregado no Node, só as funções puras) -> validação (formato do código, limiares aprendidos, ordem, classificação de erro, privacidade) -> lógica (cada função recebe casos bons e ruins) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { createRequire } from 'node:module';
import { REPO } from './stubs-supabase.mjs';

const S = createRequire(import.meta.url)(`${REPO}/sentinela.js`);
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };

// código de rastreio
const c1 = S.gerarCodigo('RPC', new Date(2026, 9, 31, 14, 7), () => 0);
registrar('o código tem o formato CSI-AAMMDD-HHMM-TIPO-XXXX', c1 === 'CSI-261031-1407-RPC-2222', c1);
let todosValidos = true, repetidos = 0; const vistos = new Set();
for (let i = 0; i < 2000; i++) { const c = S.gerarCodigo('LNT'); if (!S.codigoValido(c)) todosValidos = false; if (vistos.has(c)) repetidos++; vistos.add(c); }
registrar('2000 códigos gerados são todos válidos e quase não repetem no mesmo minuto', todosValidos && repetidos < 10, `repetidos=${repetidos}`);
registrar('o código nunca usa caracteres que se confundem (0, O, 1, I, L)', ![...vistos].some((c) => /-[A-Z0-9]{4}$/.test(c) && /[01OIL]/.test(c.slice(-4))));
registrar('códigos malformados são recusados', !S.codigoValido('abc') && !S.codigoValido('CSI-261031-1407-RPC-22') && !S.codigoValido(null));

// aprendizado: limiares
registrar('sem histórico, "lento" é 10 s e "parado" é 90 s', S.limiarLento([]) === 10000 && S.limiarParado([]) === 90000);
registrar('"lento" nunca fica abaixo de 8 s nem acima de 30 s', S.limiarLento([100, 100, 100, 100, 100]) === 8000 && S.limiarLento([60000, 60000, 60000, 60000, 60000]) === 30000);
registrar('"lento" acompanha o p90 do aparelho (2,5×)', S.limiarLento([2000, 3000, 3000, 4000, 4000, 4000, 4500, 5000, 5000, 6000]) === 12500, String(S.limiarLento([2000, 3000, 3000, 4000, 4000, 4000, 4500, 5000, 5000, 6000])));
registrar('"parado" é 3× a mediana da etapa, entre 60 s e 180 s', S.limiarParado([10, 10, 10]) === 60000 && S.limiarParado([30, 30, 30]) === 90000 && S.limiarParado([200, 200, 200]) === 180000);
registrar('percentil de lista vazia é nulo e o p50 de [1..5] é 3', S.percentil([], 0.9) === null && S.mediana([1, 2, 3, 4, 5]) === 3);

// ordem
registrar('ordem: crescente passa; repetida ou invertida não', S.ordemOk([1, 2, 5]) && S.ordemOk([]) && !S.ordemOk([2, 1]) && !S.ordemOk([3, 3]));

// classificação de erro do Supabase
const k = (...a) => S.classificarRpc(...a).tipo;
registrar('erro: sem resposta e aparelho offline = NET; online = RPC', k('chat_enviar', 0, null, false) === 'NET' && k('chat_enviar', 0, null, true) === 'RPC');
registrar('erro: "pergunta já respondida" (22023) = DES', k('chat_responder', 400, { code: '22023', message: 'Essa pergunta já foi respondida.' }, true) === 'DES');
registrar('erro: 28000 = ANT, 54000 = LIM, qualquer outro = RPC', k('x', 400, { code: '28000' }) === 'ANT' && k('x', 429, { code: '54000' }) === 'LIM' && k('x', 500, { code: 'XX000' }) === 'RPC');

// privacidade: nada de conteúdo do paciente no registro
const l = S.limpar({ passo: 'plano', ms: 12, texto: 'meu CPF 123.456.789-09', valor: { cpf: 1 }, nome: 'Maria', telefone: '71999998888', erro: 'falha para 71999998888 em maria@x.com', ok: true, objeto: { a: 1 } });
registrar('privacidade: texto, valor, nome e telefone nunca entram; números longos e e-mails são mascarados', !('texto' in l) && !('valor' in l) && !('nome' in l) && !('telefone' in l) && l.passo === 'plano' && l.ms === 12 && l.ok === true && !('objeto' in l)
  && !/\d{6,}/.test(l.erro) && !l.erro.includes('maria@x.com'), JSON.stringify(l));

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
