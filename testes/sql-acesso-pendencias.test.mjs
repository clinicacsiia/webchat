// FLUXOGRAMA: entrada (o retrato da produção + acesso-rapido-paciente.sql + acesso-rapido-chat.sql + acesso-rapido-pendencias.sql, aplicado duas vezes; pacientes da clínica e cadastros do acesso rápido INVENTADOS) -> validação (chamadas como anônimo com o código do aparelho, e como equipe logada) -> lógica (lista o que falta por pessoa; confere o CPF em silêncio com a base da clínica e marca dúvidas só para a equipe; nada da clínica volta para o paciente) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (pendências para todo paciente do acesso rápido)
// Dados: todos inventados neste arquivo (CPF 529.982.247-25 e 111.444.777-35 passam na conferência). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-chat.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-pendencias.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-rapido-pendencias.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const C1 = '52998224725', C1_TXT = '529.982.247-25', C2 = '11144477735';
const rpc = async (nome, args) => {
  const ks = Object.keys(args); await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === 'object' ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const cad = async (tel, nome, nasc, filhos = []) => (await rpc('app_cadastrar', { p_telefone: tel, p_nome: nome, p_nascimento: nasc, p_pin: '1357', p_filhos: filhos, p_aparelho: 't' }));
const pend = (tok) => rpc('app_pendencias', { p_token: tok });
const resp = (tok, pessoa, campo, valor) => rpc('app_pendencia_responder', { p_token: tok, p_pessoa: pessoa, p_campo: campo, p_valor: valor });
const linha = (tel) => um(`select * from public.app_paciente where telefone = $1`, [tel]);

// clínica: Bia (cpf C1, celular 71991230002); Duda e Dora têm o MESMO cpf C2 (repetido); Eva tem só o celular 71991230005
const bia = (await q(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc, cpf) values ('Bia Costa Teste', 'bia costa teste', array['71991230002'], '1990-02-03', '${C1_TXT}') returning id`))[0].id;
await db.exec(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc, cpf) values ('Duda Lima Teste', 'duda lima teste', array['71991230099'], '1980-01-01', '${C2}'), ('Dora Lima Teste', 'dora lima teste', array['71991230098'], '1981-01-01', '${C2}'), ('Eva Dias Teste', 'eva dias teste', array['5571991230005'], '1975-05-05', null)`);

const ana = await cad('71991230001', 'Ana Souza Teste', '1988-04-12', [{ nome: 'Leo Souza Teste', nascimento: '2019-08-30' }]);
await caso('paciente novo (nada na clínica): faltam o CPF dela, o e-mail (opcional) e o CPF do filho', async () => {
  const r = await pend(ana.token);
  const ids = r.pendencias.map((x) => x.campo + ':' + x.pessoa).sort();
  return { ok: r.ok && r.pendencias.length === 3 && r.pendencias.some((x) => x.id === 'eu:cpf' && x.opcional === false) && r.pendencias.some((x) => x.id === 'eu:email' && x.opcional === true) && r.pendencias.some((x) => x.nome === 'Leo Souza Teste' && x.campo === 'cpf'), detalhe: ids.join(' ') };
});
await caso('sem o PIN digitado (aparelho bloqueado) ou com código inválido, nada é listado nem gravado', async () => {
  await db.exec(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const a = await pend(ana.token), b = await resp(ana.token, 'eu', 'cpf', C1), c = await pend('codigo-que-nao-existe');
  await db.exec(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  return { ok: a.erro === 'bloqueado' && b.erro === 'bloqueado' && c.erro === 'sessao' && (await linha('71991230001')).cpf === null };
});
await caso('CPF inválido é recusado; e-mail inválido também; campo desconhecido também', async () => {
  const a = await resp(ana.token, 'eu', 'cpf', '12345678900'), b = await resp(ana.token, 'eu', 'email', 'isto-nao-e-email'), c = await resp(ana.token, 'eu', 'telefone', '71999999999');
  return { ok: a.erro === 'cpf' && b.erro === 'email' && c.erro === 'campo' };
});
await caso('CPF e e-mail respondidos somem da lista; o CPF do filho também; não volta CPF inteiro', async () => {
  const a = await resp(ana.token, 'eu', 'cpf', '123.456.789-09');
  const email = await resp(ana.token, 'eu', 'email', 'ANA@exemplo.invalid');
  const leo = (await pend(ana.token)).pendencias.find((x) => x.nome === 'Leo Souza Teste');
  const c = await resp(ana.token, leo.pessoa, 'cpf', C2);
  const f = await pend(ana.token);
  return { ok: a.ok && email.ok && c.ok && f.pendencias.length === 0 && !JSON.stringify([a, email, c, f]).includes('12345678909'), detalhe: JSON.stringify(f.pendencias) };
});
await caso('o e-mail fica em minúsculas e o CPF só em app_paciente / app_filho (guardados no banco)', async () => {
  const r = await linha('71991230001');
  const f = (await q(`select cpf from public.app_filho`))[0];
  return { ok: r.email === 'ana@exemplo.invalid' && r.cpf === '12345678909' && f.cpf === C2 };
});
await caso('responder de novo não troca o que já está salvo (só preenche o que falta)', async () => {
  await resp(ana.token, 'eu', 'cpf', C1); await resp(ana.token, 'eu', 'email', 'outra@exemplo.invalid');
  const r = await linha('71991230001');
  return { ok: r.cpf === '12345678909' && r.email === 'ana@exemplo.invalid' };
});
await caso('Ana (CPF que não existe na clínica; celular também não): sem marca para a equipe', async () => ({ ok: (await linha('71991230001')).revisar_motivo === null }));

const b = await cad('71991230002', 'Bia Costa Teste', '1990-02-03');
await caso('Bia informa o CPF que a clínica tem para o MESMO celular: o cadastro é sugerido (nunca vinculado) e sem marca', async () => {
  const r = await resp(b.token, 'eu', 'cpf', C1);
  const l = await linha('71991230002');
  return { ok: r.ok && l.paciente_sugerido_id === bia && l.revisar_motivo === null, detalhe: JSON.stringify({ sug: l.paciente_sugerido_id === bia, m: l.revisar_motivo }) };
});
await caso('a resposta para a Bia NÃO diz se bateu com a clínica (sem teste de CPF por tentativa)', async () => {
  const r = await pend(b.token);
  const txt = JSON.stringify(r);
  return { ok: r.ok === true && !/sugerid|revis|bateu|confere|motivo/i.test(txt), detalhe: txt.slice(0, 160) };
});

const c = await cad('71991230003', 'Cris Alves Teste', '1992-03-04');
await caso('CPF da Bia digitado por OUTRA pessoa (outro celular): marca "cpf_com_outro_celular" só para a equipe, sem aviso ao paciente', async () => {
  const r = await resp(c.token, 'eu', 'cpf', C1);
  const l = await linha('71991230003');
  return { ok: r.ok === true && l.revisar_motivo === 'cpf_com_outro_celular' && l.paciente_sugerido_id === null && !JSON.stringify(r).includes('outro_celular'), detalhe: l.revisar_motivo };
});
const d = await cad('71991230004', 'Davi Lima Teste', '1985-01-01');
await caso('CPF repetido em dois cadastros da clínica: marca "cpf_repetido_na_clinica"', async () => {
  await resp(d.token, 'eu', 'cpf', C2); return { ok: (await linha('71991230004')).revisar_motivo === 'cpf_repetido_na_clinica' };
});
const e = await cad('71991230005', 'Eva Dias Teste', '1975-05-05');
await caso('celular que já existe na clínica (com 55) mas CPF que não existe lá: marca "cpf_nao_bate_com_o_celular"', async () => {
  await resp(e.token, 'eu', 'cpf', '39053344705'); return { ok: (await linha('71991230005')).revisar_motivo === 'cpf_nao_bate_com_o_celular' };
});
await caso('CPF digitado no chat (gravado direto, atualizado_em novo) é conferido na próxima chamada de app_pendencias', async () => {
  const g = await cad('71991230006', 'Gabi Rocha Teste', '1991-06-06');
  await db.exec(`update public.app_paciente set cpf = '${C1}', atualizado_em = now() + interval '1 second' where telefone = '71991230006'`);
  await pend(g.token);
  const l = await linha('71991230006');
  return { ok: l.revisar_motivo === 'cpf_com_outro_celular' && l.cadastro_conferido_em !== null };
});

// ---- equipe
const ADM = '00000000-0000-4000-8000-0000000000a1', MKT = '00000000-0000-4000-8000-0000000000a2', PAC = '00000000-0000-4000-8000-0000000000a3';
await db.exec(`insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'), ('${MKT}', 'mkt@exemplo.invalid'), ('${PAC}', 'pac@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Adm Teste', 'adm@exemplo.invalid', 'admin', true), ('${MKT}', 'Mkt Teste', 'mkt@exemplo.invalid', 'marketing', true) on conflict (id) do update set papel = excluded.papel, ativo = true;`);
const equipe = async (uid, fn, args = []) => { await como(uid); try { return (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r; } catch (err) { return { erro: String(err.message) }; } finally { await db.exec('reset role'); } };
await caso('a equipe (admin) vê as dúvidas, sem CPF inteiro; marketing e paciente logado não veem', async () => {
  const lista = await equipe(ADM, 'painel_app_revisoes');
  const m = await equipe(MKT, 'painel_app_revisoes'), p = await equipe(PAC, 'painel_app_revisoes');
  const motivos = lista.map((x) => x.motivo).sort();
  const txt = JSON.stringify(lista);
  return { ok: motivos.includes('cpf_com_outro_celular') && motivos.includes('cpf_repetido_na_clinica') && motivos.includes('cpf_nao_bate_com_o_celular') && !txt.includes(C1) && !txt.includes('39053344705') && /Só a equipe/.test(m.erro || '') && /Só a equipe/.test(p.erro || ''), detalhe: motivos.join() };
});
await caso('o público (anon) não executa as funções da equipe nem as internas', async () => {
  await anonimo(); let n = 0;
  for (const f of ['painel_app_revisoes()', 'painel_app_revisao_resolver(null)', 'app_conferir_cadastro(null)', 'app_pendencias_lista(null)']) { try { await q(`select public.${f}`); } catch { n++; } }
  await db.exec('reset role'); return { ok: n === 4 };
});
await caso('a equipe resolve uma dúvida e ela some da lista (e não volta sozinha)', async () => {
  const id = (await linha('71991230004')).id;
  const n = await equipe(ADM, 'painel_app_revisao_resolver', [id]);
  const lista = await equipe(ADM, 'painel_app_revisoes');
  return { ok: n === 1 && !lista.some((x) => x.id === id) };
});
await caso('celular que já existe na clínica e não tem vínculo aparece como "celular_na_base_sem_vinculo" até a equipe resolver', async () => {
  const h = await cad('71991230098', 'Helena Teste Silva', '1993-01-01');   // mesmo celular da Dora, sem informar CPF
  const lista = await equipe(ADM, 'painel_app_revisoes');
  const x = lista.find((r) => r.celular === '71991230098');
  const n = await equipe(ADM, 'painel_app_revisao_resolver', [x.id]);
  const depois = await equipe(ADM, 'painel_app_revisoes');
  return { ok: x.motivo === 'celular_na_base_sem_vinculo' && n === 1 && !depois.some((r) => r.celular === '71991230098') };
});
await caso('colar a "última parte" depois não tira a permissão das funções de pendências', async () => {
  await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-ultima-parte.sql`, 'utf8'));
  const p = (await q(`select has_function_privilege('anon','public.app_pendencias(text)','execute') a, has_function_privilege('anon','public.app_pendencia_responder(text,text,text,text)','execute') b,
    has_function_privilege('anon','public.painel_app_revisoes()','execute') c, has_function_privilege('authenticated','public.painel_app_revisoes()','execute') d,
    has_function_privilege('anon','public.app_conferir_cadastro(uuid)','execute') e`))[0];
  return { ok: p.a && p.b && !p.c && p.d && !p.e, detalhe: JSON.stringify(p) };
});
await caso('interruptor desligado: pendências respondem "indisponivel"', async () => {
  await db.exec(`update public.config set valor = 'nao' where chave = 'app_acesso_modo'`);
  const r = await pend(ana.token); await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);
  return { ok: r.erro === 'indisponivel' };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
