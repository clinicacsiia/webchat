// Fluxo: configuração da página → cliente do Supabase (a mesma sessão do painel) → funções painel_simulacao_dia e painel_simulacao_indicadores.
// Versão 2.1 — 15/11/2026 / Mudança: a fonte dos dados passou a ser o banco do webchat (relatório #14359 do Klingo pela Jornada), no lugar de uma rota própria.
export const config = {
 supabaseUrl: 'https://nrvuynjwcgwpjdptkiay.supabase.co',
 supabaseKey: 'sb_publishable_e2GK1YGEj06STa_ESCevow_nvtATB-y', // chave pública (a mesma das outras telas); quem manda é o login e a regra de acesso do banco
 pollMs: 60000,
 indicatorDays: 28,
 storageNamespace: 'clinica-csi-simulacao'
};
