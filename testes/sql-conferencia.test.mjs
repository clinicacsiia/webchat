// FLUXOGRAMA: entrada (clone da produção + supabase/klingo-conferencia.sql; marcações do Klingo e pedidos do chat INVENTADOS) -> validação (próprio x filho, ligação por pedido e por celular+nome, CPF/celular/e-mail diferentes só viram conflito em pedido próprio, nunca se sugere CPF em filho, nada em claro na tabela) -> lógica (lote idempotente, avisos criados/atualizados/fechados sozinhos, "Conferido" não reabre) -> saída (PASS/FAIL e a contagem final)
// Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial (conferência Klingo x webchat)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const { db, falhas } = await criarBancoProducao();
const { um, como } = ajudantes(db);

await db.exec(readFileSync(`${REPO}/supabase/klingo-conferencia.sql`, 'utf8'));

const ADM = '00000000-0000-4000-8000-0000000000b1', ATE = '00000000-0000-4000-8000-0000000000b2';
await db.exec(`
  insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'), ('${ATE}', 'ate@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'adm@exemplo.invalid', 'admin', true), ('${ATE}', 'Atendente Teste', 'ate@exemplo.invalid', 'atendente', true);
`);
let sal = (await um(`select valor from public.config where chave = 'ia_segredo'`))?.valor;
if (!sal) { sal = 'sal-de-teste'; await db.query(`insert into public.config (chave, valor) values ('ia_segredo', $1) on conflict (chave) do update set valor = excluded.valor`, [sal]); }
const sha = (t) => createHash('sha256').update(t).digest('hex');
const dig = (v) => String(v ?? '').replace(/\D/g, '');
const hFone = (v) => (dig(v).length >= 8 ? sha(dig(v).slice(-8) + sal) : '');
const hCpf = (v) => (dig(v).length === 11 ? sha(dig(v) + sal) : '');
const hMail = (v) => (v ? sha(String(v).toLowerCase() + sal) : '');
const hoje = (await um(`select (now() at time zone 'America/Sao_Paulo')::date::text as d`)).d;

