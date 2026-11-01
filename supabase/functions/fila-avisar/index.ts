// FLUXOGRAMA: entrada (pg_net chama com o cabeçalho x-fila-aviso-segredo quando nasce um aviso) -> validação (segredo bate com FILA_AVISO_SEGREDO) -> lógica (lê fila_aviso sem enviado_em, acha os aparelhos da conta, envia Web Push, apaga aparelho que expirou) -> saída (marca enviado_em; responde quantos foram enviados)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
//
// Segredos da função (supabase secrets set ...): FILA_AVISO_SEGREDO, VAPID_PUBLICA, VAPID_PRIVADA, VAPID_CONTATO (mailto:...).
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem no ambiente. O corpo do push leva só título e texto do aviso (sem nome nem dado de saúde).
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const igual = (a: string, b: string) => {   // comparação sem atalho de tempo
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};

Deno.serve(async (req) => {
  const segredo = Deno.env.get('FILA_AVISO_SEGREDO') ?? '';
  const recebido = req.headers.get('x-fila-aviso-segredo') ?? '';
  if (!segredo || !igual(segredo, recebido)) return new Response('não autorizado', { status: 401 });

  const publica = Deno.env.get('VAPID_PUBLICA'), privada = Deno.env.get('VAPID_PRIVADA');
  if (!publica || !privada) return new Response('VAPID não configurado', { status: 500 });
  webpush.setVapidDetails(Deno.env.get('VAPID_CONTATO') ?? 'mailto:suporte@exemplo.com', publica, privada);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: avisos, error } = await db.from('fila_aviso').select('id,conta_id,tipo,titulo,corpo').is('enviado_em', null).not('conta_id', 'is', null).order('id').limit(50);
  if (error) return new Response(error.message, { status: 500 });

  let enviados = 0;
  for (const a of avisos ?? []) {
    const { data: aparelhos } = await db.from('push_inscricao').select('id,endpoint,p256dh,auth').eq('conta_id', a.conta_id);
    const corpo = JSON.stringify({ tipo: a.tipo, titulo: a.titulo, corpo: a.corpo });
    for (const p of aparelhos ?? []) {
      try {
        await webpush.sendNotification({ endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, corpo, { TTL: a.tipo === 'vez' ? 600 : 1800, urgency: a.tipo === 'chegada' ? 'normal' : 'high' });
        enviados++;
      } catch (e) {
        const st = (e as { statusCode?: number }).statusCode;
        if (st === 404 || st === 410) await db.from('push_inscricao').delete().eq('id', p.id);   // aparelho desinscrito
      }
    }
    await db.from('fila_aviso').update({ enviado_em: new Date().toISOString() }).eq('id', a.id);
  }
  return new Response(JSON.stringify({ avisos: avisos?.length ?? 0, enviados }), { headers: { 'Content-Type': 'application/json' } });
});
