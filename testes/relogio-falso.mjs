// FLUXOGRAMA: entrada (RELOGIO_UTC=HH:MM) -> lógica (troca o relógio do processo, e com ele o do Postgres embutido, para essa hora de hoje) -> saída (o teste roda como se fosse outra hora do dia)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial. Uso: RELOGIO_UTC=01:10 node --import ./relogio-falso.mjs sql-pessoa.test.mjs
// Adianta/atrasa o relógio do processo para que "agora" seja a hora UTC pedida em RELOGIO_UTC (HH:MM), no dia de hoje.
const [h, m] = (process.env.RELOGIO_UTC || '01:10').split(':').map(Number);
const real = Date.now(), alvo = new Date(real); alvo.setUTCHours(h, m, 0, 0);
const delta = alvo.getTime() - real;
const DataReal = Date;
class DataFalsa extends DataReal { constructor(...a) { if (a.length === 0) super(DataReal.now() + delta); else super(...a); } static now() { return DataReal.now() + delta; } }
globalThis.Date = DataFalsa;
