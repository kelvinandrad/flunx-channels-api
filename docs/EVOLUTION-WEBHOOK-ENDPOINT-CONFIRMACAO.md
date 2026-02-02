# Conferência do endpoint de webhook da Evolution

## Set Webhook (POST)

Conferido em [Evolution API v2 – Set Webhook](https://doc.evolution-api.com/v2/api-reference/webhook/set) e [Webhooks Config](https://doc.evolution-api.com/v2/en/configuration/webhooks).

### Endpoint

**Path confirmado:** a documentação oficial e os exemplos mostram que a Evolution usa:
- `POST /webhook/set` (sem instância no path) **ou**
- `POST /webhook/instance` (sem instância no path)

E a instância é passada no **body**.

Porém, outros endpoints da Evolution (ex.: Find Webhook) usam o path: `GET /webhook/find/[instance]`.

### Nossa implementação atual

Em `src/evolution.js`:
```javascript
POST {baseUrl}/webhook/set/{encodeURIComponent(instanceName)}
Body: { enabled: true, url: webhookUrl, webhook_by_events: false, events }
```

Usamos **instância no path** (padrão comum e análogo ao Find). Se a Evolution rejeitar (404 ou 405), ajustar para:

```javascript
POST {baseUrl}/webhook/set
Body: { instance: instanceName, enabled: true, url: webhookUrl, webhook_by_events: false, events }
```

### Exemplo de body (Evolution)

```json
{
  "enabled": true,
  "url": "https://api-canais.flunx.com.br/webhook/evolution",
  "webhook_by_events": false,
  "events": ["QRCODE_UPDATED", "MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE"]
}
```

Se `webhook_by_events: true`, a Evolution concatena o nome do evento na URL (ex.: `/webhook/evolution/messages-upsert`). Nós usamos `false` (URL única) e roteamos por `event` no payload.

### Teste manual

Após criar uma instância via POST /channels, conferir se o webhook foi registrado:

```bash
curl -X GET "https://apiwpp.flunx.com.br/webhook/find/nome-da-instancia" \
  -H "apikey: SUA_EVOLUTION_API_KEY"
```

Resposta esperada:
```json
{
  "enabled": true,
  "url": "https://api-canais.flunx.com.br/webhook/evolution",
  "webhookByEvents": false,
  "events": ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"]
}
```

### Ajuste se necessário

Se o Set falhar (HTTP 404/405), alterar `src/evolution.js`:

```diff
- const res = await fetch(`${baseUrl}/webhook/set/${encodeURIComponent(instanceName)}`, {
+ const res = await fetch(`${baseUrl}/webhook/set`, {
    method: "POST",
    headers: headers(),
-   body: JSON.stringify(body),
+   body: JSON.stringify({ instance: instanceName, ...body }),
  });
```

### Payload do webhook (Evolution → nossa API)

Quando a Evolution envia eventos, o payload típico é:

```json
{
  "event": "messages.upsert",
  "instance": "org-abc-atendimento-xyz123",
  "data": {
    "key": {
      "remoteJid": "5511999999999@s.whatsapp.net",
      "fromMe": false,
      "id": "3EB0C1234567890ABCDEF"
    },
    "message": {
      "conversation": "Olá, preciso de ajuda!"
    }
  }
}
```

Nosso handler (`webhookEvolution.js`) normaliza `event` para uppercase (MESSAGES_UPSERT) e extrai `instance`, `data.key`, `data.message`.
