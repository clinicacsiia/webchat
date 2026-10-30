import { createClient } from "jsr:@supabase/supabase-js@2";

// Atualiza o catálogo que a IA consulta (procedimentos, agenda e planos) a partir de relatórios do Klingo.
// Só relatórios de cadastro, sem dado de paciente. O token fica no secret KLINGO_APP_TOKEN.
// Chamada: POST com o header x-sync-key igual a config.ia_segredo (a noite, pelo pg_cron; ou à mão).
//
// A sincronização COMPARA com o que já existe (catalogo_sincronizar): registra o que mudou em catalogo_mudanca,
// marca como removido o que sumiu do Klingo e recusa um relatório que venha com menos da metade das linhas.
//
// Modo de inspeção: {"inspecionar": "13983"} devolve só os filtros (inputs) e os títulos das colunas do relatório,
// nunca as linhas. Serve para descobrir os ids dos filtros antes de pedir os dados.

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const INSPECIONAVEIS = new Set(["7", "47", "13981", "13983", "13984", "12301", "13825"]);
// Colunas com dado de paciente: nunca podem ser agrupadas nem filtradas na inspeção (que devolve valores e contagens).
const COLUNAS_PACIENTE: Record<string, Set<string>> = {
  "7": new Set(["Paciente", "Telefone", "Prontuario", "Obs"]),
  "13825": new Set(["col1", "col2", "col9", "col15", "col16", "col17"]),
  "47": new Set(["Paciente", "Telefone", "Usuario"]),
};
type Row = Record<string, unknown>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function relatorio(id: string, token: string): Promise<Row[]> {
  const res = await fetch(`${KLINGO_URL}?id=${id}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status} no relatório ${id}`);
  const payload = await res.json();
  if (payload?.error) throw new Error(`Klingo retornou erro no relatório ${id}`);
  if (payload?.limit) throw new Error(`O Klingo cortou o relatório ${id} (limite de linhas)`);
  const data = payload?.result?.data;
  if (!Array.isArray(data) || data.length === 0) throw new Error(`Relatório ${id} veio vazio ou em formato inesperado`);
  return data as Row[];
}

// Só a estrutura do relatório: filtros, títulos de coluna e, se pedido, contagens por valor de uma coluna
// (agrupar: "col0" devolve os valores distintos e quantas linhas cada um tem). Nunca devolve as linhas.
async function inspecionar(id: string, token: string, filtros: Record<string, string>, agrupar: string | null, somente: Record<string, string> = {}) {
  const params = new URLSearchParams({ id, ...filtros });
  const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
  const payload = await res.json().catch(() => null);
  const resumo = (v: unknown): unknown => {
    if (Array.isArray(v)) return { total: v.length, primeiros: v.slice(0, 5).map(resumo) };
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, resumo(x)]));
    return typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v;
  };
  const result = payload?.result;
  const todas: Row[] = Array.isArray(result?.data) ? result.data : [];
  const condicoes = Object.entries(somente).filter(([c]) => /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(c));
  const dados = condicoes.length ? todas.filter((r) => condicoes.every(([c, v]) => String(r[c] ?? "") === v)) : todas;
  const colunas = [...(Array.isArray(result?.group_cols) ? result.group_cols : []), ...(Array.isArray(result?.columns) ? result.columns : [])]
    .map((c: Row) => ({ nome: c?.name, titulo: c?.title }));
  let grupos: unknown = null;
  if (agrupar && /^[A-Za-z_][A-Za-z0-9_]{0,30}$/.test(agrupar)) {
    const m = new Map<string, number>();
    for (const r of dados) { const k = String(r[agrupar] ?? ""); m.set(k, (m.get(k) ?? 0) + 1); }
    grupos = [...m.entries()].slice(0, 200).map(([valor, linhas]) => ({ valor, linhas }));
  }
  return {
    http: res.status,
    error: payload?.error ?? null,
    limit: payload?.limit ?? null,
    linhas: dados.length,
    inputs_aplicados: Array.isArray(payload?.inputs) ? payload.inputs.map((i: Row) => ({ id: i?.id, name: i?.name, value: i?.value })) : null,
    inputs: filtros && Object.keys(filtros).length ? undefined : (Array.isArray(payload?.inputs) ? payload.inputs.map(resumo) : null),
    colunas: Object.keys(filtros).length ? undefined : colunas,
    grupos,
  };
}

