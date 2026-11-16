// FLUXOGRAMA: entrada (POST {"acao":"preco","plano":1,"ids":[630,645]} com x-klingo-segredo; chamado pelo banco, de forma assíncrona, quando o paciente escolhe Particular e na tela de confirmação) -> validação (segredo conferido pelo banco; até 20 ids de procedimento; um plano)
//   -> lógica (GET /preco?id_procedimento=&id_plano= da API do Klingo, SÓ LEITURA, pela cota global, 1 chamada por vez) -> saída (klingo_preco_gravar guarda exame, plano, valor e hora; resposta só tem contagens; nenhum dado de paciente)
// Versão 1.0 — 16/11/2026 / Mudança: nova (valor do atendimento Particular mostrado ao paciente antes de marcar). Valor vazio ou zero é gravado como "sem preço" e o chat manda para a equipe.
// Secret: KLINGO_APP_TOKEN.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { lerValor, limparIds } from "./preco.ts";

const BASE = "https://api-externa.klingo.app/api";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await supabase.rpc("klingo_segredo_ok", { p_valor: req.headers.get("x-klingo-segredo") ?? "" });
  if (ok !== true) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const c = await req.json().catch(() => ({}));
  if (c?.acao !== "preco") return json({ error: "acao inválida (use preco)" }, 400);
  const ids = limparIds(c?.ids);
  const plano = Number(c?.plano);
  if (!ids.length || !Number.isInteger(plano) || plano < 1) return json({ error: "ids e plano são obrigatórios" }, 400);

  const cota = async () => {
    for (let i = 0; i < 6; i++) {
      const { data } = await supabase.rpc("klingo_cota_pegar", { p_n: 1 });
      const d = (data ?? {}) as { ok?: boolean; espera_ms?: number };
      if (d.ok) return true;
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(d.espera_ms ?? 500), 50), 2000)));
    }
    return false;
  };

  const linhas: { id: number; plano: number; valor: number | null }[] = [];
  let falhas = 0;
  for (const id of ids) {
    if (!(await cota())) { falhas++; continue; }
    try {
      const r = await fetch(`${BASE}/preco?id_procedimento=${id}&id_plano=${plano}`, { headers: { "X-APP-TOKEN": token, Accept: "application/json" } });
      if (!r.ok) { falhas++; continue; }   // erro da API: não grava (o chat trata como "sem preço")
      linhas.push({ id, plano, valor: lerValor(await r.json().catch(() => null)) });
    } catch { falhas++; }
  }
  if (linhas.length) await supabase.rpc("klingo_preco_gravar", { p_linhas: linhas });
  return json({ ok: true, consultados: linhas.length, com_preco: linhas.filter((l) => l.valor !== null).length, falhas });
});
