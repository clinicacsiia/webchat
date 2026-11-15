// FLUXOGRAMA: entrada (o retrato da produção montado num Postgres embutido + supabase/acesso-rapido-paciente.sql aplicado duas vezes) -> validação (todas as chamadas feitas como "anon", a chave pública da página; a equipe como usuário logado) -> lógica (interruptor; cadastro com filhos e número de confiança; PIN no servidor com bloqueio crescente; aparelho por código; desbloqueio de 30 min; "esqueci o PIN"; filhos a qualquer momento; marcação por pessoa e "todos juntos"; número de confiança só vê depois do código; isolamento entre titulares; equipe lê e atende) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 14/11/2026 / Mudança: Implementação inicial (acesso rápido do paciente ligado ao Supabase)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8');

await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('a migração aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

// ---------------------------------------------------------------- ajudantes
const ADM = '00000000-0000-4000-8000-0000000000a1', ATEND = '00000000-0000-4000-8000-0000000000a2', MKT = '00000000-0000-4000-8000-0000000000a3';
await db.exec(`
  insert into auth.users (id, email) values ('${ADM}', 'admin@exemplo.invalid'), ('${ATEND}', 'atendente@exemplo.invalid'), ('${MKT}', 'mkt@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true),
    ('${ATEND}', 'Atendente Teste', 'atendente@exemplo.invalid', 'atendente', true), ('${MKT}', 'Mkt Teste', 'mkt@exemplo.invalid', 'marketing', true)
  on conflict (id) do update set papel = excluded.papel, ativo = true;
`);
const modo = (v) => db.query(`update public.config set valor = $1 where chave = 'app_acesso_modo'`, [v]);
// Chama uma função como o público (chave anon da página). Devolve o jsonb.
const anon = async (texto, params = []) => { await anonimo(); try { return (await q(texto, params))[0].r; } finally { await db.exec('reset role'); } };
const rpc = (fn, ...args) => anon(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args);
const json = (o) => JSON.stringify(o);
const dono = (texto, p) => q(texto, p);   // como dono do banco (sem papel), para ler o que o público não lê e para "viajar no tempo"
const hoje = new Date().toISOString().slice(0, 10);
const diasAdiante = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const anoAtras = (n) => `${new Date().getFullYear() - n}-03-15`;

const TEL_ANA = '(71) 99111-0001', TEL_BIA = '71991110002', TEL_CAIO = '71991110003';
const cad = (tel, nome, nasc, pin, filhos = [], conf = null) => rpc('app_cadastrar', tel, nome, nasc, pin, json(filhos), conf ? json(conf) : null, 'Teste').then((r) => r);
// Variante que passa jsonb de verdade (a função recebe jsonb): usa o cast no SQL.
const cadastrar = (tel, nome, nasc, pin, filhos = [], conf = null) =>
  anon(`select public.app_cadastrar($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'Aparelho de teste') as r`, [tel, nome, nasc, pin, json(filhos), conf ? json(conf) : null]);
const chamar = (fn, token, ...resto) => {
  const tipos = { app_filho_remover: ['uuid'], app_confianca_remover: ['uuid'], app_confianca_novo_codigo: ['uuid'], app_marcacao_cancelar: ['uuid'], app_selecao_salvar: ['jsonb'] };
  const t = tipos[fn] || [];
  return anon(`select public.${fn}($1${resto.map((_, i) => `, $${i + 2}${t[i] ? '::' + t[i] : ''}`).join('')}) as r`, [token, ...resto.map((v) => (typeof v === 'object' && v !== null ? json(v) : v))]);
};
const marcar = (token, pessoas, exame = 'Ultrassom', data = diasAdiante(5), turno = 'Manhã', obs = null) =>
  anon(`select public.app_marcar($1, $2::jsonb, $3, $4, $5, $6) as r`, [token, json(pessoas), exame, data, turno, obs]);

// ---------------------------------------------------------------- interruptor
await caso('nasce DESLIGADO: cadastro, entrada e "esqueci o PIN" respondem "indisponivel"', async () => {
  const v = (await um(`select valor from public.config where chave = 'app_acesso_modo'`)).valor;
  const a = await cadastrar(TEL_ANA, 'Ana Souza Teste', anoAtras(35) , '1357');
  const b = await rpc('app_login', TEL_ANA, '1357', 'x');
  const c = await rpc('app_pin_esqueci', TEL_ANA, 'Ana Souza Teste', anoAtras(35), '1111', 'x');
  const n = (await um(`select count(*)::int n from public.app_paciente`)).n;
  return { ok: v === 'nao' && a.erro === 'indisponivel' && b.erro === 'indisponivel' && c.erro === 'indisponivel' && n === 0, detalhe: `${v} ${a.erro} ${b.erro} ${c.erro}` };
});
await modo('sim');

// ---------------------------------------------------------------- isolamento: o público não toca nas tabelas
await caso('o público (anon) não lê nem grava as tabelas app_*', async () => {
  await anonimo();
  const negou = [];
  try {
    for (const t of ['app_paciente', 'app_aparelho', 'app_filho', 'app_contato_confianca', 'app_marcacao', 'app_evento']) {
      for (const s of [`select * from public.${t}`, `delete from public.${t}`]) {
        try { await db.query(s); negou.push(false); } catch (e) { negou.push(/permission denied/i.test(e.message)); }
      }
    }
  } finally { await db.exec('reset role'); }
  return { ok: negou.length === 12 && negou.every(Boolean), detalhe: negou.filter((x) => !x).length + ' liberadas' };
});
await caso('o público não executa as funções internas nem as da equipe', async () => {
  await anonimo();
  const r = [];
  try {
    for (const s of [`select public.app_modo()`, `select public.app_perfil_json(gen_random_uuid())`, `select public.app_falha(gen_random_uuid())`, `select public.app_aparelho_abrir(gen_random_uuid(), 'x')`,
      `select public.painel_app_solicitacoes('solicitada')`, `select public.painel_app_solicitacao_status(gen_random_uuid(), 'confirmada')`]) {
      try { await db.query(s); r.push(false); } catch (e) { r.push(/permission denied/i.test(e.message)); }
    }
  } finally { await db.exec('reset role'); }
  return { ok: r.every(Boolean), detalhe: JSON.stringify(r) };
});

// ---------------------------------------------------------------- cadastro: validações
await caso('cadastro recusa celular, nome, nascimento, menor de 18 e PIN inválidos (nada é gravado)', async () => {
  const base = ['(71) 99111-0001', 'Ana Souza Teste', anoAtras(35), '1357'];
  const com = (i, v) => base.map((x, k) => (k === i ? v : x));
  const r = [
    await cadastrar(...com(0, '(71) 3333-0001')), await cadastrar(...com(0, '(07) 99111-0001')), await cadastrar(...com(1, 'Ana')), await cadastrar(...com(1, 'A B')),
    await cadastrar(...com(1, 'Ana 123 Souza')), await cadastrar(...com(2, diasAdiante(3))), await cadastrar(...com(2, '2020-02-31')), await cadastrar(...com(2, anoAtras(10))),
    await cadastrar(...com(3, '123')), await cadastrar(...com(3, 'abcd')), await cadastrar(...com(3, '12345')),
  ];
  const n = (await um(`select count(*)::int n from public.app_paciente`)).n;
  const erros = r.map((x) => x.erro).join(',');
  return { ok: n === 0 && erros === 'celular,celular,nome,nome,nome,nascimento,nascimento,menor,pin,pin,pin', detalhe: erros };
});
await caso('cadastro recusa filho e número de confiança inválidos', async () => {
  const nasc = anoAtras(35);
  const r = [
    await cadastrar(TEL_ANA, 'Ana Souza Teste', nasc, '1357', [{ nome: 'Leo', nascimento: anoAtras(5) }]),
    await cadastrar(TEL_ANA, 'Ana Souza Teste', nasc, '1357', [{ nome: 'Leo Souza Teste', nascimento: diasAdiante(2) }]),
    await cadastrar(TEL_ANA, 'Ana Souza Teste', nasc, '1357', [], { nome: 'Maria', telefone: TEL_ANA, relacao: 'Outro' }),
    await cadastrar(TEL_ANA, 'Ana Souza Teste', nasc, '1357', [], { nome: 'Maria', telefone: '7133330000', relacao: 'Outro' }),
    await cadastrar(TEL_ANA, 'Ana Souza Teste', nasc, '1357', [], { nome: 'Maria', telefone: TEL_BIA, relacao: 'Vizinha' }),
    await cadastrar(TEL_ANA, 'Ana Souza Teste', nasc, '1357', Array.from({ length: 11 }, (_, i) => ({ nome: 'Filho Numero ' + i, nascimento: anoAtras(3) }))),
  ];
  const n = (await um(`select count(*)::int n from public.app_paciente`)).n;
  return { ok: n === 0 && r.every((x) => x.ok === false), detalhe: r.map((x) => x.erro).join(',') };
});

// ---------------------------------------------------------------- cadastro: caminho feliz
let ana, anaTok;
const ANA_NASC = anoAtras(35), LEO_NASC = anoAtras(6), LIA_NASC = anoAtras(2);
await caso('cadastro único: titular + 2 filhos + número de confiança; devolve código do aparelho e o perfil', async () => {
  const r = await cadastrar(TEL_ANA, 'Ana  Souza Teste', ANA_NASC, '1357',
    [{ nome: 'Leo Souza Teste', nascimento: LEO_NASC }, { nome: 'Lia Souza Teste', nascimento: LIA_NASC }], { nome: 'Bia Amiga', telefone: TEL_BIA, relacao: 'Irmão(ã)' });
  ana = r.perfil; anaTok = r.token;
  const p = (await dono(`select telefone, nome, length(pin_hash) > 20 as hash, pin_hash <> '1357' as nao_texto from public.app_paciente`))[0];
  return { ok: r.ok === true && /^[0-9a-f]{64}$/.test(anaTok) && ana.nome === 'Ana Souza Teste' && ana.telefone === '71991110001' && ana.filhos.length === 2 && ana.confiaveis.length === 1
    && /^[0-9]{6}$/.test(ana.confiaveis[0].codigo) && ana.confiaveis[0].vinculado === false && p.hash && p.nao_texto && ana.marcacoes.length === 0, detalhe: json(p) };
});
await caso('o banco guarda só o hash do código do aparelho e o PIN em bcrypt (nunca em texto)', async () => {
  const a = (await dono(`select token_hash, length(token_hash) as n from public.app_aparelho`))[0];
  return { ok: a.n === 64 && a.token_hash !== anaTok, detalhe: `${a.n}` };
});
await caso('o mesmo celular não cadastra duas vezes (mensagem manda entrar com o PIN)', async () => {
  const r = await cadastrar('71 99111-0001', 'Outra Pessoa Teste', anoAtras(40), '2468');
  return { ok: r.ok === false && r.erro === 'telefone_cadastrado' && /Entre com o seu PIN/.test(r.mensagem), detalhe: r.erro };
});
await caso('cadastro nunca devolve PIN, hash nem dado de outra pessoa', async () => {
  const txt = json(ana);
  return { ok: !/pin|hash|salt/i.test(txt) && !/sugerido/i.test(txt), detalhe: '' };
});

// ---------------------------------------------------------------- aparelho e PIN
await caso('o perfil abre com o código do aparelho (sem PIN) logo depois do cadastro', async () => {
  const r = await chamar('app_perfil', anaTok);
  return { ok: r.ok === true && r.perfil.nome === 'Ana Souza Teste' };
});
await caso('código de aparelho inexistente ou vazio: erro "sessao", sem dado', async () => {
  const a = await chamar('app_perfil', 'x'.repeat(64)), b = await chamar('app_perfil', ''), c = await rpc('app_perfil', null);
  return { ok: a.erro === 'sessao' && b.erro === 'sessao' && c.erro === 'sessao' && !a.perfil, detalhe: `${a.erro} ${b.erro} ${c.erro}` };
});
await caso('passados 30 minutos sem uso o servidor volta a exigir o PIN ("bloqueado")', async () => {
  await dono(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const r = await chamar('app_perfil', anaTok), m = await marcar(anaTok, ['eu']);
  return { ok: r.erro === 'bloqueado' && m.erro === 'bloqueado' && !r.perfil, detalhe: `${r.erro} ${m.erro}` };
});
await caso('PIN errado: conta tentativas ("Restam N"); no 5º erro bloqueia 1 minuto', async () => {
  const msgs = [];
  for (let i = 0; i < 4; i++) msgs.push((await chamar('app_desbloquear', anaTok, '0000')).mensagem);
  const quinto = await chamar('app_desbloquear', anaTok, '0000');
  return { ok: msgs[0] === 'PIN incorreto. Restam 4 tentativas.' && msgs[3] === 'PIN incorreto. Resta 1 tentativa.' && quinto.erro === 'bloqueado' && quinto.segundos > 55 && quinto.segundos <= 60, detalhe: `${msgs[0]} | ${quinto.mensagem}` };
});
await caso('durante o bloqueio nem o PIN certo entra; o bloqueio vale para o celular + PIN de outro aparelho também', async () => {
  const a = await chamar('app_desbloquear', anaTok, '1357'), b = await rpc('app_login', TEL_ANA, '1357', 'outro');
  return { ok: a.erro === 'bloqueado' && b.erro === 'bloqueado', detalhe: `${a.erro} ${b.erro}` };
});
await caso('o bloqueio cresce: depois de 5 erros seguidos mais, 15 minutos; depois, 1 hora', async () => {
  await dono(`update public.app_paciente set pin_bloqueado_ate = now() - interval '1 second'`);
  let r; for (let i = 0; i < 5; i++) r = await chamar('app_desbloquear', anaTok, '0000');
  const seg2 = r.segundos;
  await dono(`update public.app_paciente set pin_bloqueado_ate = now() - interval '1 second'`);
  for (let i = 0; i < 5; i++) r = await chamar('app_desbloquear', anaTok, '0000');
  const seg3 = r.segundos;
  return { ok: seg2 > 850 && seg2 <= 900 && seg3 > 3500 && seg3 <= 3600, detalhe: `${seg2}s e ${seg3}s` };
});
await caso('PIN certo depois do bloqueio vencer: entra, zera as tentativas e libera o aparelho por 30 min', async () => {
  await dono(`update public.app_paciente set pin_bloqueado_ate = now() - interval '1 second'`);
  const r = await chamar('app_desbloquear', anaTok, '1357');
  const p = (await dono(`select pin_falhas, pin_bloqueado_ate, (select desbloqueada_ate > now() + interval '29 minutes' from public.app_aparelho) as ate from public.app_paciente`))[0];
  const ver = await chamar('app_perfil', anaTok);
  return { ok: r.ok === true && r.perfil.filhos.length === 2 && p.pin_falhas === 0 && p.pin_bloqueado_ate === null && p.ate === true && ver.ok === true, detalhe: json(p) };
});
await caso('PIN fora do formato (letras, 3 ou 5 números, vazio) conta como erro', async () => {
  const r = [await chamar('app_desbloquear', anaTok, 'abcd'), await chamar('app_desbloquear', anaTok, '135'), await chamar('app_desbloquear', anaTok, ''), await chamar('app_desbloquear', anaTok, '13579')];
  const n = (await um(`select pin_falhas from public.app_paciente`)).pin_falhas;
  await dono(`update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null`);
  return { ok: r.every((x) => x.ok === false) && n === 4, detalhe: `${n}` };
});
await caso('aparelho parado há mais de 90 dias precisa entrar de novo ("sessao")', async () => {
  await dono(`update public.app_aparelho set ultimo_uso_em = now() - interval '91 days'`);
  const r = await chamar('app_perfil', anaTok), d = await chamar('app_desbloquear', anaTok, '1357');
  await dono(`update public.app_aparelho set ultimo_uso_em = now()`);
  return { ok: r.erro === 'sessao' && d.erro === 'sessao', detalhe: `${r.erro} ${d.erro}` };
});
await caso('"Entrar em aparelho novo": celular + PIN; celular desconhecido e PIN errado dão a MESMA mensagem', async () => {
  const certo = await rpc('app_login', '(71) 99111-0001', '1357', 'Celular novo');
  const errado = await rpc('app_login', TEL_ANA, '9999', 'x'), naoExiste = await rpc('app_login', '71988887777', '1357', 'x');
  await dono(`update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null`);
  const n = (await um(`select count(*)::int n from public.app_aparelho`)).n;
  return { ok: certo.ok === true && /^[0-9a-f]{64}$/.test(certo.token) && certo.token !== anaTok && certo.perfil.filhos.length === 2 && errado.mensagem === naoExiste.mensagem && errado.erro === 'login' && n === 2, detalhe: `${errado.mensagem} | ${naoExiste.mensagem}` };
});
await caso('no máximo 5 aparelhos por titular (o mais antigo sai)', async () => {
  for (let i = 0; i < 6; i++) await rpc('app_login', TEL_ANA, '1357', 'A' + i);
  const n = (await um(`select count(*)::int n from public.app_aparelho`)).n;
  return { ok: n === 5, detalhe: `${n}` };
});
await caso('trocar o PIN: exige o atual; o novo passa a valer e o antigo não', async () => {
  const login = await rpc('app_login', TEL_ANA, '1357', 'Troca'); const tok = login.token;
  const errado = await chamar('app_pin_trocar', tok, '0000', '2468');
  const curto = await chamar('app_pin_trocar', tok, '1357', '24');
  const ok = await chamar('app_pin_trocar', tok, '1357', '2468');
  const velho = await rpc('app_login', TEL_ANA, '1357', 'x'), novo = await rpc('app_login', TEL_ANA, '2468', 'x');
  const ev = (await um(`select count(*)::int n from public.app_evento where tipo = 'pin_trocado'`)).n;
  await dono(`update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null`);
  return { ok: errado.erro === 'pin' && curto.erro === 'pin' && ok.ok === true && velho.ok === false && novo.ok === true && ev === 1, detalhe: `${errado.erro} ${curto.erro} ${velho.ok} ${novo.ok}` };
});

// ---------------------------------------------------------------- esqueci o PIN
let tokAtual;
await caso('"Esqueci o PIN" com dados errados conta como erro e não troca nada', async () => {
  const r1 = await rpc('app_pin_esqueci', TEL_ANA, 'Ana Souza Teste', anoAtras(34), '1111', 'x');
  const r2 = await rpc('app_pin_esqueci', TEL_ANA, 'Ana Outra Teste', ANA_NASC, '1111', 'x');
  const r3 = await rpc('app_pin_esqueci', '71977776666', 'Ana Souza Teste', ANA_NASC, '1111', 'x');
  const f = (await um(`select pin_falhas from public.app_paciente`)).pin_falhas;   // lido antes do login certo, que zera o contador
  const ainda = await rpc('app_login', TEL_ANA, '2468', 'x');
  await dono(`update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null`);
  return { ok: r1.erro === 'dados' && r2.erro === 'dados' && r3.erro === 'dados' && ainda.ok === true && f === 2, detalhe: `${r1.erro} ${r2.erro} ${r3.erro} falhas=${f}` };
});
await caso('"Esqueci o PIN" com 5 erros bloqueia como o PIN', async () => {
  let r; for (let i = 0; i < 5; i++) r = await rpc('app_pin_esqueci', TEL_ANA, 'Ana Errada', ANA_NASC, '1111', 'x');
  const certo = await rpc('app_pin_esqueci', TEL_ANA, 'Ana Souza Teste', ANA_NASC, '1111', 'x');
  await dono(`update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null`);
  return { ok: r.erro === 'bloqueado' && certo.erro === 'bloqueado', detalhe: `${r.erro} ${certo.erro}` };
});
await caso('"Esqueci o PIN" certo (sem maiúsculas/acentos): novo PIN, derruba os outros aparelhos, entra com um aparelho novo e deixa registro', async () => {
  const r = await rpc('app_pin_esqueci', TEL_ANA, '  ANA souza  TESTE ', ANA_NASC, '1111', 'Novo');
  tokAtual = r.token;
  const n = (await um(`select count(*)::int n from public.app_aparelho`)).n;
  const velho = await rpc('app_login', TEL_ANA, '2468', 'x'), novo = await rpc('app_login', TEL_ANA, '1111', 'x');
  const ev = (await um(`select count(*)::int n from public.app_evento where tipo = 'pin_redefinido'`)).n;
  return { ok: r.ok === true && r.perfil.filhos.length === 2 && n === 1 && velho.ok === false && novo.ok === true && ev === 1, detalhe: `aparelhos=${n}` };
});
await caso('o registro de eventos não guarda dado pessoal', async () => {
  const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'app_evento' order by 1`)).map((x) => x.column_name);
  return { ok: json(cols) === json(['criado_em', 'id', 'paciente_id', 'tipo']), detalhe: json(cols) };
});
await dono(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);

// ---------------------------------------------------------------- filhos: a qualquer momento
let leoId, liaId;
await caso('adicionar mais um filho a qualquer momento (e o mesmo filho duas vezes não duplica)', async () => {
  const r = await chamar('app_filho_salvar', tokAtual, 'Davi Souza Teste', anoAtras(1));
  const dup = await chamar('app_filho_salvar', tokAtual, 'DAVI souza teste', anoAtras(1));
  leoId = r.perfil.filhos.find((f) => f.nome.startsWith('Leo')).id; liaId = r.perfil.filhos.find((f) => f.nome.startsWith('Lia')).id;
  return { ok: r.ok === true && r.perfil.filhos.length === 3 && dup.perfil.filhos.length === 3, detalhe: r.perfil.filhos.map((f) => f.nome).join(',') };
});
await caso('filho com nome ou nascimento inválido é recusado', async () => {
  const a = await chamar('app_filho_salvar', tokAtual, 'Leo', anoAtras(3)), b = await chamar('app_filho_salvar', tokAtual, 'Leo Souza Teste', diasAdiante(1)), c = await chamar('app_filho_salvar', tokAtual, 'Leo Souza Teste', 'ontem');
  return { ok: [a, b, c].every((x) => x.ok === false && x.erro === 'filho'), detalhe: '' };
});
await caso('limite de 10 filhos', async () => {
  for (let i = 0; i < 7; i++) await chamar('app_filho_salvar', tokAtual, `Criança Numero ${String.fromCharCode(65 + i)}`, anoAtras(4));
  const r = await chamar('app_filho_salvar', tokAtual, 'Criança Numero Z', anoAtras(4));
  const n = (await um(`select count(*)::int n from public.app_filho where removido_em is null`)).n;
  return { ok: r.ok === false && n === 10, detalhe: `${n}` };
});

// ---------------------------------------------------------------- marcações
let g1;
await caso('marcação "para mim" gera uma solicitação com status "solicitada"', async () => {
  const r = await marcar(tokAtual, ['eu'], 'Ressonância magnética', diasAdiante(7), 'Manhã', 'Pedido do Dr. Teste');
  g1 = r.grupo;
  const m = r.perfil.marcacoes;
  return { ok: r.ok === true && m.length === 1 && m[0].pessoa_id === 'eu' && m[0].status === 'solicitada' && m[0].pessoa_nome === 'Ana Souza Teste' && m[0].obs === 'Pedido do Dr. Teste', detalhe: json(m[0]) };
});
await caso('"Todos juntos": uma solicitação para cada pessoa, no mesmo grupo', async () => {
  const p = (await chamar('app_perfil', tokAtual)).perfil;
  const todos = ['eu', ...p.filhos.slice(0, 3).map((f) => f.id)];
  const r = await marcar(tokAtual, todos, 'Consulta', diasAdiante(9), 'Tarde');
  const doGrupo = r.perfil.marcacoes.filter((m) => m.grupo === r.grupo);
  const sel = (await um(`select ultima_selecao from public.app_paciente`)).ultima_selecao;
  return { ok: r.ok === true && doGrupo.length === 4 && new Set(doGrupo.map((m) => m.pessoa_id)).size === 4 && json(sel) === json(todos), detalhe: `${doGrupo.length} no grupo` };
});
await caso('a mesma pessoa repetida no pedido vira uma só solicitação', async () => {
  const r = await marcar(tokAtual, ['eu', 'eu', leoId, leoId], 'Raio-X', diasAdiante(3), 'Qualquer horário');
  return { ok: r.perfil.marcacoes.filter((m) => m.grupo === r.grupo).length === 2 };
});
await caso('marcação recusa data passada, turno/exame/observação inválidos e lista de pessoas vazia', async () => {
  const r = [await marcar(tokAtual, ['eu'], 'Ultrassom', '2020-01-01'), await marcar(tokAtual, ['eu'], 'Ultrassom', hoje.slice(0, 4) + '-02-31'), await marcar(tokAtual, ['eu'], 'Ultrassom', diasAdiante(3), 'Noite'),
    await marcar(tokAtual, ['eu'], '', diasAdiante(3)), await marcar(tokAtual, ['eu'], 'Ultrassom', diasAdiante(3), 'Manhã', 'x'.repeat(501)), await marcar(tokAtual, [], 'Ultrassom', diasAdiante(3)), await marcar(tokAtual, ['eu'], 'Ultrassom', diasAdiante(900))];
  return { ok: r.every((x) => x.ok === false), detalhe: r.map((x) => x.erro).join(',') };
});
await caso('marcação para hoje é aceita; pessoa que não é do cadastro derruba o pedido inteiro (nada é gravado)', async () => {
  const antes = (await um(`select count(*)::int n from public.app_marcacao`)).n;
  const hojeOk = await marcar(tokAtual, ['eu'], 'Ultrassom', hoje);
  const meio = (await um(`select count(*)::int n from public.app_marcacao`)).n;
  const ruim = await marcar(tokAtual, ['eu', '11111111-1111-4111-8111-111111111111'], 'Ultrassom', diasAdiante(3));
  const ruim2 = await marcar(tokAtual, ['eu', 'qualquer coisa'], 'Ultrassom', diasAdiante(3));
  const depois = (await um(`select count(*)::int n from public.app_marcacao`)).n;
  return { ok: hojeOk.ok === true && meio === antes + 1 && ruim.erro === 'pessoas' && ruim2.erro === 'pessoas' && depois === meio, detalhe: `${antes} ${meio} ${depois}` };
});
await caso('cancelar a solicitação: some da lista do paciente e fica "cancelada" para a equipe', async () => {
  const r = await chamar('app_marcacao_cancelar', tokAtual, g1);
  const st = (await dono(`select status from public.app_marcacao where grupo = $1`, [g1]))[0].status;
  return { ok: r.ok === true && !r.perfil.marcacoes.some((m) => m.grupo === g1) && st === 'cancelada' };
});
await caso('remover um filho cancela as solicitações pendentes dele, mas o nome continua para a equipe', async () => {
  const r = await chamar('app_filho_remover', tokAtual, liaId);
  const m = (await dono(`select status, pessoa_nome, filho_id from public.app_marcacao where filho_id = $1`, [liaId]));
  const outras = (await dono(`select count(*)::int n from public.app_marcacao where filho_id <> $1 and status = 'solicitada'`, [liaId]))[0].n;
  return { ok: r.ok === true && !r.perfil.filhos.some((f) => f.id === liaId) && m.length >= 1 && m.every((x) => x.status === 'cancelada' && x.pessoa_nome.startsWith('Lia')) && outras >= 1, detalhe: `${m.length}` };
});
await caso('remover um filho de outro titular não faz nada', async () => {
  const outra = await cadastrar('71 99222-0001', 'Carla Lima Teste', anoAtras(40), '4321', [{ nome: 'Pedro Lima Teste', nascimento: anoAtras(7) }]);
  const r = await chamar('app_filho_remover', outra.token, leoId);
  const leo = (await dono(`select removido_em from public.app_filho where id = $1`, [leoId]))[0].removido_em;
  const m = await marcar(outra.token, ['eu', leoId], 'Ultrassom', diasAdiante(3));
  return { ok: r.ok === true && leo === null && m.erro === 'pessoas' && r.perfil.filhos.length === 1, detalhe: '' };
});
await caso('limite de 30 solicitações aguardando por titular', async () => {
  const antes = (await um(`select count(distinct grupo)::int n from public.app_marcacao where status = 'solicitada' and responsavel_id = (select id from public.app_paciente where telefone = '71991110001')`)).n;
  let ultimo; for (let i = antes; i < 31; i++) ultimo = await marcar(tokAtual, ['eu'], 'Ultrassom', diasAdiante(4));
  return { ok: ultimo.ok === false && ultimo.erro === 'limite', detalhe: `${antes} antes` };
});
await caso('selecionar quem vai ser atendido é lembrado; lista inválida é recusada', async () => {
  const ok = await chamar('app_selecao_salvar', tokAtual, ['eu', leoId]);
  const ruim = [await chamar('app_selecao_salvar', tokAtual, []), await chamar('app_selecao_salvar', tokAtual, ['<script>']), await anon(`select public.app_selecao_salvar($1, '"eu"'::jsonb) as r`, [tokAtual])];
  const sel = (await chamar('app_perfil', tokAtual)).perfil.selecao;
  return { ok: ok.ok === true && ruim.every((x) => x.ok === false) && json(sel) === json(['eu', leoId]) };
});

// ---------------------------------------------------------------- número de confiança
let bia, biaTok, codigoBia, contatoId;
await caso('quem é número de confiança cadastra o próprio celular: ainda NÃO vê nada (falta o código)', async () => {
  const r = await cadastrar(TEL_BIA, 'Beatriz Amiga Teste', anoAtras(38), '8642');
  bia = r.perfil; biaTok = r.token;
  const p = (await chamar('app_perfil', tokAtual)).perfil.confiaveis[0];
  codigoBia = p.codigo; contatoId = p.id;
  return { ok: r.ok === true && bia.confiam_em_mim.length === 0 && /^[0-9]{6}$/.test(codigoBia), detalhe: `${bia.confiam_em_mim.length}` };
});
await caso('código errado não vincula e conta tentativa; 5 erros invalidam o código; só o titular gera outro', async () => {
  const errado = codigoBia === '000000' ? '111111' : '000000';
  const r = []; for (let i = 0; i < 5; i++) r.push(await chamar('app_confianca_aceitar', biaTok, errado));
  const certoTarde = await chamar('app_confianca_aceitar', biaTok, codigoBia);
  const inv = (await chamar('app_perfil', tokAtual)).perfil.confiaveis[0];
  const novo = await chamar('app_confianca_novo_codigo', tokAtual, contatoId);
  const nc = novo.perfil.confiaveis[0];
  codigoBia = nc.codigo;
  return { ok: r.every((x) => x.erro === 'codigo') && certoTarde.ok === false && inv.codigo_invalido === true && nc.codigo_invalido === false, detalhe: `${r.length} erros` };
});
await caso('quem não é o celular cadastrado não consegue usar o código', async () => {
  const caio = await cadastrar(TEL_CAIO, 'Caio Intruso Teste', anoAtras(30), '9753');
  const r = await chamar('app_confianca_aceitar', caio.token, codigoBia);
  return { ok: r.ok === false && r.erro === 'codigo' && caio.perfil.confiam_em_mim.length === 0, detalhe: r.erro };
});
await caso('código certo no celular certo vincula: a pessoa vê o titular, os filhos e as solicitações (só leitura)', async () => {
  const r = await chamar('app_confianca_aceitar', biaTok, codigoBia);
  const v = r.perfil.confiam_em_mim;
  const t = v[0];
  const meus = (await chamar('app_perfil', tokAtual)).perfil.confiaveis[0];
  return { ok: r.ok === true && v.length === 1 && t.titular_nome === 'Ana Souza Teste' && t.filhos.length >= 2 && t.filhos.every((f) => f.nome && f.nascimento) && t.marcacoes.length >= 1
    && !('telefone' in t) && meus.vinculado === true && meus.codigo === null, detalhe: `${t.filhos.length} filhos, ${t.marcacoes.length} solicitações` };
});
await caso('o vínculo não dá poder de escrita: o código do aparelho da Bia só mexe nos dados da Bia', async () => {
  const antes = (await um(`select count(*)::int n from public.app_marcacao where responsavel_id = (select id from public.app_paciente where telefone = '71991110001')`)).n;
  const m = await marcar(biaTok, ['eu', leoId], 'Ultrassom', diasAdiante(3));
  const f = await chamar('app_filho_remover', biaTok, leoId);
  const g = await chamar('app_marcacao_cancelar', biaTok, (await dono(`select grupo from public.app_marcacao where status = 'solicitada' limit 1`))[0].grupo);
  const depois = (await um(`select count(*)::int n from public.app_marcacao where responsavel_id = (select id from public.app_paciente where telefone = '71991110001') and status = 'solicitada'`)).n;
  const leo = (await dono(`select removido_em from public.app_filho where id = $1`, [leoId]))[0].removido_em;
  return { ok: m.erro === 'pessoas' && leo === null && depois >= 1 && antes >= 1, detalhe: `${antes}→${depois}` };
});
await caso('o mesmo código não vale duas vezes e um código errado não derruba o vínculo que já existe', async () => {
  const r = await chamar('app_confianca_aceitar', biaTok, codigoBia);
  const ainda = (await chamar('app_perfil', biaTok)).perfil.confiam_em_mim.length;
  return { ok: r.ok === false && ainda === 1 };
});
await caso('o titular remove o número de confiança: o acesso acaba na hora', async () => {
  const r = await chamar('app_confianca_remover', tokAtual, contatoId);
  const bia2 = (await chamar('app_perfil', biaTok)).perfil.confiam_em_mim.length;
  return { ok: r.ok === true && r.perfil.confiaveis.length === 0 && bia2 === 0 };
});
await caso('número de confiança: nome, celular e relação validados; o próprio celular é recusado; duplicado só atualiza; limite de 5', async () => {
  const a = await chamar('app_confianca_salvar', tokAtual, 'Z', TEL_BIA, 'Outro'), b = await chamar('app_confianca_salvar', tokAtual, 'Zé Maria', '123', 'Outro'),
    c = await chamar('app_confianca_salvar', tokAtual, 'Zé Maria', TEL_ANA, 'Outro'), d = await chamar('app_confianca_salvar', tokAtual, 'Zé Maria', TEL_BIA, 'Vizinho');
  const e1 = await chamar('app_confianca_salvar', tokAtual, 'Bia Amiga', TEL_BIA, 'Irmão(ã)'), e2 = await chamar('app_confianca_salvar', tokAtual, 'Beatriz', TEL_BIA, 'Cônjuge');
  let ult; for (let i = 0; i < 5; i++) ult = await chamar('app_confianca_salvar', tokAtual, 'Pessoa ' + i, `7199333000${i}`, 'Outro');
  return { ok: [a, b, c, d].every((x) => x.ok === false) && e1.perfil.confiaveis.length === 1 && e2.perfil.confiaveis.length === 1 && e2.perfil.confiaveis[0].relacao === 'Cônjuge' && ult.ok === false && /Limite/.test(ult.mensagem), detalhe: `${ult.mensagem}` };
});

// ---------------------------------------------------------------- isolamento entre titulares
await caso('um titular nunca vê filhos, solicitações nem número de confiança de outro', async () => {
  const outra = (await rpc('app_login', '71992220001', '4321', 'x'));
  const p = outra.perfil;
  return { ok: outra.ok === true && p.filhos.length === 1 && p.filhos[0].nome === 'Pedro Lima Teste' && p.marcacoes.length === 0 && p.confiaveis.length === 0 && !json(p).includes('Ana Souza') && !json(p).includes('Leo Souza'), detalhe: json(p.filhos) };
});
await caso('sair do aparelho apaga o código; o mesmo código deixa de funcionar', async () => {
  const r = await chamar('app_sair', tokAtual);
  const depois = await chamar('app_perfil', tokAtual);
  const sairDeNovo = await chamar('app_sair', tokAtual);
  return { ok: r.ok === true && depois.erro === 'sessao' && sairDeNovo.ok === true };
});

// ---------------------------------------------------------------- validação com a base da clínica (só sugestão)
await caso('celular + nascimento + nome iguais a um paciente da clínica viram SUGESTÃO para a equipe, sem vincular nem aparecer ao paciente', async () => {
  const pid = (await q(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc) values ('Dora Prado Teste', 'dora prado teste', array['5571991110099'], date '1980-05-05') returning id`))[0].id;
  const r = await cadastrar('71991110099', 'Dóra  Prado Teste', '1980-05-05', '1593');
  const s = (await q(`select paciente_sugerido_id, telefone_verificado_em from public.app_paciente where telefone = '71991110099'`))[0];
  const conta = (await q(`select count(*)::int n from public.contas_paciente where paciente_id = $1`, [pid]))[0].n;
  return { ok: r.ok === true && s.paciente_sugerido_id === pid && s.telefone_verificado_em === null && conta === 0 && !json(r).includes(pid), detalhe: '' };
});
await caso('dois cadastros da clínica iguais, ou nascimento diferente: nenhuma sugestão (e o cadastro continua aceito)', async () => {
  await q(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc) values ('Eva Dias Teste', 'eva dias teste', array['71991110088'], date '1985-01-01'), ('Eva Dias Teste', 'eva dias teste', array['71991110088'], date '1985-01-01')`);
  const a = await cadastrar('71991110088', 'Eva Dias Teste', '1985-01-01', '1593');
  const b = await cadastrar('71991110077', 'Fabio Reis Teste', '1990-01-01', '1593');
  await q(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc) values ('Fabio Reis Teste', 'fabio reis teste', array['71991110077'], date '1991-01-01')`);
  const s = (await q(`select telefone, paciente_sugerido_id from public.app_paciente where telefone in ('71991110088', '71991110077')`));
  return { ok: a.ok === true && b.ok === true && s.every((x) => x.paciente_sugerido_id === null), detalhe: '' };
});

