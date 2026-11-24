// FLUXOGRAMA: entrada (POST {consulta: id do procedimento, pagador: "Particular" | operadora, janela?: 0..2} vindo do site da clínica) -> validação (origem, formato, limite por IP)
//   -> processamento (consulta -> CBOS da especialidade liberada na API; pagador -> plano do Klingo; GET /agenda/horarios SÓ LEITURA; sem dado de paciente) -> persistência (NENHUMA: não grava no banco)
//   -> saída ({ok, estado, horarios: [{data, hora, profissional, unidade}]}; nunca corpo de erro do Klingo)
// Versão 1.1 — 24/11/2026 (revisão): 403 do Klingo só vira "sem horário" se o texto indicar falta de médico credenciado; limite de horários 600→1500 com aviso `truncado`; devolve `profissionalId`; IP do cliente não forjável; caches com teto; "sem_plano" também em cache.
// Versão 1.0 — 24/11/2026 / Mudança: função NOVA, só de leitura, para o ambiente de testes (/painel/testedowebchat/) mostrar os horários reais do Klingo sem abrir conversa no banco.
//   Não marca, não reserva, não grava, não usa cota global (que grava no banco): protege o Klingo com limite por IP (20/min), cache de 60 s e janela de 14 dias.
// Secret: KLINGO_APP_TOKEN (a mesma das outras funções). Publicada SEM exigir JWT (a chave pública do site não é JWT); a origem é conferida.
import { createClient } from "jsr:@supabase/supabase-js@2";

const KLINGO = "https://api-externa.klingo.app/api";
const ORIGENS = ["https://clinicacsiia.github.io"];
const JANELA_DIAS = 14;           // o Klingo recusa períodos maiores que 15 dias
const LIMITE_POR_MIN = 20, CACHE_S = 60, MAX_HORARIOS = 1500, MAX_CACHE = 500;
const hojeBahia = () => new Date().toLocaleString("sv-SE", { timeZone: "America/Bahia" }).slice(0, 10);
const horaBahia = () => new Date().toLocaleString("sv-SE", { timeZone: "America/Bahia" }).slice(11, 16);
const somaDias = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const texto = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

const clienteIp = (req: Request) => {   // o cliente pode escrever o começo de x-forwarded-for; vale o IP que a plataforma informa ou o ÚLTIMO item
  const direto = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip");
  if (direto) return direto.trim();
  const xs = (req.headers.get("x-forwarded-for") ?? "?").split(",");
  return xs[xs.length - 1].trim();
};
const podar = <V>(m: Map<string, V>, max: number) => { if (m.size > max) m.clear(); };   // evita crescer sem limite na instância
const porIp = new Map<string, number[]>();
const cache = new Map<string, { t: number; corpo: unknown }>();

const cors = (origem: string | null) => ({
  "Access-Control-Allow-Origin": origem && ORIGENS.includes(origem) ? origem : ORIGENS[0], "Vary": "Origin",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS",
});

