# Assistente Phone

Página estática que transforma um iPhone em assistente de voz e câmera usando o Claude.

- Rosto animado que olha na direção do movimento captado pela câmera
- Espectro circular que reage ao microfone
- Reconhecimento de voz e fala do próprio Safari (pt-BR)
- Comentário automático quando detecta movimento (configurável)

## Uso

1. Abra a URL do GitHub Pages no **Safari** do iPhone.
2. Cole sua chave da API Anthropic (fica salva só no aparelho) e toque em **Ligar**.
3. Diga a palavra de ativação (padrão: "assistente") ou toque na tela para falar.
4. Perguntas como "o que você está vendo?" enviam uma foto da câmera junto.

## Deixar ligado 24h

- Ajustes > Tela e Brilho > Bloqueio Automático: **Nunca**
- Ajustes > Acessibilidade > **Acesso Guiado** (trava o Safari na página; ative com triplo clique no botão lateral)
- Deixe no carregador com "Carregamento Otimizado" ligado

## Segurança

Não há chave neste repositório. Use uma chave exclusiva com limite de gasto baixo no console da Anthropic.

## Modo Mac + Claude Code (`bridge/`)

Roda o assistente no navegador do Mac e deixa ele mandar tarefas para o Claude Code
nos seus projetos ("assistente, roda os testes do chatbot-pro").

### Ligar

```bash
git clone https://github.com/luizsoga-maker/assistente-phone.git
cd assistente-phone
./bridge/start-mac.sh
```

Na primeira vez o script instala as dependências, pede a chave da API Anthropic,
cria `bridge/.env` (com um token aleatório) e `bridge/projects.json`, liga a ponte
e abre `http://localhost:8787` no Safari.

Para liberar outros projetos, edite `bridge/projects.json`:

```json
{
  "chatbot-pro": "~/projetos/chatbot-pro",
  "assistente-phone": "~/projetos/assistente-phone"
}
```

e reinicie: `pkill -f 'node server.mjs'; ./bridge/start-mac.sh`.

### Permissões

| O Claude Code quer… | O que acontece |
|---|---|
| Ler ou editar arquivos dentro do projeto | Liberado |
| Mexer em `.env`, chaves ou `.git` | Pede confirmação |
| Qualquer coisa fora do projeto | Pede confirmação |
| Rodar comandos no terminal | Pede confirmação |

A confirmação aparece na tela (Permitir/Negar) e também pode ser respondida por voz
("sim", "pode", "não"). Sem resposta em 5 minutos, é negado. "Cancela a tarefa"
interrompe o que estiver rodando.

### Segurança

- A ponte só escuta em `127.0.0.1` e só aceita o Host `localhost`.
- A chave da API fica em `bridge/.env` (fora do navegador e do git).
- Pedidos de git push, deploy e exclusões só acontecem se você pedir explicitamente.