// ---------------------------------------------------------------- freio de cadastros
await caso('freio contra cadastro em massa: acima do limite por hora o cadastro é recusado', async () => {
  await db.query(`update public.config set valor = '3' where chave = 'app_cadastros_max_hora'`);
  const r = await cadastrar('71993330001', 'Gil Mota Teste', '1970-01-01', '1111');
  await db.query(`update public.config set valor = '100' where chave = 'app_cadastros_max_hora'`);
  return { ok: r.ok === false && r.erro === 'limite', detalhe: r.erro };
});

// ---------------------------------------------------------------- equipe
await caso('equipe: só administrador e atendente leem as solicitações; marketing, paciente e anon não', async () => {
  const resp = {};
  for (const [nome, uid] of [['adm', ADM], ['atend', ATEND], ['mkt', MKT], ['paciente', '00000000-0000-4000-8000-0000000000ff']]) {
    await como(uid);
    try { resp[nome] = (await q(`select public.painel_app_solicitacoes() as r`))[0].r.length; } catch (e) { resp[nome] = /Só a equipe/.test(e.message) ? 'negado' : e.message; }
  }
  await db.exec('reset role');
  return { ok: typeof resp.adm === 'number' && typeof resp.atend === 'number' && resp.mkt === 'negado' && resp.paciente === 'negado', detalhe: json(resp) };
});
await caso('equipe vê responsável, celular, pessoas (com nascimento) e o pedido; sinaliza cadastro sugerido', async () => {
  await como(ATEND);
  const lista = (await q(`select public.painel_app_solicitacoes('solicitada') as r`))[0].r;
  await db.exec('reset role');
  const todos = lista.find((g) => g.pessoas.length >= 3);
  return { ok: !!todos && todos.responsavel === 'Ana Souza Teste' && todos.celular === '71991110001' && todos.exame === 'Consulta' && todos.turno === 'Tarde' && todos.pessoas.every((p) => p.nome && p.nascimento) && 'cadastro_sugerido' in todos, detalhe: `${lista.length} grupos` };
});
await caso('equipe confirma a solicitação: o status muda e a Bia/Ana veem "confirmada"; situação inválida é recusada; paciente não consegue', async () => {
  const lista = (await dono(`select grupo from public.app_marcacao where status = 'solicitada' order by criado_em limit 1`))[0];
  await como(ATEND);
  const n = (await q(`select public.painel_app_solicitacao_status($1, 'confirmada') as r`, [lista.grupo]))[0].r;
  let invalida = false; try { await q(`select public.painel_app_solicitacao_status($1, 'qualquer')`, [lista.grupo]); } catch (e) { invalida = /inválida/.test(e.message); }
  await como('00000000-0000-4000-8000-0000000000ff'); let negado = false; try { await q(`select public.painel_app_solicitacao_status($1, 'confirmada')`, [lista.grupo]); } catch (e) { negado = /Só a equipe/.test(e.message); }
  await db.exec('reset role');
  const novo = await rpc('app_login', TEL_ANA, '1111', 'x');
  const m = novo.perfil.marcacoes.find((x) => x.grupo === lista.grupo);
  await dono(`update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null`);
  return { ok: n >= 1 && invalida && negado && m && m.status === 'confirmada', detalhe: `${n} linhas` };
});
await caso('desligar o interruptor derruba tudo na hora, inclusive quem já estava dentro', async () => {
  const novo = await rpc('app_login', TEL_ANA, '1111', 'x'); await modo('nao');
  const a = await chamar('app_perfil', novo.token), b = await marcar(novo.token, ['eu']), c = await rpc('app_login', TEL_ANA, '1111', 'x');
  await modo('sim');
  const volta = await chamar('app_perfil', novo.token);
  return { ok: a.erro === 'indisponivel' && b.erro === 'indisponivel' && c.erro === 'indisponivel' && volta.ok === true };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
