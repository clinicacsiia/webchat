// FLUXOGRAMA: entrada (POST {alvos:[{pedido_id, conversa_id, de, ate, modo}]} com x-klingo-segredo; chamado pelo banco a cada 10 min por previsao_vigiar -> pg_net) -> validação (segredo conferido pelo banco; no máximo 12 alvos; modo nao/sombra/teste/sim já decidido pelo banco)
//   -> processamento (para cada solicitação ATIVA: dados do paciente em memória (nunca gravados aqui), plano traduzido, GET /agenda/horarios em janelas de 15 dias pela cota global, diagnosticar(); o cruzamento com as preferências é do banco)
//   -> persistência (klingo_consulta com modo "monitor"; disponibilidade_oportunidades_gravar cria no máximo UMA oportunidade nova e a notificação PENDENTE; disponibilidade_verificada guarda o resultado) -> saída (só contagens)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão (motor de solicitação de disponibilidade futura). Só LEITURA no Klingo: não reserva nem marca nada. Em modo sombra só conta.
// Secret: KLINGO_APP_TOKEN. Interruptores em config: previsao_monitor_modo (nao|sombra|teste|sim), notificacao_modo (quem recebe aviso é decidido pelo banco, não aqui).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi, KlingoErro } from "./klingo-api.ts";
import { diagnosticar, hojeBahia, horaBahia, pedidoDaApi, type DadosConversa, type Esp, type Oferta } from "./oferta.ts";
import { janelasDoPeriodo } from "./vigia.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ALVOS = 12, ORCAMENTO_MS = 100_000;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const t0 = Date.now();
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await supabase.rpc("klingo_segredo_ok", { p_valor: req.headers.get("x-klingo-segredo") ?? "" });
  if (ok !== true) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const c = await req.json().catch(() => ({}));
  const alvos = (Array.isArray(c?.alvos) ? c.alvos : []).filter((a: Record<string, unknown>) => UUID.test(String(a?.pedido_id)) && UUID.test(String(a?.conversa_id))).slice(0, MAX_ALVOS);
  const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
  const api = new KlingoApi(token, (u, i) => fetch(u, i), { antes: cotaGlobal(rpc, { maxTentativas: 4, maxEsperaMs: 2000 }), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); }, timeoutMs: 10_000, tentativas429: 0 });
  const { data: esps } = await supabase.from("klingo_especialidade").select("cbos, procedimentos").eq("liberada_api", true);
  const resumo: Record<string, number> = { vistos: 0, novas: 0, sem_vaga: 0, erros: 0, pulados: 0 };
  const hoje = hojeBahia();

  for (const a of alvos as Array<{ pedido_id: string; conversa_id: string; de: string; ate: string; modo: string }>) {
    if (Date.now() - t0 > ORCAMENTO_MS) { resumo.pulados++; continue; }
    const sombra = a.modo === "sombra";
    const reg = (resultado: string, x: { recebidos?: number; validos?: number; filtrados?: number; detalhe?: string } = {}, ctx: { tipo?: string | null; proc?: number | null; plano?: number | null } = {}) =>
      supabase.rpc("klingo_consulta_registrar", { p_conversa: a.conversa_id, p_modo: "monitor", p_tipo: ctx.tipo ?? null, p_procedimento: ctx.proc ?? null, p_plano: ctx.plano ?? null, p_resultado: resultado, p_http: null,
        p_recebidos: x.recebidos ?? null, p_validos: x.validos ?? null, p_filtrados: x.filtrados ?? null, p_gravados: null, p_ms: Date.now() - t0, p_detalhe: x.detalhe ?? null }).then(() => {}, () => {});
    const verificada = (r: string) => supabase.rpc("disponibilidade_verificada", { p_pedido: a.pedido_id, p_resultado: r }).then(() => {}, () => {});
    resumo.vistos++;
    try {
      const { data: d } = await supabase.rpc("klingo_dados_conversa", { p_conversa: a.conversa_id });
      const dados = d as DadosConversa | null;
      if (!dados || !dados.cpf || !dados.nascimento || !dados.plano) { await reg("dados_incompletos"); await verificada("dados_incompletos"); resumo.pulados++; continue; }
      const pedido = pedidoDaApi(dados, (esps ?? []) as Esp[]);
      if (!pedido) { await reg("fora_do_escopo", {}, { tipo: dados.tipo, proc: dados.procedimento }); await verificada("fora_do_escopo"); resumo.pulados++; continue; }
      const ident = dados.identidade;
      const { data: pl } = await supabase.rpc("klingo_plano_resolver", { p_operadora: dados.plano, p_plano_cadastro: ident?.situacao === "confere" ? ident.plano_id : null });
      const planoId = (pl as { plano_id?: number | null } | null)?.plano_id ?? null;
      const ctx = { tipo: dados.tipo, proc: dados.procedimento, plano: planoId };
      if (!planoId) { await reg("sem_traducao_plano", {}, ctx); await verificada("sem_traducao_plano"); resumo.pulados++; continue; }

      const ofertas: Oferta[] = []; let recebidos = 0, validos = 0, estruturaRuim = false;
      for (const j of janelasDoPeriodo(hoje, a.de, a.ate)) {
        const bruto = await api.horariosBruto({ ...pedido, plano: planoId, inicio: j.inicio, fim: j.fim, ...(dados.sexo ? { sexo: dados.sexo } : {}), nascimento: dados.nascimento });
        const dg = diagnosticar(bruto, hoje, horaBahia());
        if (dg.resultado === "estrutura_invalida") { estruturaRuim = true; break; }
        recebidos += dg.recebidos; validos += dg.validos; ofertas.push(...dg.ofertas);
      }
      if (estruturaRuim && !ofertas.length) { await reg("estrutura_invalida", {}, ctx); await verificada("estrutura_invalida"); resumo.erros++; continue; }
      const resultado = recebidos === 0 ? "api_sem_horarios" : ofertas.length === 0 ? "todos_filtrados" : "ok_com_horarios";
      await reg(resultado, { recebidos, validos, filtrados: Math.max(recebidos - ofertas.length, 0) }, ctx);
      const { data: g } = await supabase.rpc("disponibilidade_oportunidades_gravar", { p_pedido: a.pedido_id, p_ofertas: ofertas, p_sombra: sombra });
      await verificada(resultado);
      const r = (g ?? {}) as { novas?: number };
      if ((r.novas ?? 0) > 0) resumo.novas += r.novas ?? 0; else resumo.sem_vaga++;
    } catch (e) {
      const tipo = e instanceof KlingoErro ? e.tipo : "erro";
      console.error(`disponibilidade-vigia: ${e instanceof KlingoErro ? `${e.tipo} (HTTP ${e.status}) em ${e.caminho}` : `erro interno: ${(e as Error)?.name ?? "?"}`}`);   // nunca corpo, CPF ou nome
      await reg(tipo === "limite" ? "limite" : "erro_api", { detalhe: tipo });
      await verificada(tipo === "limite" ? "limite" : "erro_api");
      resumo.erros++;
      if (tipo === "limite") break;   // a API pediu calma: o resto fica para a próxima rodada
    }
  }
  return json({ ok: true, ...resumo, ms: Date.now() - t0 });
});
