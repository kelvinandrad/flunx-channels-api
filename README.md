# flunx-channels-api

API mínima para canais de comunicação: cria instâncias na Evolution API, persiste em Supabase (`chat_inboxes`) e expõe QR code para o frontend.

## Variáveis de ambiente

- `PORT` – porta do servidor (default 3001)
- `EVOLUTION_BASE_URL` – URL da Evolution API (ex: https://apiwpp.flunx.com.br)
- `EVOLUTION_API_KEY` – API key da Evolution (header `apikey`)
- `SUPABASE_URL` – URL do projeto Supabase
- `SUPABASE_SERVICE_ROLE_KEY` – Chave service role (backend)
- `SUPABASE_ANON_KEY` – (opcional) Para usar JWT do usuário e RLS
- **`WEBHOOK_BASE_URL`** ou **`CHANNELS_API_PUBLIC_URL`** – URL pública desta API, usada pela Evolution para chamar o webhook. Em produção use HTTPS (ex: `https://api-canais.flunx.com.br`). Em dev use ngrok (ex: `https://abc123.ngrok.io`).

## Endpoints

- **POST /channels** – Criar canal (body: `type`, `name`, `organization_id`). Após criar, registra o webhook na Evolution para `{WEBHOOK_BASE_URL}/webhook/evolution`.
- **GET /channels/:inboxId/qrcode** – Obter QR code do canal
- **GET /channels?organization_id=** – Listar canais da organização
- **POST /webhook/evolution** – Webhook chamado pela Evolution (MESSAGES_UPSERT, CONNECTION_UPDATE, QRCODE_UPDATED). Sem autenticação; a Evolution envia o payload.
- **GET /health** – Health check

Contrato completo em `flunx-v2/docs/api-canais.md`.

## Expor a API para a Evolution (webhook)

A Evolution precisa conseguir fazer **POST** na URL do webhook a partir da internet. Você deve:

1. **Produção:** Garantir que a API está em um host público com HTTPS (ex: `https://api-canais.flunx.com.br`) e definir no `.env`:
   ```bash
   WEBHOOK_BASE_URL=https://api-canais.flunx.com.br
   ```
2. **Desenvolvimento local:** Expor a porta com [ngrok](https://ngrok.com/) (ou similar) e usar a URL gerada:
   ```bash
   ngrok http 3001
   # Use a URL HTTPS exibida (ex: https://abc123.ngrok-free.app)
   WEBHOOK_BASE_URL=https://abc123.ngrok-free.app
   ```
   Reinicie a API após definir a variável. Ao criar um canal, a Evolution passará a enviar eventos para `{WEBHOOK_BASE_URL}/webhook/evolution`.

## Executar (local)

```bash
cp .env.example .env
# Editar .env com as chaves
npm install
npm run dev
```

## Deploy (Docker Swarm)

1. Crie `/root/flunx-channels-api/.env` com as variáveis (ver `.env.example`).
2. Build da imagem (no diretório do projeto):
   ```bash
   docker build -t flunx-channels-api:latest /root/flunx-channels-api
   ```
3. Deploy do stack (a partir de `/root`, para o bind do `.env`):
   ```bash
   docker stack deploy -c /root/flunx-channels-api/flunx-channels-api.yaml flunx-channels-api
   ```
4. Configure o DNS para `api-canais.flunx.com.br` apontar para o servidor e use essa URL nos frontends (`VITE_CHANNELS_API_URL`). Os stacks `flunx-chat.yaml` e `flunx-app.yaml` já usam `https://api-canais.flunx.com.br` em produção.

## Evolution API

Paths usados:
- `POST /instance/create` – criar instância
- `GET /instance/connect/:instanceName` – conectar e obter QR
- `GET /instance/connectionState/:instanceName` – estado da conexão
- **`POST /webhook/set/:instanceName`** – configurar webhook da instância (body: `enabled`, `url`, `events`). Conferido na [doc Evolution – Set Webhook](https://doc.evolution-api.com/v2/api-reference/webhook/set). Find Webhook: `GET /webhook/find/[instance]`.

Se sua versão usar prefixo (ex: `/v1/`), ajustar em `src/evolution.js`.
