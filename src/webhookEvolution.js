/**
 * Handler do webhook Evolution (Especificação flunx-channels-api § 9).
 * Eventos: QRCODE_UPDATED, CONNECTION_UPDATE, MESSAGES_UPSERT, MESSAGES_UPDATE.
 */

import { getSupabaseClient } from "./supabase.js";
import { fetchInstanceInfo, formatBrazilianPhone } from "./evolution.js";

function normalizeEvent(event) {
  if (!event) return "";
  const s = String(event).toUpperCase().replace(/\./g, "_");
  return s;
}

/**
 * Extrai conteúdo da mensagem para exibição (Especificação § 9 - extractMessageContent).
 * Retorna texto ou placeholder [Imagem], [Áudio], etc.
 */
export function extractMessageContent(msg) {
  const message = msg?.message ?? msg;
  if (!message) return null;
  if (typeof message === "string") return message;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return `[Imagem] ${message.imageMessage.caption}`;
  if (message.imageMessage) return "[Imagem]";
  if (message.videoMessage?.caption) return `[Vídeo] ${message.videoMessage.caption}`;
  if (message.videoMessage) return "[Vídeo]";
  if (message.audioMessage) return "[Áudio]";
  if (message.documentMessage)
    return `[Documento] ${message.documentMessage.fileName || ""}`;
  if (message.stickerMessage) return "[Sticker]";
  if (message.contactMessage)
    return `[Contato] ${message.contactMessage.displayName || ""}`;
  if (message.locationMessage) return "[Localização]";
  return null;
}

async function handleQRCodeUpdate(supabase, instanceName, data) {
  const qrBase64 = data?.qrcode?.base64 ?? data?.base64 ?? data?.qrcode;
  if (!qrBase64) return;
  const qrCode = qrBase64.startsWith("data:") ? qrBase64 : `data:image/png;base64,${qrBase64}`;
  await supabase
    .from("chat_inboxes")
    .update({ qr_code: qrCode, updated_at: new Date().toISOString() })
    .eq("evolution_instance_name", instanceName);
}

async function handleConnectionUpdate(supabase, instanceName, data) {
  const state = data?.state ?? data?.connectionStatus;
  let connection_status = "pending";
  if (state === "open" || state === "connected" || state === "CONNECTED") {
    connection_status = "connected";
  } else if (state === "close" || state === "disconnected") {
    connection_status = "disconnected";
  }

  const updates = {
    connection_status,
    updated_at: new Date().toISOString(),
  };

  if (connection_status === "connected") {
    updates.qr_code = null;
    try {
      const infoResult = await fetchInstanceInfo(instanceName);
      if (infoResult.success && infoResult.data) {
        const info = infoResult.data;
        updates.whatsapp_profile_name = info.profileName ?? null;
        updates.whatsapp_profile_pic_url = info.profilePicUrl ?? null;
        updates.whatsapp_jid = info.ownerJid ?? null;
        updates.whatsapp_phone_number = formatBrazilianPhone(info.ownerJid) ?? null;
        updates.contacts_count = info._count?.Contact ?? 0;
        updates.conversations_count = info._count?.Chat ?? 0;
        if (info.profileName && info.ownerJid) {
          updates.name = `${info.profileName} - ${formatBrazilianPhone(info.ownerJid)}`;
        }
      }
    } catch (err) {
      console.error("[webhook/evolution] Error fetching instance info:", err.message);
    }
  }

  await supabase
    .from("chat_inboxes")
    .update(updates)
    .eq("evolution_instance_name", instanceName);
}

