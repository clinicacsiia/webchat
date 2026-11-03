// FLUXOGRAMA: entrada (nome, link com o token e validade) -> validação (escapa o HTML; recusa link fora do endereço permitido) -> lógica (monta assunto, texto e HTML sem dado clínico) -> saída (objeto pronto para o provedor de e-mail)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial (era o nó "Send Email" do n8n)
// Sem imports e sem Deno: testado no Node (email.test.ts).

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapar = (t: string) => String(t).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function primeiroNome(nome: unknown): string {
  const n = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  return n.slice(0, 40);
}

export function montarLink(base: string, token: string): string {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('token inválido');
  const u = new URL(base);
  if (u.protocol !== 'https:') throw new Error('o link precisa ser https');
  u.search = '';
  u.hash = '';
  u.searchParams.set('token', token);
  return u.toString();
}

export function montarEmail(opts: { nome?: unknown; link: string; expiraEm?: unknown }) {
  const nome = primeiroNome(opts.nome);
  const saudacao = nome ? `Olá, ${nome}!` : 'Olá!';
  const quando = (() => {
    const d = new Date(String(opts.expiraEm ?? ''));
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('pt-BR', { timeZone: 'America/Bahia', dateStyle: 'short', timeStyle: 'short' });
  })();
  const validade = quando ? `O link vale até ${quando}.` : 'O link vale por poucas horas.';
  const assunto = 'Sua assinatura para o atendimento';
  const texto = `${saudacao}\n\nPara continuar o seu atendimento na CSI · Clínica de Saúde e Imagem, abra o link abaixo e assine na tela:\n\n${opts.link}\n\n${validade}\nSe você não pediu isto, ignore esta mensagem e não repasse o link a ninguém.\n`;
  const html = `<p>${escapar(saudacao)}</p><p>Para continuar o seu atendimento na CSI · Clínica de Saúde e Imagem, toque no botão e assine na tela:</p>` +
    `<p><a href="${escapar(opts.link)}" style="display:inline-block;padding:12px 20px;background:#0a7d5a;color:#fff;border-radius:8px;text-decoration:none">Abrir e assinar</a></p>` +
    `<p>${escapar(validade)}<br>Se você não pediu isto, ignore esta mensagem e não repasse o link a ninguém.</p>`;
  return { assunto, texto, html };
}
