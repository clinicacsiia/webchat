// FLUXOGRAMA: entrada (POST com x-sync-key = config.ia_segredo e {"acao": "versao" | "horarios" | "marcar", ...}) -> validação (chave, formato de datas/CPF, janela de até 31 dias) -> lógica (versao e horarios só LEEM da API do Klingo; marcar identifica o paciente pelo CPF, confere o nascimento, e só com "executar": true faz login -> reservar -> marcar, soltando a reserva se a marcação falhar) -> saída (horários e voucher enxutos; nunca nome, CPF, telefone ou corpo de erro do Klingo; nada vai para o log)
// Versão 0.1 — 12/11/2026 / Mudança: EXEMPLO de agendamento pela API externa do Klingo (horários livres + marcação). Ainda NÃO está ligado ao chat nem publicado.
//
// Ações:
//   {"acao":"versao"}                                                      -> {"ok":true,"api":"OK [API1]"}
//   {"acao":"horarios","especialidade":"225265"|"exame":"123","inicio":"2026-11-16","fim":"2026-11-20","cnes":"…","crm":"…","plano":1}
//   {"acao":"marcar","cpf":"…","nascimento":"AAAA-MM-DD","horario":"<id do horário>","procedimento":"…","plano":1,"executar":false}
//        executar ausente/false = ENSAIO: só identifica e confere o nascimento; não reserva nem marca nada.
// Secret: KLINGO_APP_TOKEN (a mesma dos relatórios).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cpfDigitos, dataIso, KlingoApi, KlingoErro } from "./api.ts";

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

    if (c?.acao === "marcar") {
      const cpf = cpfDigitos(c?.cpf), nasc = dataIso(c?.nascimento);
      const horario = soTexto(c?.horario, 120), procedimento = soTexto(c?.procedimento, 40), plano = Number(c?.plano);
      if (!cpf || !nasc || !horario || !procedimento || !Number.isInteger(plano) || plano < 0) return json({ error: "cpf, nascimento, horario, procedimento e plano são obrigatórios" }, 400);

      // 1) Identifica pelo CPF e confere o nascimento (mesma regra do klingo-paciente: sem bater, nada acontece).
      const pac = await api.pacientePorCpf(cpf) as Record<string, unknown> | null;
      const idPaciente = pac?.id ?? pac?.id_paciente ?? pac?.id_origem; // CONFIRMAR qual campo a API devolve (ver docs)
      if (!pac || idPaciente === undefined || idPaciente === null) return json({ ok: false, motivo: "nao_encontrado" });
      if (dataIso(pac.dt_nasc) !== nasc) return json({ ok: false, motivo: "nascimento_nao_confere" });
      if (c?.executar !== true) return json({ ok: true, simulacao: true, proximos_passos: ["login", "reservar", "marcar"] });

      // 2) Sessão do paciente -> reserva (10 min) -> marcação. Se a marcação falhar, solta a reserva.
      const sessao = await api.login(String(idPaciente));
      const m = { horario, procedimento, plano, enviarEmail: c?.enviar_email === true, idExterno: soTexto(c?.id_externo, 60) ?? undefined };
      const reserva = await api.reservar(sessao, m);
      try {
        const v = await api.marcar(sessao, m) as Record<string, unknown>;
        const proc = v?.procedimento as Record<string, unknown> | undefined, uni = v?.unidade as Record<string, unknown> | undefined, rea = v?.realizador as Record<string, unknown> | undefined;
        return json({ ok: true, marcado: true, voucher: { id: v?.id ?? null, status: v?.status ?? null, data: v?.data ?? null, hora: v?.hora ?? null, procedimento: proc?.descr ?? null, unidade: uni?.nome ?? null, profissional: rea?.nome ?? null } });
      } catch (e) {
        if (reserva?.id !== undefined) await api.cancelarReserva(sessao, reserva.id).catch(() => {});
        throw e;
      }
    }

    return json({ error: "acao inválida (use versao, horarios ou marcar)" }, 400);
  } catch (e) {
    // 403 em /agenda/horarios = regra de negócio ("nenhum médico credenciado para esse convênio"): não é falha.
    if (e instanceof KlingoErro && e.status === 403 && e.caminho === "/agenda/horarios") return json({ ok: true, total: 0, horarios: [], motivo: "sem_medico_credenciado" });
    // Só status e caminho; o corpo do erro do Klingo pode ter dado de paciente.
    if (e instanceof KlingoErro) return json({ ok: false, motivo: "klingo_recusou", status: e.status, caminho: e.caminho }, 502);
    return json({ ok: false, motivo: "erro" }, 500);
  }
});
