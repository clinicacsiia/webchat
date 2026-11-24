# TesteWebchat (cópia de teste do WebChat)

Cópia funcional do chat (`index.html`) e do acesso rápido (`acesso/`) de 24/11/2026 (chat 2026.11.23-2).
Endereço depois de publicado: https://clinicacsiia.github.io/webchat/painel/testedowebchat/

Diferenças em relação à produção (tudo marcado com "TESTE" no código):
- Faixa laranja "AMBIENTE DE TESTE" no topo; título e manifesto próprios; `noindex`.
- Chaves do navegador separadas (`teste_…` / `teste.webchat.…`): não mexe na conversa real guardada no mesmo aparelho.
- A porta do PIN (`acesso/`) é a cópia daqui: volta para esta pasta, não para a produção.
- Sem service worker e sem push.
- Bloqueado no cliente: `chat_horario_escolher`, `chat_consulta_salvar`, `chat_pedido_enviar` e qualquer Edge Function que não seja `chat-agenda-api` (nada marca no Klingo).
- **Limite:** usa o mesmo Supabase da produção (decisão do dono). Conversas criadas aqui aparecem no painel real; use só dados fictícios.
