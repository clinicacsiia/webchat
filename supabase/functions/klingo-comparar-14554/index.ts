// FLUXOGRAMA: entrada (POST com x-sync-key = config.ia_segredo e {"filtros"?} ou {"modo":"comparar","de","ate"}) -> validação (só o relatório 14554) -> lógica (lê o relatório só na memória e cruza com jornada_exame/jornada_card/jornada_paciente) -> saída (SÓ totais, tabelas valor-do-Klingo -> valor-do-banco de campos que não são pessoais e números de marcação; nunca nome, CPF, telefone, e-mail ou nascimento)
// Versão 1.1 — 13/11/2026 / Mudança: função TEMPORÁRIA de conferência do relatório #14554. Apagar depois.
import { createClient } from "jsr:@supabase/supabase-js@2";

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const ID = "14554";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
type Row = Record<string, unknown>;
const txt = (v: unknown) => String(v ?? "").trim();
const norm = (v: unknown) => txt(v).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const chaveFone = async (f: unknown, seg: string) => { const d = txt(f).replace(/\D/g, ""); return d.length < 8 ? "" : sha(d.slice(-8) + seg); };
const dia = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date(ms));
function formato(s: string): string {
  if (!s) return "vazio";
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return "AAAA-MM-DD hh:mm";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "AAAA-MM-DD";
  if (/^\d{2}\/\d{2}\/\d{4}[ ]\d{2}:\d{2}/.test(s)) return "DD/MM/AAAA hh:mm";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return "DD/MM/AAAA";
  return "outro";
}
function parseSP(s: string): number | null {
  const a = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (a) return Date.parse(`${a[1]}-${a[2]}-${a[3]}T${a[4] ?? "00"}:${a[5] ?? "00"}:${a[6] ?? "00"}-03:00`);
  const b = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(s);
  if (b) return Date.parse(`${b[3]}-${b[2]}-${b[1]}T${b[4] ?? "00"}:${b[5] ?? "00"}:00-03:00`);
  return null;
}
const cont = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const topo = (m: Map<string, number>, n = 30) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n));
function difData(r: number | null, d: string | null): string {
  if (r == null) return "relatorio_sem_data";
  if (!d) return "banco_sem_data";
  const x = Date.parse(d), min = Math.round((r - x) / 60000);
  if (min === 0) return "igual";
  if (Math.abs(min) === 180) return "difere_exatos_3h_(fuso)";
  if (dia(r) === dia(x)) return "mesmo_dia_hora_diferente";
  return "dia_diferente";
}
async function emChunks<T, R>(itens: T[], n: number, f: (c: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < itens.length; i += n) out.push(...await f(itens.slice(i, i + n)));
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
  if (!seg?.valor || req.headers.get("x-sync-key") !== seg.valor) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const corpo = await req.json().catch(() => ({}));
  const params = new URLSearchParams({ id: ID });
  for (const [k, v] of Object.entries(corpo?.filtros ?? {})) if (/^:?[A-Za-z0-9_-]{1,40}$/.test(k)) params.set(k, String(v).slice(0, 40));
  const comparar = corpo?.modo === "comparar" && /^\d{4}-\d{2}-\d{2}$/.test(corpo?.de ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(corpo?.ate ?? "");
  if (comparar) { params.set(":periodo0", "l"); params.set(":periodo0-from", corpo.de); params.set(":periodo0-to", corpo.ate); }
  try {
    const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
    const p = await res.json().catch(() => null);
    const r = p?.result;
    if (!comparar) {
      const colunas = [...(Array.isArray(r?.group_cols) ? r.group_cols : []), ...(Array.isArray(r?.columns) ? r.columns : [])].map((c: Record<string, unknown>) => ({ nome: c?.name, titulo: c?.title }));
      const inputs = Array.isArray(p?.inputs) ? p.inputs.map((i: Record<string, unknown>) => ({ id: i?.id, name: i?.name, type: i?.type, operator: i?.operator, value: i?.value })) : null;
      return json({ http: res.status, error: p?.error ?? null, limit: p?.limit ?? null, linhas: Array.isArray(r?.data) ? r.data.length : (r === "" ? 0 : null), inputs, colunas });
    }
    if (p?.limit || !Array.isArray(r?.data)) return json({ error: "Klingo cortou ou devolveu formato inesperado", limit: p?.limit ?? null }, 502);
    const linhas = r.data as Row[];
    const segredo = seg.valor as string;

    // ---------- qualidade do próprio relatório (só contagens) ----------
    const q = { linhas: linhas.length, ids_vazios: 0, ids_repetidos: 0, cpf_vazio: 0, cpf_11_digitos: 0, cpf_outro_formato: 0, cpf_todo_igual_ou_zeros: 0,
      tel_vazio: 0, tel_menos_de_8_digitos: 0, tel_10_ou_11_digitos: 0, tel_outro: 0, email_vazio: 0, email_formato_valido: 0, email_formato_invalido: 0,
      nasc_vazio: 0, nasc_futuro_ou_antes_de_1900: 0, nome_vazio: 0, procedimento_vazio: 0, operadora_vazia: 0, unidade_vazia: 0 };
    const fmtEm = new Map<string, number>(), fmtPara = new Map<string, number>(), fmtNasc = new Map<string, number>();
    const statusL = new Map<string, number>(), origem = new Map<string, number>(), portal = new Map<string, number>(), classif = new Map<string, number>(), unidL = new Map<string, number>(), operL = new Map<string, number>();
    const porId = new Map<string, Row>();
    for (const x of linhas) {
      const id = txt(x.col0);
      if (!id) { q.ids_vazios++; continue; }
      if (porId.has(id)) q.ids_repetidos++;
      porId.set(id, x);
      cont(fmtEm, formato(txt(x.col1))); cont(fmtPara, formato(txt(x.col2))); cont(fmtNasc, formato(txt(x.col15)));
      cont(statusL, txt(x.col11) || "(vazio)"); cont(origem, txt(x.col3) || "(vazio)"); cont(portal, txt(x.col4) || "(vazio)"); cont(classif, txt(x.col6) || "(vazio)");
      cont(unidL, txt(x.col9) || "(vazio)"); cont(operL, /partic/i.test(txt(x.col8)) ? "Particular" : (txt(x.col8) ? "Convênio" : "(vazio)"));
      const cpf = txt(x.col12).replace(/\D/g, "");
      if (!txt(x.col12)) q.cpf_vazio++; else if (cpf.length === 11) { q.cpf_11_digitos++; if (/^(\d)\1{10}$/.test(cpf)) q.cpf_todo_igual_ou_zeros++; } else q.cpf_outro_formato++;
      const tel = txt(x.col13).replace(/\D/g, "");
      if (!tel) q.tel_vazio++; else if (tel.length < 8) q.tel_menos_de_8_digitos++; else if (tel.length === 10 || tel.length === 11) q.tel_10_ou_11_digitos++; else q.tel_outro++;
      const em = txt(x.col14);
      if (!em) q.email_vazio++; else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) q.email_formato_valido++; else q.email_formato_invalido++;
      const nasc = txt(x.col15);
      if (!nasc) q.nasc_vazio++; else { const t = parseSP(nasc); if (t == null || t > Date.now() || t < Date.parse("1900-01-01")) q.nasc_futuro_ou_antes_de_1900++; }
      if (!txt(x.col10)) q.nome_vazio++; if (!txt(x.col7)) q.procedimento_vazio++; if (!txt(x.col8)) q.operadora_vazia++; if (!txt(x.col9)) q.unidade_vazia++;
    }

    // ---------- cruzamento com o banco ----------
    const ids = [...porId.keys()].map((i) => "m" + i);
    const banco = await emChunks(ids, 150, async (c) => {
      const { data, error } = await supabase.from("jornada_exame").select("marcacao_id,card_id,procedimento,operadora,unidade,agendado_em,agendado_para,status,atualizado_em").in("marcacao_id", c);
      if (error) throw new Error("banco: " + error.message.slice(0, 100));
      return data ?? [];
    });
    const bId = new Map(banco.map((b) => [b.marcacao_id as string, b]));
    const iniJ = Date.parse(`${corpo.de}T00:00:00-03:00`), fimJ = Date.parse(`${corpo.ate}T00:00:00-03:00`) + 86_400_000;
    const { data: soBancoRaw, error: eB } = await supabase.from("jornada_exame").select("marcacao_id,agendado_para,status").gte("agendado_em", new Date(iniJ).toISOString()).lt("agendado_em", new Date(fimJ).toISOString()).limit(5000);
    if (eB) throw new Error("banco: " + eB.message.slice(0, 100));
    const idSet = new Set(ids);
    const soBanco = (soBancoRaw ?? []).filter((b) => !idSet.has(b.marcacao_id as string));

    const cardIds = [...new Set(banco.map((b) => b.card_id as number))];
    const cards = await emChunks(cardIds, 150, async (c) => (await supabase.from("jornada_card").select("id,paciente_chave").in("id", c)).data ?? []);
    const cardP = new Map(cards.map((c) => [c.id as number, c.paciente_chave as string]));
    const pront = [...new Set(cards.map((c) => c.paciente_chave as string))];
    const pacs = await emChunks(pront, 150, async (c) => (await supabase.from("jornada_paciente").select("prontuario,nome,fone_chave").in("prontuario", c)).data ?? []);
    const pacP = new Map(pacs.map((x) => [x.prontuario as string, x]));

    const hoje = dia(Date.now()), ontem2 = dia(Date.now() - 2 * 86_400_000), mais30 = dia(Date.now() + 30 * 86_400_000);
    const c = { no_relatorio: porId.size, no_banco: 0, so_relatorio: 0, so_relatorio_fora_janela_dos_cartoes: 0, so_relatorio_dentro_janela_dos_cartoes: 0, so_relatorio_passado_antes_da_janela: 0, so_relatorio_futuro_depois_da_janela: 0, so_banco_com_agendado_em_na_janela: soBanco.length };
    const dEm = new Map<string, number>(), dPara = new Map<string, number>(), cStatus = new Map<string, number>(), cUnid = new Map<string, number>();
    const cOper = { igual: 0, difere: 0, banco_vazio: 0 }, cProc = { igual: 0, difere: 0 };
    const cNome = { igual: 0, difere: 0, banco_sem_nome: 0, sem_paciente_no_banco: 0 }, cFone = { igual: 0, difere: 0, banco_sem_fone: 0, relatorio_sem_fone: 0, sem_paciente_no_banco: 0 };
    const am: Record<string, string[]> = { so_relatorio_dentro_janela: [], so_banco: [], dia_exame_diferente: [], cancelada_no_klingo_viva_no_banco: [] };
    const faltaStatus = new Map<string, number>(), faltaMes = new Map<string, number>(), faltaProc = new Map<string, number>();
    const push = (k: string, v: string) => { if (am[k].length < 12) am[k].push(v); };
    for (const [id, x] of porId) {
      const b = bId.get("m" + id);
      const para = parseSP(txt(x.col2)), diaPara = para != null ? dia(para) : "";
      if (!b) {
        c.so_relatorio++;
        if (diaPara && diaPara >= ontem2 && diaPara <= mais30) { c.so_relatorio_dentro_janela_dos_cartoes++; push("so_relatorio_dentro_janela", id); } else { c.so_relatorio_fora_janela_dos_cartoes++; if (diaPara && diaPara < ontem2) c.so_relatorio_passado_antes_da_janela++; else c.so_relatorio_futuro_depois_da_janela++; cont(faltaStatus, txt(x.col11) || "(vazio)"); cont(faltaMes, diaPara.slice(0, 7) || "(sem data)"); cont(faltaProc, /partic/i.test(txt(x.col8)) ? "Particular" : "Convênio"); }
        continue;
      }
      c.no_banco++;
      const e = difData(parseSP(txt(x.col1)), b.agendado_em as string | null), pa = difData(para, b.agendado_para as string | null);
      cont(dEm, e); cont(dPara, pa);
      if (pa === "dia_diferente") push("dia_exame_diferente", id);
      cont(cStatus, `${txt(x.col11) || "(vazio)"} → ${b.status}`);
      if (txt(x.col11) === "Cancelada" && !["cancelado", "remarcado", "atendido"].includes(b.status as string)) push("cancelada_no_klingo_viva_no_banco", `${id}:${b.status}:banco_atualizado_ha_${Math.round((Date.now() - Date.parse(b.atualizado_em as string)) / 60000)}min`);
      cont(cUnid, `${txt(x.col9) || "(vazio)"} → ${b.unidade ?? "(vazio)"}`);
      if (!b.operadora) cOper.banco_vazio++; else if (norm(x.col8) === norm(b.operadora)) cOper.igual++; else cOper.difere++;
      if (norm(x.col7) === norm(b.procedimento)) cProc.igual++; else cProc.difere++;
      const pc = pacP.get(cardP.get(b.card_id as number) ?? "");
      if (!pc) { cNome.sem_paciente_no_banco++; cFone.sem_paciente_no_banco++; continue; }
      if (!pc.nome) cNome.banco_sem_nome++; else if (norm(x.col10) === norm(pc.nome)) cNome.igual++; else cNome.difere++;
      const fr = await chaveFone(x.col13, segredo);
      if (!fr) cFone.relatorio_sem_fone++; else if (!pc.fone_chave) cFone.banco_sem_fone++; else if (fr === pc.fone_chave) cFone.igual++; else cFone.difere++;
    }
    for (const s of soBanco.slice(0, 12)) am.so_banco.push(String(s.marcacao_id));

    return json({
      janela_marcado_em: `${corpo.de}..${corpo.ate}`, hoje, janela_dos_cartoes: `${ontem2}..${mais30}`,
      qualidade_do_relatorio: q,
      formatos: { agendado_em: topo(fmtEm), agendado_para: topo(fmtPara), nascimento: topo(fmtNasc) },
      valores_do_relatorio: { status: topo(statusL), origem: topo(origem), portal: topo(portal), classificacao_responsavel: topo(classif), unidade: topo(unidL), plano: topo(operL) },
      cruzamento: c, agendado_em: topo(dEm), agendado_para: topo(dPara), operadora: cOper, procedimento: cProc, nome: cNome, telefone: cFone,
      status_klingo_para_banco: topo(cStatus, 40), unidade_klingo_para_banco: topo(cUnid, 40), so_relatorio_detalhe: { status: topo(faltaStatus), mes_do_exame: topo(faltaMes), plano: topo(faltaProc) }, amostra_marcacoes: am,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "erro" }, 502);
  }
});
