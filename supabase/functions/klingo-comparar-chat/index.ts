// FLUXOGRAMA: entrada (POST com x-sync-key = config.ia_segredo e {"de","ate","ids":[marcações que o chat diz ter agendado]}) -> validação (chave; datas AAAA-MM-DD; só o relatório #14554) -> lógica (lê o relatório na memória, soma por origem/portal/status e cruza o Id da Marcação com a lista do chat) -> saída (SÓ contagens por categoria e Ids de marcação; nunca nome nem dado de paciente)
// Versão 1.1 — 13/11/2026 / Mudança: função temporária para auditar "Agendaram pelo chat" contra o relatório #14554 (apagar depois da auditoria). 1.1: devolve, por Id de marcação do chat achado, origem, status e dias até o exame
import { createClient } from "jsr:@supabase/supabase-js@2";

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const dataOk = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const soNum = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const cat = (v: unknown) => String(v ?? "(vazio)").trim().slice(0, 40) || "(vazio)";
const soma = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const dia = (v: unknown): string | null => { const t = String(v ?? "").trim(); const a = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (a) return `${a[1]}-${a[2]}-${a[3]}`; const b = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/); return b ? `${b[3]}-${b[2]}-${b[1]}` : null; };
const dias = (de: string | null, para: string | null) => (de && para ? Math.round((Date.parse(para) - Date.parse(de)) / 86_400_000) : null);
const topo = (m: Map<string, number>, n = 25) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([nome, n]) => ({ nome, n }));

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
  if (!seg?.valor || req.headers.get("x-sync-key") !== seg.valor) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const c = await req.json().catch(() => ({}));
  if (!dataOk(c?.de) || !dataOk(c?.ate)) return json({ error: "de/ate inválidos" }, 400);
  const chat = new Set<string>((Array.isArray(c?.ids) ? c.ids : []).map(soNum).filter(Boolean));
  const params = new URLSearchParams({ id: "14554", ":periodo0": "l", ":periodo0-from": c.de, ":periodo0-to": c.ate });
  try {
    const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(110_000) });
    const p = await res.json().catch(() => null);
    const r = p?.result;
    const rows: Record<string, unknown>[] = Array.isArray(r?.data) ? r.data : [];
    const porOrigem = new Map<string, number>(), porPortal = new Map<string, number>(), porStatus = new Map<string, number>(), porClass = new Map<string, number>(), porOP = new Map<string, number>();
    const achadas = new Map<string, number>(), achadasStatus = new Map<string, number>();
    const idsRelatorio = new Set<string>(); let achouIds = 0; const chatLinhas: Record<string, unknown>[] = []; const antec = new Map<string, number>();
    for (const x of rows) {
      const id = soNum(x.col0), origem = cat(x.col3), portal = cat(x.col4), status = cat(x.col11), cls = cat(x.col6);
      idsRelatorio.add(id);
      soma(porOrigem, origem); soma(porPortal, portal); soma(porStatus, status); soma(porClass, cls); soma(porOP, `${origem} | ${portal}`);
      const d = dias(dia(x.col1), dia(x.col2)); soma(antec, d == null ? "?" : d > 30 ? ">30" : "<=30");
      if (chat.has(id)) { achouIds++; chatLinhas.push({ id, origem, status, dias: d }); soma(achadas, `${origem} | ${portal}`); soma(achadasStatus, status); }
    }
    const naoAchadas = [...chat].filter((i) => !idsRelatorio.has(i));
    return json({
      http: res.status, error: p?.error ?? null, limit: p?.limit ?? null, linhas: rows.length,
      ids_do_chat_enviados: chat.size, ids_do_chat_no_relatorio: achouIds, ids_do_chat_fora_do_relatorio: naoAchadas.length, ids_fora: naoAchadas.slice(0, 60),
      por_origem: topo(porOrigem), por_portal: topo(porPortal), por_origem_e_portal: topo(porOP), por_status: topo(porStatus), por_classificacao: topo(porClass),
      antecedencia_relatorio: topo(antec), chat_linhas: chatLinhas, chat_por_origem_e_portal: topo(achadas), chat_por_status: topo(achadasStatus),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "erro" }, 502);
  }
});
