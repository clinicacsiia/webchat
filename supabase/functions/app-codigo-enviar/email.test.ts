// FLUXOGRAMA: entrada (dados inventados) -> validação (código, escape, aviso de spam) -> saída (asserções do node:test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarEmail } from './email.ts';

test('mostra o código, a validade e o aviso de spam/lixeira', () => {
  const m = montarEmail({ nome: 'Maria Souza', codigo: '123456', finalidade: 'cadastro', validadeMin: 60 });
  assert.match(m.assunto, /123456/);
  assert.match(m.texto, /Olá, Maria!/);
  assert.match(m.texto, /60 minutos/);
  assert.match(m.texto, /spam \(lixo eletrônico\) e a lixeira/);
  assert.match(m.html, /spam \(lixo eletrônico\) e a lixeira/);
});
test('o texto muda conforme a finalidade', () => {
  assert.match(montarEmail({ codigo: '000001', finalidade: 'esqueci_pin', validadeMin: 1 }).texto, /novo PIN/);
  assert.match(montarEmail({ codigo: '000001', finalidade: 'cadastro', validadeMin: 1 }).texto, /confirmar o seu e-mail/);
  assert.match(montarEmail({ codigo: '000001', finalidade: 'cadastro', validadeMin: 1 }).texto, /1 minuto\./);
});
test('nome com HTML é escapado e código inválido é recusado', () => {
  const m = montarEmail({ nome: '<script>x</script>', codigo: '654321', finalidade: 'cadastro', validadeMin: 5 });
  assert.ok(!m.html.includes('<script>'));
  assert.throws(() => montarEmail({ codigo: '12a456', finalidade: 'cadastro', validadeMin: 5 }), /codigo_invalido/);
});