Deno.serve(async (req: Request) => {
  const origem = req.headers.get("origin");
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors(origem), "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origem) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!origem || !ORIGENS.includes(origem)) return json({ error: "Origem não permitida" }, 403);

  // Limite por IP (memória da instância): protege a cota do Klingo, compartilhada com o chat real.
  const ip = clienteIp(req), agora = Date.now();
  const marcas = (porIp.get(ip) ?? []).filter((t) => t > agora - 60_000);
  if (marcas.length >= LIMITE_POR_MIN) return json({ ok: false, estado: "limite", motivo: "muitas_consultas" }, 429);
  marcas.push(agora); podar(porIp, 5000); porIp.set(ip, marcas);

  const c = await req.json().catch(() => ({}));
  const consulta = Number(c?.consulta), pagador = String(c?.pagador ?? "").trim().slice(0, 80);
  const janela = Math.min(Math.max(Number.isInteger(c?.janela) ? Number(c.janela) : 0, 0), 2);
  if (!Number.isInteger(consulta) || consulta <= 0 || !pagador || /[\r\n]/.test(pagador)) return json({ error: "Pedido inválido" }, 400);

  const chaveCache = `${consulta}|${pagador.toLowerCase()}|${janela}|${c?.semFiltro === true ? "sf" : ""}`, c0 = cache.get(chaveCache);
  if (c0 && agora - c0.t < CACHE_S * 1000) return json({ ...(c0.corpo as object), cache: true });

  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ ok: false, estado: "indisponivel", motivo: "sem_chave" });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);   // SÓ leitura abaixo (select e função STABLE)

  // 1) consulta -> especialidade liberada na API (hoje: pediatria, neurologia, radiologia). As demais são da equipe.
  const { data: esps } = await sb.from("klingo_especialidade").select("cbos, procedimentos").eq("liberada_api", true);
  const esp = (esps ?? []).find((e: { cbos: string; procedimentos: number[] }) => e.procedimentos.includes(consulta));
  if (!esp) { const r = { ok: true, estado: "fora_do_escopo", motivo: "A API do Klingo não oferece horários desta consulta; só a equipe agenda.", horarios: [] }; podar(cache, MAX_CACHE); cache.set(chaveCache, { t: agora, corpo: r }); return json(r); }

  // 2) pagador -> plano do Klingo (mesma tradução do chat)
  const { data: pl } = await sb.rpc("klingo_plano_resolver", { p_operadora: pagador });
  const planoId = (pl as { plano_id?: number | null } | null)?.plano_id ?? null;
  if (!planoId) { const r = { ok: true, estado: "sem_plano", motivo: (pl as { motivo?: string } | null)?.motivo ?? "sem_traducao", horarios: [] }; podar(cache, MAX_CACHE); cache.set(chaveCache, { t: agora, corpo: r }); return json(r); }

  // 3) horários reais (GET /agenda/horarios)
  const inicio = somaDias(hojeBahia(), janela * (JANELA_DIAS + 1)), fim = somaDias(inicio, JANELA_DIAS);
  const q = new URLSearchParams({ especialidade: esp.cbos, plano: String(planoId), inicio, fim });
  let res: Response;
  try { res = await fetch(`${KLINGO}/agenda/horarios?${q}`, { headers: { "X-APP-TOKEN": token, Accept: "application/json" }, signal: AbortSignal.timeout(9000) }); }
  catch { return json({ ok: false, estado: "indisponivel", motivo: "klingo_fora" }); }
  const t = await res.text().catch(() => "");
  if (res.status === 429) return json({ ok: false, estado: "limite", motivo: "klingo_limite" });
  if (res.status === 403) {   // só é regra de negócio (nenhum médico credenciado para o convênio) quando o texto diz isso; senão pode ser token/permissão e NÃO vira "sem horário"
    if (!/credenciado|m[eé]dico/i.test(t)) return json({ ok: false, estado: "indisponivel", motivo: "klingo_recusou", status: 403 });
    const r = { ok: true, estado: "sem_horarios", motivo: "sem_medico_credenciado", horarios: [], inicio, fim };
    podar(cache, MAX_CACHE); cache.set(chaveCache, { t: agora, corpo: r }); return json(r);
  }
  if (!res.ok) return json({ ok: false, estado: "indisponivel", motivo: "klingo_recusou", status: res.status });
  let bruto: { horarios?: unknown } | null = null;
  try { bruto = JSON.parse(t); } catch { return json({ ok: false, estado: "indisponivel", motivo: "resposta_invalida" }); }
  const dias = bruto?.horarios;
  if (!Array.isArray(dias)) return json({ ok: false, estado: "indisponivel", motivo: "estrutura_inesperada" });

  const hoje = hojeBahia(), hora = horaBahia(), out: Array<Record<string, unknown>> = [], vistos = new Set<string>();
  const porProc: Record<string, number> = {}, semFiltro = c?.semFiltro === true;
  for (const d of dias as Record<string, unknown>[]) {
    const prof = d.profissional as Record<string, unknown> | undefined, uni = d.unidade as Record<string, unknown> | undefined;
    const proc = texto(d.procedimento);
    const nHoras = Array.isArray(d.horarios) ? d.horarios.length : d.horarios && typeof d.horarios === "object" ? Object.keys(d.horarios as object).length : 0;
    porProc[proc ?? "?"] = (porProc[proc ?? "?"] ?? 0) + nHoras;   // resumo (sem dado pessoal): quantos horários a API mandou por procedimento
    if (!semFiltro && proc && Number(proc) !== consulta) continue;   // a API devolve vários procedimentos da especialidade; fica o da consulta escolhida
    const data = String(d.data ?? ""), lista = d.horarios;
    const horas: string[] = [];
    if (Array.isArray(lista)) for (const h of lista) { const s = typeof h === "string" ? h : String((h as Record<string, unknown>)?.hora ?? (h as Record<string, unknown>)?.horario ?? ""); if (/^\d{2}:\d{2}/.test(s)) horas.push(s.slice(0, 5)); }
    else if (lista && typeof lista === "object") for (const [k, v] of Object.entries(lista as Record<string, unknown>)) { const s = typeof v === "string" && /^\d{2}:\d{2}/.test(v) ? v : /^\d{2}:\d{2}/.test(k) ? k : ""; if (s) horas.push(s.slice(0, 5)); }
    for (const h of horas) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data < hoje || (data === hoje && h <= hora)) continue;
      const chave = `${data}|${h}|${texto(prof?.id)}|${texto(uni?.id)}`;
      if (vistos.has(chave)) continue; vistos.add(chave);
      out.push({ data, hora: h, profissional: texto(prof?.nome), profissionalId: texto(prof?.id), unidade: texto(uni?.nome) ?? texto(uni?.sigla), ordemChegada: d.ordem_chegada === true });
    }
  }
  out.sort((a, b) => (String(a.data) + String(a.hora)).localeCompare(String(b.data) + String(b.hora)));
  const r = { ok: true, estado: out.length ? "com_horarios" : "sem_horarios", fonte: "klingo_api", procedimentos: porProc, consultadoEm: new Date().toISOString(), inicio, fim, total: out.length, truncado: out.length > MAX_HORARIOS, horarios: out.slice(0, MAX_HORARIOS) };
  podar(cache, MAX_CACHE); cache.set(chaveCache, { t: agora, corpo: r });
  return json(r);
});
