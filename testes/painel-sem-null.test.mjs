// replaceChildren(..., null, ...) escreve a palavra "null" na tela (aconteceu no botão "Esconder detalhes e avisos", 17/11/2026).
// Este teste procura, em painel/index.html, argumentos de replaceChildren que podem ser null/undefined e falha se achar.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const arq = fileURLToPath(new URL('../painel/index.html', import.meta.url));
const s = fs.readFileSync(arq, 'utf8');
const ruins = [];
let i = -1;
while ((i = s.indexOf('replaceChildren(', i + 1)) >= 0) {
  let d = 0, j = i + 15, ini = j + 1, q = null; const args = [];
  for (; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { d--; if (d === 0) { args.push(s.slice(ini, j)); break; } }
    else if (c === ',' && d === 1) { args.push(s.slice(ini, j)); ini = j + 1; }
  }
  for (const a of args) if (/\?[^]*:\s*(null|undefined)\s*$/.test(a.trim())) ruins.push(s.slice(0, i).split('\n').length + ': ' + a.trim().slice(0, 70));
}
if (ruins.length) { console.log('FAIL  replaceChildren com null solto:\n  ' + ruins.join('\n  ')); process.exit(1); }
console.log('PASS  nenhum replaceChildren do painel recebe null solto');
