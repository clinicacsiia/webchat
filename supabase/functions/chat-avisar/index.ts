// FLUXOGRAMA: entrada (pg_net chama com x-fila-aviso-segredo quando o atendente/assistente responde no chat) -> validação (segredo do Vault) -> lógica (acha os aparelhos da conversa e envia Web Push genérico; apaga aparelho expirado) -> saída (responde quantos foram enviados)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial
//
// Usa os mesmos segredos da fila-avisar: VAPID_PRIVADA (segredo da função), config.fila_vapid_publica e o segredo do Vault (fila_aviso_segredo).
// O aviso NÃO leva o texto da mensagem nem nome: só "você recebeu uma resposta" (o texto pode ter dado de saúde e aparece na tela bloqueada).
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const igual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const recebido = req.headers.get('x-fila-aviso-segredo') ?? '';
  const { data: segredo } = await db.rpc('fila_aviso_segredo');
  if (!segredo || !igual(String(segredo), recebido)) return new Response('não autorizado', { status: 401 });

  let conversa = '';
  try { conversa = String((await req.json()).conversa ?? ''); } catch { /* corpo inválido */ }
  if (!UUID.test(conversa)) return new Response('conversa inválida', { status: 400 });

  const privada = Deno.env.get('VAPID_PRIVADA');
  const { data: cfg } = await db.from('config').select('valor').eq('chave', 'fila_vapid_publica').maybeSingle();
  const publica = cfg?.valor;
  if (!publica || !privada) return new Response('VAPID não configurado', { status: 500 });
  webpush.setVapidDetails(Deno.env.get('VAPID_CONTATO') ?? 'https://clinicacsiia.github.io/webchat/', publica, privada);

  const { data: aparelhos, error } = await db.from('chat_push_inscricao').select('id,endpoint,p256dh,auth').eq('conversa_id', conversa);
  if (error) return new Response(error.message, { status: 500 });

  const corpo = JSON.stringify({ tipo: 'chat', titulo: 'CSI · Clínica de Saúde e Imagem', corpo: 'Você recebeu uma resposta no chat. Toque para abrir.', conversa });
  let enviados = 0;
  for (const p of aparelhos ?? []) {
    try {
      await webpush.sendNotification({ endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, corpo, { TTL: 3600, urgency: 'high' });
      enviados++;
    } catch (e) {
      const st = (e as { statusCode?: number }).statusCode;
      if (st === 404 || st === 410) await db.from('chat_push_inscricao').delete().eq('id', p.id);   // aparelho desinscrito
    }
  }
  return new Response(JSON.stringify({ aparelhos: aparelhos?.length ?? 0, enviados }), { headers: { 'Content-Type': 'application/json' } });
});
