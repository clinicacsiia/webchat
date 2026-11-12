// FLUXOGRAMA: entrada (POST {operacao_id} com x-klingo-segredo = segredo do cofre do banco; só o banco chama, via pg_net) -> validação (segredo conferido pelo banco; a operação precisa estar "pendente": só um executor pega)
//   -> lógica (executor.ts: identidade na API -> plano -> sessão conferida -> horário ainda existe -> reservar -> marcar com id_externo; incerto é reconciliado por GET /vouchers)
//   -> saída (klingo_operacao_concluir grava estado, voucher e código interno; o chat avisa o paciente; resposta HTTP só diz o estado)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento Klingo, etapas 2 e 3: marcar para quem tem cadastro e para paciente novo).
//
// REGRA CENTRAL: esta função NÃO recebe CPF, nascimento, horário, procedimento nem plano de ninguém de fora. Recebe só o id de uma operação já aprovada
// pelo banco (klingo_pode_marcar) e lê o resto de lá. Não há modo diagnóstico e o segredo NÃO é o x-sync-key (é um segredo próprio do cofre).
// Nunca registra nome, CPF, telefone nem o corpo de erro do Klingo. Secret: KLINGO_APP_TOKEN.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi } from "./klingo-api.ts";
import { executar, type Esp, type Pegar } from "./executor.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await supabase.rpc("klingo_segredo_ok", { p_valor: req.headers.get("x-klingo-segredo") ?? "" });
  if (ok !== true) return json({ error: "Forbidden" }, 403);
  const c = await req.json().catch(() => ({}));
  const opId = String(c?.operacao_id ?? "");
  if (!UUID.test(opId)) return json({ error: "operacao_id inválido" }, 400);

  const { data: pegar } = await supabase.rpc("klingo_operacao_pegar", { p_op: opId });
  if (!(pegar as { ok?: boolean } | null)?.ok) return json({ ok: false, motivo: (pegar as { motivo?: string } | null)?.motivo ?? "indisponivel" });
  const concluir = (estado: string, r: Record<string, unknown>) => supabase.rpc("klingo_operacao_concluir", { p_op: opId, p_estado: estado, p_r: r });

  const tokenKlingo = Deno.env.get("KLINGO_APP_TOKEN");
  if (!tokenKlingo) { await concluir("falha", { codigo: "sem_chave" }); return json({ ok: false, motivo: "sem_chave" }, 500); }
  try {
    const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
    const api = new KlingoApi(tokenKlingo, (u, i) => fetch(u, i), { antes: cotaGlobal(rpc, { maxTentativas: 10, maxEsperaMs: 3000 }), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); }, tentativas429: 2 });
    const { data: esps } = await supabase.from("klingo_especialidade").select("cbos, procedimentos");
    const r = await executar(api, rpc, pegar as unknown as Pegar, (esps ?? []) as Esp[]);
    await concluir(r.estado, { voucher: r.voucher ?? null, codigo: r.codigo ?? null, http_status: r.http_status ?? null, caminho: r.caminho ?? null });
    return json({ ok: true, estado: r.estado });
  } catch {
    await concluir("incerto", { codigo: "erro_no_executor" });   // se algo escapou, o seguro é a equipe conferir antes de marcar de novo
    return json({ ok: false, motivo: "erro" }, 500);
  }
});
