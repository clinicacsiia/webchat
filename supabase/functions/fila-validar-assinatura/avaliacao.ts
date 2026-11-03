// FLUXOGRAMA: entrada (pontos [{x, y, timestamp, pressao, traco}], perfil do paciente, tentativas_falhas, consentimento) -> validação (consentimento, tamanho, valores finitos, tempo crescente, duração, canvas normalizado) -> lógica (características dinâmicas -> distância normalizada contra o perfil -> score = 1/(1+d) arredondado -> limiar 0,30 -> EWMA do perfil só se aprovado; contador de 3 tentativas) -> saída (resultado para assinatura_registrar: aprovado, tipo, score, características, perfil novo, tentativas restantes, bloqueio)
// Versão 1.0 — 03/11/2026 / Mudança: porte de biometria/avaliar_assinatura.py (que rodava no n8n) para TypeScript.
//
// Sem imports e sem Deno: roda igual no Edge Function e no teste do Node (avaliacao.test.ts).
// O Python continua no repositório como REFERÊNCIA: biometria/gerar_vetores.py gera vetores.json e o teste exige resultado idêntico.
// O banco (assinatura_registrar) continua sendo a autoridade final: limiar, tentativas, hash e perfil são conferidos de novo lá.

export const SCORE_MINIMO = 0.30;
export const TENTATIVAS_MAXIMAS = 3;
const MIN_PONTOS = 20;
const MAX_PONTOS = 5000;
const DURACAO_MIN_MS = 300;
const DURACAO_MAX_MS = 60000;
const MAX_TRACOS = 200;
const TOLERANCIA_BORDA = 0.05;     // o pointer capture pode levar o ponteiro levemente para fora do canvas
const JANELA_APRENDIZADO = 20;     // taxa de aprendizado mínima = 1/20: o perfil segue o paciente sem derivar sozinho
const PISO_DESVIO_RELATIVO = 0.10; // desvio nunca menor que 10% da média do próprio paciente

export const NOMES_FEATURES = [
  'velocidade_media', 'jitter', 'duracao_ms', 'pressao_media', 'pressao_desvio', 'num_tracos', 'pausa_media_ms',
] as const;
export type Nome = typeof NOMES_FEATURES[number];
export type Features = Record<Nome, number>;
export type Perfil = { versao: number; n: number; features: Record<Nome, { media: number; variancia: number }> };
export type Ponto = { x: number; y: number; timestamp: number; pressao: number; traco: number };

// Uma feature de média zero (ex.: pausa quando só há um traço) não pode transformar variação pequena em rejeição.
const PISO_DESVIO_ABSOLUTO: Record<Nome, number> = {
  velocidade_media: 0.0005, jitter: 0.001, duracao_ms: 50, pressao_media: 0.05,
  pressao_desvio: 0.02, num_tracos: 1, pausa_media_ms: 300,
};

export class SerieInvalida extends Error {}

// Arredondamento como o round() do Python: o valor decimal EXATO do double decide (toFixed(100) o mostra inteiro) e,
// só num empate exato (…5000…), vai para o dígito par. toFixed sozinho desempata para cima.
export function arredondar(v: number, casas: number): number {
  const r = Number(v.toFixed(casas));
  if (!(v >= 0) || !Number.isFinite(v)) return r;
  const exato = v.toFixed(100);
  const ponto = exato.indexOf('.');
  const resto = exato.slice(ponto + 1 + casas);
  if (!/^50*$/.test(resto)) return r;
  const ultimo = Number(casas === 0 ? exato[ponto - 1] : exato[ponto + casas]);
  if (ultimo % 2 !== 0) return r;                       // ímpar: arredonda para cima (par), igual ao toFixed
  return Number(exato.slice(0, casas === 0 ? ponto : ponto + 1 + casas));   // par: fica
}

// Soma compensada (Neumaier), igual ao sum() de números reais do Python 3.12+. Sem isso, a média de pressão diverge na 6ª casa
// em valores que caem exatamente num empate de arredondamento (ex.: média = k * 1,25e-6).
function soma(valores: number[]): number {
  let total = 0, c = 0;
  for (const x of valores) {
    const t = total + x;
    c += Math.abs(total) >= Math.abs(x) ? (total - t) + x : (x - t) + total;
    total = t;
  }
  return c !== 0 && Number.isFinite(c) ? total + c : total;
}
const media = (valores: number[]) => (valores.length ? soma(valores) / valores.length : 0);
const limitar = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

// float() do Python aceita número e texto numérico; qualquer outra coisa é "malformado".
function numero(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new Error('não numérico');
}

