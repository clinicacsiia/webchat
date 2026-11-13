// Cifra dos dados da pessoa (CPF, nascimento, nome, celular) com AES-GCM 256. Sem Deno: usa só a Web Crypto, que existe no Deno e no Node (testes).
// Versão 1.0 — 13/11/2026. A chave (32 bytes em base64) fica SÓ no secret FAMILIA_CHAVE da função; o banco guarda apenas o texto cifrado ("iv.dados" em base64url).
// Quem perde a chave perde a leitura dos dados: guardar uma cópia do secret fora do Supabase (cofre de senhas do dono).

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

async function chaveDe(base64: string): Promise<CryptoKey> {
  const bruto = Uint8Array.from(atob(base64.trim()), (c) => c.charCodeAt(0));
  if (bruto.length !== 32) throw new Error("chave_invalida");
  return await crypto.subtle.importKey("raw", bruto, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function cifrar(obj: unknown, chaveBase64: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dados = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await chaveDe(chaveBase64), new TextEncoder().encode(JSON.stringify(obj))));
  return `${b64u(iv)}.${b64u(dados)}`;
}

export async function decifrar<T = Record<string, unknown>>(texto: string, chaveBase64: string): Promise<T> {
  const [iv, dados] = String(texto).split(".");
  if (!iv || !dados) throw new Error("texto_invalido");
  const claro = await crypto.subtle.decrypt({ name: "AES-GCM", iv: deb64u(iv) }, await chaveDe(chaveBase64), deb64u(dados));
  return JSON.parse(new TextDecoder().decode(claro)) as T;
}

/** Código aleatório de aparelho (32 bytes, base64url = 43 caracteres) e o hash dele (SHA-256 em hexadecimal), que é o que o banco guarda. */
export const novoToken = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(texto: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const novaChaveBase64 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
