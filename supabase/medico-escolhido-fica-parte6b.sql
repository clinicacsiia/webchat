-- Parte 6b: sai a versão de 2 parâmetros (valores padrão), que nenhuma tela publicada chama. Fica separada porque a ferramenta de migração pede confirmação em "drop".
drop function if exists public.chat_medico_sem_horario_abrir(uuid, text);
