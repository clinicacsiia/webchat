// FLUXOGRAMA: entrada (linhas do relatório de marcações do Klingo, #13825 ou o duplicado por data do exame) -> validação (id da marcação, data do exame e uma forma de identificar o paciente: prontuário, ou nome + telefone; textos cortados) -> lógica (janela de leitura por modo e filtro; telefone vira marca/hash; sem valor em R$) -> saída (linhas enxutas {m,a,p,n,f,x,o,u,e,d,s,t,r,c} em lotes para jornada_klingo_lote)
// Versão 1.3 — 15/11/2026 / Mudança: #14359 ganhou colunas (Celular=col16, Atendido=col17, Check-In=col18, 2º Prontuário=col19, Primeira Vez=col20); trava que para a leitura se o layout mudar de novo
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

// Em que coluna (colN) está cada campo, por relatório. "criacao" = #13825; "exame" = #14359, refeito em 14/11/2026 (nome e responsável vieram para o começo).
export type Layout = { m: string; a: string; pront: string; nome: string; resp: string; em: string; d: string; proc: string; oper: string; unid: string; conf: string; motivo: string; status: string; atend: string; cel: string; tel: string };
export const LAYOUT_CRIACAO: Layout = { m: "col0", a: "col1", pront: "col2", em: "col3", d: "col4", proc: "col5", oper: "col6", unid: "col14", conf: "col10", motivo: "col11", status: "col12", atend: "col13", nome: "col15", cel: "col16", tel: "col17", resp: "col7" };
// 15/11/2026: o dono acrescentou colunas ao #14359 e o Celular passou para col16 e o Atendido para col17 (antes era o contrário). col18 = Check-In - Data (ainda não lida), col19 = um 2º "Prontuário" (repetido; ignorar), col20 = Primeira Vez.
export const LAYOUT_EXAME: Layout = { m: "col0", a: "col1", nome: "col2", resp: "col3", pront: "col4", em: "col5", d: "col6", proc: "col7", oper: "col8", unid: "col9", conf: "col12", motivo: "col13", tel: "col14", status: "col15", cel: "col16", atend: "col17" };
export const layoutDe = (f: Filtro): Layout => (f === "exame" ? LAYOUT_EXAME : LAYOUT_CRIACAO);

// Quantos dias para trás e para a frente da data de hoje a Jornada mostra (tem que bater com jornada_klingo_fechar).
export const CARTOES_ATRAS = 2;
export const CARTOES_FRENTE = 365;

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
export async function chavePaciente(r: Row, segredo: string, L: Layout = LAYOUT_CRIACAO): Promise<string> {
  const prontuario = txt(r[L.pront], 40);
  if (prontuario) return prontuario;
  const nome = normNome(r[L.nome]);
  if (!nome) return "";
  const fone = String(r[L.cel] ?? "").replace(/\D/g, "").slice(-8) || String(r[L.tel] ?? "").replace(/\D/g, "").slice(-8);
  return "n:" + (await sha256Hex(`${nome}|${fone}|${segredo}`)).slice(0, 24);
}

// Uma linha do relatório -> uma linha enxuta para o banco. null = linha sem id, sem como identificar o paciente ou sem data do exame (não serve).
export async function mapearLinha(r: Row, segredo: string, L: Layout = LAYOUT_CRIACAO): Promise<LinhaLote | null> {
  const m = txt(r[L.m], 40), d = txt(r[L.d], 30);
  if (!m || !ISO.test(d)) return null;
  const p = await chavePaciente(r, segredo, L);
  if (!p) return null;
  const e = txt(r[L.em], 30);
  return {
    m, a: txt(r[L.a], 40), p, n: txt(r[L.nome], 120),
    f: (await chaveFone(r[L.cel], segredo)) || (await chaveFone(r[L.tel], segredo)),
    x: txt(r[L.proc], 200), o: txt(r[L.oper], 80), u: txt(r[L.unid], 120),
    e: ISO.test(e) ? e : "", d,
    s: txt(r[L.status], 20), t: txt(r[L.atend], 3), r: txt(r[L.motivo], 120), c: txt(r[L.conf], 40),
  };
}

