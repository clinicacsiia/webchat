// FLUXOGRAMA: entrada (o KLINGO chama esta URL quando uma marcação muda: cabeçalhos X-APP-TOKEN, X-DOMAIN, X-EVENT; corpo {id_marcacao, status, motivo, checkin, evento, nova}) -> validação (X-APP-TOKEN igual à chave da clínica,
//   comparação de tempo constante; interruptor config.klingo_webhook = sim; corpo válido) -> lógica (klingo_evento_aplicar: idempotente por hash do evento; cancelada -> pedido cancelado; remarcada -> pedido aponta para a marcação nova; check-in -> nota)
//   -> saída (200 sempre que o aviso foi entendido, para o Klingo não repetir; corpo inválido = 400 sem registrar o corpo)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (etapa 5: sincronização por aviso). PRONTA, mas só ganha efeito depois que o Klingo cadastrar esta URL e config.klingo_webhook = sim.
// O Klingo não manda id nem horário do evento nem assinatura: por isso a idempotência é por hash de (evento, marcação, status, check-in, marcação nova) e as rotinas de relatório continuam ligadas.
// Secret: KLINGO_APP_TOKEN. Nunca registra o corpo do aviso.
import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const igual = (a: string, b: string) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const token = Deno.env.get("KLINGO_APP_TOKEN") ?? "";
  const enviado = req.headers.get("x-app-token") ?? "";
  if (!token || !igual(enviado, token)) return json({ error: "Forbidden" }, 403);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: on } = await supabase.rpc("klingo_cfg", { p_chave: "klingo_webhook", p_padrao: "nao" });
  if (on !== "sim") return json({ ok: true, ignorado: true });
  const corpo = await req.json().catch(() => null) as Record<string, unknown> | null;
  const id = String(corpo?.id_marcacao ?? "");
  if (!corpo || !/^\d+$/.test(id)) return json({ error: "corpo inválido" }, 400);
  const ev = corpo.evento as { nome?: string } | string | undefined;
  const { data, error } = await supabase.rpc("klingo_evento_aplicar", { p: {
    evento: String(req.headers.get("x-event") ?? (typeof ev === "object" ? ev?.nome : ev) ?? ""), id_marcacao: id, status: String(corpo.status ?? ""),
    checkin: corpo.checkin == null ? null : String(corpo.checkin), nova: corpo.nova == null ? null : String(corpo.nova), motivo: null } });
  if (error) return json({ ok: false }, 500);
  return json({ ok: true, ...(data as Record<string, unknown>) });
});
