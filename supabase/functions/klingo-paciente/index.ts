// FLUXOGRAMA: entrada (POST com x-sync-key = config.ia_segredo e {"acao","cpf"|"prontuario","nascimento",...}) -> validação (formato de CPF, prontuário, nascimento) -> lógica (lê os relatórios A/B/C do Klingo só na memória; histórico e resultados só saem depois de o nascimento conferir) -> saída (veredito ou lista enxuta; nunca nome, CPF, telefone, e-mail, valor ou observação; nada vai para o log)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial
import { createClient } from "jsr:@supabase/supabase-js@2";
import { conferir, cpfDigitos, cpfFormatos, hojeBrasilia, janela, marcacoes, nascimentoIso, prontuarioValido, REL, resultados, type Row } from "./mapa.ts";

// Ações: "conferir" {cpf, nascimento} | "historico" {prontuario, nascimento, meses?} | "resultados" {prontuario, nascimento, meses?}.
// Chamada pelo banco/n8n com a chave interna. Os relatórios do Klingo recusam consulta sem filtro; aqui nunca se chama sem filtro.

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function ler(token: string, id: string, filtros: Record<string, string>): Promise<Row[]> {
  if (Object.keys(filtros).length === 0) throw new Error("consulta sem filtro");
  const res = await fetch(`${KLINGO_URL}?${new URLSearchParams({ id, ...filtros })}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Klingo HTTP ${res.status} no relatório ${id}`);
  const p = await res.json().catch(() => null);
  if (p?.error) throw new Error(`Klingo recusou o relatório ${id}`);
  if (p?.limit) throw new Error(`Klingo cortou o relatório ${id}`);
  if (p?.result === "") return [];
  if (!Array.isArray(p?.result?.data)) throw new Error(`Formato inesperado no relatório ${id}`);
  return p.result.data as Row[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
  if (!seg?.valor || req.headers.get("x-sync-key") !== seg.valor) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);

  const c = await req.json().catch(() => ({}));
  const nasc = nascimentoIso(c?.nascimento);
  if (!nasc) return json({ error: "nascimento inválido (use AAAA-MM-DD)" }, 400);

  try {
    if (c?.acao === "conferir") {
      const cpf = cpfDigitos(c?.cpf);
      if (!cpf) return json({ error: "cpf inválido" }, 400);
      let linhas: Row[] = [];
      for (const f of cpfFormatos(cpf)) {   // o cadastro pode guardar com ou sem pontuação
        linhas = await ler(token, REL.A, { ":parm1": f });
        if (linhas.length) break;
      }
      return json({ ok: true, ...conferir(linhas, nasc, cpf) });
    }

    if (c?.acao === "historico" || c?.acao === "resultados") {
      const pront = prontuarioValido(c?.prontuario);
      if (!pront) return json({ error: "prontuario inválido" }, 400);
      // Antes de qualquer detalhe, o nascimento tem de bater com o cadastro daquele prontuário.
      const v = conferir(await ler(token, REL.A, { ":parm0": pront }), nasc);
      if (!v.encontrado || !v.confere) return json({ ok: true, encontrado: v.encontrado, confere: false });
      const { de, ate } = janela(c?.meses, hojeBrasilia());
      if (c.acao === "historico") {
        const l = await ler(token, REL.B, { ":parm0": pront, ":periodo2": "l", ":periodo2-from": de, ":periodo2-to": ate });
        return json({ ok: true, confere: true, janela: `${de}..${ate}`, marcacoes: marcacoes(l) });
      }
      const l = await ler(token, REL.C, { ":parm0": pront, ":periodo1": "l", ":periodo1-from": de, ":periodo1-to": ate });
      return json({ ok: true, confere: true, janela: `${de}..${ate}`, resultados: resultados(l) });
    }
    return json({ error: "acao desconhecida" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "erro" }, 502);   // mensagens não carregam dado de paciente
  }
});