const txt = (v: unknown) => (v === null || v === undefined || v === "" || v === 0 ? null : String(v).trim() || null);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Supa = ReturnType<typeof createClient>;

// Preços de convênio: relatório 13983 pedido uma operadora por vez (filtro :parm0 = id da operadora).
// Operadora sem preço volta vazia e é ignorada. Pára antes do limite de tempo e diz quais ficaram pendentes.
async function precosConvenio(supabase: Supa, token: string, pedidas: number[] | null) {
  const limite = Date.now() + 100_000;
  const { data: feitas } = await supabase.rpc("catalogo_preco_operadoras");
  const ultima = new Map<number, number>(((feitas ?? []) as Array<{ operadora_id: number; atualizado_em: string }>)
    .map((r) => [r.operadora_id, Date.parse(r.atualizado_em)]));
  const ids = pedidas ?? Array.from({ length: 60 }, (_, i) => i + 1);
  const resultado: unknown[] = [];
  const erros: string[] = [];
  const pendentes: number[] = [];
  const vazias: number[] = [];
  for (const id of ids) {
    if (!pedidas && (ultima.get(id) ?? 0) > Date.now() - 12 * 3600_000) continue;
    if (Date.now() > limite) { pendentes.push(id); continue; }
    try {
      const res = await fetch(`${KLINGO_URL}?${new URLSearchParams({ id: "13983", ":parm0": String(id) })}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status}`);
      const payload = await res.json();
      if (payload?.error) throw new Error("Klingo retornou erro no relatório");
      if (payload?.limit) throw new Error("O Klingo cortou o relatório (limite de linhas)");
      const dados = payload?.result?.data;
      if (!Array.isArray(dados) || dados.length === 0) { vazias.push(id); continue; }
      const linhas = (dados as Row[]).map((r) => ({
        operadora_id: num(r.col0), operadora: txt(r.col1), tabela_id: num(r.col2), tabela: txt(r.col3), procedimento_id: num(r.col4),
        procedimento: txt(r.col5), item_codigo: txt(r.col6), item_descricao: txt(r.col7), valor: num(r.col8), moeda: txt(r.col9),
      })).filter((r) => r.operadora_id === id && r.procedimento_id !== null && r.valor !== null && r.valor > 0);
      if (linhas.length === 0) { vazias.push(id); continue; }
      const { data, error } = await supabase.rpc("catalogo_preco_sincronizar", { p_operadora_id: id, p_linhas: linhas });
      if (error) throw new Error(error.message);
      resultado.push(data);
    } catch (e) {
      erros.push(`operadora ${id}: ${e instanceof Error ? e.message : "erro desconhecido"}`);
    }
    await dorme(300);
  }
  return { operadoras: resultado, sem_preco: vazias, pendentes, erros };
}

const dia = (d: Date) => d.toISOString().slice(0, 10);

