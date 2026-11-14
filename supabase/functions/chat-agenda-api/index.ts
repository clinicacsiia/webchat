// FLUXOGRAMA: entrada (o chat chega ao passo do horário: POST {conversa, token, janela?}) -> validação (token da conversa; modo EFETIVO desta conversa vindo do banco: klingo_modo; 1 procedimento; convênio traduzido para plano do Klingo)
//   -> processamento (cota global; GET /agenda/horarios por 14 dias com sexo e nascimento; diagnosticar(): estrutura x quantidade x filtros; no modo sombra só mede) -> persistência (klingo_consulta guarda o resultado de CADA etapa; klingo_oferta só no modo teste/sim)
//   -> saída ({ok, modo, estado, ofertas}; nunca dado de paciente; sombra responde na hora e não devolve horário)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento Klingo, etapa 1: horários reais). Só LEITURA: não reserva nem marca nada.
// Versão 2.0 — 14/11/2026 / Mudança: (1) o modo vem de klingo_modo (o mestre klingo_auto NÃO transforma "sombra" em "sim": sombra só mede, não grava oferta visível e não responde horário); (2) HTTP 200 não é "ok":
//   resposta vazia, estrutura inesperada e "tudo filtrado" viram resultados distintos em klingo_consulta; (3) janela 0/1/2 soma mais 14 dias sem apagar o que já veio; (4) a mesma conversa não consulta duas vezes ao mesmo tempo.
//
// Nunca trava o chat: qualquer problema (limite de chamadas, Klingo lento ou fora, convênio sem tradução) devolve ok:false/estado e o chat NÃO mostra horário da grade (o banco só monta o calendário com oferta da API).
// Quem prova que pode pedir é o token da conversa, por isso a função é publicada SEM exigir JWT (igual à chat-agenda-ao-vivo).
// Secret: KLINGO_APP_TOKEN. Interruptores em config: klingo_auto (teto), klingo_api_horarios (nao|sombra|teste|sim), klingo_api_telefones_teste, klingo_api_percentual (ver supabase/webchat-v2-parte1-modos.sql).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi, KlingoErro } from "./klingo-api.ts";
import { diagnosticar, estadoDoResultado, hojeBahia, horaBahia, pedidoDaApi, resultadoDoMotivo, somaDias, type DadosConversa, type Esp } from "./oferta.ts";
import { identificar } from "./identificar.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JANELA_DIAS = 14;   // o Klingo recusa períodos maiores que 15 dias (403 "Período excedido. Máximo 15 dias.", provado em 12/11/2026)
const VALIDADE_CACHE_S = 45;
const EM_ANDAMENTO = new Map<string, number>();   // conversa -> quando começou (só impede duas consultas ao mesmo tempo na mesma instância)

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const t0 = Date.now();
  const c = await req.json().catch(() => ({}));
  const conversa = String(c?.conversa ?? ""), tokenConversa = String(c?.token ?? "");
  const janela = Math.min(Math.max(Number.isInteger(c?.janela) ? Number(c.janela) : 0, 0), 2);
  if (!UUID.test(conversa) || !tokenConversa || tokenConversa.length > 200) return json({ error: "Pedido inválido" }, 400);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error: eTok } = await supabase.rpc("chat_valida", { p_conversa: conversa, p_token: tokenConversa });
  if (eTok) return json({ error: "Conversa não encontrada" }, 403);

  // Modo EFETIVO desta conversa (nao | sombra | teste | sim). O banco decide; esta função só obedece.
  const modo = String((await supabase.rpc("klingo_modo", { p_conversa: conversa, p_chave: "klingo_api_horarios" })).data ?? "nao");
  if (modo !== "sombra" && modo !== "teste" && modo !== "sim") return json({ ok: false, estado: "nao_integrado", motivo: "desligado" });
  const sombra = modo === "sombra";

  // Registro de cada consulta (sem dado pessoal) e motivo que a equipe lê na conversa.
  const ctx: { tipo: string | null; proc: number | null; plano: number | null } = { tipo: null, proc: null, plano: null };
  const registrar = (resultado: string, x: { http?: number; recebidos?: number; validos?: number; filtrados?: number; gravados?: number; detalhe?: string } = {}) =>
    supabase.rpc("klingo_consulta_registrar", { p_conversa: conversa, p_modo: modo, p_tipo: ctx.tipo, p_procedimento: ctx.proc, p_plano: ctx.plano, p_resultado: resultado,
      p_http: x.http ?? null, p_recebidos: x.recebidos ?? null, p_validos: x.validos ?? null, p_filtrados: x.filtrados ?? null, p_gravados: x.gravados ?? null, p_ms: Date.now() - t0, p_detalhe: x.detalhe ?? null }).then(() => {}, () => {});
  const motivar = (motivo: string | null, detalhe?: string) => supabase.rpc("klingo_horarios_motivo", { p_conversa: conversa, p_motivo: motivo, p_detalhe: detalhe ?? null }).then(() => {}, () => {});
  const recusar = async (motivo: string, detalhe?: string) => {
    await motivar(motivo, detalhe); await registrar(resultadoDoMotivo(motivo), { detalhe: motivo + (detalhe ? `: ${detalhe}` : "") });
    return json({ ok: false, modo, estado: estadoDoResultado(resultadoDoMotivo(motivo)), motivo, ...(detalhe ? { detalhe } : {}) });
  };
  const tokenKlingo = Deno.env.get("KLINGO_APP_TOKEN");
  if (!tokenKlingo) return await recusar("sem_chave");
  if ((EM_ANDAMENTO.get(conversa) ?? 0) > Date.now() - 20_000) return json({ ok: true, modo, estado: "consultando", emAndamento: true });

  const trabalho = async (): Promise<Response> => {
    EM_ANDAMENTO.set(conversa, Date.now());
    try {
      const { data: d } = await supabase.rpc("klingo_dados_conversa", { p_conversa: conversa });
      const dados = d as DadosConversa | null;
      if (!dados) return await recusar("sem_pedido");
      ctx.tipo = dados.tipo; ctx.proc = dados.procedimento;
      const { data: esps } = await supabase.from("klingo_especialidade").select("cbos, procedimentos").eq("liberada_api", true);
      const pedido = pedidoDaApi(dados, (esps ?? []) as Esp[]);
      if (!pedido) return await recusar("fora_do_escopo");
      if (!dados.cpf || !dados.nascimento || !dados.plano) return await recusar("dados_incompletos");

      // Cache curto: o chat pede de novo quando a paciente volta de um passo; a mesma lista vale por 45 s (só para a janela inicial e para o mesmo tipo de modo).
      if (janela === 0) {
        const { data: ult } = await supabase.from("klingo_oferta").select("criado_em").eq("conversa_id", conversa).eq("sombra", sombra).order("criado_em", { ascending: false }).limit(1);
        if (ult?.[0] && Date.now() - Date.parse(ult[0].criado_em) < VALIDADE_CACHE_S * 1000) return json({ ok: true, modo, cache: true, ...(sombra ? {} : { estado: "com_horarios" }) });
      }

      const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
      const api = new KlingoApi(tokenKlingo, (u, i) => fetch(u, i), {
        antes: cotaGlobal(rpc, { maxTentativas: 3, maxEsperaMs: 1500 }), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); }, timeoutMs: 8000, tentativas429: 0,
      });

      // Identidade (CPF + nascimento conferidos na API): normalmente já veio do passo anterior; se não, confere agora.
      let ident = dados.identidade;
      if (!ident || ident.situacao === "erro") {
        const r = await identificar(api, dados.cpf, dados.nascimento);
        const { _plano_achado, _contatos_achados, ...limpo } = r;
        await supabase.rpc("klingo_identidade_registrar", { p_cpf: dados.cpf, p_nasc: dados.nascimento, p_r: limpo, p_conversa: conversa });
        ident = { situacao: r.situacao, klingo_id: r.klingo_id ?? null, plano_id: r.plano_id ?? null };
      }
      const { data: pl } = await supabase.rpc("klingo_plano_resolver", { p_operadora: dados.plano, p_plano_cadastro: ident?.situacao === "confere" ? ident.plano_id : null });
      const planoId = (pl as { plano_id?: number | null } | null)?.plano_id ?? null;
      ctx.plano = planoId;
      if (!planoId) return await recusar((pl as { motivo?: string } | null)?.motivo ?? "sem_traducao");

      const hoje = hojeBahia(), inicio = somaDias(hoje, janela * (JANELA_DIAS + 1));
      const bruto = await api.horariosBruto({
        ...pedido, plano: planoId, inicio, fim: somaDias(inicio, JANELA_DIAS),
        ...(dados.sexo ? { sexo: dados.sexo } : {}), nascimento: dados.nascimento,
      });
      const dg = diagnosticar(bruto, hoje, horaBahia());
      const proc = dg.ofertas.find((o) => o.procedimento)?.procedimento ?? dados.procedimento ?? 0;
      ctx.proc = dados.procedimento ?? proc;

      // Persistência: só quando há o que gravar; a falha de gravação é um resultado próprio (não vira "sem horário").
      let gravados = 0;
      if (dg.ofertas.length || janela === 0) {
        const { data: n, error: eGravar } = await supabase.rpc("klingo_oferta_gravar_v2", { p_conversa: conversa, p_procedimento: proc, p_plano: planoId, p_ofertas: dg.ofertas, p_sombra: sombra, p_substituir: janela === 0 });
        if (eGravar) { await registrar("erro_gravacao", { http: 200, recebidos: dg.recebidos, validos: dg.validos, filtrados: dg.filtrados, detalhe: "gravar_oferta" }); await motivar("indisponivel", "gravar_oferta"); return json({ ok: false, modo, estado: "indisponivel", motivo: "erro_gravacao" }); }
        gravados = Number(n ?? 0);
      }
      // exame: aprende sozinho se a API tem horário para ele (só conta quando a estrutura era válida)
      if (ctx.tipo === "exame" && dados.procedimento && dg.resultado !== "estrutura_invalida") {
        await supabase.from("klingo_proc_api").upsert({ procedimento_id: dados.procedimento, [dg.ofertas.length ? "com_horario_em" : "vazio_em"]: new Date().toISOString() }, { onConflict: "procedimento_id" });
      }
      if (sombra) await supabase.rpc("klingo_sombra_medir", { p_conversa: conversa });
      await registrar(dg.resultado, { http: 200, recebidos: dg.recebidos, validos: dg.validos, filtrados: dg.filtrados, gravados });
      if (dg.resultado === "ok_com_horarios") await motivar(null);
      else await motivar(dg.resultado === "estrutura_invalida" ? "indisponivel" : "api_sem_horario", dg.resultado === "estrutura_invalida" ? "estrutura_inesperada" : dg.resultado);
      return json(sombra ? { ok: true, modo, assincrono: true } : { ok: true, modo, estado: estadoDoResultado(dg.resultado), resultado: dg.resultado, ofertas: gravados, janela });
    } catch (e) {
      const tipo = e instanceof KlingoErro ? e.tipo : "erro";
      // Nunca engolir o erro em silêncio: o log guarda só status, caminho e tipo (nunca corpo, CPF ou nome) e a resposta devolve o motivo técnico.
      const detalhe = e instanceof KlingoErro ? `${e.tipo} (HTTP ${e.status}) em ${e.caminho}${e.resumo ? `: ${e.resumo}` : ""}` : `erro interno: ${(e as Error)?.name ?? "?"}`;
      console.error(`chat-agenda-api: ${detalhe}`);
      // 403 de plano/médico é regra de negócio, não falha técnica: não entra na conta de erros (que faz o sistema recuar sozinho) e a equipe é avisada do motivo.
      if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) {
        await supabase.rpc("klingo_medir", { p_tipo: "horarios_api_regra", p_n: 1, p_ms: null }).then(() => {}, () => {});
        return await recusar(e.tipo, e.resumo);
      }
      await registrar(tipo === "limite" ? "limite" : "erro_api", { http: e instanceof KlingoErro ? e.status : undefined, detalhe });
      await motivar(tipo === "limite" ? "limite" : "indisponivel", detalhe);
      return json({ ok: false, modo, estado: "indisponivel", motivo: tipo === "limite" ? "limite" : "indisponivel", detalhe });
    } finally {
      EM_ANDAMENTO.delete(conversa);
    }
  };
  if (sombra) {
    // Sombra: o paciente não espera e NADA do resultado volta para ele. A medição roda em segundo plano, depois da resposta.
    const er = (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
    if (er) { er.waitUntil(trabalho().catch(() => {})); return json({ ok: true, modo, assincrono: true }); }
  }
  return await trabalho();
});
