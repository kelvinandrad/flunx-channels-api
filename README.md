# flunx-channels-api

API intermediária entre o frontend **flunx-chat** e a **Evolution API**. Persiste canais, contatos, conversas e mensagens no **Supabase**. Implementação da **Especificação Técnica flunx-channels-api v1.0**.

## Visão geral

| Componente           | Responsabilidade                                      |
|----------------------|--------------------------------------------------------|
| flunx-channels-api   | Orquestrar comunicação, processar webhooks, autenticar |
| Evolution API        | Conectar WhatsApp, enviar/receber mensagens, QR codes  |
| Supabase             | Persistir chat_inboxes, chat_contacts, chat_conversations, chat_messages |
| Frontend (flunx-chat)| Interface; consome esta API com JWT Supabase           |

## Variáveis de ambiente

- **PORT** – porta do servidor (default 3001)
- **SUPABASE_URL** – URL do projeto Supabase
- **SUPABASE_SERVICE_KEY** ou **SUPABASE_SERVICE_ROLE_KEY** – Service Role Key (não usar anon key aqui)
- **SUPABASE_ANON_KEY** – (opcional) Para `createUserClient` e RLS com JWT do usuário
- **EVOLUTION_API_URL** ou **EVOLUTION_BASE_URL** – URL da Evolution API (ex: https://apiwpp.flunx.com.br)
- **EVOLUTION_API_KEY** – API key da Evolution (header `apikey`)
- **WEBHOOK_BASE_URL** – URL pública desta API para a Evolution chamar o webhook (ex: https://api-canais.flunx.com.br)
- **WEBHOOK_SECRET_TOKEN** – (opcional) Token para validar webhook (query `?token=` ou header `X-Webhook-Token`)

## Autenticação

As rotas protegidas exigem **Bearer JWT** do Supabase no header `Authorization`. O middleware valida com `supabase.auth.getUser(token)` e, quando aplicável, verifica acesso à organização via tabela **organization_members**.

## Endpoints

- **GET /health** – Health check (sem auth)
- **POST /webhook/evolution** – Webhook da Evolution (sem auth): QRCODE_UPDATED, CONNECTION_UPDATE, MESSAGES_UPSERT, MESSAGES_UPDATE

### Canais (auth)

- **POST /channels** – Criar canal (body: `organization_id`, `name`)
- **GET /channels** – Listar canais (query: `organization_id` opcional)
- **GET /channels/:id/info** – Atualizar e retornar info do canal
- **GET /channels/:inboxId/qrcode** – Obter/atualizar QR code
- **POST /channels/:id/reconnect** – Reconectar canal (nova instância + QR)
- **DELETE /channels/:id** – Remover canal e instância Evolution

### Inboxes / conversas / mensagens (auth)

- **POST /inboxes/:inboxId/sync** – Sincronizar contatos e conversas da Evolution
- **GET /inboxes/:inboxId/conversations** – Listar conversas (query: `limit`, `before`, `days`, `only_with_messages`)
- **GET /inboxes/:inboxId/contacts** – Listar contatos
- **GET /conversations/:conversationId/messages** – Listar mensagens
- **POST /conversations/:conversationId/messages** – Enviar mensagem (body: `content`)

## Estrutura do projeto

```
src/
  index.js           # Entry point + rotas Express
  evolution.js       # Cliente Evolution API
  supabase.js        # supabaseAdmin + createUserClient
  webhookEvolution.js# Handler de webhooks
  auth.js            # authMiddleware + validateOrganizationAccess
  utils.js           # randomId, isValidUUID, slugify
```

## Executar (local)

```bash
cp .env.example .env
# Editar .env com as chaves
npm install
npm run dev
```

## Deploy (Docker Swarm)

1. Crie `.env` com as variáveis (ver `.env.example`).
2. Build: `docker build -t flunx-channels-api:latest .`
3. Deploy: `docker stack deploy -c flunx-channels-api.yaml flunx-channels-api`
4. DNS: aponte `api-canais.flunx.com.br` para o servidor e use essa URL no frontend.

## Referências

- [Evolution API v2 Docs](https://doc.evolution-api.com/v2/)
- [Supabase JS Client](https://supabase.com/docs/reference/javascript)
- [Express.js](https://expressjs.com/)
