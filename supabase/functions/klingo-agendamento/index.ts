// FLUXOGRAMA: entrada (POST JSON {"acao": "...", ...} vindo da página pública /agendamento/, sem login) -> validação (tamanho do corpo, ação conhecida, campos conferidos um a um,
//   CPF com dígito verificador, travas por CPF) -> lógica (regras.ts: catálogos e horários só leem; ações do paciente conferem CPF + nascimento no Klingo antes e depois do login;
//   toda chamada passa pela cota global do banco) -> saída (JSON enxuto; nunca corpo de erro do Klingo, CPF, RG, foto nem contato sem máscara; nada de paciente vai para log)
// Versão 1.0 — 13/11/2026 / Mudança: primeira versão (página de agendamento com tudo o que a API externa do Klingo permite, menos dinheiro).
//
// Publicar com verify_jwt=false (a página é pública; quem protege é a conferência de CPF + nascimento e as travas em regras.ts).
// Secrets: KLINGO_APP_TOKEN (o mesmo das outras funções) e, opcional, AGENDAMENTO_RESULTADO=1 (liga a entrega de laudo; desligada por padrão). Tabela usada: klingo_identidade (já existe); RPCs: klingo_hash, klingo_cota_pegar, klingo_cota_429,
// klingo_identidade_registrar, klingo_pre_gravar. NÃO cria tabela nem função no banco.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi } from "./api.ts";
import { type Banco, type Ctx, tratar } from "./regras.ts";

const ORIGENS = ["https://clinicacsiia.github.io", "http://localhost:8000", "http://localhost:8080", "http://127.0.0.1:8000", "http://127.0.0.1:8080"];
const MAX_CORPO = 16 * 1024;

const cors = (origem: string | null): Record<string, string> => ({
  ...(origem && ORIGENS.includes(origem) ? { "Access-Control-Allow-Origin": origem, Vary: "Origin" } : {}),
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
});
const json = (b: unknown, status: number, origem: string | null) => new Response(JSON.stringify(b), { status, headers: { ...cors(origem), "Content-Type": "application/json" } });
const dataSP = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());

// Marca dos pré-cadastros criados por esta página (klingo_pre_gravar exige um uuid de operação; aqui é sempre o mesmo): serve para contar o teto diário.
const OPERACAO_PAGINA = "00000000-0000-4000-8000-0000000a9e11";

const cache = new Map<string, { ate: number; v: unknown }>();

Deno.serve(async (req: Request) => {
  const origem = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origem) });
  if (req.method !== "POST") return json({ ok: false, motivo: "metodo" }, 405, origem);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ ok: false, motivo: "sem_configuracao" }, 500, origem);

  const texto = await req.text().catch(() => "");
  if (texto.length > MAX_CORPO) return json({ ok: false, motivo: "corpo_grande" }, 413, origem);
  let corpo: Record<string, unknown>;
  try { const x = JSON.parse(texto); if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("x"); corpo = x; } catch { return json({ ok: false, motivo: "json_invalido" }, 400, origem); }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
  const hash = async (t: string) => { const { data, error } = await rpc("klingo_hash", { p_texto: t }); if (error || typeof data !== "string") throw new Error("hash"); return data; };

  const db: Banco = {
    hash,
    async divergentesRecentes(cpfHash) {
      const desde = new Date(Date.now() - 3_600_000).toISOString();
      const { count, error } = await supabase.from("klingo_identidade").select("id", { count: "exact", head: true }).eq("cpf_hash", cpfHash).eq("situacao", "divergente").gte("conferido_em", desde);
      if (error) throw new Error("tentativas");   // na dúvida, NÃO libera (a ação falha com 500)
      return count ?? 0;
    },
    async registrarIdentidade(cpf, nascimento, r) {
      await rpc("klingo_identidade_registrar", { p_cpf: cpf, p_nasc: nascimento, p_r: r, p_conversa: null });
    },
    async preDoPar(cpf, nascimento) {
      const chave = await hash(`${cpf}|${nascimento}`);
      const { data } = await supabase.from("klingo_identidade").select("klingo_id").eq("chave", chave).eq("tipo", "pre").maybeSingle();
      return data ? { klingo_id: (data as { klingo_id: string | null }).klingo_id } : null;
    },
    async reservarPre(cpf, nascimento) {
      const chave = await hash(`${cpf}|${nascimento}`), cpfHash = await hash(cpf);
      const { error } = await supabase.from("klingo_identidade").insert({ chave, cpf_hash: cpfHash, tipo: "pre", klingo_id: null, situacao: "pre_cadastro" });
      if (!error) return { criado: true, mesmoPar: true, klingo_id: null, idadeMin: 0 };
      if ((error as { code?: string }).code !== "23505") throw new Error("reservar_pre");
      const { data } = await supabase.from("klingo_identidade").select("chave, klingo_id, conferido_em").eq("cpf_hash", cpfHash).eq("tipo", "pre").limit(1).maybeSingle();
      const d = data as { chave: string; klingo_id: string | null; conferido_em: string } | null;
      return { criado: false, mesmoPar: d?.chave === chave, klingo_id: d?.klingo_id ?? null, idadeMin: d ? (Date.now() - Date.parse(d.conferido_em)) / 60_000 : 0 };
    },
    async gravarPre(cpf, nascimento, klingoId) {
      const { error } = await rpc("klingo_pre_gravar", { p_op: OPERACAO_PAGINA, p_cpf: cpf, p_nasc: nascimento, p_klingo_id: klingoId });
      if (error) throw new Error("gravar_pre");
    },
    async soltarPre(cpf, nascimento) {
      await supabase.from("klingo_identidade").delete().eq("chave", await hash(`${cpf}|${nascimento}`)).eq("tipo", "pre").is("klingo_id", null);
    },
    async precadastrosRecentes() {
      const desde = new Date(Date.now() - 86_400_000).toISOString();
      const { count } = await supabase.from("klingo_identidade").select("id", { count: "exact", head: true }).eq("tipo", "pre").or(`criado_pela_operacao.is.null,criado_pela_operacao.eq.${OPERACAO_PAGINA}`).gte("conferido_em", desde);
      return count ?? 0;
    },
  };

  const api = new KlingoApi(token, (u, i) => fetch(u, i), { antes: cotaGlobal(rpc), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); } });
  const ctx: Ctx = { api, db, hoje: dataSP, agora: () => Date.now(), uuid: () => crypto.randomUUID(), cache, resultado: Deno.env.get("AGENDAMENTO_RESULTADO") === "1" };
  try {
    const r = await tratar(ctx, corpo);
    return json(r.corpo, r.status, origem);
  } catch {
    return json({ ok: false, motivo: "erro" }, 500, origem);   // nunca devolve a mensagem do erro
  }
});
