// FLUXOGRAMA: entrada (vetores.json gerado pelo Python de referência) -> validação (cada caso roda resolver() do TypeScript) -> lógica (compara com o que o Python devolveu: números com tolerância mínima, textos e booleanos iguais) -> saída (teste verde ou a diferença exata)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial
// Rodar: node --experimental-strip-types --test supabase/functions/fila-validar-assinatura/avaliacao.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arredondar, resolver, avaliar, novoPerfil, atualizarPerfil, registrarTentativa, extrairCaracteristicas } from './avaliacao.ts';

const vetores = JSON.parse(readFileSync(new URL('./vetores.json', import.meta.url), 'utf8')) as { nome: string; entrada: any; esperado: any }[];

function iguais(a: any, b: any, caminho: string) {
  if (typeof b === 'number' && typeof a === 'number') {
    const tol = Math.max(1e-9, Math.abs(b) * 1e-9);   // o arredondamento já é igual; a tolerância cobre só a ordem das somas
    assert.ok(Math.abs(a - b) <= tol, `${caminho}: TypeScript ${a} x Python ${b}`);
  } else if (b && typeof b === 'object') {
    assert.ok(a && typeof a === 'object', `${caminho}: esperava objeto`);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${caminho}: chaves diferentes`);
    for (const k of Object.keys(b)) iguais(a[k], b[k], `${caminho}.${k}`);
  } else assert.equal(a, b, caminho);
}

for (const v of vetores) {
  test(`paridade com o Python: ${v.nome}`, () => iguais(resolver(v.entrada), v.esperado, v.nome));
}

test('os vetores cobrem aprovação, reprovação, bloqueio e série inválida', () => {
  const r = vetores.map((v) => v.esperado);
  assert.ok(r.some((x) => x.ok && x.tipo === 'enrolamento'));
  assert.ok(r.some((x) => x.ok && x.tipo === 'comparacao' && x.aprovado));
  assert.ok(r.some((x) => x.ok && x.tipo === 'comparacao' && !x.aprovado));
  assert.ok(r.some((x) => x.ok && x.bloqueado));
  assert.ok(r.some((x) => !x.ok && x.erro === 'serie_invalida'));
  assert.ok(r.some((x) => !x.ok && x.erro === 'consentimento_obrigatorio'));
});

test('arredondar segue o round() do Python (empate vai para o par)', () => {
  assert.equal(arredondar(0.125, 2), 0.12);
  assert.equal(arredondar(0.375, 2), 0.38);
  assert.equal(arredondar(2.5, 0), 2);
  assert.equal(arredondar(3.5, 0), 4);
  assert.equal(arredondar(0.30004, 4), 0.3);
  assert.equal(arredondar(0.29996, 4), 0.3);
  assert.equal(arredondar(0.12345678, 6), 0.123457);
});

test('limiar: o score já arredondado decide (0,3000 aprova, 0,2999 reprova)', () => {
  const perfil = { versao: 1, n: 3, features: Object.fromEntries(['velocidade_media', 'jitter', 'duracao_ms', 'pressao_media', 'pressao_desvio', 'num_tracos', 'pausa_media_ms'].map((k) => [k, { media: 1, variancia: 0 }])) } as any;
  const f = (d: number) => Object.fromEntries(Object.keys(perfil.features).map((k) => [k, 1 + d * Math.max(0.1, { velocidade_media: 0.0005, jitter: 0.001, duracao_ms: 50, pressao_media: 0.05, pressao_desvio: 0.02, num_tracos: 1, pausa_media_ms: 300 }[k as 'jitter'])])) as any;
  assert.equal(avaliar(f(0), perfil).score, 1);
  assert.equal(avaliar(f(7 / 3), perfil).aprovado, true);
  assert.equal(avaliar(f(2.4), perfil).aprovado, false);
});

test('perfil: primeira aprovação define a média; reprovação nunca é chamada aqui; n cresce de 1 em 1', () => {
  const f = { velocidade_media: 1, jitter: 2, duracao_ms: 3, pressao_media: 4, pressao_desvio: 5, num_tracos: 6, pausa_media_ms: 7 };
  const p1 = atualizarPerfil(novoPerfil(), f);
  assert.equal(p1.n, 1);
  assert.equal(p1.features.jitter.media, 2);
  assert.equal(p1.features.jitter.variancia, 0);
  assert.equal(atualizarPerfil(p1, f).n, 2);
});

test('3 tentativas: a terceira falha bloqueia e contador fora do intervalo é erro', () => {
  assert.deepEqual(registrarTentativa(0, false), { falhas: 1, restantes: 2, bloqueado: false });
  assert.deepEqual(registrarTentativa(2, false), { falhas: 3, restantes: 0, bloqueado: true });
  assert.deepEqual(registrarTentativa(1, true), { falhas: 1, restantes: 2, bloqueado: false });
  assert.throws(() => registrarTentativa(4, false));
});

test('entrada hostil nunca derruba: texto, nulo, NaN e lista gigante viram serie_invalida', () => {
  const base = { consentimento: true, perfil: {}, tentativas_falhas: 0 };
  for (const pontos of [null, 'abc', 5, [], [null], new Array(6000).fill({ x: 0, y: 0, timestamp: 0 })]) {
    const r = resolver({ ...base, pontos }) as any;
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'serie_invalida');
  }
  assert.throws(() => extrairCaracteristicas([{ x: 'a', y: 0, timestamp: 0 }]));
  const nan = Array.from({ length: 30 }, (_, i) => ({ x: i === 3 ? NaN : 0.5, y: 0.5, timestamp: i * 20, pressao: 0.5, traco: 0 }));
  assert.equal((resolver({ ...base, pontos: nan }) as any).ok, false);
  assert.equal((resolver({ consentimento: 'true', pontos: nan }) as any).erro, 'consentimento_obrigatorio');
});
