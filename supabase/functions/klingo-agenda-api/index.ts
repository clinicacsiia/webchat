// FLUXOGRAMA: entrada (POST com x-sync-key = config.ia_segredo e {"acao": "versao" | "horarios", ...}) -> validação (chave, formato de datas, janela de até 31 dias) -> lógica (SÓ LEITURA da API do Klingo) -> saída (horários enxutos; nunca nome, CPF, telefone ou corpo de erro do Klingo; nada vai para o log)
// Versão 0.4 — 12/11/2026 / Mudança: SEM ESCRITA. As ações "marcar" e "marcar_pre" foram removidas (responde 410): marcar agora só acontece pela função klingo-executar, que recebe apenas o id de uma operação aprovada pelo banco e usa um segredo próprio do cofre.
//   Motivo (planejamento 12/11/2026, item J-01): o x-sync-key é um segredo único e antigo (ficou escrito num fluxo arquivado do n8n); com ele esta função marcava consulta para qualquer CPF.
// 0.3: marcar_pre (paciente novo). 0.2: agendamento pela API externa do Klingo, publicada para TESTE. 0.2: o id de login vem do Klingo já com "P" e a sessão é conferida antes de reservar ou marcar.
//
// Ações:
//   {"acao":"versao"}                                                      -> {"ok":true,"api":"OK [API1]"}
//   {"acao":"horarios","especialidade":"225265"|"exame":"123","inicio":"2026-11-16","fim":"2026-11-20","cnes":"…","crm":"…","plano":1}
//   {"acao":"marcar"|"marcar_pre"}                                         -> 410 (use o chat; a marcação é feita pela klingo-executar)
// Secret: KLINGO_APP_TOKEN (a mesma dos relatórios).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { dataIso, KlingoApi, KlingoErro } from "./api.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const MAX_DIAS = 31;

const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const soTexto = (v: unknown, max = 80): string | null => { const s = String(v ?? "").trim(); return s && s.length <= max && !/[\r\n]/.test(s) ? s : null; };

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
  if (!seg?.valor || req.headers.get("x-sync-key") !== seg.valor) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);

  const c = await req.json().catch(() => ({}));
  const api = new KlingoApi(token);

  try {
    if (c?.acao === "versao") return json({ ok: true, api: await api.versao() });

    if (c?.acao === "horarios") {
      const inicio = c?.inicio ? dataIso(c.inicio) : undefined, fim = c?.fim ? dataIso(c.fim) : undefined;
      if ((c?.inicio && !inicio) || (c?.fim && !fim)) return json({ error: "datas devem ser AAAA-MM-DD" }, 400);
      if (inicio && fim && (fim < inicio || diasEntre(inicio, fim) > MAX_DIAS)) return json({ error: `período inválido (máximo ${MAX_DIAS} dias)` }, 400);
      const especialidade = c?.especialidade ? soTexto(c.especialidade, 20) : null, exame = c?.exame ? soTexto(c.exame, 40) : null;
      if (!especialidade && !exame) return json({ error: "informe especialidade (CBOS) ou exame" }, 400);
      const horarios = await api.horarios({
        especialidade: especialidade ?? undefined, exame: exame ?? undefined, inicio: inicio ?? undefined, fim: fim ?? undefined,
        cnes: c?.cnes ? soTexto(c.cnes, 20) ?? undefined : undefined, crm: c?.crm ? soTexto(c.crm, 20) ?? undefined : undefined,
        plano: c?.plano ? soTexto(c.plano, 20) ?? undefined : undefined,
      });
      return json({ ok: true, total: horarios.length, horarios });
    }

    if (c?.acao === "marcar" || c?.acao === "marcar_pre") return json({ ok: false, motivo: "desligado", mensagem: "A marcação não é mais feita por aqui; use a klingo-executar (chat)." }, 410);

    return json({ error: "acao inválida (use versao ou horarios)" }, 400);
  } catch (e) {
    // 403 em /agenda/horarios = regra de negócio ("nenhum médico credenciado para esse convênio"): não é falha.
    if (e instanceof KlingoErro && e.status === 403 && e.caminho === "/agenda/horarios") return json({ ok: true, total: 0, horarios: [], motivo: "sem_medico_credenciado" });
    // Só status e caminho; o corpo do erro do Klingo pode ter dado de paciente.
    if (e instanceof KlingoErro) return json({ ok: false, motivo: "klingo_recusou", status: e.status, caminho: e.caminho }, 502);
    return json({ ok: false, motivo: "erro" }, 500);
  }
});
