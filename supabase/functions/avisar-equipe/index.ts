// FLUXOGRAMA: entrada (pg_net chama de fluxo_transferir, ou da rotina espera_vigiar, com x-fila-aviso-segredo) -> validação (segredo bate com o do Vault; conversa é um UUID) -> lógica (acha os aparelhos da equipe ativa em push_inscricao, envia Web Push genérico e apaga aparelho expirado) -> saída (responde quantos aparelhos e quantos envios)
// Versão 1.1 — 07/11/2026 / Mudança: novo aviso `tipo: 'espera'` (paciente esperando uma pessoa há mais de 10 min), sem conversa; um push só com a contagem
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial (substitui o aviso à equipe que o n8n nunca chegou a fazer)
//
// Usa os mesmos segredos da fila-avisar: VAPID_PRIVADA (segredo da função), config.fila_vapid_publica e o segredo do Vault (fila_aviso_segredo).
// O aviso NÃO leva nome, motivo nem texto da conversa: só "um paciente pediu atendimento" (a tela bloqueada é visível a qualquer um).
// Quem recebe: agentes ativos com papel admin ou atendente que permitiram os avisos no painel.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const igual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const recebido = req.headers.get('x-fila-aviso-segredo') ?? '';
  const { data: segredo } = await db.rpc('fila_aviso_segredo');
  if (!segredo || !igual(String(segredo), recebido)) return new Response('não autorizado', { status: 401 });

  let corpo: { conversa?: unknown; urgencia?: unknown; tipo?: unknown; quantidade?: unknown } = {};
  try { corpo = await req.json(); } catch { /* corpo inválido */ }
  const espera = corpo.tipo === 'espera';   // rotina do banco: paciente(s) esperando uma pessoa há mais de 10 min (não leva conversa)
  if (!espera && !UUID.test(String(corpo.conversa ?? ''))) return json({ erro: 'conversa inválida' }, 400);
  const alta = !espera && corpo.urgencia === 'alta';
  const qtd = Math.max(1, Math.min(99, Math.floor(Number(corpo.quantidade)) || 1));

  const privada = Deno.env.get('VAPID_PRIVADA');
  const { data: cfg } = await db.from('config').select('valor').eq('chave', 'fila_vapid_publica').maybeSingle();
  const publica = cfg?.valor;
  if (!publica || !privada) return json({ erro: 'VAPID não configurado' }, 500);
  webpush.setVapidDetails(Deno.env.get('VAPID_CONTATO') ?? 'https://clinicacsiia.github.io/webchat/', publica, privada);

  const { data: equipe, error: e1 } = await db.from('agentes').select('id').eq('ativo', true).in('papel', ['admin', 'atendente']);
  if (e1) return json({ erro: e1.message }, 500);
  const ids = (equipe ?? []).map((a: { id: string }) => a.id);
  if (!ids.length) return json({ aparelhos: 0, enviados: 0 });
  const { data: aparelhos, error: e2 } = await db.from('push_inscricao').select('id,endpoint,p256dh,auth').in('conta_id', ids);
  if (e2) return json({ erro: e2.message }, 500);

  const carga = JSON.stringify(espera
    ? { tipo: 'equipe', titulo: 'CSI · Paciente esperando', corpo: qtd > 1 ? `${qtd} pacientes esperam há mais de 10 minutos. Abra o painel.` : 'Um paciente espera há mais de 10 minutos. Abra o painel.' }
    : {
      tipo: 'equipe',
      titulo: alta ? 'CSI · Urgência: paciente aguardando' : 'CSI · Paciente aguardando',
      corpo: alta ? 'Um paciente precisa de atendimento com urgência. Abra o painel.' : 'Um paciente pediu atendimento. Abra o painel.',
    });
  let enviados = 0;
  for (const p of aparelhos ?? []) {
    try {
      await webpush.sendNotification({ endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, carga, { TTL: 1800, urgency: alta || espera ? 'high' : 'normal' });
      enviados++;
    } catch (e) {
      const st = (e as { statusCode?: number }).statusCode;
      if (st === 404 || st === 410) await db.from('push_inscricao').delete().eq('id', p.id);   // aparelho desinscrito
    }
  }
  return json({ aparelhos: aparelhos?.length ?? 0, enviados });
});