let seq = 0;
// Conversa + pedido do chat. dados = o que o paciente digitou (no filho: nome/nascimento da criança; cpf/celular/e-mail do responsável).
const chat = async ({ tipo = 'proprio', fone, dados, marc }) => {
  seq++;
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Contato ' + seq, fone])).id;
  const conv = (await um(`insert into public.conversas (contato_id, nome_informado, status, paciente_tipo, paciente_nome, ia_ativa) values ($1, $2, 'em_atendimento', $3, $4, false) returning id`,
    [ct, dados.nome, tipo, tipo === 'filho' ? dados.nome : null])).id;
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, etapa, paciente, klingo_marcacoes) values ($1, 'exame', 'RAIO X', 'agendado', 'pronto', $2::jsonb, $3)`,
    [conv, JSON.stringify(dados), marc ? [marc] : null]);
  return conv;
};
const linha = (o) => ({ m: '1', em: hoje, para: hoje, o: 'Whatsapp', s: 'Aberta', u: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', pl: 'Particular', n: 'Paciente', fh: '', fh2: '', nasc: '2000-01-01', cpfh: '', emh: '', vz: [], ...o });
const lote = async (linhas) => (await um(`select public.klingo_conferir_lote($1::jsonb) as r`, [JSON.stringify(linhas)])).r;
const avisos = async () => (await db.query(`select tipo, resolvido_em is null as aberto, detalhe, conversa_id from public.paciente_aviso where tipo like 'klingo_%' and tipo in ('klingo_conflito','klingo_dado_faltando') order by id`)).rows;
const k = async (m) => (await um(`select * from public.klingo_conferencia where m = $1`, [m]));
const ler = async (fn, args = '') => { await como(ADM); try { return (await um(`select public.${fn}(${args}) as r`)).r; } finally { await como(null); } };

// A) próprio, tudo igual. B) próprio, CPF diferente e e-mail faltando no Klingo. C) filho: contatos do responsável diferentes e celular faltando. D) filho com nome diferente.
// E) ligado só por celular+nome (sem pedido). F) sem conversa. G) origem em branco, cancelada.
const cA = await chat({ fone: '71988880001', dados: { nome: 'Ana Teste Silva', cpf: '529.982.247-25', dt_nasc: '1990-05-17', email: 'ana@teste.invalid', celular: '71988880001' }, marc: '101' });
const cB = await chat({ fone: '71988880002', dados: { nome: 'Bia Teste Souza', cpf: '111.444.777-35', dt_nasc: '1985-03-02', email: 'bia@teste.invalid', celular: '71988880002' }, marc: '102' });
const cC = await chat({ tipo: 'filho', fone: '71988880003', dados: { nome: 'Caio Teste Lima', cpf: '390.533.447-05', dt_nasc: '2018-09-09', email: 'mae.caio@teste.invalid', celular: '71988880003' }, marc: '103' });
const cD = await chat({ tipo: 'filho', fone: '71988880004', dados: { nome: 'Davi Teste Rocha', cpf: '168.995.350-09', dt_nasc: '2019-01-20', celular: '71988880004' }, marc: '104' });
const cE = await chat({ fone: '71988880005', dados: { nome: 'Eva Teste Prado', dt_nasc: '1975-12-12' } });   // sem pedido ligado: entra por celular + nome
await db.query(`update public.pre_agendamentos set klingo_marcacoes = null where conversa_id = $1`, [cE]);

const L = [
  linha({ m: '101', n: 'Ana Teste Silva', fh: hFone('71988880001'), nasc: '1990-05-17', cpfh: hCpf('52998224725'), emh: hMail('ana@teste.invalid') }),
  linha({ m: '102', n: 'Bia Teste Souza', fh: hFone('71988880002'), nasc: '1985-03-02', cpfh: hCpf('99999999999'), emh: '', vz: ['email'] }),
  linha({ m: '103', n: 'Caio Teste Lima', fh: '', nasc: '2018-09-09', cpfh: hCpf('12345678909'), emh: hMail('outro@teste.invalid'), vz: ['celular'], o: 'Telefone' }),
  linha({ m: '104', n: 'Davi Outro Nome', fh: hFone('71988880004'), nasc: '2019-01-20', cpfh: '', emh: '', vz: ['cpf', 'email'] }),
  linha({ m: '105', n: 'Eva Teste Prado', fh: hFone('71988880005'), nasc: '1975-12-12', cpfh: hCpf('52998224725'), emh: hMail('eva@teste.invalid') }),
  linha({ m: '106', n: 'Fulano Sem Chat', fh: hFone('71988889999'), nasc: '1999-09-09', cpfh: '', emh: '', vz: ['cpf', 'email'], o: '' }),
  linha({ m: '107', n: 'Gui Cancelado', s: 'Cancelada', o: '', fh: hFone('71988887777'), vz: ['cpf', 'email'] }),
];

await caso('o clone da produção monta sem falhas e a migração aplica', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));

const r1 = await lote(L);
await caso('o lote grava uma linha por marcação, sem duplicar', async () => ({ ok: r1.lidas === 7 && (await um(`select count(*)::int n from public.klingo_conferencia`)).n === 7, detalhe: JSON.stringify(r1) }));

await caso('a tabela não guarda CPF, e-mail, telefone nem nascimento (só campos e marcas)', async () => {
  const cols = (await db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'klingo_conferencia'`)).rows.map((x) => x.column_name);
  const ruins = cols.filter((c) => /cpf|mail|fone|telefone|nasc|celular$|^nome/.test(c) && !['falta_no_klingo', 'conflito'].includes(c));
  return { ok: ruins.length === 0, detalhe: ruins.join(',') || cols.join(',') };
});

