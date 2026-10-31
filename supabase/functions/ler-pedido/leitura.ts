// Partes puras da leitura do pedido médico pela IA: o formato da resposta, o texto de instrução e a limpeza do que voltou.
// Ficam fora do index.ts para rodar nos testes sem Deno nem rede.

export type Lado = "D" | "E" | "A" | "N";
export type Opcao = { rotulo: string; ids: number[] };
export type Exame = { escrito: string; entendido: string; lado: Lado; certeza: "alta" | "media" | "baixa"; opcoes: Opcao[] };
export type Leitura = {
  e_pedido_medico: boolean;
  legibilidade: "boa" | "parcial" | "ruim";
  total_exames: number;
  exames: Exame[];
  observacoes: string;
};
// [id, nome, modalidade], como ocr_ia_contexto devolve
export type ItemCatalogo = [number, string, string];

// Formato exigido da resposta (structured outputs): a IA não consegue devolver outra coisa.
export const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["e_pedido_medico", "legibilidade", "total_exames", "exames", "observacoes"],
  properties: {
    e_pedido_medico: { type: "boolean" },
    legibilidade: { type: "string", enum: ["boa", "parcial", "ruim"] },
    total_exames: { type: "integer" },
    exames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["escrito", "entendido", "lado", "certeza", "opcoes"],
        properties: {
          escrito: { type: "string" },
          entendido: { type: "string" },
          lado: { type: "string", enum: ["D", "E", "A", "N"] },
          certeza: { type: "string", enum: ["alta", "media", "baixa"] },
          opcoes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["rotulo", "ids"],
              properties: { rotulo: { type: "string" }, ids: { type: "array", items: { type: "integer" } } },
            },
          },
        },
      },
    },
    observacoes: { type: "string" },
  },
} as const;

const INSTRUCOES = `Você lê fotos de pedidos médicos (solicitação de exames) que pacientes enviam a uma clínica de exames de imagem no Brasil. Muitos pedidos são escritos à mão, com abreviações e letra difícil.

A sua leitura não vai direto para o paciente como resposta: ela vira opções que o próprio paciente (muitas vezes uma pessoa idosa, com pouca prática no celular) marca na tela, e depois um atendente confere a foto. Um exame errado marcado como certo atrapalha mais do que um "não tenho certeza", então quando a letra não deixar claro, diga isso pela certeza e pelas opções em vez de adivinhar.

Para cada exame pedido:
- escrito: o trecho do pedido como está no papel, com as abreviações. Só o exame: nunca o nome do paciente, documento, telefone ou endereço.
- entendido: o que o médico pediu, em português simples (ex.: "Ressonância do joelho esquerdo"). Vazio se não deu para ler.
- lado: D (direito), E (esquerdo), A (os dois lados) ou N (não se aplica ou o pedido não diz).
- certeza: alta, media ou baixa, sobre qual exame foi pedido.
- opcoes: os exames do catálogo abaixo que correspondem ao pedido.
  - O catálogo repete o mesmo exame com nomes diferentes (tabelas de convênios diferentes). Coloque esses ids juntos numa única opção.
  - Crie mais de uma opção só quando forem exames de fato diferentes e o pedido não deixar claro qual deles é. Exemplo: "eco" pode ser ecocardiograma ou ultrassom; "RX tórax" pode ser só PA ou PA e perfil.
  - rotulo: nome curto e simples, que uma pessoa idosa entende (ex.: "Ressonância do joelho", "Ultrassom da barriga inteira (abdome total)").
  - No máximo 4 opções. Deixe vazio quando o exame não está no catálogo ou não dá para ler: o atendente confere pela foto.
- Um pedido de "RM dos dois joelhos" é um exame com lado A, não dois exames.

total_exames: quantos exames o pedido tem, contando os que você não conseguiu ler. Cada exame do pedido aparece uma vez em exames, na ordem do papel.
e_pedido_medico: false se a foto não for um pedido de exame (receita de remédio, atestado, documento, foto sem texto).
legibilidade: boa, parcial ou ruim.
observacoes: o que o atendente precisa saber, curto: contraste, sedação, urgência, data do pedido, CID, convênio escrito no pedido. Nunca dados pessoais do paciente. Vazio se não houver nada.

Siglas comuns em pedidos: RM, RNM e RMN = ressonância magnética; TC e TCC = tomografia; US, USG e ECO = ultrassom (ECO também pode ser ecocardiograma: decida pelo resto da linha); RX = raio-X; MMG = mamografia; DMO = densitometria óssea; ECG = eletrocardiograma; c/ = com; s/ = sem; D, Dir = direito; E, Esq = esquerdo; bilat = bilateral; abd = abdome; tot = total; LS = lombossacra; CC = coluna cervical; art. = articulação; MMII = membros inferiores; MMSS = membros superiores.`;

