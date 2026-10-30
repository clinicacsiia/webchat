// FLUXOGRAMA: entrada (instalação nova = fila-biometria.sql; banco no estado v1 = o mesmo arquivo com as 5 funções devolvidas ao texto da v1) -> validação (aplica fila-biometria-v2-delta.sql sobre o estado v1) -> lógica (compara, função por função, o texto do corpo e o privilégio de execução de anon/authenticated; confere que as assinaturas antigas sumiram) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const SEGS = { segJwt: 'segredo-jwt-de-teste-com-mais-de-32-caracteres-aaaa', segN8n: 'segredo-n8n-de-teste-bbbbbbbbbbbbbbbbbbbbbbbb' };
const completo = readFileSync(`${REPO}/supabase/fila-biometria.sql`, 'utf8');
const delta = readFileSync(`${REPO}/supabase/fila-biometria-v2-delta.sql`, 'utf8');

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };

const trocar = (texto, de, para) => {
  if (!texto.includes(de)) throw new Error(`trecho não encontrado para montar o estado v1: ${de.slice(0, 60)}`);
  return texto.replace(de, para);
};
const bloco = (nome) => {
  const m = completo.match(new RegExp(`create or replace function public\\.${nome}\\([\\s\\S]*?end \\$\\$;\\n`));
  if (!m) throw new Error(`função ${nome} não encontrada`);
  return m[0];
};

// Devolve as 5 funções ao texto exato da v1 (segredo em parâmetro; sem link_agendado; reenvio sem checagem de config).
function funcoesV1() {
  const v1 = [];
  let entrar = bloco('fila_entrar');
  entrar = trocar(entrar, "  v_ativo boolean := coalesce((select valor from public.config where chave = 'fila_webhook_url'), '') <> '';\n", '');
  entrar = trocar(entrar, ", 'link_agendado', v_ativo);", ');');
  v1.push(entrar);

  let reenviar = bloco('fila_reenviar_link');
  reenviar = trocar(reenviar, "  if coalesce((select valor from public.config where chave = 'fila_webhook_url'), '') = '' then\n    raise exception 'O envio do link por e-mail ainda não está configurado (config.fila_webhook_url).' using errcode = 'P0001';\n  end if;\n", '');
  v1.push(reenviar);

  let emitir = bloco('fila_emitir_token');
  emitir = trocar(emitir, 'fila_emitir_token(p_atendimento uuid)', 'fila_emitir_token(p_segredo text, p_atendimento uuid)');
  emitir = trocar(emitir, 'if not public.fila_n8n_autorizado() then', 'if not public.fila_segredo_ok(p_segredo) then');
  v1.push(emitir);

  let contexto = bloco('assinatura_contexto');
  contexto = trocar(contexto, 'assinatura_contexto(p_token text, p_hash text)', 'assinatura_contexto(p_segredo text, p_token text, p_hash text)');
  contexto = trocar(contexto, 'if not public.fila_n8n_autorizado() then', 'if not public.fila_segredo_ok(p_segredo) then');
  v1.push(contexto);

  let registrarFn = bloco('assinatura_registrar');
  registrarFn = trocar(registrarFn, '  p_token text, p_hash text, p_resultado jsonb', '  p_segredo text, p_token text, p_hash text, p_resultado jsonb');
  registrarFn = trocar(registrarFn, 'if not public.fila_n8n_autorizado() then', 'if not public.fila_segredo_ok(p_segredo) then');
  v1.push(registrarFn);

  v1.push(`revoke all on function public.fila_emitir_token(text, uuid), public.assinatura_contexto(text, text, text),
  public.assinatura_registrar(text, text, text, jsonb, jsonb, text, text) from public;
grant execute on function public.fila_emitir_token(text, uuid), public.assinatura_contexto(text, text, text),
  public.assinatura_registrar(text, text, text, jsonb, jsonb, text, text) to anon, authenticated;`);
  return v1.join('\n');
}

const impressao = async (db) => (await db.query(`
  select p.oid::regprocedure::text as assinatura, md5(p.prosrc) as corpo, p.prosecdef as definer,
         has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as autenticado
    from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'fila\\_%' or p.proname like 'assinatura\\_%')
   order by 1`)).rows;

// A) instalação nova
const nova = await criarBanco(SEGS);
await nova.exec(completo);
const fpNova = await impressao(nova);

// B) estado v1 (instala o arquivo completo, troca as 5 funções para o texto v1 e remove as novas) + delta
const antigo = await criarBanco(SEGS);
await antigo.exec(completo);
await antigo.exec(`
  drop function public.fila_emitir_token(uuid);
  drop function public.assinatura_contexto(text, text);
  drop function public.assinatura_registrar(text, text, jsonb, jsonb, text, text);
  drop function public.fila_n8n_autorizado();
  drop function public.fila_segredo_do_cabecalho();
`);
await antigo.exec(funcoesV1());
const fpV1 = await impressao(antigo);
registrar('o estado v1 reconstruído tem as 3 RPCs antigas (segredo em parâmetro) e não tem o cabeçalho',
  fpV1.some((f) => f.assinatura === 'fila_emitir_token(text,uuid)') && fpV1.some((f) => f.assinatura === 'assinatura_contexto(text,text,text)')
  && !fpV1.some((f) => f.assinatura === 'fila_n8n_autorizado()'));

const erroDelta = await antigo.exec(delta).then(() => null, (e) => e.message);
registrar('o delta aplica sobre o estado v1 sem erro', erroDelta === null, erroDelta ?? '');
const fpDepois = await impressao(antigo);

registrar('as 3 assinaturas antigas sumiram', !fpDepois.some((f) => /^(fila_emitir_token\(text,uuid\)|assinatura_contexto\(text,text,text\)|assinatura_registrar\(text,text,text,jsonb,jsonb,text,text\))$/.test(f.assinatura)));
const mapa = (fp) => Object.fromEntries(fp.map((f) => [f.assinatura, `${f.corpo}|${f.definer}|${f.anon}|${f.autenticado}`]));
const a = mapa(fpNova), b = mapa(fpDepois);
const diferentes = Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
registrar(`v1 + delta = instalação nova (${Object.keys(a).length} funções: corpo, definer e privilégios de execução)`, diferentes.length === 0, diferentes.join(', '));

const erroSegundaVez = await antigo.exec(delta).then(() => null, (e) => e.message);
registrar('o delta é idempotente (segunda aplicação sem erro)', erroSegundaVez === null, erroSegundaVez ?? '');

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
await nova.close(); await antigo.close();
process.exit(falhas ? 1 : 0);
