# Aplicativo da CSI para iPhone (App Store) e Android (Google Play)

Versão 1.0 — 16/11/2026. Mudança: casca nativa criada na pasta `app/` (Capacitor), sem mexer no site.

## Como funciona

A pasta `app/` é uma **casca nativa** que abre o chat publicado em `https://clinicacsiia.github.io/webchat/`. O site continua sendo um só: toda mudança publicada no GitHub Pages aparece no app **sem nova versão na loja**. Só precisa de nova versão da loja quando mudar a casca (ícone, permissões, recursos nativos).

Pastas: `app/ios` (projeto Xcode), `app/android` (projeto Android Studio), `app/capacitor.config.json` (endereço do site e domínios permitidos), `app/www` (tela de "sem internet").

## O que só o dono consegue fazer (iPhone)

1. **Conta Apple Developer** (US$ 99/ano), como organização (CNPJ da clínica; pede número D-U-N-S, leva alguns dias): https://developer.apple.com/programs/enroll/
2. **Um Mac com Xcode** ou um serviço de build na nuvem (ex.: Codemagic). Sem Mac não dá para gerar o arquivo da loja. A sessão do Claude roda em Linux e não gera o `.ipa`.
3. Criar o app na loja: https://appstoreconnect.apple.com/apps (nome "CSI", identificador `br.com.csi.paciente`).
4. Preencher privacidade (dados de saúde, CPF, telefone), URL da política (`https://clinicacsiia.github.io/webchat/privacidade.html`) e uma **conta de teste** para o revisor da Apple.

Passos no Mac:

```bash
cd app && npm install && npx cap sync ios && npx cap open ios
```

No Xcode: escolher o time (Signing & Capabilities) → Product → Archive → Distribute App → App Store Connect.

## Android (depois)

Conta Google Play (US$ 25, uma vez): https://play.google.com/console/signup. Gerar o pacote com `cd app && npx cap sync android && npx cap open android` → Build → Generate Signed Bundle (.aab). **Guardar o arquivo `.keystore` fora do repositório** (perdeu, perdeu a conta do app).

## Riscos de aprovação na Apple (importante)

- **Regra 4.2 (funcionalidade mínima):** a Apple rejeita app que é só um site dentro de uma moldura. Este app precisa de pelo menos um recurso nativo real. O mais natural aqui é **aviso (push) nativo** e **Face ID** para entrar. Hoje o site usa *Web Push* (service worker), que **não funciona dentro do app**; a "minha vez" e os avisos de resposta precisam de push nativo (APNs).
- **Push nativo (fase 2, ainda não feita):** exige chave APNs (`.p8`, criada em https://developer.apple.com/account/resources/authkeys/list, entregue pelo dono, nunca no repositório), plugin `@capacitor/push-notifications`, uma tabela para o token do aparelho e uma Edge Function que envia pelo APNs. Hoje o site avisa quando não há push possível (`pushPossivel()` em `index.html`), então o chat continua funcionando sem avisos.
- **Regra 5.1.1:** como o app tem conta, precisa permitir apagar a conta. Já existe ("Meus dados"); o revisor precisa achar fácil.
- **Dados de saúde:** o jurídico ainda precisa revisar o texto de privacidade (pendência já registrada).
- Cloudflare Turnstile e o login do Supabase funcionam no endereço `clinicacsiia.github.io`; por isso o app carrega o site publicado em vez de cópia local. Não trocar para arquivos locais sem testar os dois.

## Testes ainda não feitos

Nada foi aberto num aparelho ou simulador (aqui não há Xcode). A casca foi só criada e sincronizada. Primeiro teste a fazer: abrir no simulador, entrar no chat, enviar mensagem, anexar foto de pedido (pede permissão de câmera/fotos; os textos em português já estão no `Info.plist`).