// Faixa de datas que a leitura pede ao Klingo.
//  - filtro "exame" (relatório novo, por data do exame): rápido = ontem, hoje e amanhã (e anteontem, para fechar o dia); completo = a janela inteira dos cartões.
//  - filtro "criacao" (#13825, que só filtra pela data em que a marcação foi FEITA): rápido = marcações de ontem e de hoje (pega as novas);
//    completo = as feitas nos últimos 45 dias (pega confirmação, cancelamento e atendimento de marcações mais antigas).
export function janelaLeitura(modo: Modo, filtro: Filtro, hoje: string): { de: string; ate: string } {
  if (filtro === "exame") return modo === "rapido" ? { de: hoje, ate: somaDias(hoje, 7) } : { de: hoje, ate: somaDias(hoje, CARTOES_FRENTE) };
  return modo === "rapido" ? { de: somaDias(hoje, -1), ate: hoje } : { de: somaDias(hoje, -45), ate: hoje };
}

// Só entra na Jornada o exame que cai na janela dos cartões (anteontem até daqui a 1 ano).
export const dentroDosCartoes = (dataExame: string, hoje: string): boolean => {
  const dia = dataExame.slice(0, 10);
  return dia >= somaDias(hoje, -CARTOES_ATRAS) && dia <= somaDias(hoje, CARTOES_FRENTE);
};

// Por que uma linha não serve (só o motivo, nunca o conteúdo): ajuda a ver, sem expor paciente, o que o relatório traz de estranho.
export type Descartes = { sem_id: number; sem_data: number; sem_identificacao: number };
export function motivoDescarte(r: Row, L: Layout = LAYOUT_CRIACAO): keyof Descartes | null {
  if (!txt(r[L.m], 40)) return "sem_id";
  if (!ISO.test(txt(r[L.d], 30))) return "sem_data";
  if (!txt(r[L.pront], 40) && !normNome(r[L.nome])) return "sem_identificacao";
  return null;
}

// Mapeia, descarta o que não serve, tira repetidas (a mesma marcação duas vezes: vale a última) e mantém só a janela dos cartões.
// "semProntuario" conta as linhas que ficaram com a chave por nome (n:...), só para o resumo.
export async function prepararLinhas(linhas: Row[], segredo: string, hoje: string, L: Layout = LAYOUT_CRIACAO): Promise<{ linhas: LinhaLote[]; descartadas: number; descartes: Descartes; fora: number; semProntuario: number }> {
  const porId = new Map<string, LinhaLote>();
  const descartes: Descartes = { sem_id: 0, sem_data: 0, sem_identificacao: 0 };
  let descartadas = 0, fora = 0, semProntuario = 0;
  for (const r of linhas) {
    const motivo = motivoDescarte(r, L);
    if (motivo) { descartes[motivo]++; descartadas++; continue; }
    const l = (await mapearLinha(r, segredo, L))!;
    if (!dentroDosCartoes(l.d, hoje)) { fora++; continue; }
    if (l.p.startsWith("n:")) semProntuario++;
    porId.set(l.m, l);
  }
  return { linhas: [...porId.values()], descartadas, descartes, fora, semProntuario };
}


// Trava contra mudança de colunas no relatório: "Atendido" só pode ser S, N ou vazio e "Status" só Aberta/Cancelada/Bloqueada. Se muitas linhas fugirem disso, o relatório mudou de ordem:
// é melhor parar a leitura (e avisar pelo erro) do que gravar telefone no lugar de "Atendido" e criar pacientes duplicados. Só conta e devolve o motivo: nunca o conteúdo.
export function layoutSuspeito(linhas: Row[], L: Layout): string | null {
  if (linhas.length < 20) return null;
  let atendRuim = 0, statusRuim = 0;
  for (const r of linhas) {
    if (!/^(S|N|)$/i.test(txt(r[L.atend], 10))) atendRuim++;
    if (!/^(aberta|cancelada|bloqueada)$/i.test(txt(r[L.status], 20))) statusRuim++;
  }
  const limite = linhas.length * 0.02;
  if (atendRuim > limite) return `Layout do relatório mudou: ${atendRuim} de ${linhas.length} linhas com "Atendido" fora de S/N na ${L.atend}`;
  if (statusRuim > limite) return `Layout do relatório mudou: ${statusRuim} de ${linhas.length} linhas com "Status" inesperado na ${L.status}`;
  return null;
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
