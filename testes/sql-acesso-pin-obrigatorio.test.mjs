// FLUXOGRAMA: entrada (o retrato da produção + as migrações do acesso rápido + acesso-rapido-pin-obrigatorio.sql, aplicada duas vezes; pacientes, conversas e cadastros INVENTADOS) -> validação (chamadas como anônimo, como aparelho com e sem PIN digitado e como equipe logada) -> lógica (porta ligada/desligada; "o que falta" sem entregar nada da clínica; CPF aproveitado do histórico só com celular + nome + nascimento juntos; cadastro com CPF e PIN tudo ou nada; registro de acesso com posição só quando permitido) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (PIN obrigatório na porta do chat)
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
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pendencias.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-pin-obrigatorio.sql`, 'utf8');
const sqlFechar = readFileSync(`${REPO}/supabase/acesso-rapido-acesso-log-fechar.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-rapido-pin-obrigatorio.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await caso('acesso-rapido-acesso-log-fechar.sql aplica duas vezes e tira toda permissão de tabela do público', async () => {
  await db.exec(sqlFechar); await db.exec(sqlFechar);
  const r = await um(`select has_table_privilege('anon', 'public.app_acesso_log', 'select') a, has_table_privilege('authenticated', 'public.app_acesso_log', 'select') b, has_table_privilege('anon', 'public.app_acesso_log', 'insert') c, has_table_privilege('authenticated', 'public.app_acesso_log', 'delete') d`);
  return { ok: !r.a && !r.b && !r.c && !r.d, detalhe: JSON.stringify(r) };
});
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const C1 = '52998224725', C1_TXT = '529.982.247-25', C2 = '11144477735';
const rpc = async (nome, args) => {
  const ks = Object.keys(args); await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === 'object' ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
const linha = (tel) => um(`select * from public.app_paciente where telefone = $1`, [tel]);
const pre = (tel, nome, nasc, filhos = []) => rpc('app_pre_cadastro', { p_telefone: tel, p_nome: nome, p_nascimento: nasc, p_filhos: filhos });
const criar = (o) => rpc('app_pin_criar', Object.assign({ p_pin: '1357', p_aparelho: 'Teste' }, o));

// ---- a porta
await caso('a porta nasce DESLIGADA e liga/desliga pela configuração', async () => {
  const a = await rpc('app_porta', {}); await cfg('app_pin_obrigatorio', 'sim');
  const b = await rpc('app_porta', {}); await cfg('app_acesso_modo', 'nao');
  const c = await rpc('app_porta', {}); await cfg('app_acesso_modo', 'sim'); await cfg('app_pin_obrigatorio', 'nao');
  return { ok: a.ativo === true && a.obrigatorio === false && a.local === false && b.obrigatorio === true && c.ativo === false && c.obrigatorio === false, detalhe: JSON.stringify([a, b, c]) };
});

// ---- histórico da clínica / conversas antigas
// Bia está na clínica (celular, nome e nascimento certos). Cora só tem conversa antiga (CPF digitado no chat). Leo é filho da Cora com CPF no histórico.
await db.exec(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc, cpf) values ('Bia Costa Teste', 'bia costa teste', array['71991230002'], '1990-02-03', '${C1_TXT}')`);
const contato = async (nome, tel) => (await q(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, [nome, tel]))[0].id;
const conversa = async (contatoId, nomePac, tipo, nasc, cpf) => {
  const c = (await q(`insert into public.conversas (contato_id, paciente_tipo, paciente_nome) values ($1, $2, $3) returning id`, [contatoId, tipo, nomePac]))[0].id;
  await q(`insert into public.pre_agendamentos (conversa_id, paciente) values ($1, $2::jsonb)`, [c, JSON.stringify({ nome: nomePac, dt_nasc: nasc, ...(cpf ? { cpf } : {}) })]);
  return c;
};
const cc = await contato('Cora Alves Teste', '71991230003');
await conversa(cc, 'Cora Alves Teste', 'proprio', '15/06/1985', C2);
await conversa(cc, 'Leo Alves Teste', 'filho', '2019-08-30', C1);

await caso('o que falta: tudo novo => falta o CPF dela e de cada filho', async () => {
  const r = await pre('71991230010', 'Ana Souza Teste', '1988-04-12', [{ nome: 'Pedro Souza Teste', nascimento: '2018-01-01' }]);
  return { ok: r.ok && r.situacao === 'novo' && r.falta.length === 2 && r.falta[0].pessoa === 'eu' && r.falta[1].pessoa === 'filho' && r.falta[1].indice === 0, detalhe: JSON.stringify(r) };
});
await caso('o que falta: a clínica já tem a pessoa (celular + nome + nascimento) => não falta nada, e a resposta não traz CPF', async () => {
  const r = await pre('(71) 99123-0002', 'bia  COSTA teste', '1990-02-03');
  return { ok: r.ok && r.situacao === 'novo' && r.falta.length === 0 && !JSON.stringify(r).includes('5299'), detalhe: JSON.stringify(r) };
});
await caso('o que falta: com UM dos três dados diferente (nascimento, nome ou celular) o histórico não vale', async () => {
  const a = await pre('71991230002', 'Bia Costa Teste', '1990-02-04'), b = await pre('71991230002', 'Bia Costa Outra', '1990-02-03'), c = await pre('71991230099', 'Bia Costa Teste', '1990-02-03');
  return { ok: [a, b, c].every((x) => x.ok && x.falta.length === 1), detalhe: JSON.stringify([a.falta, b.falta, c.falta]) };
});
await caso('o que falta: conversa antiga do chat também vale (dela e do filho), sem listar o filho do histórico', async () => {
  const a = await pre('71991230003', 'Cora Alves Teste', '1985-06-15', [{ nome: 'Leo Alves Teste', nascimento: '2019-08-30' }, { nome: 'Gui Alves Teste', nascimento: '2020-01-01' }]);
  const so = await pre('71991230003', 'Cora Alves Teste', '1985-06-15');
  return { ok: a.ok && a.falta.length === 1 && a.falta[0].indice === 1 && so.falta.length === 0 && !JSON.stringify(so).includes('Leo'), detalhe: JSON.stringify([a.falta, so.falta]) };
});
await caso('o que falta: validações (celular, nome, nascimento, menor de 18) e celular que já tem PIN', async () => {
  const a = await pre('123', 'Ana Souza Teste', '1988-04-12'), b = await pre('71991230010', 'Ana', '1988-04-12'), c = await pre('71991230010', 'Ana Souza Teste', '2030-01-01'), d = await pre('71991230010', 'Ana Souza Teste', '2015-01-01');
  const x = await criar({ p_telefone: '71991230020', p_nome: 'Rita Lopes Teste', p_nascimento: '1990-01-01', p_cpf: C1 });
  const e = await pre('71991230020', 'qualquer', 'x');
  return { ok: a.erro === 'celular' && b.erro === 'nome' && c.erro === 'nascimento' && d.erro === 'menor' && x.ok && e.situacao === 'tem_pin', detalhe: JSON.stringify([a.erro, b.erro, c.erro, d.erro, e]) };
});

// ---- criar o cadastro com PIN
await caso('sem CPF (e sem histórico) o PIN NÃO é criado e nada fica gravado', async () => {
  const r = await criar({ p_telefone: '71991230030', p_nome: 'Dani Rocha Teste', p_nascimento: '1992-02-02' });
  return { ok: r.ok === false && r.erro === 'cpf_falta' && (await linha('71991230030')) === undefined, detalhe: JSON.stringify(r) };
});
await caso('CPF inválido é recusado', async () => {
  const r = await criar({ p_telefone: '71991230030', p_nome: 'Dani Rocha Teste', p_nascimento: '1992-02-02', p_cpf: '12345678900' });
  return { ok: r.erro === 'cpf' && (await linha('71991230030')) === undefined };
});
await caso('com o CPF digitado cria o cadastro e o PIN juntos; CPF fica salvo, e-mail em minúsculas, nada falta para o chat', async () => {
  const r = await criar({ p_telefone: '71991230030', p_nome: 'Dani Rocha Teste', p_nascimento: '1992-02-02', p_cpf: C1_TXT, p_email: 'DANI@exemplo.invalid' });
  const l = await linha('71991230030'), p = await rpc('app_pendencias', { p_token: r.token });
  return { ok: r.ok && !!r.token && l.cpf === C1 && l.email === 'dani@exemplo.invalid' && p.pendencias.filter((x) => !x.opcional).length === 0 && !JSON.stringify(r).includes(C1), detalhe: JSON.stringify(p.pendencias) };
});
await caso('o PIN criado entra de novo pelo celular', async () => {
  const r = await rpc('app_login', { p_telefone: '71991230030', p_pin: '1357', p_aparelho: 'Outro' });
  return { ok: r.ok === true, detalhe: JSON.stringify(r).slice(0, 80) };
});
await caso('já preenchido antes (clínica): cria o PIN SEM digitar CPF, e o CPF da clínica entra no cadastro', async () => {
  const r = await criar({ p_telefone: '71991230002', p_nome: 'Bia Costa Teste', p_nascimento: '1990-02-03' });
  const l = await linha('71991230002');
  return { ok: r.ok && l.cpf === C1 && !JSON.stringify(r).includes(C1), detalhe: JSON.stringify(r).slice(0, 100) };
});
await caso('já preenchido antes (conversas): o CPF dela e o do filho entram sozinhos, só para quem foi digitado', async () => {
  const r = await criar({ p_telefone: '71991230003', p_nome: 'Cora Alves Teste', p_nascimento: '1985-06-15', p_filhos: [{ nome: 'Leo Alves Teste', nascimento: '2019-08-30' }] });
  const l = await linha('71991230003'), f = await um(`select * from public.app_filho where responsavel_id = $1`, [l.id]);
  return { ok: r.ok && l.cpf === C2 && f.cpf === C1, detalhe: JSON.stringify(r).slice(0, 100) };
});
await caso('filho sem CPF no histórico: pede o CPF dele, e não cria nada até informar (tudo ou nada)', async () => {
  const args = { p_telefone: '71991230040', p_nome: 'Eva Dias Teste', p_nascimento: '1980-03-03', p_cpf: C1, p_filhos: [{ nome: 'Tomas Dias Teste', nascimento: '2017-07-07' }] };
  const a = await criar(args);
  const b = await criar({ ...args, p_filhos: [{ nome: 'Tomas Dias Teste', nascimento: '2017-07-07', cpf: '000' }] });
  const nenhum = (await linha('71991230040')) === undefined;
  const c = await criar({ ...args, p_filhos: [{ nome: 'Tomas Dias Teste', nascimento: '2017-07-07', cpf: C2 }] });
  const l = await linha('71991230040'), f = await um(`select cpf from public.app_filho where responsavel_id = $1`, [l.id]);
  return { ok: a.erro === 'filho_cpf_falta' && a.indice === 0 && b.erro === 'filho_cpf' && nenhum && c.ok && f.cpf === C2, detalhe: JSON.stringify([a.erro, b.erro, c.ok]) };
});
await caso('erro de cadastro (menor de 18, celular repetido) não deixa meio cadastro', async () => {
  const a = await criar({ p_telefone: '71991230050', p_nome: 'Menor Idade Teste', p_nascimento: '2015-01-01', p_cpf: C1 });
  const b = await criar({ p_telefone: '71991230030', p_nome: 'Dani Rocha Teste', p_nascimento: '1992-02-02', p_cpf: C1 });
  return { ok: a.erro === 'menor' && (await linha('71991230050')) === undefined && b.erro === 'telefone_cadastrado' };
});
await caso('com o acesso rápido desligado nada é criado', async () => {
  await cfg('app_acesso_modo', 'nao');
  const a = await criar({ p_telefone: '71991230060', p_nome: 'Fabi Nunes Teste', p_nascimento: '1990-01-01', p_cpf: C1 }), b = await pre('71991230061', 'Fabi Nunes Teste', '1990-01-01');
  await cfg('app_acesso_modo', 'sim');
  return { ok: a.erro === 'indisponivel' && b.erro === 'indisponivel' };
});

// ---- registro de acessos
const dani = await rpc('app_login', { p_telefone: '71991230030', p_pin: '1357', p_aparelho: 'Celular da Dani' });
const DISP = { agente: 'Mozilla/5.0 (Teste)', idioma: 'pt-BR', fuso: 'America/Bahia', tela: '390x844', plataforma: 'Android' };
const POS_CLINICA = { lat: -12.97141, lng: -38.50121, precisao: 20 };
await caso('registra o acesso sem posição quando o interruptor está desligado (a posição enviada é ignorada)', async () => {
  const r = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'login', p_local: POS_CLINICA, p_dispositivo: DISP });
  const l = await um(`select * from public.app_acesso_log order by id desc limit 1`);
  return { ok: r.ok === true && r.na_clinica === null && l.evento === 'login' && l.lat === null && l.agente === 'Mozilla/5.0 (Teste)' && l.fuso === 'America/Bahia', detalhe: JSON.stringify(r) };
});
await caso('com a posição ligada: arredonda (~100 m), calcula a distância e diz se está na clínica', async () => {
  await cfg('app_local_ativo', 'sim'); await cfg('clinica_lat', '-12.9714'); await cfg('clinica_lng', '-38.5012'); await cfg('clinica_raio_m', '300');
  const dentro = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'desbloqueio', p_local: POS_CLINICA, p_dispositivo: DISP });
  const l = await um(`select * from public.app_acesso_log order by id desc limit 1`);
  const fora = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'desbloqueio', p_local: { lat: -12.9, lng: -38.4, precisao: 30 }, p_dispositivo: DISP });
  const l2 = await um(`select * from public.app_acesso_log order by id desc limit 1`);
  return { ok: dentro.na_clinica === true && Number(l.lat) === -12.971 && Number(l.lng) === -38.501 && l.distancia_m < 30 && fora.na_clinica === false && l2.distancia_m > 5000, detalhe: `${l.distancia_m} m / ${l2.distancia_m} m` };
});
await caso('sem as coordenadas da clínica não há "na clínica"; permissão negada fica registrada; posição inválida é ignorada', async () => {
  await cfg('clinica_lat', ''); await cfg('clinica_lng', '');
  const a = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'abertura', p_local: POS_CLINICA, p_dispositivo: DISP });
  const b = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'abertura', p_local: { negado: true }, p_dispositivo: DISP });
  const l = await um(`select * from public.app_acesso_log order by id desc limit 1`);
  const c = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'abertura', p_local: { lat: 999, lng: 'x' }, p_dispositivo: DISP });
  const l3 = await um(`select * from public.app_acesso_log order by id desc limit 1`);
  return { ok: a.na_clinica === null && b.local_negado === true && l.local_negado === true && l.lat === null && c.ok && l3.lat === null };
});
await caso('exames de hoje entram no registro e a equipe vê a divergência (tem exame hoje e NÃO está na clínica)', async () => {
  const pac = (await linha('71991230030')).id;
  const hoje = (await um(`select to_char(now() at time zone 'America/Bahia', 'YYYY-MM-DD') as d`)).d;
  const ct = await contato('Dani Rocha Teste', '71991230030');
  const cv = (await q(`insert into public.conversas (contato_id, status) values ($1, 'em_atendimento') returning id`, [ct]))[0].id;
  await db.exec(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 1, 'agendamento', 'klingo') on conflict do nothing`);
  const cartao = (await q(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, conversa_id) values ('dani-teste', current_date, 'Centro', 'agendado', $1) returning id`, [cv]))[0].id;
  await db.query(`insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu) values ($1, $2, 'Dani Rocha Teste', true)`, [pac, cv]);
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_para, status, confirm_status, atendimento_id) values ($1, 'm-dani', 'RM JOELHO', 'Centro', (($2 || ' 10:00')::timestamp at time zone 'America/Bahia'), 'confirmado', 'confirmado', 'a-dani')`, [cartao, hoje]);
  await cfg('clinica_lat', '-12.9714'); await cfg('clinica_lng', '-38.5012');
  const r = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'login', p_local: { lat: -12.9, lng: -38.4, precisao: 30 }, p_dispositivo: DISP });
  const ok2 = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'login', p_local: POS_CLINICA, p_dispositivo: DISP });
  return { ok: r.exames_hoje === 1 && r.na_clinica === false && ok2.exames_hoje === 1 && ok2.na_clinica === true, detalhe: JSON.stringify([r, ok2]) };
});
await caso('registrar exige o aparelho desbloqueado e um evento conhecido', async () => {
  const bloq = await db.exec(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`).then(() => rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'login' }));
  await db.exec(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  const inv = await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'qualquer' }), sem = await rpc('app_acesso_registrar', { p_token: 'nao-existe', p_evento: 'login' });
  return { ok: bloq.erro === 'bloqueado' && inv.erro === 'evento' && sem.erro === 'sessao' };
});
await caso('IP e dados do aparelho: o IP vem do cabeçalho da requisição e o texto longo é cortado', async () => {
  await db.query(`select set_config('request.headers', '{"x-forwarded-for": "203.0.113.7, 10.0.0.1"}', false)`);
  await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'login', p_dispositivo: { ...DISP, agente: 'x'.repeat(500) } });
  const l = await um(`select * from public.app_acesso_log order by id desc limit 1`);
  await db.query(`select set_config('request.headers', '', false)`);
  return { ok: l.ip === '203.0.113.7' && l.agente.length === 200, detalhe: `${l.ip} ${l.agente.length}` };
});
await caso('registros com mais de 180 dias são apagados no próximo registro', async () => {
  const pac = (await linha('71991230030')).id;
  await db.query(`insert into public.app_acesso_log (paciente_id, evento, em) values ($1, 'login', now() - interval '200 days')`, [pac]);
  await rpc('app_acesso_registrar', { p_token: dani.token, p_evento: 'login', p_dispositivo: DISP });
  return { ok: Number((await um(`select count(*) n from public.app_acesso_log where em < now() - interval '180 days'`)).n) === 0 };
});
await caso('a tabela do histórico não pode ser lida pelo público', async () => {
  await anonimo();
  try { await q(`select * from public.app_acesso_log limit 1`); return { ok: false }; } catch { return { ok: true }; } finally { await db.exec('reset role'); }
});


// ---- o chat não pergunta o que já sabe: "continua o mesmo?" e, se mudou, troca no cadastro
const iniciar = async (nome, tel) => {
  await db.exec(`update public.conversas set criado_em = criado_em - interval '2 hours'`);
  const r = await rpc('chat_iniciar', { p_nome: nome, p_telefone: tel, p_email: 'dani@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  return { c: r.conversa_id, t: r.token };
};
const resumo = (c, tok = dani.token) => rpc('app_chat_dados_resumo', { p_token: tok, p_conversa: c.c, p_conv_token: c.t });
const atualizar = (c, tok = dani.token) => rpc('app_dados_atualizar', { p_token: tok, p_conversa: c.c, p_conv_token: c.t });
await caso('conversa nova de quem já tem CPF e nascimento salvos: o resumo diz "tem" e mostra o CPF só mascarado', async () => {
  const c = await iniciar('Dani Rocha Teste', '71991230030');
  const r = await resumo(c);
  return { ok: r.ok && r.tem === true && r.cpf_mascara === '***.***.***-25' && r.nascimento === '1992-02-02' && r.primeiro_nome === 'Dani' && r.eu === true && !JSON.stringify(r).includes(C1), detalhe: JSON.stringify(r) };
});
await caso('cadastro sem CPF (jeito antigo): o resumo diz que NÃO tem, então o chat pergunta uma vez', async () => {
  const x = await rpc('app_cadastrar', { p_telefone: '71991230070', p_nome: 'Gui Prado Teste', p_nascimento: '1990-03-03', p_pin: '1357', p_filhos: [], p_aparelho: 'T' });
  const c = await iniciar('Gui Prado Teste', '71991230070');
  const r = await resumo(c, x.token);
  return { ok: r.ok && r.tem === false, detalhe: JSON.stringify(r) };
});
await caso('o resumo e a atualização recusam conversa de outro celular, aparelho travado e código inválido', async () => {
  const outra = await iniciar('Outra Pessoa Teste', '71991230071');
  const a = await resumo(outra), b = await atualizar(outra);
  const c = await iniciar('Dani Rocha Teste', '71991230030');
  await db.exec(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute' where id = (select id from public.app_aparelho where paciente_id = (select id from public.app_paciente where telefone = '71991230030') order by ultimo_uso_em desc limit 1)`);
  const d = await resumo(c); const e = await resumo(c, 'nao-existe');
  await db.exec(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  return { ok: a.erro === 'celular' && b.erro === 'celular' && d.erro === 'bloqueado' && e.erro === 'sessao', detalhe: [a.erro, b.erro, d.erro, e.erro].join(' ') };
});
await caso('"mudou algo": o CPF e o nascimento digitados na conversa passam a valer no cadastro; repetir não muda de novo', async () => {
  const c = await iniciar('Dani Rocha Teste', '71991230030');
  await rpc('chat_responder', { p_conversa: c.c, p_token: c.t, p_passo: 'cpf_nasc', p_valor: { cpf: C2, dt_nasc: '03/03/1991' }, p_texto: 'Enviado.' });
  const a = await atualizar(c), b = await atualizar(c);
  const l = await linha('71991230030'), nasc = (await um(`select nascimento::text n from public.app_paciente where telefone = '71991230030'`)).n;
  return { ok: a.ok && a.atualizou === true && b.atualizou === false && l.cpf === C2 && nasc === '1991-03-03', detalhe: JSON.stringify([a.atualizou, b.atualizou, l.cpf]) };
});
await caso('sem nada digitado na conversa nada é trocado', async () => {
  const c = await iniciar('Dani Rocha Teste', '71991230030');
  const r = await atualizar(c);
  return { ok: r.ok && r.atualizou === false };
});

// ---- equipe
const ADM = '00000000-0000-4000-8000-0000000000b1', MKT = '00000000-0000-4000-8000-0000000000b2';
await db.exec(`insert into auth.users (id, email) values ('${ADM}', 'adm2@exemplo.invalid'), ('${MKT}', 'mkt2@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Adm Teste', 'adm2@exemplo.invalid', 'admin', true), ('${MKT}', 'Mkt Teste', 'mkt2@exemplo.invalid', 'marketing', true) on conflict (id) do update set papel = excluded.papel, ativo = true;`);
const equipe = async (uid, args = []) => { await como(uid); try { return (await q(`select public.painel_app_acessos(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r; } catch (err) { return { erro: String(err.message) }; } finally { await db.exec('reset role'); } };
await caso('a equipe (admin) lê o histórico de acessos e vê a divergência; marketing e o público não leem', async () => {
  const a = await equipe(ADM), m = await equipe(MKT);
  await anonimo(); let anon; try { anon = (await q(`select public.painel_app_acessos() r`))[0].r; } catch (e) { anon = { erro: String(e.message) }; } finally { await db.exec('reset role'); }
  return { ok: Array.isArray(a) && a.length > 5 && a.some((x) => x.divergente === true) && a.some((x) => x.na_clinica === true) && m.erro && anon.erro, detalhe: `${a.length} linhas` };
});

console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} casos passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
