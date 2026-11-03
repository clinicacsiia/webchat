// FLUXOGRAMA: entrada (pg_net chama de fila_avisar_link com x-fila-aviso-segredo e {atendimento_uuid}) -> validação (segredo do Vault; UUID; provedor de e-mail configurado ANTES de gastar um envio) -> lógica (fila_emitir_token com o segredo do módulo no cabeçalho; monta o e-mail só com o endereço que o BANCO devolve; envia pelo provedor) -> saída ({ok} sem token, nunca no corpo nem no log)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial (substitui o workflow "Fila - emitir link" do n8n)
//
// Segredos da função (painel do Supabase > Edge Functions > Secrets; nunca em arquivo):
//   EMAIL_API_KEY    chave do provedor (Resend, https://resend.com)
//   EMAIL_REMETENTE  ex.: "CSI <nao-responda@seudominio.com.br>" (o domínio precisa estar verificado no provedor)
//   FILA_LINK_BASE   opcional; padrão https://clinicacsiia.github.io/webchat/fila/
// O token (JWT de 4 h) nunca é gravado em log. O destinatário vem da resposta do banco, nunca do corpo da chamada.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { montarEmail, montarLink } from './email.ts';

const igual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const servico = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const recebido = req.headers.get('x-fila-aviso-segredo') ?? '';
  const { data: aviso } = await servico.rpc('fila_aviso_segredo');
  if (!aviso || !igual(String(aviso), recebido)) return new Response('não autorizado', { status: 401 });

  let atendimento = '';
  try { atendimento = String((await req.json()).atendimento_uuid ?? ''); } catch { /* corpo inválido */ }
  if (!UUID.test(atendimento)) return json({ ok: false, erro: 'atendimento_invalido' }, 400);

  const chave = Deno.env.get('EMAIL_API_KEY');
  const remetente = Deno.env.get('EMAIL_REMETENTE');
  if (!chave || !remetente) return json({ ok: false, erro: 'email_nao_configurado' }, 503);   // antes de emitir: não gasta um dos 10 envios

  // O módulo da fila confere o segredo dele (Vault: fila_segredo) pelo cabeçalho x-fila-segredo, como a credencial do n8n fazia.
  const { data: segredoFila } = await servico.rpc('fila_segredo_vault', { p_nome: 'fila_segredo' });
  if (!segredoFila) return json({ ok: false, erro: 'segredo_da_fila_ausente' }, 500);
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false }, global: { headers: { 'x-fila-segredo': String(segredoFila) } } });

  const { data: emissao, error } = await anon.rpc('fila_emitir_token', { p_atendimento: atendimento });
  if (error) return json({ ok: false, erro: 'falha_ao_emitir' }, 502);
  if (!emissao?.ok) return json({ ok: false, erro: emissao?.erro ?? 'recusado' });   // fora da fila, limite de envios…

  let mensagem;
  try {
    const base = Deno.env.get('FILA_LINK_BASE') ?? 'https://clinicacsiia.github.io/webchat/fila/';
    mensagem = montarEmail({ nome: emissao.nome, link: montarLink(base, String(emissao.token)), expiraEm: emissao.expira_em });
  } catch { return json({ ok: false, erro: 'link_invalido' }, 500); }

  const resposta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: remetente, to: [String(emissao.email)], subject: mensagem.assunto, text: mensagem.texto, html: mensagem.html }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!resposta || !resposta.ok) return json({ ok: false, erro: 'email_nao_enviado', status: resposta?.status ?? 0 }, 502);
  return json({ ok: true });
});
