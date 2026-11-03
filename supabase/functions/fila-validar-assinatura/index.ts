// FLUXOGRAMA: entrada (o navegador do paciente envia {token, hash, pontos, consentimento}) -> validação (formato, tamanho, consentimento; origem do site) -> lógica (assinatura_contexto -> avaliação em TypeScript -> assinatura_registrar; repete uma vez se o perfil mudou no meio) -> saída (só {ok, aprovado, tentativas_restantes, bloqueado} ou {ok:false, erro}; nunca o score nem o perfil)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial (substitui o workflow "Fila - validar assinatura" e o nó Python do n8n)
//
// Pública (sem JWT do Supabase): quem prova quem é o token da fila, conferido DENTRO do banco. O banco é a autoridade final
// (limiar 0,30, 3 tentativas, hash do documento, perfil); aqui é só o cálculo. Nada do corpo vai para o log.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { resolver } from './avaliacao.ts';

const ORIGENS_PERMITIDAS = (Deno.env.get('FILA_ORIGENS') ?? 'https://clinicacsiia.github.io').split(',').map((s) => s.trim());
const cors = (origem: string | null) => ({
  'Access-Control-Allow-Origin': origem && ORIGENS_PERMITIDAS.includes(origem) ? origem : ORIGENS_PERMITIDAS[0],
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
});
const HASH = /^[0-9a-f]{64}$/;

Deno.serve(async (req) => {
  const origem = req.headers.get('origin');
  const cabecalhos = { ...cors(origem), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const responder = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: cabecalhos });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cabecalhos });
  if (req.method !== 'POST') return responder({ ok: false, erro: 'metodo' }, 405);
  if (origem && !ORIGENS_PERMITIDAS.includes(origem)) return responder({ ok: false, erro: 'origem' }, 403);

  let corpo: Record<string, unknown> = {};
  try { corpo = await req.json(); } catch { return responder({ ok: false, erro: 'pedido_invalido' }, 400); }
  const { token, hash, pontos, consentimento } = corpo;
  if (typeof token !== 'string' || token.length < 20 || token.length > 2000 || typeof hash !== 'string' || !HASH.test(hash)
      || !Array.isArray(pontos) || consentimento !== true) return responder({ ok: false, erro: 'pedido_invalido' }, 400);

  const url = Deno.env.get('SUPABASE_URL')!;
  const servico = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: segredoFila } = await servico.rpc('fila_segredo_vault', { p_nome: 'fila_segredo' });
  if (!segredoFila) return responder({ ok: false, erro: 'indisponivel' }, 500);
  const banco = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false }, global: { headers: { 'x-fila-segredo': String(segredoFila) } } });

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  const agente = req.headers.get('user-agent') ?? '';

  for (let tentativa = 0; tentativa < 2; tentativa++) {   // 2ª volta só se outro envio mudou o perfil no meio ("conflito"); não conta tentativa
    const { data: ctx, error: e1 } = await banco.rpc('assinatura_contexto', { p_token: token, p_hash: hash });
    if (e1) return responder({ ok: false, erro: 'indisponivel' }, 502);
    if (!ctx?.ok) return responder({ ok: false, erro: ctx?.erro ?? 'token_invalido' });

    const resultado = resolver({ consentimento: true, pontos, perfil: ctx.perfil, tentativas_falhas: ctx.tentativas_falhas });
    if (!resultado.ok) return responder({ ok: false, erro: resultado.erro });   // série inválida: não conta tentativa

    const { data: reg, error: e2 } = await banco.rpc('assinatura_registrar', {
      p_token: token, p_hash: hash, p_resultado: resultado, p_pontos: pontos, p_ip: ip, p_user_agent: agente,
    });
    if (e2) return responder({ ok: false, erro: 'indisponivel' }, 502);
    if (reg?.erro === 'conflito' && tentativa === 0) continue;
    if (!reg?.ok) return responder({ ok: false, erro: reg?.erro ?? 'recusado' });
    return responder(reg.aprovado
      ? { ok: true, aprovado: true }
      : { ok: true, aprovado: false, tentativas_restantes: reg.tentativas_restantes, bloqueado: reg.bloqueado });
  }
  return responder({ ok: false, erro: 'conflito' });
});
