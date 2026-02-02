import "dotenv/config";
import express from "express";
import cors from "cors";
import { createInstance, connectInstance, getConnectionState, evolutionBaseUrl, setWebhook, deleteInstance, fetchInstanceInfo, formatBrazilianPhone, logoutInstance, sendText } from "./evolution.js";
import { getSupabaseClient } from "./supabase.js";
import { handleEvolutionWebhook } from "./webhookEvolution.js";

const app = express();
const PORT = process.env.PORT || 3001;

/** URL base que a Evolution usará para chamar nosso webhook (ex.: https://api.flunx.com.br ou ngrok em dev) */
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || process.env.CHANNELS_API_PUBLIC_URL || `http://localhost:${PORT}`;

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:8080',
    'https://chat.flunx.com.br',
    'https://app.flunx.com.br'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Token']
}));
app.use(express.json());

// Webhook Evolution (sem auth; Evolution chama com POST)
app.post("/webhook/evolution", handleEvolutionWebhook);

/** Gera slug seguro para nome da instância: org_slug + nome do canal + sufixo aleatório */
function slugify(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "channel";
}

/** Sufixo aleatório 8 caracteres para reduzir colisões de instanceName */
function randomSuffix() {
  return Math.random().toString(36).slice(2, 10);
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUUID(value) {
  return typeof value === "string" && UUID_REGEX.test(value);
}

/** Retorna Supabase client: com JWT do usuário (RLS) se Authorization presente, senão service role */
function supabaseFromReq(req) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  return getSupabaseClient(token);
}

/** Exige Bearer JWT; retorna 401 se ausente. Para rotas que devem respeitar RLS. */
function requireAuth(req, res) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Authorization required", detail: "Bearer token missing" });
    return null;
  }
  return getSupabaseClient(token);
}

// ---- POST /channels ----
app.post("/channels", async (req, res) => {
  const { type, name, organization_id } = req.body || {};
  // Aceita 'whatsapp' ou 'whatsapp_non_official' (legado), mas salva como 'whatsapp'
  const validTypes = ["whatsapp", "whatsapp_non_official"];
  if (!validTypes.includes(type) || !name || !organization_id) {
    return res.status(400).json({
      error: "Body must include type: 'whatsapp' or 'whatsapp_non_official', name, and organization_id",
    });
  }
  const channelType = "whatsapp"; // Normaliza para o valor aceito pelo banco

  if (!isValidUUID(organization_id)) {
    return res.status(400).json({
      error: "organization_id must be a valid UUID",
    });
  }

  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  // Busca nome da organização para usar no slug
  let orgName = "org";
  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", organization_id)
    .single();
  if (org?.name) {
    orgName = slugify(org.name).slice(0, 16);
  }

  const nameSlug = slugify(name).slice(0, 16);

  let instanceName = null;
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const candidate = `${orgName}-${nameSlug}-${randomSuffix()}`;
    const { data: existing } = await supabase
      .from("chat_inboxes")
      .select("id")
      .eq("evolution_instance_name", candidate)
      .maybeSingle();
    if (existing) continue;
    const createResult = await createInstance(candidate);
    if (createResult.success) {
      instanceName = candidate;
      break;
    }
    if (createResult.status === 409) continue;
    return res.status(502).json({
      error: "Evolution create instance failed",
      detail: createResult.error,
    });
  }

  if (!instanceName) {
    return res.status(502).json({
      error: "Evolution create instance failed",
      detail: "Could not get unique instance name after retries",
    });
  }

  const connectResult = await connectInstance(instanceName);
  const qrCode = connectResult.qrCode || null;
  const connectionStatus = connectResult.connectionStatus || "pending";

  const { data: inbox, error } = await supabase
    .from("chat_inboxes")
    .insert({
      organization_id,
      name,
      channel_type: channelType,
      evolution_instance_name: instanceName,
      evolution_base_url: evolutionBaseUrl,
      connection_status: connectionStatus,
      qr_code: qrCode,
    })
    .select()
    .single();

  if (error) {
    await deleteInstance(instanceName);
    return res.status(500).json({
      error: "Failed to save channel",
      detail: error.message,
    });
  }

  const webhookBase = `${WEBHOOK_BASE_URL.replace(/\/$/, "")}/webhook/evolution`;
  const webhookUrl = process.env.WEBHOOK_SECRET_TOKEN
    ? `${webhookBase}?token=${encodeURIComponent(process.env.WEBHOOK_SECRET_TOKEN)}`
    : webhookBase;
  const webhookResult = await setWebhook(instanceName, webhookUrl);
  if (!webhookResult.success) {
    const serviceSupabase = getSupabaseClient(null);
    if (serviceSupabase) await serviceSupabase.from("chat_inboxes").delete().eq("id", inbox.id);
    await deleteInstance(instanceName);
    return res.status(500).json({
      error: "Webhook registration failed",
      detail: webhookResult.error,
    });
  }

  return res.status(201).json({
    inbox: {
      id: inbox.id,
      organization_id: inbox.organization_id,
      name: inbox.name,
      channel_type: inbox.channel_type,
      evolution_instance_name: inbox.evolution_instance_name,
      connection_status: inbox.connection_status,
      evolution_base_url: inbox.evolution_base_url,
      created_at: inbox.created_at,
    },
    qrCode: qrCode,
  });
});

