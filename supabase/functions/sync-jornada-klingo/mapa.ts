// FLUXOGRAMA: entrada (linhas do relatório de marcações do Klingo, #13825 ou o duplicado por data do exame) -> validação (id da marcação, data do exame e uma forma de identificar o paciente: prontuário, ou nome + telefone; textos cortados) -> lógica (janela de leitura por modo e filtro; telefone vira marca/hash; sem valor em R$) -> saída (linhas enxutas {m,a,p,n,f,x,o,u,e,d,s,t,r,c} em lotes para jornada_klingo_lote)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
//
// Tudo aqui é função pura (sem rede, sem banco), para testar sem Klingo. As linhas trazem nome e telefone de pacientes: ficam só na memória da Edge Function;
// o telefone nunca sai daqui, vira só uma marca (SHA-256 dos 8 últimos dígitos + o segredo da clínica) que o banco usa para achar a conversa do chat.
//
// Colunas do relatório (as mesmas do #13825): col0 Id da Marcação, col1 Id do Atendimento, col2 Prontuário, col3 Agendado Em, col4 Agendado Para (a data do exame),
// col5 Procedimento, col6 Operadora, col8 Valor (NUNCA lido), col10 Confirm Status, col11 Cancelamento - Motivo, col12 Status (Aberta/Cancelada), col13 Atendido (S/N),
// col14 Unidade, col15 Nome, col16 Celular, col17 Telefone.

export type Row = Record<string, unknown>;
export type LinhaLote = { m: string; a: string; p: string; n: string; f: string; x: string; o: string; u: string; e: string; d: string; s: string; t: string; r: string; c: string };
export type Modo = "rapido" | "completo";
export type Filtro = "criacao" | "exame";

// Quantos dias para trás e para a frente da data de hoje a Jornada mostra (tem que bater com jornada_klingo_fechar).
export const CARTOES_ATRAS = 2;
export const CARTOES_FRENTE = 30;

const ISO = /^\d{4}-\d{2}-\d{2}/;
const txt = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);

export const somaDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// Data de hoje em Brasília (YYYY-MM-DD), qualquer que seja o fuso do servidor.
export const hojeBrasilia = (agora: Date = new Date()): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(agora);

