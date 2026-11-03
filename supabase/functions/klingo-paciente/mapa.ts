// Funções puras (sem rede) da leitura de paciente no Klingo: conferir CPF + nascimento, histórico de marcações e resultados.
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial. Relatórios: A #14024, B #14025, C #14026.
export type Row = Record<string, unknown>;

export const REL = { A: "14024", B: "14025", C: "14026" } as const;
export const MESES_MAX = 12;       // o Klingo recusa períodos maiores (erro "."): 12 meses funcionou, 22 não
export const LINHAS_MAX = 200;

const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export function cpfDigitos(v: unknown): string | null {
  const d = txt(v).replace(/\D/g, "");
  return d.length === 11 ? d : null;
}
// O filtro "Apenas" do Klingo compara texto: não se sabe se o cadastro guarda com ou sem pontos. Tenta os dois.
export function cpfFormatos(d: string): string[] {
  return [d, `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`];
}
export function prontuarioValido(v: unknown): string | null {
  const t = txt(v);
  return /^[0-9A-Za-z-]{1,20}$/.test(t) ? t : null;
}
// Aceita AAAA-MM-DD, DD/MM/AAAA e qualquer um dos dois seguido de hora.
export function nascimentoIso(v: unknown): string | null {
  const t = txt(v);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y: string, mo: string, d: string;
  if (m) [, y, mo, d] = m;
  else if ((m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) [, d, mo, y] = m;
  else return null;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  return `${y}-${mo}-${d}`;
}

// Relatório A: col0 prontuário, col1 nome, col2 CPF, col3 nascimento, col4 e-mail, col5 celular, col6 telefone, col7 cadastro.
export type Verificacao = { encontrado: boolean; ambiguo: boolean; confere: boolean; prontuario: string | null; cadastro_faltando: string[] };

export function conferir(linhas: Row[], nascimento: string, cpf?: string): Verificacao {
  const alvo = cpf ? linhas.filter((r) => cpfDigitos(r.col2) === cpf) : linhas;
  const prontuarios = new Set(alvo.map((r) => txt(r.col0)).filter(Boolean));
  if (prontuarios.size === 0) return { encontrado: false, ambiguo: false, confere: false, prontuario: null, cadastro_faltando: [] };
  if (prontuarios.size > 1) return { encontrado: true, ambiguo: true, confere: false, prontuario: null, cadastro_faltando: [] };
  const r = alvo[0];
  const confere = nascimentoIso(r.col3) === nascimento;
  // Só diz QUAIS campos faltam (nunca o valor), e só depois de o nascimento conferir.
  const faltando = confere ? ([["email", r.col4], ["celular", r.col5], ["telefone", r.col6]] as const).filter(([, v]) => !txt(v)).map(([k]) => k) : [];
  return { encontrado: true, ambiguo: false, confere, prontuario: confere ? txt(r.col0) : null, cadastro_faltando: faltando };
}

const dia = (v: unknown) => nascimentoIso(v);
const ord = (a: string | null, b: string | null) => (b ?? "").localeCompare(a ?? "");

// Relatório B: só o necessário para o atendimento. Fica de fora: nome, CPF, valor, observação, usuário, telefones.
export function marcacoes(linhas: Row[]) {
  return linhas.map((r) => ({
    marcacao_id: txt(r.col3), atendimento_id: txt(r.col4), agendado_em: dia(r.col5), data: dia(r.col6), hora: txt(r.col7) || null,
    chegada: dia(r.col8) ?? (txt(r.col8) || null), procedimento: txt(r.col9), operadora: txt(r.col10), confirmacao: txt(r.col14) || null,
    motivo_cancelamento: txt(r.col15) || null, status: txt(r.col16), atendido: txt(r.col17) || null, unidade: txt(r.col18),
  })).sort((a, b) => ord(a.data, b.data)).slice(0, LINHAS_MAX);
}

// Relatório C: col0 atendimento, col1 prontuário, col2 nome, col3 procedimento, col4 data, col5 status, col6 laudo pronto, col7 laudo id.
export function resultados(linhas: Row[]) {
  return linhas.map((r) => {
    const pronto = dia(r.col6);
    return { atendimento_id: txt(r.col0), procedimento: txt(r.col3), data: dia(r.col4), status: txt(r.col5), laudo_id: txt(r.col7) || null, laudo_pronto_em: pronto, laudo_pronto: Boolean(pronto || txt(r.col7)) };
  }).sort((a, b) => ord(a.data, b.data)).slice(0, LINHAS_MAX);
}

export function hojeBrasilia(agora = new Date()): string {
  return new Date(agora.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
}
export function janela(meses: unknown, hoje: string): { de: string; ate: string } {
  const n = Math.min(MESES_MAX, Math.max(1, Math.trunc(Number(meses)) || MESES_MAX));
  const d = new Date(`${hoje}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  d.setUTCDate(d.getUTCDate() + 1);
  return { de: d.toISOString().slice(0, 10), ate: hoje };
}

// Resumo curto do histórico (para a nota da equipe): quantas marcações, a data e o nome do último exame. Ignora canceladas.
export function resumoHistorico(linhas: Row[]) {
  const ativas = marcacoes(linhas).filter((m) => !/cancel/i.test(`${m.status} ${m.motivo_cancelamento ?? ""}`));
  const u = ativas[0];
  return { total: ativas.length, ultima_data: u?.data ?? null, ultimo_procedimento: u?.procedimento ?? null };
}
