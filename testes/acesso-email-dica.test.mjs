// FLUXOGRAMA: entrada (acesso/index.html: a parte pura entre /*EMAIL-INI*/ e /*EMAIL-FIM*/ e as ligações na tela) -> validação (endereços certos nunca são questionados; erros comuns de digitação recebem a sugestão certa) -> lógica (emailSugestao compara o que vem depois do @ com os provedores mais usados) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 21/11/2026 / Mudança: Implementação inicial (e-mail conferido na hora, antes de pedir o código).
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../acesso/index.html', import.meta.url), 'utf8');
const [, puro] = html.match(/\/\*EMAIL-INI\*\/([\s\S]*?)\/\*EMAIL-FIM\*\//) || [];
let falhas = 0;
const caso = (nome, ok, det = '') => { if (!ok) falhas++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${det ? '  -- ' + det : ''}`); };
if (!puro) { console.log('FAIL  trecho puro não encontrado'); process.exit(1); }
const emailSugestao = new Function(`${puro}; return emailSugestao;`)();

// Erros reais e comuns -> sugestão certa
const erros = {
  'maria@hotmal.com': 'maria@hotmail.com', 'maria@hotmail.coml': 'maria@hotmail.com', 'maria@gmail.con': 'maria@gmail.com',
  'maria@gmai.com': 'maria@gmail.com', 'maria@gmial.com': 'maria@gmail.com', 'maria@gmail.co': 'maria@gmail.com',
  'maria@gmail.com.br': 'maria@gmail.com', 'maria@hotmail.cm': 'maria@hotmail.com', 'maria@outlok.com': 'maria@outlook.com',
  'maria@yaho.com.br': 'maria@yahoo.com.br', 'maria@icloud.con': 'maria@icloud.com', 'MARIA@Hotmal.com': 'maria@hotmail.com',
  'maria@gmail.com ': ''
};
for (const [dado, certo] of Object.entries(erros)) { const r = emailSugestao(dado); caso(`erro "${dado}" -> "${certo || '(nada)'}"`, r === certo, `veio "${r}"`); }

// Endereços certos nunca são questionados
for (const ok of ['a@gmail.com', 'a@hotmail.com', 'a@hotmail.com.br', 'a@outlook.com.br', 'a@yahoo.com', 'a@yahoo.com.br', 'a@uol.com.br', 'a@icloud.com', 'a@live.com', 'a@mail.com', 'a@ternegocios.com.br', 'joao.silva@clinicacsiia.com.br', 'a@empresa.com', 'a@usp.br', 'sem-arroba', 'a@b', '', null, undefined])
  caso(`certo "${ok}" fica quieto`, emailSugestao(ok) === '', `veio "${emailSugestao(ok)}"`);

// Ligações na tela
caso('campo do código ligado ao aviso (render)', /querySelectorAll\('#cemail,#pend input\[data-pc="email"\]'\)\.forEach\(ligarEmail\)/.test(html));
caso('botão "Enviar código" confere antes de chamar o servidor', /if\(!emailConferido\(\$\('#cemail'\)\)\)return;\s*\n\s*ocupado\(true\);const r=await rpc\('app_codigo_pedir'/.test(html));
caso('as duas telas de pendência também conferem', (html.match(/pc==='email'&&!emailConferido\(i\)/g) || []).length === 2);
caso('aviso nunca vira HTML (só textContent)', !/emailmsg[^\n]*innerHTML/.test(html));

console.log(falhas ? `\n${falhas} falha(s)` : '\nTodos os casos passaram');
process.exit(falhas ? 1 : 0);