async function findOrCreateContact(supabase, inbox, remoteJid, pushName, isGroup) {
  const { data: existing } = await supabase
    .from("chat_contacts")
    .select("id, name")
    .eq("inbox_id", inbox.id)
    .eq("remote_jid", remoteJid)
    .maybeSingle();

  if (existing) {
    if (pushName && pushName !== existing.name) {
      await supabase
        .from("chat_contacts")
        .update({ name: pushName, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    }
    return existing;
  }

  const name = pushName || remoteJid.split("@")[0] || remoteJid;
  const { data: newContact, error } = await supabase
    .from("chat_contacts")
    .insert({
      inbox_id: inbox.id,
      organization_id: inbox.organization_id,
      remote_jid: remoteJid,
      source_id: remoteJid,
      name,
      contact_type: isGroup ? "group" : "individual",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[Webhook] Erro ao criar contato:", error);
    return null;
  }
  return newContact;
}

async function findOrCreateConversation(supabase, inbox, contactId) {
  const { data: existing } = await supabase
    .from("chat_conversations")
    .select("id")
    .eq("inbox_id", inbox.id)
    .eq("contact_id", contactId)
    .maybeSingle();

  if (existing) return existing;

  const { data: newConv, error } = await supabase
    .from("chat_conversations")
    .insert({
      inbox_id: inbox.id,
      contact_id: contactId,
      organization_id: inbox.organization_id,
      status: "open",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[Webhook] Erro ao criar conversa:", error);
    return null;
  }
  return newConv;
}

async function handleMessagesUpsert(supabase, instanceName, data) {
  const messages = data?.messages;
  const list = Array.isArray(messages)
    ? messages
    : data?.key || data?.message
      ? [data]
      : [];

  const { data: inbox } = await supabase
    .from("chat_inboxes")
    .select("id, organization_id")
    .eq("evolution_instance_name", instanceName)
    .single();

  if (!inbox) {
    console.error(`[Webhook] Inbox não encontrado: ${instanceName}`);
    return;
  }

  for (const msg of list) {
    if (msg?.key?.fromMe === undefined) continue;
    if (msg.messageType === "protocolMessage") continue;

    const remoteJid = msg.key?.remoteJid ?? msg.key?.remote_jid;
    const isFromMe = !!msg.key?.fromMe;
    const isGroup = remoteJid?.includes("@g.us");
    const content = extractMessageContent(msg);
    if (content === null && !msg.message) continue;

    const pushName = msg.pushName ?? msg.push_name ?? null;
    let contact = await findOrCreateContact(
      supabase,
      inbox,
      remoteJid,
      pushName,
      isGroup
    );
    if (!contact) continue;

    let conversation = await findOrCreateConversation(supabase, inbox, contact.id);
    if (!conversation) continue;

    const evolutionMessageId = msg.key?.id ?? msg.key?.messageId;
    if (evolutionMessageId) {
      const { data: existing } = await supabase
        .from("chat_messages")
        .select("id")
        .eq("evolution_message_id", evolutionMessageId)
        .maybeSingle();
      if (existing) continue;
    }

    const messageTimestamp = msg.messageTimestamp ?? msg.message_timestamp;
    const created_at =
      messageTimestamp != null
        ? new Date(Number(messageTimestamp) * 1000).toISOString()
        : new Date().toISOString();

    await supabase.from("chat_messages").insert({
      conversation_id: conversation.id,
      content: content || "",
      direction: isFromMe ? "outgoing" : "incoming",
      message_type: msg.messageType || "text",
      status: isFromMe ? "sent" : "received",
      evolution_message_id: evolutionMessageId || null,
      participant_remote_jid: isGroup ? (msg.key?.participant ?? null) : null,
      created_at,
    });

    await supabase
      .from("chat_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation.id);
  }
}

/** Fase C: CHATS_UPDATE / CHATS_UPSERT — archive/pin (payload real pode variar). */
async function handleChatsUpdate(supabase, instanceName, data) {
  const updates = data?.updates ?? (data?.chats ? [data.chats].flat() : []);
  const list = Array.isArray(updates) ? updates : [updates];
  const { data: inbox } = await supabase
    .from("chat_inboxes")
    .select("id")
    .eq("evolution_instance_name", instanceName)
    .single();
  if (!inbox) return;

  for (const item of list) {
    const remoteJid = item?.key?.remoteJid ?? item?.remoteJid ?? item?.id;
    if (!remoteJid) continue;
    const archive = item?.archive ?? item?.isArchived;
    const pin = item?.pin ?? item?.isPinned;
    if (archive === undefined && pin === undefined) continue;

    const { data: contact } = await supabase
      .from("chat_contacts")
      .select("id")
      .eq("inbox_id", inbox.id)
      .eq("remote_jid", remoteJid)
      .maybeSingle();
    if (!contact) continue;

    const patch = { updated_at: new Date().toISOString() };
    if (typeof archive === "boolean") patch.is_archived = archive;
    if (typeof pin === "boolean") patch.is_pinned = pin;
    await supabase
      .from("chat_conversations")
      .update(patch)
      .eq("inbox_id", inbox.id)
      .eq("contact_id", contact.id);
  }
}

/** Status de mensagem atualizado (delivered, read) - Especificação § 9. */
async function handleMessagesUpdate(supabase, instanceName, data) {
  const updates = data?.updates ?? (data?.key ? [data] : []);
  const list = Array.isArray(updates) ? updates : [updates];

  const statusMap = {
    DELIVERY_ACK: "delivered",
    READ: "read",
    PLAYED: "read",
  };

  for (const update of list) {
    const messageId = update?.key?.id ?? update?.key?.messageId;
    const status = update?.status ?? update?.update;
    if (!messageId || !status) continue;
    const newStatus = statusMap[status];
    if (!newStatus) continue;
    await supabase
      .from("chat_messages")
      .update({ status: newStatus })
      .eq("evolution_message_id", messageId);
  }
}

/**
 * Handler principal do webhook Evolution.
 * POST /webhook/evolution - sem auth (Evolution não envia Bearer).
 */
export async function handleEvolutionWebhook(req, res) {
  const secret = process.env.WEBHOOK_SECRET_TOKEN;
  if (secret) {
    const token = req.query?.token ?? req.headers["x-webhook-token"];
    if (token !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const supabase = getSupabaseClient(null);
  if (!supabase) {
    console.error("[webhook/evolution] Supabase not configured");
    return res.status(503).json({ error: "Database not configured" });
  }

  const payload = req.body || {};
  const event = normalizeEvent(payload.event ?? payload.type);
  const instanceName = payload.instance ?? payload.instanceName ?? payload.data?.instance;

  if (process.env.NODE_ENV !== "production") {
    console.log(`[Webhook] Evento: ${event}, Instância: ${instanceName}`);
  }

  try {
    switch (event) {
      case "QRCODE_UPDATED":
        await handleQRCodeUpdate(supabase, instanceName, payload.data ?? payload);
        break;
      case "CONNECTION_UPDATE":
        await handleConnectionUpdate(supabase, instanceName, payload.data ?? payload);
        break;
      case "MESSAGES_UPSERT":
        await handleMessagesUpsert(supabase, instanceName, payload.data ?? payload);
        break;
      case "MESSAGES_UPDATE":
        await handleMessagesUpdate(supabase, instanceName, payload.data ?? payload);
        break;
      case "CHATS_UPDATE":
      case "CHATS_UPSERT":
        await handleChatsUpdate(supabase, instanceName, payload.data ?? payload);
        break;
      default:
        if (event) console.log(`[Webhook] Evento não tratado: ${event}`);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(`[Webhook] Erro processando ${event}:`, err);
    res.status(500).json({ error: err.message });
  }
}
