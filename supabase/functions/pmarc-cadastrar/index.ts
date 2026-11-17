// FLUXOGRAMA: entrada (POST do pg_cron, via pmarc_vigiar, com x-sync-key e {"modo":"rapido"|"completo"|"enriquecer","de","ate"}) -> validação (chave = config.ia_segredo; token KLINGO_APP_TOKEN; só trabalha se `previsao_marcacao_modo` = sim)
//   -> lógica (lê o #14359 por data do exame e/ou o #14554 por data de marcação, divide a faixa se o Klingo cortar, manda lotes enxutos para pmarc_lote e pmarc_enriquecer_lote)
//   -> saída (resumo SÓ com contagens; nada de paciente no log nem na resposta; o resultado vai para pmarc_estado) | ROLLBACK: apagar a função e/ou `update public.config set valor='nao' where chave='previsao_marcacao_modo'`
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (Webchat de Previsão de marcação: registrar todo mundo que tem marcação).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emLotes, hojeBrasilia, janelas, layoutPorTitulos, modoValido, prepararCadastro, prepararEnriquecer, somaDias, type Coluna, type Row } from "./mapa.ts";

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const TAMANHO_LOTE = 400;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// O relatório numa faixa de datas (campo = id do filtro de período). Se o Klingo cortar por limite de linhas, divide a faixa ao meio e junta.
async function ler(token: string, id: string, campo: string, de: string, ate: string, meta: { colunas?: Coluna[] }, nivel = 0): Promise<Row[]> {
  const params = new URLSearchParams({ id, [`:${campo}`]: "l", [`:${campo}-from`]: de, [`:${campo}-to`]: ate });
  const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status} no relatório ${id}`);
  const payload = await res.json();
  if (payload?.error) throw new Error(`Klingo retornou erro no relatório ${id}`);
  if (payload?.limit) {
    if (de >= ate || nivel >= 6) throw new Error(`O Klingo cortou o relatório ${id} mesmo em faixa curta`);
    const meio = new Date((Date.parse(`${de}T00:00:00Z`) + Date.parse(`${ate}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
    return [...await ler(token, id, campo, de, meio, meta, nivel + 1), ...await ler(token, id, campo, somaDias(meio, 1), ate, meta, nivel + 1)];
  }
  if (payload?.result === "") return [];
  const dados = payload?.result?.data;
  if (!Array.isArray(dados)) throw new Error(`Formato inesperado no relatório ${id}`);
  if (!meta.colunas) {
    const cols = [...(Array.isArray(payload?.result?.group_cols) ? payload.result.group_cols : []), ...(Array.isArray(payload?.result?.columns) ? payload.result.columns : [])];
    if (cols.length) meta.colunas = cols as Coluna[];
  }
  return dados as Row[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: cfg } = await supabase.from("config").select("chave, valor").in("chave", ["ia_segredo"]);
  const sal = (cfg ?? []).find((c: { chave: string }) => c.chave === "ia_segredo")?.valor as string | undefined;
  if (!sal || req.headers.get("x-sync-key") !== sal) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);

  const corpo = await req.json().catch(() => ({}));
  const modo = modoValido(corpo?.modo);
  const inicio = Date.now();

  // Desligado: nem chama o Klingo (o banco responde `ligada:false` a um lote vazio).
  const teste = await supabase.rpc("pmarc_lote", { p_linhas: [] });
  if (teste.error) return json({ error: `O banco recusou (${teste.error.code ?? "sem código"})` }, 502);
  if (!(teste.data as { ligada?: boolean })?.ligada) return json({ ok: true, ligada: false });

  const hoje = hojeBrasilia();
  const { exame, feitas } = janelas(modo, hoje, corpo);
  const resumo: Record<string, unknown> = { modo };
  try {
    if (exame) {
      const meta: { colunas?: Coluna[] } = {};
      const brutas = await ler(token, "14359", "periodo0", exame.de, exame.ate, meta);
      const { layout, faltando, por } = layoutPorTitulos(meta.colunas);
      if (faltando.length) throw new Error(`O #14359 perdeu coluna(s): ${faltando.join(", ")}`);
      const { linhas, descartadas, semProntuario } = await prepararCadastro(brutas, layout, sal);
      let novas = 0, alteradas = 0;
      for (const lote of emLotes(linhas, TAMANHO_LOTE)) {
        const { data, error } = await supabase.rpc("pmarc_lote", { p_linhas: lote });
        if (error) throw new Error(`O banco recusou um lote (${error.code ?? "sem código"}): ${error.message.slice(0, 120)}`);
        novas += (data as { novas?: number })?.novas ?? 0; alteradas += (data as { alteradas?: number })?.alteradas ?? 0;
      }
      Object.assign(resumo, { janela_exame: `${exame.de}..${exame.ate}`, linhas_14359: brutas.length, pessoas: linhas.length, descartadas, sem_prontuario: semProntuario, novas, alteradas, colunas_por: por });
    }
    if (feitas) {
      let brutas: Row[];
      try { brutas = await ler(token, "14554", "periodo0", feitas.de, feitas.ate, {}); }
      catch (e) {
        // O Klingo às vezes recusa período que termina hoje: tenta até ontem.
        if (feitas.ate === hoje && feitas.ate > feitas.de) brutas = await ler(token, "14554", "periodo0", feitas.de, somaDias(hoje, -1), {}); else throw e;
      }
      const { linhas, descartadas } = prepararEnriquecer(brutas);
      let achadas = 0, alt = 0;
      for (const lote of emLotes(linhas, TAMANHO_LOTE)) {
        const { data, error } = await supabase.rpc("pmarc_enriquecer_lote", { p_linhas: lote });
        if (error) throw new Error(`O banco recusou um lote do #14554 (${error.code ?? "sem código"}): ${error.message.slice(0, 120)}`);
        achadas += (data as { achadas?: number })?.achadas ?? 0; alt += (data as { alteradas?: number })?.alteradas ?? 0;
      }
      Object.assign(resumo, { janela_feitas: `${feitas.de}..${feitas.ate}`, linhas_14554: brutas.length, descartadas_14554: descartadas, pessoas_achadas: achadas, pessoas_completadas: alt });
    }
    resumo.leitura_ms = Date.now() - inicio;
    await supabase.rpc("pmarc_estado_gravar", { p_modo: modo, p_resultado: resumo, p_erro: null });
    return json({ ok: true, ligada: true, ...resumo });
  } catch (e) {
    const erro = e instanceof Error ? e.message.slice(0, 250) : "erro desconhecido";
    await supabase.rpc("pmarc_estado_gravar", { p_modo: modo, p_resultado: null, p_erro: erro });
    return json({ error: erro }, 502);
  }
});