// ---- GET /channels/:inboxId/qrcode ----
app.get("/channels/:inboxId/qrcode", async (req, res) => {
  const { inboxId } = req.params;
  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  const { data: inbox, error } = await supabase
    .from("chat_inboxes")
    .select("id, evolution_instance_name, connection_status")
    .eq("id", inboxId)
    .single();

  if (error || !inbox) {
    return res.status(404).json({ error: "Inbox not found" });
  }

  const state = await getConnectionState(inbox.evolution_instance_name);
  if (state.state === "connected") {
    return res.json({ qrCode: null, connection_status: "connected" });
  }

  const connectResult = await connectInstance(inbox.evolution_instance_name);
  const qrCode = connectResult.qrCode || null;

  if (qrCode) {
    await supabase
      .from("chat_inboxes")
      .update({ qr_code: qrCode, updated_at: new Date().toISOString() })
      .eq("id", inboxId);
  }

  return res.json({
    qrCode,
    connection_status: connectResult.connectionStatus || inbox.connection_status,
  });
});

// ---- GET /channels?organization_id=uuid ----
app.get("/channels", async (req, res) => {
  const { organization_id } = req.query;
  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  let q = supabase.from("chat_inboxes").select("*").order("created_at", { ascending: false });
  if (organization_id) q = q.eq("organization_id", organization_id);

  const { data: channels, error } = await q;

  if (error) {
    return res.status(500).json({ error: "Failed to list channels", detail: error.message });
  }

  return res.json({ channels: channels || [] });
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ---- DELETE /channels/:id ----
app.delete("/channels/:id", async (req, res) => {
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  const serviceSupabase = getSupabaseClient(null);

  try {
    // 1. Buscar inbox no Supabase
    const { data: inbox, error: fetchError } = await serviceSupabase
      .from("chat_inboxes")
      .select("id, evolution_instance_name, channel_type")
      .eq("id", id)
      .single();

    if (fetchError || !inbox) {
      return res.status(404).json({ error: "Inbox not found" });
    }

    // 2. Se for WhatsApp (não-oficial), deletar instância na Evolution
    if (inbox.channel_type === "whatsapp" && inbox.evolution_instance_name) {
      const deleteResult = await deleteInstance(inbox.evolution_instance_name);
      if (!deleteResult.success) {
        console.warn(`[DELETE /channels/${id}] Failed to delete Evolution instance:`, deleteResult.error);
        // Continua mesmo se falhar (instância pode já ter sido deletada manualmente)
      }
    }

    // 3. Deletar inbox no Supabase
    const { error: deleteError } = await serviceSupabase
      .from("chat_inboxes")
      .delete()
      .eq("id", id);

    if (deleteError) {
      return res.status(500).json({
        error: "Failed to delete inbox from database",
        detail: deleteError.message,
      });
    }

    res.status(200).json({ success: true, message: "Channel deleted successfully" });
  } catch (err) {
    console.error("[DELETE /channels/:id] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ---- POST /channels/:id/reconnect ----
// Reconecta um canal: desconecta se conectado, deleta instância, cria nova, retorna QR code
app.post("/channels/:id/reconnect", async (req, res) => {
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  const serviceSupabase = getSupabaseClient(null);

  try {
    // 1. Buscar inbox atual
    const { data: inbox, error: fetchError } = await serviceSupabase
      .from("chat_inboxes")
      .select("id, name, organization_id, evolution_instance_name, channel_type")
      .eq("id", id)
      .single();

    if (fetchError || !inbox) {
      return res.status(404).json({ error: "Inbox not found" });
    }

    if (inbox.channel_type !== "whatsapp") {
      return res.status(400).json({ error: "Reconnect only supported for WhatsApp channels" });
    }

    // 2. Se tem instância antiga, desconecta e deleta
    if (inbox.evolution_instance_name) {
      // Tenta logout primeiro (se conectado)
      await logoutInstance(inbox.evolution_instance_name);
      // Deleta a instância
      await deleteInstance(inbox.evolution_instance_name);
    }

    // 3. Gera novo nome de instância
    let orgName = "org";
    const { data: org } = await serviceSupabase
      .from("organizations")
      .select("name")
      .eq("id", inbox.organization_id)
      .single();
    if (org?.name) {
      orgName = slugify(org.name).slice(0, 16);
    }

    // Extrai nome base do canal (remove parte após " - " se existir)
    const baseName = inbox.name.split(" - ")[0];
    const nameSlug = slugify(baseName).slice(0, 16);

    let newInstanceName = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = `${orgName}-${nameSlug}-${randomSuffix()}`;
      const createResult = await createInstance(candidate);
      if (createResult.success) {
        newInstanceName = candidate;
        break;
      }
      if (createResult.status !== 409) {
        return res.status(502).json({
          error: "Evolution create instance failed",
          detail: createResult.error,
        });
      }
    }

    if (!newInstanceName) {
      return res.status(502).json({
        error: "Could not create new instance after retries",
      });
    }

    // 4. Conecta e obtém QR code
    const connectResult = await connectInstance(newInstanceName);
    const qrCode = connectResult.qrCode || null;
    const connectionStatus = connectResult.connectionStatus || "pending";

    // 5. Configura webhook
    const webhookToken = process.env.WEBHOOK_SECRET_TOKEN;
    let webhookUrl = `${WEBHOOK_BASE_URL}/webhook/evolution`;
    if (webhookToken) webhookUrl += `?token=${webhookToken}`;

    const webhookResult = await setWebhook(newInstanceName, webhookUrl);
    if (!webhookResult.success) {
      // Rollback: deleta a instância criada
      await deleteInstance(newInstanceName);
      return res.status(500).json({
        error: "Webhook registration failed",
        detail: webhookResult.error,
      });
    }

    // 6. Atualiza inbox com nova instância (limpa dados do WhatsApp anterior)
    const { error: updateError } = await serviceSupabase
      .from("chat_inboxes")
      .update({
        evolution_instance_name: newInstanceName,
        evolution_base_url: evolutionBaseUrl,
        connection_status: connectionStatus,
        qr_code: qrCode,
        // Limpa dados do perfil anterior
        whatsapp_profile_name: null,
        whatsapp_profile_pic_url: null,
        whatsapp_phone_number: null,
        whatsapp_jid: null,
        contacts_count: 0,
        conversations_count: 0,
        // Reseta nome para o nome base
        name: baseName,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    if (updateError) {
      // Rollback
      await deleteInstance(newInstanceName);
      return res.status(500).json({
        error: "Failed to update inbox",
        detail: updateError.message,
      });
    }

    res.json({
      success: true,
      inbox: {
        id: inbox.id,
        name: baseName,
        evolution_instance_name: newInstanceName,
        connection_status: connectionStatus,
      },
      qrCode,
    });
  } catch (err) {
    console.error("[POST /channels/:id/reconnect] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ---- GET /channels/:id/info ----
// Busca informações atualizadas do canal (sincroniza com Evolution)
app.get("/channels/:id/info", async (req, res) => {
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  const supabase = supabaseFromReq(req);

  try {
    const { data: inbox, error: fetchError } = await supabase
      .from("chat_inboxes")
      .select("*")
      .eq("id", id)
      .single();

    if (fetchError || !inbox) {
      return res.status(404).json({ error: "Inbox not found" });
    }

    // Se tem instância e está conectado, busca dados atualizados
    if (inbox.evolution_instance_name && inbox.connection_status === "connected") {
      const infoResult = await fetchInstanceInfo(inbox.evolution_instance_name);
      if (infoResult.success && infoResult.data) {
        const info = infoResult.data;
        // Atualiza no banco se os dados mudaram
        const serviceSupabase = getSupabaseClient(null);
        await serviceSupabase
          .from("chat_inboxes")
          .update({
            whatsapp_profile_name: info.profileName || inbox.whatsapp_profile_name,
            whatsapp_profile_pic_url: info.profilePicUrl || inbox.whatsapp_profile_pic_url,
            whatsapp_jid: info.ownerJid || inbox.whatsapp_jid,
            whatsapp_phone_number: formatBrazilianPhone(info.ownerJid) || inbox.whatsapp_phone_number,
            contacts_count: info._count?.Contact ?? inbox.contacts_count,
            conversations_count: info._count?.Chat ?? inbox.conversations_count,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        // Retorna dados atualizados
        return res.json({
          ...inbox,
          whatsapp_profile_name: info.profileName || inbox.whatsapp_profile_name,
          whatsapp_profile_pic_url: info.profilePicUrl || inbox.whatsapp_profile_pic_url,
          whatsapp_jid: info.ownerJid || inbox.whatsapp_jid,
          whatsapp_phone_number: formatBrazilianPhone(info.ownerJid) || inbox.whatsapp_phone_number,
          contacts_count: info._count?.Contact ?? inbox.contacts_count,
          conversations_count: info._count?.Chat ?? inbox.conversations_count,
        });
      }
    }

    res.json(inbox);
  } catch (err) {
    console.error("[GET /channels/:id/info] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ---- Fase 2: listagem e envio de mensagens (auth JWT + RLS) ----

// GET /inboxes/:inboxId/conversations
app.get("/inboxes/:inboxId/conversations", async (req, res) => {
  const supabase = requireAuth(req, res);
  if (!supabase) return;

  const { inboxId } = req.params;
  if (!isValidUUID(inboxId)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  try {
    const { data: conversations, error: convError } = await supabase
      .from("chat_conversations")
      .select("id, contact_id, status, updated_at, chat_contacts(id, name, remote_jid)")
      .eq("inbox_id", inboxId)
      .order("updated_at", { ascending: false });

    if (convError) {
      return res.status(500).json({ error: "Failed to list conversations", detail: convError.message });
    }

    const list = conversations || [];
    if (list.length === 0) {
      return res.json({ conversations: [] });
    }

    const conversationIds = list.map((c) => c.id);
    const { data: messages, error: msgError } = await supabase
      .from("chat_messages")
      .select("conversation_id, content, created_at")
      .in("conversation_id", conversationIds)
      .order("created_at", { ascending: false });

    const previewByConv = {};
    if (!msgError && messages) {
      for (const m of messages) {
        if (previewByConv[m.conversation_id] == null) {
          previewByConv[m.conversation_id] = { content: m.content || "", created_at: m.created_at };
        }
      }
    }

    const result = list.map((c) => ({
      id: c.id,
      contact: c.chat_contacts
        ? { id: c.chat_contacts.id, name: c.chat_contacts.name || null, remote_jid: c.chat_contacts.remote_jid || null }
        : null,
      preview: previewByConv[c.id]?.content ?? null,
      preview_at: previewByConv[c.id]?.created_at ?? null,
      status: c.status ?? "open",
      updated_at: c.updated_at,
    }));

    res.json({ conversations: result });
  } catch (err) {
    console.error("[GET /inboxes/:inboxId/conversations] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// GET /conversations/:conversationId/messages
// Ordem: desc (mais recente primeiro) para UI de chat típica.
// Cursor "before" para carregar mensagens mais antigas.
app.get("/conversations/:conversationId/messages", async (req, res) => {
  const supabase = requireAuth(req, res);
  if (!supabase) return;

  const { conversationId } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const before = req.query.before; // cursor: created_at ISO (para carregar msgs mais antigas)

  if (!isValidUUID(conversationId)) {
    return res.status(400).json({ error: "Invalid conversation ID format" });
  }

  try {
    let q = supabase
      .from("chat_messages")
      .select("id, content, direction, status, created_at, evolution_message_id")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit + 1);

    if (before) {
      q = q.lt("created_at", before);
    }

    const { data: messages, error } = await q;

    if (error) {
      return res.status(500).json({ error: "Failed to list messages", detail: error.message });
    }

    const list = messages || [];
    const hasMore = list.length > limit;
    const page = hasMore ? list.slice(0, limit) : list;
    const cursor = hasMore && page.length ? page[page.length - 1].created_at : null;

    const items = page.map((m) => ({
      id: m.id,
      content: m.content ?? "",
      direction: m.direction ?? "incoming",
      message_type: "text",
      status: m.status ?? "received",
      created_at: m.created_at,
      evolution_message_id: m.evolution_message_id ?? null,
    }));

    res.json({ messages: items, cursor, has_more: hasMore });
  } catch (err) {
    console.error("[GET /conversations/:conversationId/messages] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// POST /conversations/:conversationId/messages
app.post("/conversations/:conversationId/messages", async (req, res) => {
  const supabase = requireAuth(req, res);
  if (!supabase) return;

  const { conversationId } = req.params;
  const { content } = req.body || {};

  if (!isValidUUID(conversationId)) {
    return res.status(400).json({ error: "Invalid conversation ID format" });
  }

  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    return res.status(400).json({ error: "Body must include content (non-empty string)" });
  }

  try {
    const { data: conv, error: convError } = await supabase
      .from("chat_conversations")
      .select("id, inbox_id, contact_id, chat_inboxes(evolution_instance_name), chat_contacts(remote_jid)")
      .eq("id", conversationId)
      .single();

    if (convError || !conv) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const instanceName = conv.chat_inboxes?.evolution_instance_name;
    const remoteJid = conv.chat_contacts?.remote_jid;

    if (!instanceName || !remoteJid) {
      return res.status(400).json({
        error: "Conversation or inbox not ready for sending",
        detail: "Missing evolution_instance_name or contact remote_jid",
      });
    }

    const number = String(remoteJid).replace(/@.*$/, "").trim();
    if (!number) {
      return res.status(400).json({ error: "Invalid contact remote_jid" });
    }

    const { data: inserted, error: insertError } = await supabase
      .from("chat_messages")
      .insert({
        conversation_id: conversationId,
        content: text,
        direction: "outgoing",
        sender_type: "agent",
        status: "pending_send",
      })
      .select("id, content, direction, status, created_at, evolution_message_id")
      .single();

    if (insertError) {
      return res.status(500).json({ error: "Failed to create message", detail: insertError.message });
    }

    await supabase
      .from("chat_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    const sendResult = await sendText(instanceName, number, text);

    const serviceSupabase = getSupabaseClient(null);
    if (sendResult.success) {
      const evolutionId = sendResult.data?.key?.id || sendResult.data?.id || null;
      await serviceSupabase
        .from("chat_messages")
        .update({ status: "sent", evolution_message_id: evolutionId })
        .eq("id", inserted.id);
      return res.status(201).json({
        ...inserted,
        status: "sent",
        evolution_message_id: evolutionId,
      });
    }

    await serviceSupabase.from("chat_messages").update({ status: "failed" }).eq("id", inserted.id);
    return res.status(502).json({
      error: "Failed to send message via Evolution",
      detail: sendResult.error,
      message: { ...inserted, status: "failed" },
    });
  } catch (err) {
    console.error("[POST /conversations/:conversationId/messages] Error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`flunx-channels-api listening on port ${PORT}`);
});
