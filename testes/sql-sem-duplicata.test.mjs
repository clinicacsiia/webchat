// FLUXOGRAMA: entrada (clone da produção + supabase/chat-sem-duplicata.sql) -> validação (paciente anon chama chat_iniciar) -> lógica (mesma pessoa + mesmo paciente sem atendente: a antiga é encerrada e a nova aponta para ela; outra criança, conversa assumida ou outro telefone: nada é encerrado) -> saída (PASS/FAIL)
// Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes } from './banco-producao.mjs';
const res = [];
const reg = (n, ok, d = '') => { res.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`); };
const { db } = await criarBancoProducao();
const { q, anonimo, como } = ajudantes(db);
await db.exec(`insert into public.config (chave, valor) values ('ia_segredo','x'), ('motor','fluxo') on conflict (chave) do update set valor = excluded.valor;`);
await db.exec(readFileSync(new URL('../supabase/chat-sem-duplicata.sql', import.meta.url), 'utf8'));
let n = 0; const tel = () => '7198' + String(8000000 + ++n);
const ini = async (t, tipo = 'proprio', filho = null) => {
  await anonimo();
  const r = await q(`select public.chat_iniciar(p_nome => 'Maria Teste da Silva', p_telefone => $1, p_email => 'm@exemplo.invalid', p_aceite => true, p_paciente_tipo => $2, p_paciente_nome => $3) r`, [t, tipo, filho]);
  return r[0].r.conversa_id;
};
const st = async (id) => { await como(''); return (await q(`select status, motivo_encerramento m, encerramento_origem o, reentrada_de r from public.conversas where id = $1`, [id]))[0]; };
try {
  const t1 = tel();
  const a = await ini(t1, 'filho', 'Ana Criança'); const b = await ini(t1, 'filho', 'ana criança ');
  const sa = await st(a), sb = await st(b);
  reg('mesma criança sem atendente: antiga encerrada como nova_conversa pelo sistema', sa.status === 'encerrada' && sa.m === 'nova_conversa' && sa.o === 'sistema', JSON.stringify(sa));
  reg('a nova fica aberta e aponta para a antiga', sb.status !== 'encerrada' && sb.r === a, JSON.stringify(sb));
  const t2 = tel(); const c = await ini(t2, 'filho', 'Ana'); const d = await ini(t2, 'filho', 'Bia');
  reg('outra criança (irmã): nenhuma é encerrada', (await st(c)).status !== 'encerrada' && (await st(d)).status !== 'encerrada');
  const t3 = tel(); const e = await ini(t3); await como(''); await q(`update public.conversas set status = 'em_atendimento' where id = $1`, [e]); const f = await ini(t3);
  const se = await st(e), sf = await st(f); reg('conversa que a equipe já assumiu (em atendimento) não é encerrada', se.status !== 'encerrada' && sf.status !== 'encerrada', JSON.stringify([se, sf]));
  const g = await ini(tel()); const h = await ini(tel());
  reg('telefones diferentes: nada é encerrado', (await st(g)).status !== 'encerrada' && (await st(h)).status !== 'encerrada');
  const t5 = tel(); const i = await ini(t5); const j = await ini(t5); const k = await ini(t5);
  reg('3 aberturas seguidas: só a última fica aberta', (await st(i)).status === 'encerrada' && (await st(j)).status === 'encerrada' && (await st(k)).status !== 'encerrada');
} catch (e) { reg('exceção', false, String(e.message).split('\n')[0]); }
process.exit(res.every(Boolean) ? 0 : 1);
