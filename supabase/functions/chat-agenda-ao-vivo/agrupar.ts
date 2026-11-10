// FLUXOGRAMA: entrada (linhas do relatório #7 do Klingo para alguns dias, e a lista de dias que a paciente quer ver) -> validação (datas AAAA-MM-DD, período curto, só linhas com horário, profissional e unidade) -> lógica (agrupa por horário+profissional+unidade; divide os dias em blocos seguidos para ler em paralelo) -> saída (linhas SEM dado de paciente para agenda_ao_vivo_gravar)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (agenda ao vivo no chat)
//
// Funções puras (sem rede, sem banco). O relatório #7 traz dados de paciente (nome, telefone, prontuário, observação): aqui só saem
// quando (Data_Atendimento), quem atende (Medico), onde (Unidade) e qual exame (Procedimento), como na leitura geral da ocupação.

export type Row = Record<string, unknown>;
export type Linha = { inicio: string; profissional: string; unidade: string; procedimento: string; qtd: number };

const DATA = /^\d{4}-\d{2}-\d{2}$/;

export function agruparMarcacoes(rows: Row[]): Linha[] {
  const agrupado = new Map<string, Linha>();
  for (const r of rows) {
    const inicio = String(r.Data_Atendimento ?? "").slice(0, 19).replace("T", " ");
    const profissional = String(r.Medico ?? "").trim(), unidade = String(r.Unidade ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(inicio) || !profissional || !unidade) continue;
    const chave = `${inicio}|${profissional}|${unidade}`;
    const g = agrupado.get(chave);
    if (g) g.qtd += 1;
    else agrupado.set(chave, { inicio, profissional, unidade, procedimento: String(r.Procedimento ?? "").trim(), qtd: 1 });
  }
  return [...agrupado.values()];
}

const dia = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);

// Todos os dias de "de" a "ate", inclusive. Recusa datas inválidas, intervalo invertido e mais de 15 dias.
export function diasEntre(de: string, ate: string): string[] {
  if (!DATA.test(de) || !DATA.test(ate) || Number.isNaN(ms(de)) || Number.isNaN(ms(ate)) || ms(ate) < ms(de)) throw new Error("Período inválido");
  const n = Math.round((ms(ate) - ms(de)) / 86_400_000) + 1;
  if (n > 15) throw new Error("Período inválido");
  return Array.from({ length: n }, (_, i) => dia(ms(de) + i * 86_400_000));
}

// Junta dias SEGUIDOS em blocos de até "max" dias (cada bloco vira uma leitura no Klingo; blocos são lidos em paralelo).
export function blocosConsecutivos(dias: string[], max = 4): Array<{ de: string; ate: string; dias: string[] }> {
  const ordenados = [...new Set(dias)].filter((d) => DATA.test(d)).sort();
  const out: Array<{ de: string; ate: string; dias: string[] }> = [];
  for (const d of ordenados) {
    const b = out[out.length - 1];
    if (b && b.dias.length < max && ms(d) - ms(b.ate) === 86_400_000) { b.ate = d; b.dias.push(d); }
    else out.push({ de: d, ate: d, dias: [d] });
  }
  return out;
}

// O instante mais antigo entre as leituras (é o que vale para a frase "agenda conferida às ...").
export function maisAntigo(instantes: Array<string | null | undefined>): string | null {
  const v = instantes.filter((x): x is string => !!x && !Number.isNaN(Date.parse(x)));
  return v.length ? v.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b)) : null;
}