const sha256Hex = async (texto: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Mesma conta de public.jornada_conversa_do_card: SHA-256 em hexadecimal de (8 últimos dígitos + segredo). Sem 8 dígitos, não há marca.
export async function chaveFone(fone: unknown, segredo: string): Promise<string> {
  const digitos = String(fone ?? "").replace(/\D/g, "");
  if (digitos.length < 8) return "";
  return sha256Hex(digitos.slice(-8) + segredo);
}

// Nome sem acento, em maiúsculas, só letras/números e espaço simples (para a mesma pessoa dar sempre a mesma chave).
export const normNome = (v: unknown): string =>
  String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

// Marcação SEM prontuário no Klingo (cerca de 1 em cada 5): a chave do paciente passa a ser "n:" + hash(nome + últimos 8 dígitos do telefone + segredo).
// Com o segredo no hash, a chave não dá para refazer a partir de um nome conhecido. Sem prontuário e sem nome, não há como identificar: a linha é descartada.
export async function chavePaciente(r: Row, segredo: string): Promise<string> {
  const prontuario = txt(r.col2, 40);
  if (prontuario) return prontuario;
  const nome = normNome(r.col15);
  if (!nome) return "";
  const fone = String(r.col16 ?? "").replace(/\D/g, "").slice(-8) || String(r.col17 ?? "").replace(/\D/g, "").slice(-8);
  return "n:" + (await sha256Hex(`${nome}|${fone}|${segredo}`)).slice(0, 24);
}

// Uma linha do relatório -> uma linha enxuta para o banco. null = linha sem id, sem como identificar o paciente ou sem data do exame (não serve).
export async function mapearLinha(r: Row, segredo: string): Promise<LinhaLote | null> {
  const m = txt(r.col0, 40), d = txt(r.col4, 30);
  if (!m || !ISO.test(d)) return null;
  const p = await chavePaciente(r, segredo);
  if (!p) return null;
  const e = txt(r.col3, 30);
  return {
    m, a: txt(r.col1, 40), p, n: txt(r.col15, 120),
    f: (await chaveFone(r.col16, segredo)) || (await chaveFone(r.col17, segredo)),
    x: txt(r.col5, 200), o: txt(r.col6, 80), u: txt(r.col14, 120),
    e: ISO.test(e) ? e : "", d,
    s: txt(r.col12, 20), t: txt(r.col13, 3), r: txt(r.col11, 120), c: txt(r.col10, 40),
  };
}

// Faixa de datas que a leitura pede ao Klingo.
//  - filtro "exame" (relatório novo, por data do exame): rápido = ontem, hoje e amanhã (e anteontem, para fechar o dia); completo = a janela inteira dos cartões.
//  - filtro "criacao" (#13825, que só filtra pela data em que a marcação foi FEITA): rápido = marcações de ontem e de hoje (pega as novas);
//    completo = as feitas nos últimos 45 dias (pega confirmação, cancelamento e atendimento de marcações mais antigas).
export function janelaLeitura(modo: Modo, filtro: Filtro, hoje: string): { de: string; ate: string } {
  if (filtro === "exame") return modo === "rapido" ? { de: somaDias(hoje, -CARTOES_ATRAS), ate: somaDias(hoje, 1) } : { de: somaDias(hoje, -CARTOES_ATRAS), ate: somaDias(hoje, CARTOES_FRENTE) };
  return modo === "rapido" ? { de: somaDias(hoje, -1), ate: hoje } : { de: somaDias(hoje, -45), ate: hoje };
}

// Só entra na Jornada o exame que cai na janela dos cartões (anteontem até daqui a 30 dias).
export const dentroDosCartoes = (dataExame: string, hoje: string): boolean => {
  const dia = dataExame.slice(0, 10);
  return dia >= somaDias(hoje, -CARTOES_ATRAS) && dia <= somaDias(hoje, CARTOES_FRENTE);
};

// Por que uma linha não serve (só o motivo, nunca o conteúdo): ajuda a ver, sem expor paciente, o que o relatório traz de estranho.
export type Descartes = { sem_id: number; sem_data: number; sem_identificacao: number };
export function motivoDescarte(r: Row): keyof Descartes | null {
  if (!txt(r.col0, 40)) return "sem_id";
  if (!ISO.test(txt(r.col4, 30))) return "sem_data";
  if (!txt(r.col2, 40) && !normNome(r.col15)) return "sem_identificacao";
  return null;
}

// Mapeia, descarta o que não serve, tira repetidas (a mesma marcação duas vezes: vale a última) e mantém só a janela dos cartões.
// "semProntuario" conta as linhas que ficaram com a chave por nome (n:...), só para o resumo.
export async function prepararLinhas(linhas: Row[], segredo: string, hoje: string): Promise<{ linhas: LinhaLote[]; descartadas: number; descartes: Descartes; fora: number; semProntuario: number }> {
  const porId = new Map<string, LinhaLote>();
  const descartes: Descartes = { sem_id: 0, sem_data: 0, sem_identificacao: 0 };
  let descartadas = 0, fora = 0, semProntuario = 0;
  for (const r of linhas) {
    const motivo = motivoDescarte(r);
    if (motivo) { descartes[motivo]++; descartadas++; continue; }
    const l = (await mapearLinha(r, segredo))!;
    if (!dentroDosCartoes(l.d, hoje)) { fora++; continue; }
    if (l.p.startsWith("n:")) semProntuario++;
    porId.set(l.m, l);
  }
  return { linhas: [...porId.values()], descartadas, descartes, fora, semProntuario };
}

export function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}

export const modoValido = (v: unknown): Modo => (v === "completo" ? "completo" : "rapido");
export const filtroValido = (v: unknown): Filtro => (v === "exame" ? "exame" : "criacao");
// Id de relatório do Klingo: só dígitos (vem da config; nunca vai cru para a URL).
export const relatorioValido = (v: unknown): string => (/^\d{1,8}$/.test(String(v ?? "").trim()) ? String(v).trim() : "13825");
