// Resume os achados (.jsonl) da auditoria de layout, agrupando por tipo e elemento. Uso: node auditoria-layout-resumo.mjs <pasta> [tipos,separados,por,virgula]
import { readdirSync, readFileSync } from 'node:fs';
const dir = process.argv[2]; const so = process.argv[3];
if (!dir) { console.error('Uso: node auditoria-layout-resumo.mjs <pasta> [tipos]'); process.exit(2); }
const todos = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) for (const l of readFileSync(dir + '/' + f, 'utf8').split('\n').filter(Boolean)) { try { todos.push({ ...JSON.parse(l), teste: f.replace('.jsonl', '') }); } catch { /* linha incompleta */ } }
const por = {}; for (const a of todos) (por[a.tipo] ||= []).push(a);
console.log('total de achados:', todos.length, Object.fromEntries(Object.entries(por).map(([k, v]) => [k, v.length])));
const norm = (e) => e.split(' > ').slice(-2).join(' > ').replace(/#[a-z0-9_-]+/gi, '');
for (const tipo of Object.keys(por)) {
  if (so && !so.split(',').includes(tipo)) continue;
  const g = new Map();
  for (const a of por[tipo]) { const k = a.pagina.replace(/\/index\.html$/, '/') + ' ' + norm(a.el); if (!g.has(k)) g.set(k, { n: 0, a, testes: new Set() }); const x = g.get(k); x.n++; x.testes.add(a.teste); }
  console.log(`\n### ${tipo}: ${g.size} elementos distintos`);
  for (const [k, v] of [...g].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) console.log(` - ${k} | “${v.a.texto}” | ${v.a.detalhe.slice(0, 120)} | ${v.a.contexto} | ${[...v.testes].slice(0, 2).join(',')}`);
}
