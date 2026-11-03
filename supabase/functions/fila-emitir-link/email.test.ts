// FLUXOGRAMA: entrada (nome, link, validade) -> validação (token fora do formato JWT, link http e HTML injetado) -> lógica (montarLink e montarEmail) -> saída (teste verde ou a diferença)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial
// Rodar: node --experimental-strip-types --test supabase/functions/fila-emitir-link/email.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapar, montarEmail, montarLink, primeiroNome } from './email.ts';

const JWT = 'aaaa.bbbb.cccc';

test('montarLink põe o token no endereço da fila e descarta o que já havia na URL', () => {
  assert.equal(montarLink('https://clinicacsiia.github.io/webchat/fila/', JWT), `https://clinicacsiia.github.io/webchat/fila/?token=${JWT}`);
  assert.equal(montarLink('https://x.com/fila/?velho=1#h', JWT), `https://x.com/fila/?token=${JWT}`);
});

test('montarLink recusa token fora do formato e endereço sem https', () => {
  assert.throws(() => montarLink('https://x.com/', 'sem pontos'));
  assert.throws(() => montarLink('https://x.com/', 'a.b.c" onclick="x'));
  assert.throws(() => montarLink('http://x.com/', JWT));
  assert.throws(() => montarLink('javascript:alert(1)', JWT));
});

test('o e-mail usa só o primeiro nome, traz o link e a validade, e não tem dado clínico', () => {
  const m = montarEmail({ nome: 'Maria da Silva Souza', link: `https://x.com/fila/?token=${JWT}`, expiraEm: '2026-11-03T18:00:00Z' });
  assert.match(m.texto, /Olá, Maria!/);
  assert.ok(!m.texto.includes('Silva'));
  assert.ok(m.texto.includes(`https://x.com/fila/?token=${JWT}`));
  assert.match(m.texto, /O link vale até 03\/11\/2026/);
  assert.match(m.html, /href="https:\/\/x\.com\/fila\/\?token=aaaa\.bbbb\.cccc"/);
  assert.equal(m.assunto, 'Sua assinatura para o atendimento');
});

test('nome malicioso é escapado e validade ilegível vira texto genérico', () => {
  const m = montarEmail({ nome: '<script>alert(1)</script> Fulano', link: `https://x.com/?token=${JWT}`, expiraEm: 'lixo' });
  assert.ok(!m.html.includes('<script>'));
  assert.match(m.texto, /vale por poucas horas/);
  assert.equal(escapar(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(primeiroNome(null), '');
  assert.match(montarEmail({ link: `https://x.com/?token=${JWT}` }).texto, /^Olá!/);
});