export function validarSerie(pontos: unknown): Ponto[] {
  if (!Array.isArray(pontos) || pontos.length < MIN_PONTOS || pontos.length > MAX_PONTOS) {
    throw new SerieInvalida(`a série precisa ter entre ${MIN_PONTOS} e ${MAX_PONTOS} pontos`);
  }
  const limpos: Ponto[] = [];
  let anterior: number | null = null;
  pontos.forEach((p, i) => {
    let x: number, y: number, t: number, pressao: number, traco: number;
    try {
      if (p === null || typeof p !== 'object') throw new Error('ponto');
      const o = p as Record<string, unknown>;
      x = numero(o.x); y = numero(o.y); t = numero(o.timestamp);
      const vazio = (v: unknown) => v === null || v === undefined || v === '' || v === false;   // como "x or 0" do Python
      pressao = vazio(o.pressao) ? 0 : numero(o.pressao);
      traco = vazio(o.traco) ? 0 : Math.trunc(numero(o.traco));
    } catch {
      throw new SerieInvalida(`ponto ${i} malformado`);
    }
    if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(t) && Number.isFinite(pressao))) throw new SerieInvalida(`ponto ${i} com valor não finito`);
    if (anterior !== null && t < anterior) throw new SerieInvalida(`ponto ${i} fora de ordem no tempo`);
    anterior = t;
    if (!(x >= -TOLERANCIA_BORDA && x <= 1 + TOLERANCIA_BORDA && y >= -TOLERANCIA_BORDA && y <= 1 + TOLERANCIA_BORDA)) throw new SerieInvalida(`ponto ${i} fora do canvas normalizado`);
    if (!(traco >= 0 && traco < MAX_TRACOS)) throw new SerieInvalida(`ponto ${i} com índice de traço inválido`);
    limpos.push({ x: limitar(x, 0, 1), y: limitar(y, 0, 1), timestamp: t, pressao: limitar(pressao, 0, 1), traco });
  });
  const duracao = limpos[limpos.length - 1].timestamp - limpos[0].timestamp;
  if (!(duracao >= DURACAO_MIN_MS && duracao <= DURACAO_MAX_MS)) throw new SerieInvalida('duração da assinatura fora do intervalo aceito');
  return limpos;
}

export function extrairCaracteristicas(pontos: unknown): Features {
  const serie = validarSerie(pontos);
  const porTraco = new Map<number, Ponto[]>();
  for (const p of serie) {
    if (!porTraco.has(p.traco)) porTraco.set(p.traco, []);
    porTraco.get(p.traco)!.push(p);
  }
  const sequencias = [...porTraco.keys()].sort((a, b) => a - b).map((k) => porTraco.get(k)!);

  const velocidades: number[] = [];
  const jitters: number[] = [];
  for (const seq of sequencias) {
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i], b = seq[i + 1];
      const dt = b.timestamp - a.timestamp;
      if (dt > 0) {
        const dx = b.x - a.x, dy = b.y - a.y;
        velocidades.push((dx * dx + dy * dy) ** 0.5 / dt);
      }
    }
    for (let i = 0; i + 2 < seq.length; i++) {
      const a = seq[i], b = seq[i + 1], c = seq[i + 2];
      const ddx = c.x - 2 * b.x + a.x, ddy = c.y - 2 * b.y + a.y;   // segunda diferença: quanto o traço "treme"
      jitters.push((ddx * ddx + ddy * ddy) ** 0.5);
    }
  }
  const pausas: number[] = [];
  for (let i = 0; i + 1 < sequencias.length; i++) {
    pausas.push(sequencias[i + 1][0].timestamp - sequencias[i][sequencias[i].length - 1].timestamp);
  }
  const pressoes = serie.filter((p) => p.pressao > 0).map((p) => p.pressao);
  const mediaPressao = media(pressoes);
  const desvioPressao = pressoes.length ? (soma(pressoes.map((p) => (p - mediaPressao) ** 2)) / pressoes.length) ** 0.5 : 0;

  return {
    velocidade_media: arredondar(media(velocidades), 8),
    jitter: arredondar(media(jitters), 8),
    duracao_ms: arredondar(serie[serie.length - 1].timestamp - serie[0].timestamp, 3),
    pressao_media: arredondar(mediaPressao, 6),
    pressao_desvio: arredondar(desvioPressao, 6),
    num_tracos: sequencias.length,
    pausa_media_ms: arredondar(media(pausas), 3),
  };
}

export function novoPerfil(): Perfil {
  const features = {} as Perfil['features'];
  for (const nome of NOMES_FEATURES) features[nome] = { media: 0, variancia: 0 };
  return { versao: 1, n: 0, features };
}