// Instrução + catálogo: muda só quando o catálogo muda (uma vez por dia), por isso fica em cache na API.
export function montarSistema(catalogo: ItemCatalogo[]): string {
  const linhas = [...catalogo].sort((a, b) => a[0] - b[0]).map(([id, nome, mod]) => `${id} | ${nome} | ${mod}`);
  return `${INSTRUCOES}\n\nCatálogo de exames que a clínica faz (id | nome | tipo):\n${linhas.join("\n")}`;
}

// O que muda a cada foto: quem é o paciente e as escritas que a equipe já confirmou.
export function montarPedido(paciente: string, aprendido: [string, number][]): string {
  const memoria = aprendido.length
    ? `\n\nEscritas que a equipe da clínica já confirmou em pedidos anteriores (como estava escrito → id do exame). Quando a escrita for a mesma, use o mesmo exame:\n${aprendido.map(([t, id]) => `${t} → ${id}`).join("\n")}`
    : "";
  return `O paciente é ${paciente}: use isso para escolher entre a versão de adulto e a pediátrica de um exame.${memoria}\n\nLeia o pedido médico da foto.`;
}

const corta = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

// Limpa a resposta: só ids do catálogo, textos curtos, no máximo 12 exames e 4 opções por exame.
export function limparLeitura(bruta: unknown, catalogo: ItemCatalogo[]): Leitura {
  const r = (bruta && typeof bruta === "object" ? bruta : {}) as Record<string, unknown>;
  const ids = new Set(catalogo.map((c) => c[0]));
  const exames: Exame[] = (Array.isArray(r.exames) ? r.exames : []).slice(0, 12).map((x) => {
    const e = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const opcoes: Opcao[] = (Array.isArray(e.opcoes) ? e.opcoes : []).map((o) => {
      const op = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
      const v = [...new Set((Array.isArray(op.ids) ? op.ids : []).filter((i): i is number => Number.isInteger(i) && ids.has(i as number)))].slice(0, 12);
      return { rotulo: corta(op.rotulo, 120), ids: v };
    }).filter((o) => o.ids.length > 0).slice(0, 4);
    return {
      escrito: corta(e.escrito, 160),
      entendido: corta(e.entendido, 160),
      lado: (["D", "E", "A", "N"].includes(e.lado as string) ? e.lado : "N") as Lado,
      certeza: (["alta", "media", "baixa"].includes(e.certeza as string) ? e.certeza : "baixa") as Exame["certeza"],
      opcoes,
    };
  });
  const total = Number.isInteger(r.total_exames) ? Math.max(0, Math.min(30, r.total_exames as number)) : exames.length;
  return {
    e_pedido_medico: r.e_pedido_medico !== false,
    legibilidade: (["boa", "parcial", "ruim"].includes(r.legibilidade as string) ? r.legibilidade : "ruim") as Leitura["legibilidade"],
    total_exames: Math.max(total, exames.length),
    exames,
    observacoes: corta(r.observacoes, 500),
  };
}