await caso('A: pedido ligado, tudo igual: nenhum conflito nem falta', async () => {
  const a = await k('101');
  return { ok: a.conversa_id === cA && a.ligacao === 'pedido' && a.conflito.length === 0 && a.falta_no_klingo.length === 0 && a.paciente_tipo === 'proprio', detalhe: JSON.stringify([a.ligacao, a.conflito, a.falta_no_klingo]) };
});
await caso('B (próprio): CPF diferente vira conflito; e-mail que o chat tem e o Klingo não, vira dado faltando', async () => {
  const b = await k('102');
  return { ok: JSON.stringify(b.conflito) === '["cpf"]' && JSON.stringify(b.falta_no_klingo) === '["email"]', detalhe: JSON.stringify([b.conflito, b.falta_no_klingo]) };
});
await caso('C (FILHO): CPF, e-mail diferentes são do responsável: sem conflito, e nunca se sugere CPF; celular do responsável pode faltar', async () => {
  const c = await k('103');
  return { ok: c.paciente_tipo === 'filho' && c.conflito.length === 0 && JSON.stringify(c.responsavel_diferente) === '["cpf","email"]' && JSON.stringify(c.falta_no_klingo) === '["celular"]', detalhe: JSON.stringify([c.conflito, c.responsavel_diferente, c.falta_no_klingo]) };
});
await caso('D (FILHO): nome da criança diferente continua sendo conflito; CPF do responsável que falta no Klingo NÃO é sugerido', async () => {
  const d = await k('104');
  return { ok: JSON.stringify(d.conflito) === '["nome"]' && !d.falta_no_klingo.includes('cpf'), detalhe: JSON.stringify([d.conflito, d.falta_no_klingo]) };
});
await caso('E: sem pedido ligado, entra por celular + nome (ligação telefone_nome) e compara o que tiver', async () => {
  const e = await k('105');
  return { ok: e.conversa_id === cE && e.ligacao === 'telefone_nome', detalhe: JSON.stringify([e.ligacao, e.conflito]) };
});
await caso('F/G: sem conversa não tem conflito nem aviso; origem em branco vira sem_origem', async () => {
  const f = await k('106'), g = await k('107');
  return { ok: f.conversa_id === null && f.conflito.length === 0 && f.falta_no_klingo.length === 0 && f.origem === 'sem_origem' && g.status_klingo === 'Cancelada', detalhe: f.origem };
});

const a1 = await um(`select public.klingo_conferir_avisos() as r`);
const av = await avisos();
await caso('avisos: B (conflito e faltando), C (só faltando, filho), D (só conflito); A e F sem aviso', async () => {
  const por = (c, t) => av.find((x) => x.conversa_id === c && x.tipo === t);
  const ok = por(cB, 'klingo_conflito') && por(cB, 'klingo_dado_faltando') && !por(cC, 'klingo_conflito') && por(cC, 'klingo_dado_faltando') && por(cD, 'klingo_conflito') && !por(cA, 'klingo_conflito') && !por(cA, 'klingo_dado_faltando');
  return { ok: !!ok && av.length === 4, detalhe: `${av.length} avisos: ${JSON.stringify(a1.r)}` };
});
await caso('aviso do filho: marca filho=true e nunca lista CPF como campo a cadastrar', async () => {
  const c = av.find((x) => x.conversa_id === cC && x.tipo === 'klingo_dado_faltando');
  return { ok: c && c.detalhe.filho === true && !c.detalhe.campos.includes('cpf') && JSON.stringify(c.detalhe.campos) === '["celular"]', detalhe: JSON.stringify(c && c.detalhe) };
});
await caso('rodar de novo não duplica avisos (idempotente)', async () => {
  await lote(L); await um(`select public.klingo_conferir_avisos() as r`);
  const n = (await avisos()).length;
  return { ok: n === 4, detalhe: `${n} avisos` };
});

await caso('"Conferido" pela equipe não reabre o aviso enquanto os dados forem os mesmos', async () => {
  await como(ATE);
  const id = (await um(`select id from public.paciente_aviso where conversa_id = $1 and tipo = 'klingo_conflito'`, [cD])).id;
  await um(`select public.paciente_aviso_resolver($1::bigint, false) as r`, [id]);
  await como(null);
  await lote(L); await um(`select public.klingo_conferir_avisos() as r`);
  const abertos = (await db.query(`select count(*)::int n from public.paciente_aviso where conversa_id = $1 and tipo = 'klingo_conflito' and resolvido_em is null`, [cD])).rows[0].n;
  return { ok: abertos === 0, detalhe: `abertos=${abertos}` };
});

