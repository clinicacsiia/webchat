// FLUXOGRAMA: entrada (POST do banco, pg_net, com x-klingo-segredo e {id}; o banco chama quando alguém pede o código de e-mail do acesso rápido) -> validação (segredo conferido pelo banco; id é UUID; o banco só entrega o código se o envio ainda está pendente, sem uso, sem descarte e sem vencer; SMTP configurado) -> lógica (monta o e-mail com o código e manda pelo SMTP; anota no banco se saiu ou o motivo técnico) -> saída ({ok} apenas; o código e o e-mail NUNCA vão para o log nem para a resposta)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial. Se o envio falhar, a equipe ainda vê o código no painel (Pendências > Códigos) e passa a quem confirmar a identidade.
//
// Segredos (painel do Supabase > Edge Functions > Secrets; nunca em arquivo nem na conversa):
//   SMTP_USUARIO     e-mail que envia (ex.: o Gmail da clínica)
//   SMTP_SENHA       senha de app do Gmail (https://myaccount.google.com/apppasswords)
//   SMTP_REMETENTE   opcional; ex.: "CSI <contato@...>" (padrão: SMTP_USUARIO)
//   SMTP_HOST        opcional; padrão smtp.gmail.com (porta 465, TLS)
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
import { montarEmail } from './email.ts';

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: ok } = await supabase.rpc('klingo_segredo_ok', { p_valor: req.headers.get('x-klingo-segredo') ?? '' });
  if (ok !== true) return json({ error: 'Forbidden' }, 403);
  const corpo = await req.json().catch(() => ({}));
  const id = String(corpo?.id ?? '');
  if (!UUID.test(id)) return json({ ok: false, erro: 'id_invalido' }, 400);

  const { data: dados } = await supabase.rpc('app_codigo_para_enviar', { p_id: id });
  if (!dados) return json({ ok: false, erro: 'nada_a_enviar' });

  const usuario = Deno.env.get('SMTP_USUARIO'), senha = Deno.env.get('SMTP_SENHA');
  if (!usuario || !senha) { await supabase.rpc('app_codigo_envio_marcar', { p_id: id, p_ok: false, p_erro: 'smtp_nao_configurado' }); return json({ ok: false, erro: 'smtp_nao_configurado' }, 503); }

  let msg;
  try { msg = montarEmail({ nome: dados.nome, codigo: String(dados.codigo), finalidade: String(dados.finalidade), validadeMin: Number(dados.validade_min) || 60 }); }
  catch { await supabase.rpc('app_codigo_envio_marcar', { p_id: id, p_ok: false, p_erro: 'mensagem_invalida' }); return json({ ok: false, erro: 'mensagem_invalida' }, 500); }

  const cliente = new SMTPClient({ connection: { hostname: Deno.env.get('SMTP_HOST') ?? 'smtp.gmail.com', port: 465, tls: true, auth: { username: usuario, password: senha } } });
  try {
    await cliente.send({ from: Deno.env.get('SMTP_REMETENTE') ?? usuario, to: String(dados.email), subject: msg.assunto, content: msg.texto, html: msg.html });
    await supabase.rpc('app_codigo_envio_marcar', { p_id: id, p_ok: true });
    return json({ ok: true });
  } catch (e) {
    // só o tipo do erro (sem endereço, sem código): ajuda a equipe a ver por que não saiu
    const motivo = /535|auth/i.test(String((e as Error)?.message)) ? 'smtp_senha_recusada' : 'smtp_falha';
    await supabase.rpc('app_codigo_envio_marcar', { p_id: id, p_ok: false, p_erro: motivo });
    return json({ ok: false, erro: motivo }, 502);
  } finally { try { await cliente.close(); } catch { /* já fechado */ } }
});
