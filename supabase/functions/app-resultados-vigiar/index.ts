// FLUXOGRAMA: entrada (POST do banco, pg_net, com x-klingo-segredo = segredo do cofre; a cada 10 min quando config.app_resultado_vigia = 'sim')
//   -> validação (segredo conferido pelo banco; KLINGO_APP_TOKEN presente; o banco só entrega exames FEITOS de pacientes com acesso rápido, sem resultado entregue, dos últimos 90 dias)
//   -> lógica (por prontuário: confere o nascimento no relatório A #14024 e lê o relatório C #14026 dos últimos 3 meses; "laudo pronto" = data ou Id do laudo preenchido, casado pelo Id do atendimento)
//   -> saída (o banco marca "disponivel" por app_resultado_disponivel; a resposta tem só contagens; nunca nome, CPF, telefone nem valor; nada vai para o log)
// Versão 1.0 — 15/11/2026 / Mudança: primeira versão. NUNCA foi provada com um laudo real: o relatório C só foi testado em estrutura e contagem.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { agrupar, hojeBrasilia, janela, laudosProntos, nascimentoConfere, REL, type Alvo, type Row } from "./mapa.ts";

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

async function ler(token: string, id: string, filtros: Record<string, string>): Promise<Row[]> {
  if (Object.keys(filtros).length === 0) throw new Error("consulta sem filtro");
  const res = await fetch(`${KLINGO_URL}?${new URLSearchParams({ id, ...filtros })}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Klingo HTTP ${res.status}`);
  const p = await res.json().catch(() => null);
  if (p?.error || p?.limit) throw new Error("Klingo recusou o relatório");
  if (p?.result === "") return [];
  if (!Array.isArray(p?.result?.data)) throw new Error("Formato inesperado");
  return p.result.data as Row[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await supabase.rpc("klingo_segredo_ok", { p_valor: req.headers.get("x-klingo-segredo") ?? "" });
  if (ok !== true) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const c = await req.json().catch(() => ({}));
  const limite = Math.min(Math.max(Number(c?.limite) || 30, 1), 60);
  const { data: lista, error } = await supabase.rpc("app_resultados_a_conferir", { p_limite: limite });
  if (error) return json({ ok: false, motivo: "banco" }, 500);
  const grupos = agrupar(Array.isArray(lista) ? (lista as Alvo[]) : []);
  const { de, ate } = janela(3, hojeBrasilia());
  const prontos: string[] = []; let consultas = 0, divergentes = 0, falhas = 0;
  for (const [, alvos] of grupos) {
    const { prontuario, nascimento } = alvos[0];
    try {
      consultas++;
      const a = await ler(token, REL.A, { ":parm0": prontuario });
      if (!nascimentoConfere(a, prontuario, nascimento)) { divergentes++; continue; }   // o exame não é desta pessoa: nunca marca
      const feitos = laudosProntos(await ler(token, REL.C, { ":parm0": prontuario, ":periodo1": "l", ":periodo1-from": de, ":periodo1-to": ate }));
      for (const x of alvos) if (feitos.has(x.atendimento)) prontos.push(x.id);
    } catch { falhas++; }   // sem detalhe no retorno: a próxima rodada tenta de novo (depois de 30 min)
  }
  let marcados = 0;
  if (prontos.length) { const { data: n } = await supabase.rpc("app_resultado_disponivel", { p_ids: prontos }); marcados = Number(n) || 0; }
  return json({ ok: true, conferidos: grupos.size, consultas, divergentes, falhas, disponiveis: marcados });
});