await caso('quando o Klingo é corrigido, o aviso fecha sozinho', async () => {
  const L2 = L.map((x) => (x.m === '102' ? { ...x, cpfh: hCpf('11144477735'), emh: hMail('bia@teste.invalid'), vz: [] } : x));
  await lote(L2); const r = await um(`select public.klingo_conferir_avisos() as r`);
  const abertos = (await db.query(`select count(*)::int n from public.paciente_aviso where conversa_id = $1 and tipo in ('klingo_conflito','klingo_dado_faltando') and resolvido_em is null`, [cB])).rows[0].n;
  return { ok: abertos === 0, detalhe: `abertos=${abertos} ${JSON.stringify(r.r)}` };
});

// indicador: precisa de exames na Jornada para explicar "fora do banco" e "remarcadas".
await db.exec(`
  insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('t_ag', 'Agendado', 1, 'agendamento', 'klingo') on conflict do nothing;
  insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ('P1', current_date, 'CSI 1', 't_ag');
  insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_em, agendado_para, status)
  select (select id from public.jornada_card limit 1), 'm' || m, 'RAIO X', 'CSI 1', now(), now(), st from (values ('101', 'atendido'), ('102', 'agendado'), ('103', 'remarcado'), ('105', 'faltou')) v(m, st);
`);
await caso('o indicador explica a divergência: total, origem, fora do banco, remarcadas e novas marcações', async () => {
  const r = await ler('painel_indicadores_conferencia', `current_date, current_date`);
  const e = r.explicacao;
  return { ok: r.total === 7 && r.por_origem.Whatsapp === 4 && r.por_origem.Telefone === 1 && r.por_origem.sem_origem === 2 && e.no_banco === 4 && e.fora_do_banco === 3 && e.remarcadas === 1 && e.novas_marcacoes_indicador === 3 && e.canceladas_no_klingo === 1,
           detalhe: JSON.stringify({ t: r.total, o: r.por_origem, e }) };
});
await caso('o indicador mostra o webchat: ligadas, por tipo de ligação, situação do exame e a qualidade do cadastro do Klingo', async () => {
  const w = (await ler('painel_indicadores_conferencia', `current_date, current_date`)).webchat;
  const q = (await ler('painel_indicadores_conferencia', `current_date, current_date`)).qualidade_klingo;
  return { ok: w.marcacoes_ligadas === 5 && w.por_ligacao.pedido === 4 && w.por_ligacao.telefone_nome === 1 && w.exames.atendido === 1 && w.exames.faltou === 1 && w.exames.por_vir === 1 && w.exames.cancelado_ou_remarcado === 1 && w.exames.ainda_fora_do_banco === 1 && q.sem_celular >= 1,
           detalhe: JSON.stringify({ w, q }) };
});
await caso('o indicador lista, marcação por marcação, os problemas e as ligadas; filho identificado', async () => {
  const r = await ler('painel_indicadores_conferencia', `current_date, current_date`);
  const c = r.lista_problemas.find((x) => x.m === '103'), d = r.lista_ligadas.find((x) => x.m === '104');
  return { ok: r.lista_ligadas.length === 5 && r.lista_problemas.length >= 2 && c && c.tipo === 'filho' && d.tipo === 'filho', detalhe: `${r.lista_ligadas.length} ligadas, ${r.lista_problemas.length} com problema` };
});
await caso('período sem leitura avisa os dias sem dado', async () => {
  const r = await ler('painel_indicadores_conferencia', `current_date - 10, current_date - 8`);
  return { ok: r.total === 0 && r.dias_sem_leitura.length === 3, detalhe: JSON.stringify(r.dias_sem_leitura) };
});
await caso('só administrador e atendente leem o indicador; anônimo não executa o lote nem os avisos', async () => {
  let negou = false; try { await como(null); await db.exec(`set role anon;`); await db.query(`select public.klingo_conferir_lote('[]'::jsonb)`); } catch { negou = true; } finally { await db.exec(`reset role;`); }
  let negou2 = false; try { await db.exec(`set role anon;`); await db.query(`select public.painel_indicadores_conferencia()`); } catch { negou2 = true; } finally { await db.exec(`reset role;`); }
  return { ok: negou && negou2, detalhe: `lote negado=${negou} indicador negado=${negou2}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
