// FLUXOGRAMA: entrada (POST com x-klingo-segredo = segredo do cofre do banco; chamado pelo banco via pg_net e pela rotina de revisão) -> validação (segredo conferido pelo banco; CPF e nascimento válidos)
//   -> lógica (GET /paciente/cpf pela cota global; confere o nascimento; só aceita id definitivo "P…"; grava SÓ hash + id + situação por klingo_identidade_registrar)
//   -> saída (contagens; nunca nome, CPF, telefone ou corpo de erro do Klingo; nada vai para o log)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento Klingo, passo "cpf_nasc" e revisão dos pacientes antigos).
//
// Ações:
//   {"acao":"conferir","cpf":"…","nascimento":"AAAA-MM-DD","conversa":"<uuid opcional>"}   -> {"ok":true,"situacao":"confere|divergente|nao_encontrado|sem_id_definitivo|erro"}
//   {"acao":"revisar","limite":20}   -> confere em lote quem já deixou CPF + nascimento e ainda não foi conferido: {"ok":true,"processados":n,"por_situacao":{…},"restantes":n}
// Secret: KLINGO_APP_TOKEN (o mesmo dos relatórios).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, cpfDigitos, dataIso, KlingoApi } from "./klingo-api.ts";
import { identificar } from "./identificar.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await supabase.rpc("klingo_segredo_ok", { p_valor: req.headers.get("x-klingo-segredo") ?? "" });
  if (ok !== true) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const c = await req.json().catch(() => ({}));
  const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
  const api = new KlingoApi(token, (u, i) => fetch(u, i), { antes: cotaGlobal(rpc), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); } });
  try {
    if (c?.acao === "conferir") {
      const cpf = cpfDigitos(c?.cpf), nasc = dataIso(c?.nascimento);
      if (!cpf || !nasc) return json({ error: "cpf e nascimento (AAAA-MM-DD) são obrigatórios" }, 400);
      const conversa = typeof c?.conversa === "string" && /^[0-9a-f-]{36}$/.test(c.conversa) ? c.conversa : null;
      const r = await identificar(api, cpf, nasc);
      const { _plano_achado, _contatos_achados, ...limpo } = r;
      const { error } = await supabase.rpc("klingo_identidade_registrar", { p_cpf: cpf, p_nasc: nasc, p_r: limpo, p_conversa: conversa });
      if (error) return json({ ok: false, motivo: "gravar" }, 500);
      return json({ ok: true, situacao: r.situacao });
    }
    if (c?.acao === "revisar") {
      const limite = Math.min(Math.max(Number(c?.limite) || 20, 1), 40);
      const t0 = Date.now();
      const { data: lista } = await supabase.rpc("klingo_revisao_pendentes", { p_limite: limite });
      const por: Record<string, number> = {}; let n = 0, comPlano = 0, comContatos = 0;
      for (const p of (Array.isArray(lista) ? lista : []) as Array<{ cpf: string; nascimento: string }>) {
        if (Date.now() - t0 > 100_000) break;
        const r = await identificar(api, p.cpf, p.nascimento);
        // o erro também é gravado: a nova tentativa só vem depois de 30 minutos
        if (r._plano_achado) comPlano++;
        if (r._contatos_achados) comContatos++;
        const { _plano_achado, _contatos_achados, ...limpo } = r;
        const { error } = await supabase.rpc("klingo_identidade_registrar", { p_cpf: p.cpf, p_nasc: p.nascimento, p_r: limpo, p_conversa: null });
        por[error ? "falha_ao_gravar" : r.situacao] = (por[error ? "falha_ao_gravar" : r.situacao] ?? 0) + 1; n++;
      }
      const { data: resto } = await supabase.rpc("klingo_revisao_pendentes", { p_limite: 100 });
      return json({ ok: true, processados: n, por_situacao: por, com_plano_no_cadastro: comPlano, com_contatos_no_cadastro: comContatos, restantes: Array.isArray(resto) ? resto.length : null, ms: Date.now() - t0 });
    }
    return json({ error: "acao inválida (use conferir ou revisar)" }, 400);
  } catch {
    return json({ ok: false, motivo: "erro" }, 500);
  }
});
