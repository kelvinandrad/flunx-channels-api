/**
 * Handler do webhook Evolution (Fase 1.4 e 1.5).
 * Recebe eventos (MESSAGES_UPSERT, CONNECTION_UPDATE, QRCODE_UPDATED) e persiste no Supabase.
 * Usar Supabase com service role (sem JWT) para inserir em chat_contacts, chat_conversations, chat_messages.
 */

import { getSupabaseClient } from "./supabase.js";
import { fetchInstanceInfo, formatBrazilianPhone } from "./evolution.js";

function normalizeEvent(event) {
  if (!event) return "";
  const s = String(event).toUpperCase().replace(/\./g, "_");
  return s;
}

/**
 * Extrai texto da mensagem do payload Evolution (data.message).
 * Suporta conversation (texto), imageMessage.caption, etc.
 */
function extractMessageText(message) {
  if (!message) return "";
  if (typeof message === "string") return message;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  return "";
}

/**
 * Processa MESSAGES_UPSERT: cria/atualiza contact, conversation, message.
 */
async function handleMessagesUpsert(supabase, payload) {
  const instance = payload.instance || payload.instanceName || payload.data?.instance;
  const data = payload.data || payload;
  const key = data.key || {};
  const remoteJid = key.remoteJid || key.remote_jid;
  const fromMe = !!key.fromMe;
  const evolutionMessageId = key.id || key.messageId;
  const messageContent = data.message || data.messageContent || data;
  const text = extractMessageText(messageContent);

  if (!instance || !remoteJid) return;

  const { data: inbox, error: inboxError } = await supabase
    .from("chat_inboxes")
    .select("id, organization_id")
    .eq("evolution_instance_name", instance)
    .single();

  if (inboxError || !inbox) return;

  const direction = fromMe ? "outgoing" : "incoming";

  let contactId = null;
  const { data: existingContact } = await supabase
    .from("chat_contacts")
    .select("id")
    .eq("inbox_id", inbox.id)
    .eq("remote_jid", remoteJid)
    .maybeSingle();

  if (existingContact) {
    contactId = existingContact.id;
  } else {
    const { data: newContact, error: contactError } = await supabase
      .from("chat_contacts")
      .insert({
        inbox_id: inbox.id,
        organization_id: inbox.organization_id,
        remote_jid: remoteJid,
        name: remoteJid.replace(/@.*$/, "") || remoteJid,
      })
      .select("id")
      .single();
    if (!contactError && newContact) contactId = newContact.id;
  }

  if (!contactId) return;

  let conversationId = null;
  const { data: existingConv } = await supabase
    .from("chat_conversations")
    .select("id")
    .eq("inbox_id", inbox.id)
    .eq("contact_id", contactId)
    .maybeSingle();

  if (existingConv) {
    conversationId = existingConv.id;
  } else {
    const { data: newConv, error: convError } = await supabase
      .from("chat_conversations")
      .insert({
        inbox_id: inbox.id,
        contact_id: contactId,
        status: "open",
      })
      .select("id")
      .single();
    if (!convError && newConv) conversationId = newConv.id;
  }

  if (!conversationId) return;

  if (evolutionMessageId) {
    const { data: existingMsg } = await supabase
      .from("chat_messages")
      .select("id")
      .eq("evolution_message_id", evolutionMessageId)
      .maybeSingle();
    if (existingMsg) return;
  }

  const senderType = direction === "incoming" ? "contact" : "agent";
  await supabase.from("chat_messages").insert({
    conversation_id: conversationId,
    content: text,
    direction,
    sender_type: senderType,
    status: "received",
    evolution_message_id: evolutionMessageId || null,
  });

  await supabase
    .from("chat_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);
}

/**
 * Processa CONNECTION_UPDATE: atualiza connection_status em chat_inboxes.
 * Quando conecta, busca dados do perfil (nome, foto, número) e salva.
 */
async function handleConnectionUpdate(supabase, payload) {
  const instance = payload.instance || payload.instanceName || payload.data?.instance;
  const state = payload.state ?? payload.data?.state ?? payload.connectionStatus;
  const connected = state === "open" || state === "connected" || state === "CONNECTED";

  if (!instance) return;

  const updateData = {
    connection_status: connected ? "connected" : "disconnected",
    updated_at: new Date().toISOString(),
  };

  // Se conectou, busca dados do perfil do WhatsApp
  if (connected) {
    try {
      const infoResult = await fetchInstanceInfo(instance);
      if (infoResult.success && infoResult.data) {
        const info = infoResult.data;
        updateData.whatsapp_profile_name = info.profileName || null;
        updateData.whatsapp_profile_pic_url = info.profilePicUrl || null;
        updateData.whatsapp_jid = info.ownerJid || null;
        updateData.whatsapp_phone_number = formatBrazilianPhone(info.ownerJid);
        updateData.contacts_count = info._count?.Contact || 0;
        updateData.conversations_count = info._count?.Chat || 0;

        // Atualiza o nome do canal para "Nome - (XX) XXXXX-XXXX"
        if (info.profileName && info.ownerJid) {
          const formattedPhone = formatBrazilianPhone(info.ownerJid);
          updateData.name = `${info.profileName} - ${formattedPhone}`;
        }
      }
    } catch (err) {
      console.error("[webhook/evolution] Error fetching instance info:", err.message);
    }
  }

  await supabase
    .from("chat_inboxes")
    .update(updateData)
    .eq("evolution_instance_name", instance);
}

/**
 * Processa QRCODE_UPDATED: atualiza qr_code em chat_inboxes.
 */
async function handleQrcodeUpdated(supabase, payload) {
  const instance = payload.instance || payload.instanceName || payload.data?.instance;
  const qr = payload.qrcode ?? payload.base64 ?? payload.data?.qrcode ?? payload.data?.base64;

  if (!instance) return;

  const qrCode = qr ? (qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`) : null;

  await supabase
    .from("chat_inboxes")
    .update({
      qr_code: qrCode,
      updated_at: new Date().toISOString(),
    })
    .eq("evolution_instance_name", instance);
}

/**
 * Handler principal: roteia por evento e persiste.
 * Responde 200 sempre para não dar timeout na Evolution; erros são logados.
 * Se WEBHOOK_SECRET_TOKEN estiver definido, exige token na query (?token=) ou header X-Webhook-Token.
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

  if (process.env.NODE_ENV !== "production") {
    console.log("[webhook/evolution] payload:", JSON.stringify(req.body ?? {}));
  }

  res.status(200).send("OK");

  const supabase = getSupabaseClient(null);
  if (!supabase) {
    console.error("[webhook/evolution] Supabase not configured");
    return;
  }

  const payload = req.body || {};
  const event = normalizeEvent(payload.event ?? payload.type);

  try {
    if (event === "MESSAGES_UPSERT") {
      await handleMessagesUpsert(supabase, payload);
    } else if (event === "CONNECTION_UPDATE") {
      await handleConnectionUpdate(supabase, payload);
    } else if (event === "QRCODE_UPDATED") {
      await handleQrcodeUpdated(supabase, payload);
    }
  } catch (err) {
    console.error("[webhook/evolution]", event, err.message);
  }
}
