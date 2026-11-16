// FLUXOGRAMA: entrada (nome, código de 6 números, finalidade e validade vindos do banco) -> validação (código só com 6 números; textos do paciente escapados no HTML) -> lógica (monta assunto, texto e HTML com o aviso de conferir spam/lixo eletrônico) -> saída ({assunto, texto, html})
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (confirmação por e-mail do acesso rápido).
export type EntradaEmail = { nome?: string | null; codigo: string; finalidade: string; validadeMin: number };

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function montarEmail(e: EntradaEmail): { assunto: string; texto: string; html: string } {
  if (!/^[0-9]{6}$/.test(e.codigo)) throw new Error('codigo_invalido');
  const primeiro = (e.nome ?? '').trim().split(/\s+/)[0] ?? '';
  const ola = primeiro ? `Olá, ${primeiro}!` : 'Olá!';
  const motivo = e.finalidade === 'esqueci_pin' ? 'criar um novo PIN no acesso rápido da CSI' : 'confirmar o seu e-mail e criar o seu acesso rápido da CSI';
  const min = Math.max(1, Math.round(e.validadeMin));
  const validade = `O código vale por ${min} minuto${min === 1 ? '' : 's'}.`;
  const spam = 'Não achou este e-mail? Olhe também a pasta de spam (lixo eletrônico) e a lixeira.';
  const ignore = 'Se não foi você, ignore esta mensagem: ninguém entra sem digitar este código. Nunca passe o código a quem ligar pedindo.';
  const assunto = `Seu código CSI: ${e.codigo}`;
  const texto = `${ola}\n\nSeu código para ${motivo}:\n\n${e.codigo}\n\n${validade}\n${spam}\n\n${ignore}\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#222"><p>${esc(ola)}</p>`
    + `<p>Seu código para ${esc(motivo)}:</p>`
    + `<p style="font-size:32px;letter-spacing:6px;font-weight:bold;margin:16px 0">${e.codigo}</p>`
    + `<p>${esc(validade)}</p><p><b>${esc(spam)}</b></p><p style="color:#666;font-size:13px">${esc(ignore)}</p></div>`;
  return { assunto, texto, html };
}
