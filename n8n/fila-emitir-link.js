// FLUXOGRAMA: entrada (webhook: nome, email_informado, paciente_id, atendimento_uuid) -> validação (UUIDs, e-mail, segredo presente) -> lógica (JWT HS256 com role/aud authenticated, sub = paciente_id, atendimento_id, email_informado, iat, exp = 4 h, jti) -> saída (link https://.../webchat/fila/?token=... para o nó de e-mail; o webhook de resposta não devolve o token)
// Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
// Nó "Code" (JavaScript, Run Once for Each Item). Segredo: variável de ambiente FILA_JWT_SECRET (o mesmo SUPABASE_JWT_SECRET do projeto).
const crypto = require('crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK_BASE = 'https://clinicacsiia.github.io/webchat/fila/';
const VALIDADE_S = 4 * 60 * 60;

const entrada = $input.first().json.body ?? $input.first().json;
const email = String(entrada.email_informado || '').trim().toLowerCase();
const atendimento = String(entrada.atendimento_uuid || '').trim().toLowerCase();
const paciente = String(entrada.paciente_id || '').trim().toLowerCase();

if (!UUID.test(atendimento) || !UUID.test(paciente) || !EMAIL.test(email)) {
  throw new Error('Dados inválidos para o link de assinatura.');
}

const segredo = $env.FILA_JWT_SECRET;
if (!segredo) {
  throw new Error('FILA_JWT_SECRET não configurado no n8n.');
}

const agora = Math.floor(Date.now() / 1000);
const cabecalho = { alg: 'HS256', typ: 'JWT' };
const payload = {
  role: 'authenticated',
  aud: 'authenticated',
  sub: paciente,
  atendimento_id: atendimento,
  email_informado: email,
  iat: agora,
  exp: agora + VALIDADE_S,
  jti: crypto.randomUUID(),
};

const codificar = (objeto) => Buffer.from(JSON.stringify(objeto)).toString('base64url');
const parteCabecalho = codificar(cabecalho);
const partePayload = codificar(payload);
const assinatura = crypto
  .createHmac('sha256', segredo)
  .update(`${parteCabecalho}.${partePayload}`)
  .digest('base64url');
const token = `${parteCabecalho}.${partePayload}.${assinatura}`;

return [{
  json: {
    nome: String(entrada.nome || '').trim(),
    email_informado: email,
    atendimento_uuid: atendimento,
    expira_em: new Date(payload.exp * 1000).toISOString(),
    link: `${LINK_BASE}?token=${token}`,
  },
}];
