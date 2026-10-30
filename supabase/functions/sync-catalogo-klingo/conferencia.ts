// Conferência da marcação: compara o pré-agendamento (telefone, nome, exames, horário escolhido) com as linhas do relatório #7 do Klingo.
// Tudo acontece na memória: as linhas trazem nome e telefone de pacientes, que NUNCA são gravados, devolvidos nem escritos em log.
// A saída tem só o veredito por horário (ok / outro / livre), de que forma o paciente foi reconhecido e um texto curto de divergência.

export type Row = Record<string, unknown>;
export type Slot = { idx: number; data: string; hora: string; prof: string; unidade: string; chegada: boolean; min: number };
export type Alvo = { id: string; status: string; conf: string | null; fones: string[]; nomes: string[]; procs: string[]; slots: Slot[] };
export type Via = "telefone" | "nome" | "ambos";
export type Resultado = { id: string; slots: Array<{ idx: number; r: "ok" | "outro" | "livre" }>; via: Via | null; div: string | null };
export type Linha = {
  ini: string; dia: string; prof: string; unidade: string; profOrig: string; unidadeOrig: string;
  proc: string; procNorm: string; fones: string[]; nome: string;
};

// Mesma normalização de public.norm_nome: maiúsculas, sem acento, só letras e espaços.
export const normNome = (t: unknown): string =>
  String(t ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();

// Últimos 8 dígitos de cada telefone do campo (aceita vários números, com ou sem DDD, com máscara).
export function fonesDaLinha(txt: unknown): string[] {
  const out: string[] = [];
  for (const m of String(txt ?? "").matchAll(/\d[\d\s().+-]{6,}\d/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length < 8) continue;
    if (d.length <= 13) out.push(d.slice(-8));
    else for (let i = 0; i + 8 <= d.length; i++) out.push(d.slice(i, i + 8)); // números colados sem separador
  }
  return out;
}

// Mesmo critério de public.nome_confere: igual, ou o nome mais curto (2+ palavras de mais de 2 letras) contido no mais longo.
export function nomeConfere(a: unknown, b: unknown): boolean {
  const na = normNome(a), nb = normNome(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [curto, longo] = na.length <= nb.length ? [na, nb] : [nb, na];
  const palavras = new Set(longo.split(" "));
  const chaves = curto.split(" ").filter((t) => t.length > 2);
  return chaves.length >= 2 && chaves.every((t) => palavras.has(t));
}

export function linhaDe(r: Row): Linha | null {
  const ini = String(r.Data_Atendimento ?? "").slice(0, 16).replace("T", " ");
  const profOrig = String(r.Medico ?? "").trim(), unidadeOrig = String(r.Unidade ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(ini) || !profOrig || !unidadeOrig) return null;
  const proc = String(r.Procedimento ?? "").trim();
  return {
    ini, dia: ini.slice(0, 10), prof: normNome(profOrig), unidade: normNome(unidadeOrig), profOrig, unidadeOrig,
    proc, procNorm: normNome(proc), fones: fonesDaLinha(r.Telefone), nome: String(r.Paciente ?? ""),
  };
}

const FORCA: Record<Via, number> = { nome: 1, telefone: 2, ambos: 3 };
const dataBR = (ini: string) => `${ini.slice(8, 10)}/${ini.slice(5, 7)} ${ini.slice(11, 16)}`;

export function avaliar(alvo: Alvo, linhas: Linha[]): Resultado {
  const procBate = (l: Linha) => alvo.procs.length === 0 || alvo.procs.some((p) =>
    l.procNorm === p || (l.procNorm.length >= 8 && p.length >= 8 && (l.procNorm.includes(p) || p.includes(l.procNorm))));
  const paciente = (l: Linha): Via | null => {
    const t = alvo.fones.some((f) => l.fones.includes(f));
    const n = alvo.nomes.some((x) => nomeConfere(x, l.nome));
    return t && n ? "ambos" : t ? "telefone" : n ? "nome" : null;
  };
  const naPosicao = (l: Linha, s: Slot) =>
    l.prof === s.prof && l.unidade === s.unidade && (s.chegada ? l.dia === s.data : l.ini === `${s.data} ${s.hora}`);

  let via: Via | null = null;
  const slots = alvo.slots.map((s) => {
    const candidatas = linhas.filter((l) => naPosicao(l, s));
    const boa = candidatas.map((l) => ({ l, v: paciente(l) })).find((c) => c.v && procBate(c.l));
    if (boa && boa.v) {
      if (!via || FORCA[boa.v] < FORCA[via]) via = boa.v;
      return { idx: s.idx, r: "ok" as const };
    }
    // Horário com hora exata ocupado por quem não bate com este paciente. Ordem de chegada nunca é "ocupado".
    return { idx: s.idx, r: !s.chegada && candidatas.length > 0 ? ("outro" as const) : ("livre" as const) };
  });

  let div: string | null = null;
  if (alvo.procs.length > 0) {
    for (const l of [...linhas].sort((a, b) => (a.ini < b.ini ? -1 : 1))) {
      if (!paciente(l)) continue;
      const pos = alvo.slots.some((s) => naPosicao(l, s));
      const procOk = procBate(l);
      if (pos && !procOk) { div = `No horário escolhido, a marcação deste paciente é de outro exame: ${l.proc || "não informado"}.`; break; }
      if (!pos && procOk) {
        div = `Este paciente tem ${l.proc || "o exame"} marcado em ${dataBR(l.ini)} (${l.profOrig}, ${l.unidadeOrig}), diferente do horário escolhido no chat.`;
        break;
      }
    }
  }
  return { id: alvo.id, slots, via, div };
}

// Escolhe os alvos desta rodada sem passar de maxDias dias diferentes (cada dia é uma consulta ao Klingo).
// A ordem é embaralhada para que, se houver muitos dias esperando, todos sejam atendidos com o tempo.
export function escolherAlvos(alvos: Alvo[], maxDias = 8, rng: () => number = Math.random): Alvo[] {
  const ordem = [...alvos];
  for (let i = ordem.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [ordem[i], ordem[j]] = [ordem[j], ordem[i]];
  }
  const dias = new Set<string>();
  const escolhidos: Alvo[] = [];
  for (const a of ordem) {
    const meus = a.slots.map((s) => s.data);
    const novos = meus.filter((d) => !dias.has(d));
    if (dias.size + new Set(novos).size > maxDias) continue;
    meus.forEach((d) => dias.add(d));
    escolhidos.push(a);
  }
  return escolhidos;
}