export function distanciaNormalizada(f: Features, perfil: Perfil): number {
  if (Math.trunc(Number(perfil.n) || 0) === 0) throw new SerieInvalida('perfil sem amostras: use avaliar() para o enrolamento');
  let soma = 0;
  for (const nome of NOMES_FEATURES) {
    const ref = perfil.features[nome];
    const mediaRef = Number(ref.media);
    const variancia = Math.max(Number(ref.variancia), 0);
    const desvio = Math.max(variancia ** 0.5, PISO_DESVIO_RELATIVO * Math.abs(mediaRef), PISO_DESVIO_ABSOLUTO[nome]);
    const z = (Number(f[nome]) - mediaRef) / desvio;
    soma += z * z;
  }
  return (soma / NOMES_FEATURES.length) ** 0.5;
}

export const scoreSimilaridade = (distancia: number) => 1 / (1 + distancia);

// Enrolamento (sem perfil) aprova sem score. Comparação decide pelo score JÁ arredondado em 4 casas, o mesmo que o banco confere.
export function avaliar(f: Features, perfil: Perfil): { tipo: 'enrolamento' | 'comparacao'; score: number | null; aprovado: boolean } {
  if (Math.trunc(Number(perfil.n) || 0) === 0) return { tipo: 'enrolamento', score: null, aprovado: true };
  const score = arredondar(scoreSimilaridade(distanciaNormalizada(f, perfil)), 4);
  return { tipo: 'comparacao', score, aprovado: score >= SCORE_MINIMO };
}

export function atualizarPerfil(perfil: Perfil, f: Features): Perfil {
  const nAntes = Math.trunc(Number(perfil.n) || 0);
  const n = nAntes + 1;
  const novas = {} as Perfil['features'];
  if (nAntes === 0) {
    for (const nome of NOMES_FEATURES) novas[nome] = { media: Number(f[nome]), variancia: 0 };
  } else {
    const alpha = 1 / Math.min(n, JANELA_APRENDIZADO);
    for (const nome of NOMES_FEATURES) {
      const mediaRef = Number(perfil.features[nome].media);
      const varRef = Number(perfil.features[nome].variancia);
      const delta = Number(f[nome]) - mediaRef;
      novas[nome] = { media: mediaRef + alpha * delta, variancia: (1 - alpha) * (varRef + alpha * delta * delta) };
    }
  }
  return { versao: 1, n, features: novas };
}

// A contagem é do atendimento, não do token. O banco refaz esta conta; aqui ela só gera a mensagem.
export function registrarTentativa(falhasAtuais: number, aprovado: boolean) {
  if (!(falhasAtuais >= 0 && falhasAtuais <= TENTATIVAS_MAXIMAS)) throw new SerieInvalida('contador de falhas fora do intervalo');
  if (aprovado) return { falhas: falhasAtuais, restantes: TENTATIVAS_MAXIMAS - falhasAtuais, bloqueado: false };
  const falhas = falhasAtuais + 1;
  return { falhas, restantes: Math.max(TENTATIVAS_MAXIMAS - falhas, 0), bloqueado: falhas >= TENTATIVAS_MAXIMAS };
}

export type Entrada = { consentimento?: unknown; perfil?: unknown; pontos?: unknown; tentativas_falhas?: unknown };

// Uma assinatura de ponta a ponta. Nunca lança: erro de série vira { ok: false, erro }.
export function resolver(entrada: Entrada) {
  if (entrada.consentimento !== true) return { ok: false as const, erro: 'consentimento_obrigatorio' };
  let perfil = (entrada.perfil && typeof entrada.perfil === 'object' ? entrada.perfil : {}) as Perfil;
  if (Math.trunc(Number(perfil.n) || 0) === 0) perfil = novoPerfil();
  try {
    const features = extrairCaracteristicas(entrada.pontos);
    const avaliacao = avaliar(features, perfil);
    const tentativa = registrarTentativa(Math.trunc(Number(entrada.tentativas_falhas) || 0), avaliacao.aprovado);
    const saida: Record<string, unknown> = {
      ok: true,
      aprovado: avaliacao.aprovado,
      tipo: avaliacao.tipo,
      score: avaliacao.score,
      consentimento: true,
      perfil_n_base: Math.trunc(Number(perfil.n) || 0),
      caracteristicas: features,
      tentativas_restantes: tentativa.restantes,
      bloqueado: tentativa.bloqueado,
    };
    if (avaliacao.aprovado) saida.perfil_novo = atualizarPerfil(perfil, features);
    return saida as { ok: true; aprovado: boolean; tipo: string; score: number | null; perfil_n_base: number; caracteristicas: Features; tentativas_restantes: number; bloqueado: boolean; perfil_novo?: Perfil };
  } catch (e) {
    if (e instanceof SerieInvalida) return { ok: false as const, erro: 'serie_invalida', detalhe: e.message };
    throw e;
  }
}
