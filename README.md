# flunx-evolution-api

API de canais Evolution: cria/configura instâncias na Evolution e persiste canais no **Supabase**. Eventos (QR, connection, mensagens) são consumidos pela **flunx-rabbitmq-api** via RabbitMQ.

## Visão geral

| Componente           | Responsabilidade                                      |
|----------------------|--------------------------------------------------------|
| flunx-evolution-api  | Criar instância, configurar settings, canais, sync, mensagens (eventos em tempo real vêm do RabbitMQ global da Evolution) |
| flunx-rabbitmq-api   | Consumir eventos globais Evolution via RabbitMQ (QR, connection, messages)     |
| Evolution API        | Conectar WhatsApp; publica eventos no RabbitMQ (global)                |
| Supabase             | Persistir chat_inboxes, chat_contacts, chat_conversations, chat_messages |
| Frontend (flunx-chat)| Interface; consome esta API com JWT Supabase           |

## Variáveis de ambiente

- **PORT** – porta (default 3001)
- **SUPABASE_URL**, **SUPABASE_SERVICE_KEY** – Supabase
- **SUPABASE_ANON_KEY** – (opcional) RLS com JWT
- **EVOLUTION_API_URL** – URL da Evolution (ex: https://apiwpp.flunx.com.br)
- **EVOLUTION_API_KEY** – API key (header `apikey`)

Eventos: Evolution deve ter **RABBITMQ_GLOBAL_ENABLED=true** e envs de RabbitMQ configuradas.

## Autenticação

Rotas protegidas exigem **Bearer JWT** do Supabase (`Authorization`). Validação via `supabase.auth.getUser` e `organization_members`.

## Endpoints

- **GET /health** – Health check

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