// Relatório 13825 (marcações) em faixa de datas; se o Klingo cortar, divide a faixa ao meio. As linhas têm dados
// de paciente: ficam só na memória desta função e nunca são gravadas, devolvidas nem escritas em log.
async function marcacoes(token: string, de: string, ate: string, nivel = 0): Promise<Row[]> {
  const params = new URLSearchParams({ id: "13825", ":periodo0": "l", ":periodo0-from": de, ":periodo0-to": ate });
  const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status} nas marcações`);
  const payload = await res.json();
  if (payload?.error) throw new Error("Klingo retornou erro nas marcações");
  if (payload?.limit) {
    if (de >= ate || nivel >= 4) throw new Error("O Klingo cortou as marcações mesmo em faixa curta");
    const meio = dia(new Date((Date.parse(`${de}T00:00:00Z`) + Date.parse(`${ate}T00:00:00Z`)) / 2));
    const a = await marcacoes(token, de, meio, nivel + 1);
    const b = await marcacoes(token, dia(new Date(Date.parse(`${meio}T00:00:00Z`) + 86_400_000)), ate, nivel + 1);
    return [...a, ...b];
  }
  if (payload?.result === "") return [];
  const dados = payload?.result?.data;
  if (!Array.isArray(dados)) throw new Error("Formato inesperado nas marcações");
  return dados as Row[];
}

// Preço Particular = valor das marcações abertas de Particular dos últimos 90 dias, agregado por procedimento.
// Confiança alta: o valor mais recente se repete em 2 ou mais marcações e nunca variou; média: repete mas já variou; baixa: 1 só.
async function precosParticular(supabase: Supa, token: string) {
  const hoje = new Date();
  const faixas: Array<[string, string]> = [];
  for (let i = 3; i >= 0; i--) {
    const ate = new Date(hoje.getTime() + (30 - i * 30) * 86_400_000);
    const de = new Date(ate.getTime() - 29 * 86_400_000);
    faixas.push([dia(de), dia(ate)]);
  }
  const corte = dia(new Date(hoje.getTime() - 90 * 86_400_000));
  const porProc = new Map<string, { criado: string; valor: number }[]>();
  const demanda = new Map<string, number>();
  let lidas = 0;
  for (const [de, ate] of faixas) {
    for (const r of await marcacoes(token, de, ate)) {
      lidas++;
      const nome = String(r.col5 ?? "").trim();
      const criado = String(r.col3 ?? "").slice(0, 19);
      if (!nome || r.col12 !== "Aberta" || criado.slice(0, 10) < corte) continue;
      demanda.set(nome, (demanda.get(nome) ?? 0) + 1);
      const valor = num(r.col8);
      if (!/particular/i.test(String(r.col6 ?? "")) || valor === null || valor <= 0) continue;
      const lista = porProc.get(nome) ?? [];
      lista.push({ criado, valor });
      porProc.set(nome, lista);
    }
    await dorme(300);
  }
  const linhas = [...porProc.entries()].map(([procedimento, l]) => {
    l.sort((a, b) => (a.criado < b.criado ? 1 : -1));
    const valor = l[0].valor;
    const iguais = l.filter((x) => x.valor === valor).length;
    const min = Math.min(...l.map((x) => x.valor));
    const max = Math.max(...l.map((x) => x.valor));
    return {
      procedimento, valor, amostras: l.length, valor_min: min, valor_max: max, ultima_marcacao: l[0].criado.slice(0, 10),
      confianca: iguais >= 2 && min === max ? "alta" : iguais >= 2 ? "media" : "baixa",
    };
  });
  if (linhas.length === 0) throw new Error("Nenhuma marcação de Particular com valor nos últimos 90 dias: nada foi alterado");
  const { data, error } = await supabase.rpc("catalogo_preco_particular_sincronizar", {
    p_linhas: linhas, p_demanda: [...demanda.entries()].map(([procedimento, marcacoes]) => ({ procedimento, marcacoes })),
  });
  if (error) throw new Error(error.message);
  const confianca = { alta: 0, media: 0, baixa: 0 } as Record<string, number>;
  for (const l of linhas) confianca[l.confianca]++;
  return { marcacoes_lidas: lidas, procedimentos_particular: linhas.length, confianca, banco: data };
}

// Agenda ocupada: relatório #7 (marcações) para os próximos 45 dias, SEM nenhum dado de paciente.
// Só quando, quem atende, onde e qual exame (para estimar a duração). Linhas sem profissional ou unidade são ignoradas.
// Só marca a atualização como completa se TODAS as faixas foram lidas; se uma falhar, os dados anteriores continuam valendo.
async function agendaOcupacao(supabase: Supa, token: string) {
  const inicioExecucao = new Date().toISOString();
  const hoje = new Date(Date.now() - 3 * 3600_000);
  const faixas: Array<[string, string]> = [];
  for (let i = 0; i < 46; i += 7) {
    faixas.push([dia(new Date(hoje.getTime() + i * 86_400_000)), dia(new Date(hoje.getTime() + Math.min(i + 6, 45) * 86_400_000))]);
  }
  const lido = async (de: string, ate: string, nivel = 0): Promise<Row[]> => {
    const params = new URLSearchParams({ id: "7", ":data_atendimento": "l", ":data_atendimento-from": de, ":data_atendimento-to": ate });
    const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status} na agenda marcada`);
    const payload = await res.json();
    if (payload?.error) throw new Error("Klingo retornou erro na agenda marcada");
    if (payload?.limit) {
      if (de >= ate || nivel >= 4) throw new Error("O Klingo cortou a agenda marcada mesmo em faixa curta");
      const meio = dia(new Date((Date.parse(`${de}T00:00:00Z`) + Date.parse(`${ate}T00:00:00Z`)) / 2));
      return [...await lido(de, meio, nivel + 1), ...await lido(dia(new Date(Date.parse(`${meio}T00:00:00Z`) + 86_400_000)), ate, nivel + 1)];
    }
    if (payload?.result === "") return [];
    const dados = payload?.result?.data;
    if (!Array.isArray(dados)) throw new Error("Formato inesperado na agenda marcada");
    return dados as Row[];
  };
  const agrupado = new Map<string, { inicio: string; profissional: string; unidade: string; procedimento: string; qtd: number }>();
  let lidas = 0;
  for (const [de, ate] of faixas) {
    for (const r of await lido(de, ate)) {
      lidas++;
      const inicio = String(r.Data_Atendimento ?? "").slice(0, 19).replace("T", " ");
      const profissional = String(r.Medico ?? "").trim(), unidade = String(r.Unidade ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(inicio) || !profissional || !unidade) continue;
      const chave = `${inicio}|${profissional}|${unidade}`;
      const g = agrupado.get(chave);
      if (g) g.qtd += 1;
      else agrupado.set(chave, { inicio, profissional, unidade, procedimento: String(r.Procedimento ?? "").trim(), qtd: 1 });
    }
    await dorme(300);
  }
  if (lidas === 0) throw new Error("A agenda marcada veio vazia: nada foi alterado");
  const linhas = [...agrupado.values()];
  let gravadas = 0;
  for (let i = 0; i < linhas.length; i += 1500) {
    const { data, error } = await supabase.rpc("agenda_ocupacao_atualizar", { p_linhas: linhas.slice(i, i + 1500), p_execucao: inicioExecucao, p_finalizar: false });
    if (error) throw new Error(error.message);
    gravadas += Number((data as Row)?.gravadas ?? 0);
  }
  const { data: fim, error: erroFim } = await supabase.rpc("agenda_ocupacao_atualizar", { p_linhas: [], p_execucao: inicioExecucao, p_finalizar: true });
  if (erroFim) throw new Error(erroFim.message);
  return { marcacoes_lidas: lidas, horarios_ocupados: linhas.length, gravadas, vigentes: (fim as Row)?.vigentes ?? null };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
  if (!seg?.valor || req.headers.get("x-sync-key") !== seg.valor) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);

  const corpo = await req.json().catch(() => ({}));
  if (corpo?.inspecionar !== undefined) {
    const id = String(corpo.inspecionar);
    if (!INSPECIONAVEIS.has(id)) return json({ error: "Relatório não liberado para inspeção" }, 400);
    try {
      const filtros: Record<string, string> = {};
      for (const [k, v] of Object.entries(corpo.filtros ?? {})) if (/^:?[A-Za-z0-9_-]{1,40}$/.test(k)) filtros[k] = String(v).slice(0, 40);
      const somente: Record<string, string> = {};
      for (const [k, v] of Object.entries(corpo.somente ?? {})) somente[k] = String(v);
      const bloqueadas = COLUNAS_PACIENTE[id];
      if (bloqueadas && ([corpo.agrupar, ...Object.keys(somente)].some((c) => typeof c === "string" && bloqueadas.has(c)))) {
        return json({ error: "Coluna com dado de paciente não pode ser inspecionada" }, 400);
      }
      return json(await inspecionar(id, token, filtros, typeof corpo.agrupar === "string" ? corpo.agrupar : null, somente));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "erro desconhecido" }, 502);
    }
  }

  // Agenda ocupada: {"agenda":"ocupacao"}
  if (corpo?.agenda === "ocupacao") {
    try {
      return json(await agendaOcupacao(supabase, token));
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "erro desconhecido" }, 502);
    }
  }

  // Preços: {"precos":"convenio"} (opcional "operadoras":[17,6]) ou {"precos":"particular"}.
  if (corpo?.precos === "convenio" || corpo?.precos === "particular") {
    try {
      if (corpo.precos === "particular") return json(await precosParticular(supabase, token));
      const pedidas = Array.isArray(corpo.operadoras) ? corpo.operadoras.map(Number).filter((n: number) => Number.isInteger(n) && n > 0 && n < 1000) : null;
      const r = await precosConvenio(supabase, token, pedidas && pedidas.length ? pedidas : null);
      return json(r, r.erros.length ? 207 : 200);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "erro desconhecido" }, 502);
    }
  }

  const resultado: Record<string, unknown> = {};
  const erros: string[] = [];
  const etapas: Array<[string, string, (d: Row[]) => unknown[]]> = [
    ["procedimento", "13981", (d) => d.map((r) => ({
      id: num(r.col0), nome: txt(r.col1), tuss: txt(r.col2), especialidade: txt(r.col5), classe: txt(r.col6),
      idade_min: num(r.col8), idade_max: num(r.col9), sexo: txt(r.col10), preparo: txt(r.col13),
    })).filter((r) => r.id !== null && r.nome)],
    ["plano", "12301", (d) => d.map((r) => ({ operadora: txt(r.col0), plano: txt(r.col1), produto: txt(r.col2) })).filter((r) => r.operadora || r.plano)],
    ["agenda", "13984", (d) => d.map((r) => ({
      unidade: txt(r.col3), local: txt(r.col4), profissional_id: num(r.col5), profissional: txt(r.col6), especialidade: txt(r.col8),
      procedimento_id: num(r.col9), procedimento: txt(r.col10), dia_num: num(r.col11), dia: txt(r.col12),
      hora_ini: txt(r.col13), hora_fim: txt(r.col14), duracao_min: num(r.col15), operadoras: txt(r.col16),
      tele: r.col17 === "S", vagas_extras: num(r.col18), vig_ini: txt(r.col19), vig_fim: txt(r.col20),
    })).filter((r) => r.profissional && r.dia && r.hora_ini && r.hora_fim && r.vig_ini && r.vig_fim)],
  ];

  // Cada relatório é independente: se um falhar (ou vier cortado), o catálogo anterior dele continua valendo.
  for (const [tipo, id, mapear] of etapas) {
    try {
      const linhas = mapear(await relatorio(id, token));
      const { data, error } = await supabase.rpc("catalogo_sincronizar", { p_tipo: tipo, p_linhas: linhas });
      if (error) throw new Error(error.message);
      resultado[tipo] = data;
    } catch (e) {
      erros.push(`${tipo}: ${e instanceof Error ? e.message : "erro desconhecido"}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return json({ atualizados: resultado, erros }, erros.length ? 207 : 200);
});
