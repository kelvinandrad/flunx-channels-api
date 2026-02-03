/**
 * flunx-channels-api - Entry point (Especificação § 10).
 * API intermediária entre flunx-chat (frontend) e Evolution API.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  createInstance,
  connectInstance,
  getConnectionState,
  evolutionBaseUrl,
  setWebhook,
  deleteInstance,
  fetchInstanceInfo,
  formatBrazilianPhone,
  logoutInstance,
  sendText,
  findContacts,
  fetchAllGroups,
  findChats,
} from "./evolution.js";
import { getSupabaseClient, supabaseAdmin } from "./supabase.js";
import { handleEvolutionWebhook, extractMessageContent } from "./webhookEvolution.js";
import { authMiddleware, validateOrganizationAccess } from "./auth.js";
import { randomId, isValidUUID, slugify } from "./utils.js";

const app = express();
const PORT = process.env.PORT || 3001;
const WEBHOOK_BASE_URL =
  process.env.WEBHOOK_BASE_URL ||
  process.env.CHANNELS_API_PUBLIC_URL ||
  `http://localhost:${PORT}`;

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:8080",
      "https://chat.flunx.com.br",
      "https://app.flunx.com.br",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Webhook-Token"],
  })
);
app.use(express.json());

// --- Health & Webhook (sem auth) ---
app.get("/health", (_, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
app.post("/webhook/evolution", handleEvolutionWebhook);

/** Helper: Supabase com JWT do usuário (RLS) a partir do request. */
function supabaseFromReq(req) {
  const token =
    req.headers.authorization?.startsWith("Bearer ") &&
    req.headers.authorization.slice(7).trim();
  return getSupabaseClient(token) || supabaseAdmin;
}

// --- POST /channels - Criar canal WhatsApp (Especificação § 8.1) ---
app.post("/channels", authMiddleware, async (req, res) => {
  const { organization_id, name } = req.body || {};
  if (!organization_id || !name) {
    return res.status(400).json({
      error: "Body must include organization_id and name",
    });
  }
  if (!isValidUUID(organization_id)) {
    return res.status(400).json({ error: "organization_id must be a valid UUID" });
  }

  const hasAccess = await validateOrganizationAccess(req.user.id, organization_id);
  if (!hasAccess) {
    return res.status(403).json({ error: "Sem acesso à organização" });
  }

  const instanceName = `flunx-${slugify(name).slice(0, 20)}-${randomId()}`;

  try {
    const createResult = await createInstance(instanceName);
    if (!createResult.success) {
      return res.status(502).json({
        error: "Evolution create instance failed",
        detail: createResult.error,
      });
    }

    const webhookUrl = `${WEBHOOK_BASE_URL.replace(/\/$/, "")}/webhook/evolution`;
    const webhookWithToken = process.env.WEBHOOK_SECRET_TOKEN
      ? `${webhookUrl}?token=${encodeURIComponent(process.env.WEBHOOK_SECRET_TOKEN)}`
      : webhookUrl;
    const webhookResult = await setWebhook(instanceName, webhookWithToken);
    if (!webhookResult.success) {
      await deleteInstance(instanceName);
      return res.status(500).json({
        error: "Webhook registration failed",
        detail: webhookResult.error,
      });
    }

    const { data: inbox, error } = await supabaseAdmin
      .from("chat_inboxes")
      .insert({
        organization_id,
        name,
        channel_type: "whatsapp",
        evolution_instance_name: instanceName,
        evolution_base_url: evolutionBaseUrl,
        connection_status: "pending",
      })
      .select()
      .single();

    if (error) {
      await deleteInstance(instanceName);
      return res.status(500).json({ error: "Failed to save channel", detail: error.message });
    }

    const connectResult = await connectInstance(inbox.evolution_instance_name);
    const qrCode = connectResult.qrCode ?? null;
    if (qrCode) {
      await supabaseAdmin
        .from("chat_inboxes")
        .update({ qr_code: qrCode })
        .eq("id", inbox.id);
    }

    return res.status(201).json({
      success: true,
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
      qrcode: connectResult.qrCode ? { base64: connectResult.qrCode } : null,
    });
  } catch (err) {
    console.error("[POST /channels] Erro:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- GET /channels - Listar canais ---
app.get("/channels", authMiddleware, async (req, res) => {
  const { organization_id } = req.query;
  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }
  let q = supabase
    .from("chat_inboxes")
    .select("*")
    .order("created_at", { ascending: false });
  if (organization_id && isValidUUID(organization_id)) {
    const hasAccess = await validateOrganizationAccess(req.user.id, organization_id);
    if (!hasAccess) return res.status(403).json({ error: "Sem acesso à organização" });
    q = q.eq("organization_id", organization_id);
  }
  const { data: channels, error } = await q;
  if (error) {
    return res.status(500).json({ error: "Failed to list channels", detail: error.message });
  }
  return res.json({ channels: channels || [] });
});

// --- GET /channels/:id/info - Atualizar info do canal (Especificação § 8.1) ---
app.get("/channels/:id/info", authMiddleware, async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }
  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  const { data: inbox, error } = await supabase
    .from("chat_inboxes")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !inbox) {
    return res.status(404).json({ error: "Canal não encontrado" });
  }

  try {
    const infoResult = await fetchInstanceInfo(inbox.evolution_instance_name);
    if (!infoResult.success || !infoResult.data) {
      return res.json(inbox);
    }
    const info = infoResult.data;
    let connection_status = "pending";
    if (info.instance?.state === "open") connection_status = "connected";
    else if (info.instance?.state === "close") connection_status = "disconnected";

    const updates = {
      connection_status,
      whatsapp_profile_name: info.instance?.profileName ?? info.profileName ?? null,
      whatsapp_profile_pic_url: info.instance?.profilePictureUrl ?? info.profilePicUrl ?? null,
      whatsapp_phone_number: formatBrazilianPhone(info.instance?.owner ?? info.ownerJid) ?? null,
      whatsapp_jid: info.instance?.owner ?? info.ownerJid ?? null,
      contacts_count: info._count?.Contact ?? inbox.contacts_count ?? 0,
      conversations_count: info._count?.Chat ?? inbox.conversations_count ?? 0,
      updated_at: new Date().toISOString(),
    };

    await supabaseAdmin
      .from("chat_inboxes")
      .update(updates)
      .eq("id", id);

    return res.json({ success: true, ...updates });
  } catch (err) {
    console.error("[GET /channels/:id/info] Erro:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- GET /channels/:inboxId/qrcode - Obter/atualizar QR code ---
app.get("/channels/:inboxId/qrcode", authMiddleware, async (req, res) => {
  const { inboxId } = req.params;
  if (!isValidUUID(inboxId)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }
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
  const qrCode = connectResult.qrCode ?? null;
  if (qrCode) {
    await supabase
      .from("chat_inboxes")
      .update({ qr_code: qrCode, updated_at: new Date().toISOString() })
      .eq("id", inboxId);
  }
  return res.json({
    qrCode,
    connection_status: connectResult.connectionStatus ?? inbox.connection_status,
  });
});

// --- POST /channels/:id/reconnect (Especificação § 8.1) ---
app.post("/channels/:id/reconnect", authMiddleware, async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  const { data: inbox } = await supabaseAdmin
    .from("chat_inboxes")
    .select("id, name, organization_id, evolution_instance_name, channel_type")
    .eq("id", id)
    .single();

  if (!inbox) {
    return res.status(404).json({ error: "Canal não encontrado" });
  }

  const hasAccess = await validateOrganizationAccess(req.user.id, inbox.organization_id);
  if (!hasAccess) {
    return res.status(403).json({ error: "Sem acesso à organização" });
  }

  try {
    if (inbox.evolution_instance_name) {
      await logoutInstance(inbox.evolution_instance_name);
      await deleteInstance(inbox.evolution_instance_name);
    }

    const baseName = inbox.name.split(" - ")[0];
    const nameSlug = slugify(baseName).slice(0, 16);
    let newInstanceName = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = `flunx-${nameSlug}-${randomId()}`;
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

    const connectResult = await connectInstance(newInstanceName);
    const qrCode = connectResult.qrCode ?? null;
    const webhookUrl = process.env.WEBHOOK_SECRET_TOKEN
      ? `${WEBHOOK_BASE_URL.replace(/\/$/, "")}/webhook/evolution?token=${encodeURIComponent(process.env.WEBHOOK_SECRET_TOKEN)}`
      : `${WEBHOOK_BASE_URL.replace(/\/$/, "")}/webhook/evolution`;
    const webhookResult = await setWebhook(newInstanceName, webhookUrl);
    if (!webhookResult.success) {
      await deleteInstance(newInstanceName);
      return res.status(500).json({
        error: "Webhook registration failed",
        detail: webhookResult.error,
      });
    }

    await supabaseAdmin
      .from("chat_inboxes")
      .update({
        evolution_instance_name: newInstanceName,
        evolution_base_url: evolutionBaseUrl,
        connection_status: connectResult.connectionStatus ?? "pending",
        qr_code: qrCode,
        whatsapp_profile_name: null,
        whatsapp_profile_pic_url: null,
        whatsapp_phone_number: null,
        whatsapp_jid: null,
        contacts_count: 0,
        conversations_count: 0,
        name: baseName,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    return res.json({
      success: true,
      inbox: {
        id: inbox.id,
        name: baseName,
        evolution_instance_name: newInstanceName,
        connection_status: connectResult.connectionStatus ?? "pending",
      },
      qrcode: qrCode ? { base64: qrCode } : null,
    });
  } catch (err) {
    console.error("[POST /channels/:id/reconnect] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- DELETE /channels/:id ---
app.delete("/channels/:id", authMiddleware, async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  const { data: inbox } = await supabaseAdmin
    .from("chat_inboxes")
    .select("id, organization_id, evolution_instance_name, channel_type")
    .eq("id", id)
    .single();

  if (!inbox) {
    return res.status(404).json({ error: "Inbox not found" });
  }

  const hasAccess = await validateOrganizationAccess(req.user.id, inbox.organization_id);
  if (!hasAccess) {
    return res.status(403).json({ error: "Sem acesso à organização" });
  }

  try {
    if (inbox.channel_type === "whatsapp" && inbox.evolution_instance_name) {
      await logoutInstance(inbox.evolution_instance_name);
      await deleteInstance(inbox.evolution_instance_name);
    }
    await supabaseAdmin.from("chat_inboxes").delete().eq("id", id);
    return res.status(200).json({ success: true, message: "Channel deleted successfully" });
  } catch (err) {
    console.error("[DELETE /channels/:id] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- POST /inboxes/:inboxId/sync (Especificação § 8.2) ---
app.post("/inboxes/:inboxId/sync", authMiddleware, async (req, res) => {
  const { inboxId } = req.params;
  if (!isValidUUID(inboxId)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  const { data: inbox } = await supabaseAdmin
    .from("chat_inboxes")
    .select("id, organization_id, evolution_instance_name, connection_status")
    .eq("id", inboxId)
    .single();

  if (!inbox) {
    return res.status(404).json({ error: "Inbox not found" });
  }

  const hasAccess = await validateOrganizationAccess(req.user.id, inbox.organization_id);
  if (!hasAccess) {
    return res.status(403).json({ error: "Sem acesso à organização" });
  }

  if (inbox.connection_status !== "connected" || !inbox.evolution_instance_name) {
    return res.status(400).json({
      error: "Inbox must be connected to sync",
      detail: "Channel must have evolution_instance_name and connection_status 'connected'",
    });
  }

  try {
    const findResult = await findContacts(inbox.evolution_instance_name);
    const groupsResult = await fetchAllGroups(inbox.evolution_instance_name);
    const chatsResult = await findChats(inbox.evolution_instance_name);
    const contacts = findResult.success ? findResult.contacts || [] : [];
    const groups = groupsResult.success ? groupsResult.groups || [] : [];
    const chats = chatsResult.success ? chatsResult.chats || [] : [];

    let contactsCreated = 0;
    let conversationsCreated = 0;
    let chatsProcessed = 0;
    let messagesInserted = 0;

    const upsertContactAndConversation = async (
      remoteJid,
      name,
      contactType,
      avatarUrl
    ) => {
      if (!remoteJid || typeof remoteJid !== "string") return;
      const sourceId = remoteJid;

      let contactId = null;
      const { data: existingContact } = await supabaseAdmin
        .from("chat_contacts")
        .select("id")
        .eq("inbox_id", inbox.id)
        .eq("remote_jid", remoteJid)
        .maybeSingle();

      const updateData = {
        name,
        contact_type: contactType,
        updated_at: new Date().toISOString(),
      };
      if (avatarUrl != null) updateData.avatar_url = avatarUrl;

      if (existingContact) {
        contactId = existingContact.id;
        await supabaseAdmin
          .from("chat_contacts")
          .update(updateData)
          .eq("id", contactId);
      } else {
        const { data: newContact, error: contactError } = await supabaseAdmin
          .from("chat_contacts")
          .insert({
            inbox_id: inbox.id,
            organization_id: inbox.organization_id,
            remote_jid: remoteJid,
            source_id: sourceId,
            name,
            contact_type: contactType,
            ...(avatarUrl != null && { avatar_url: avatarUrl }),
          })
          .select("id")
          .single();
        if (!contactError && newContact) {
          contactId = newContact.id;
          contactsCreated++;
        }
      }
      if (!contactId) return null;

      const { data: existingConv } = await supabaseAdmin
        .from("chat_conversations")
        .select("id")
        .eq("inbox_id", inbox.id)
        .eq("contact_id", contactId)
        .maybeSingle();

      let conversationId = existingConv?.id ?? null;

      if (!existingConv) {
        const { data: newConv, error: convError } = await supabaseAdmin
          .from("chat_conversations")
          .insert({
            inbox_id: inbox.id,
            contact_id: contactId,
            organization_id: inbox.organization_id,
            status: "open",
          })
          .select("id")
          .single();
        if (!convError && newConv?.id) {
          conversationId = newConv.id;
          conversationsCreated++;
        }
      }

      if (!conversationId) return { contactId };
      return { contactId, conversationId };
    };

    for (const contact of contacts) {
      const remoteJid =
        contact.id?.remoteJid ?? contact.remoteJid ?? contact.id;
      if (!remoteJid || typeof remoteJid !== "string") continue;
      if (remoteJid.endsWith("@g.us")) continue;
      const name =
        contact.name ?? contact.pushName ?? remoteJid.replace(/@.*$/, "") ?? remoteJid;
      const avatarUrl =
        contact.profilePicUrl ?? contact.profile_pic_url ?? null;
      await upsertContactAndConversation(remoteJid, name, "individual", avatarUrl);
    }

    for (const group of groups) {
      const remoteJid =
        group.id?.remoteJid ?? group.id ?? group.remoteJid;
      if (!remoteJid || typeof remoteJid !== "string") continue;
      if (!remoteJid.endsWith("@g.us")) continue;
      const name =
        group.subject ?? group.name ?? remoteJid.replace(/@.*$/, "") ?? remoteJid;
      const avatarUrl =
        group.pictureUrl ?? group.picture_url ?? group.subjectPictureUrl ?? null;
      await upsertContactAndConversation(remoteJid, name, "group", avatarUrl);
    }

    const upsertMessageFromChat = async (
      conversationId,
      remoteJid,
      isGroup,
      message
    ) => {
      if (!conversationId || !message) return false;
      const evolutionMessageId =
        message?.key?.id ??
        message?.key?.messageId ??
        message?.id ??
        message?.messageId ??
        null;

      if (evolutionMessageId) {
        const { data: existing } = await supabaseAdmin
          .from("chat_messages")
          .select("id")
          .eq("evolution_message_id", evolutionMessageId)
          .maybeSingle();
        if (existing) return false;
      }

      const content =
        extractMessageContent(message) ??
        message?.text ??
        message?.body ??
        message?.message?.conversation ??
        null;
      if (content == null) return false;

      const isFromMe =
        message?.key?.fromMe ??
        message?.key?.from_me ??
        message?.fromMe ??
        false;
      const timestamp =
        message?.messageTimestamp ??
        message?.message_timestamp ??
        message?.timestamp ??
        message?.conversationTimestamp ??
        Date.now() / 1000;
      const createdAt = new Date(Number(timestamp) * 1000).toISOString();

      await supabaseAdmin.from("chat_messages").insert({
        conversation_id: conversationId,
        content: content || "",
        direction: isFromMe ? "outgoing" : "incoming",
        message_type: message?.messageType || message?.type || "text",
        status: isFromMe ? "sent" : "received",
        evolution_message_id: evolutionMessageId,
        participant_remote_jid: isGroup ? message?.key?.participant ?? null : null,
        created_at: createdAt,
      });

      await supabaseAdmin
        .from("chat_conversations")
        .update({ updated_at: createdAt })
        .eq("id", conversationId);
      return true;
    };

    if (Array.isArray(chats) && chats.length > 0) {
      const limitedChats = chats.slice(0, 100); // prioriza até 100 chats recentes
      for (const chat of limitedChats) {
        const remoteJid =
          chat?.id?.remoteJid ??
          chat?.id?._serialized ??
          chat?.id ??
          chat?.remoteJid ??
          chat?.remote_jid ??
          chat?.jid ??
          null;
        if (!remoteJid || typeof remoteJid !== "string") continue;
        const isGroup = remoteJid.includes("@g.us");
        const name =
          chat?.name ??
          chat?.pushName ??
          chat?.contactName ??
          chat?.subject ??
          remoteJid.replace(/@.*$/, "") ??
          remoteJid;
        const avatarUrl =
          chat?.profilePicUrl ??
          chat?.pictureUrl ??
          chat?.avatarUrl ??
          null;

        const upsertResult = await upsertContactAndConversation(
          remoteJid,
          name,
          isGroup ? "group" : "individual",
          avatarUrl
        );
        if (!upsertResult?.conversationId) continue;

        const lastMessage =
          chat?.lastMessage ??
          (Array.isArray(chat?.messages) && chat.messages.length > 0
            ? chat.messages[chat.messages.length - 1]
            : null);
        if (lastMessage && typeof lastMessage === "object") {
          const inserted = await upsertMessageFromChat(
            upsertResult.conversationId,
            remoteJid,
            isGroup,
            lastMessage
          );
          if (inserted) {
            chatsProcessed++;
            messagesInserted++;
          }
        } else if (chat?.conversationTimestamp) {
          const ts = new Date(Number(chat.conversationTimestamp) * 1000).toISOString();
          await supabaseAdmin
            .from("chat_conversations")
            .update({ updated_at: ts })
            .eq("id", upsertResult.conversationId);
          chatsProcessed++;
        }
      }
    }

    const { count: convCount } = await supabaseAdmin
      .from("chat_conversations")
      .select("*", { count: "exact", head: true })
      .eq("inbox_id", inboxId);
    const { count: contactCount } = await supabaseAdmin
      .from("chat_contacts")
      .select("*", { count: "exact", head: true })
      .eq("inbox_id", inboxId);

    await supabaseAdmin
      .from("chat_inboxes")
      .update({
        contacts_count: contactCount ?? 0,
        conversations_count: convCount ?? 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", inboxId);

    return res.json({
      success: true,
      contacts_processed: contacts.length + groups.length,
      contacts_created: contactsCreated,
      conversations_created: conversationsCreated,
      chats_processed: chatsProcessed,
      messages_inserted: messagesInserted,
    });
  } catch (err) {
    console.error("[POST /inboxes/:inboxId/sync] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- GET /inboxes/:inboxId/conversations (Especificação § 8.3) ---
app.get("/inboxes/:inboxId/conversations", authMiddleware, async (req, res) => {
  const { inboxId } = req.params;
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || 50, 1),
    100
  );
  const before = req.query.before;
  const days = parseInt(req.query.days, 10) || 30;
  const only_with_messages = req.query.only_with_messages !== "false";
  const include_archived = req.query.include_archived === "true";
  const filter_pinned = req.query.pinned === "true";

  if (!isValidUUID(inboxId)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    let query = supabase
      .from("chat_conversations")
      .select(
        `
        id,
        status,
        updated_at,
        labels,
        is_archived,
        is_pinned,
        contact:chat_contacts(
          id,
          name,
          remote_jid,
          contact_type,
          avatar_url
        )
      `
      )
      .eq("inbox_id", inboxId)
      .order("updated_at", { ascending: false })
      .limit(limit + 1);

    if (!include_archived) {
      query = query.or("is_archived.eq.false,is_archived.is.null");
    }
    if (filter_pinned) {
      query = query.eq("is_pinned", true);
    }
    if (days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      query = query.gte("updated_at", since.toISOString());
    }
    if (before) query = query.lt("updated_at", before);

    const { data, error } = await query;
    if (error) throw error;

    const hasMore = (data || []).length > limit;
    const conversations = hasMore ? data.slice(0, limit) : data || [];

    const conversationsWithPreview = await Promise.all(
      conversations.map(async (conv) => {
        const { data: lastMsg } = await supabase
          .from("chat_messages")
          .select("content, created_at")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        return {
          id: conv.id,
          contact: conv.contact,
          status: conv.status,
          updated_at: conv.updated_at,
          labels: conv.labels ?? [],
          is_archived: conv.is_archived ?? false,
          is_pinned: conv.is_pinned ?? false,
          preview: lastMsg?.content ?? null,
          preview_at: lastMsg?.created_at ?? null,
        };
      })
    );

    const filtered =
      only_with_messages === true
        ? conversationsWithPreview.filter((c) => c.preview !== null)
        : conversationsWithPreview;

    return res.json({
      conversations: filtered,
      has_more: hasMore,
      cursor:
        filtered.length > 0
          ? filtered[filtered.length - 1].updated_at
          : null,
    });
  } catch (err) {
    console.error("[GET /inboxes/:inboxId/conversations] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- GET /inboxes/:inboxId/contacts (Especificação § 8.3) ---
app.get("/inboxes/:inboxId/contacts", authMiddleware, async (req, res) => {
  const { inboxId } = req.params;
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || 50, 1),
    100
  );
  const before = req.query.before;

  if (!isValidUUID(inboxId)) {
    return res.status(400).json({ error: "Invalid inbox ID format" });
  }

  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    let query = supabase
      .from("chat_contacts")
      .select("id, name, remote_jid, contact_type, avatar_url, updated_at")
      .eq("inbox_id", inboxId)
      .order("updated_at", { ascending: false })
      .limit(limit + 1);
    if (before) query = query.lt("updated_at", before);

    const { data, error } = await query;
    if (error) throw error;

    const hasMore = (data || []).length > limit;
    const contacts = hasMore ? data.slice(0, limit) : data || [];

    return res.json({
      contacts,
      has_more: hasMore,
      cursor: contacts.length > 0 ? contacts[contacts.length - 1].updated_at : null,
    });
  } catch (err) {
    console.error("[GET /inboxes/:inboxId/contacts] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- GET /conversations/:conversationId/messages (Especificação § 8.4) ---
app.get("/conversations/:conversationId/messages", authMiddleware, async (req, res) => {
  const { conversationId } = req.params;
  const limit = Math.min(
    Math.max(parseInt(req.query.limit, 10) || 50, 1),
    100
  );
  const before = req.query.before;

  if (!isValidUUID(conversationId)) {
    return res.status(400).json({ error: "Invalid conversation ID format" });
  }

  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    let query = supabase
      .from("chat_messages")
      .select(
        "id, content, direction, message_type, status, created_at, evolution_message_id, participant_remote_jid"
      )
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(limit + 1);
    if (before) query = query.lt("created_at", before);

    const { data, error } = await query;
    if (error) throw error;

    const hasMore = (data || []).length > limit;
    const messages = hasMore ? data.slice(0, limit) : data || [];

    return res.json({
      messages,
      has_more: hasMore,
      cursor:
        messages.length > 0 ? messages[messages.length - 1].created_at : null,
    });
  } catch (err) {
    console.error("[GET /conversations/:conversationId/messages] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- POST /conversations/:conversationId/messages (Especificação § 8.4) ---
app.post("/conversations/:conversationId/messages", authMiddleware, async (req, res) => {
  const { conversationId } = req.params;
  const { content } = req.body || {};

  if (!isValidUUID(conversationId)) {
    return res.status(400).json({ error: "Invalid conversation ID format" });
  }
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    return res.status(400).json({
      error: "Conteúdo da mensagem é obrigatório",
    });
  }

  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const { data: conversation, error: convError } = await supabase
      .from("chat_conversations")
      .select(
        `
        id,
        inbox:chat_inboxes(id, evolution_instance_name),
        contact:chat_contacts(id, remote_jid)
      `
      )
      .eq("id", conversationId)
      .single();

    if (convError || !conversation) {
      return res.status(404).json({ error: "Conversa não encontrada" });
    }

    const instanceName = conversation.inbox?.evolution_instance_name;
    const remoteJid = conversation.contact?.remote_jid;
    if (!instanceName || !remoteJid) {
      return res.status(400).json({
        error: "Conversation or inbox not ready for sending",
      });
    }

    const { data: message, error: msgError } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        conversation_id: conversationId,
        content: text,
        direction: "outgoing",
        message_type: "text",
        status: "sending",
      })
      .select()
      .single();

    if (msgError) throw msgError;

    const sendResult = await sendText(
      instanceName,
      remoteJid.replace(/@s.whatsapp.net/, "").replace(/@g.us/, ""),
      text
    );

    const newStatus = sendResult.success && sendResult.data?.key?.id
      ? "sent"
      : "failed";

    await supabaseAdmin
      .from("chat_messages")
      .update({
        status: newStatus,
        evolution_message_id: sendResult.data?.key?.id ?? null,
      })
      .eq("id", message.id);

    await supabaseAdmin
      .from("chat_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    return res.status(201).json({
      ...message,
      status: newStatus,
      evolution_message_id: sendResult.data?.key?.id ?? null,
    });
  } catch (err) {
    console.error("[POST /conversations/:conversationId/messages] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// --- PATCH /conversations/:conversationId (labels, is_archived, is_pinned) ---
app.patch("/conversations/:conversationId", authMiddleware, async (req, res) => {
  const { conversationId } = req.params;
  const { labels, is_archived, is_pinned } = req.body || {};

  if (!isValidUUID(conversationId)) {
    return res.status(400).json({ error: "Invalid conversation ID format" });
  }

  const supabase = supabaseFromReq(req);
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const { data: conv, error: fetchError } = await supabase
      .from("chat_conversations")
      .select("id, organization_id")
      .eq("id", conversationId)
      .single();

    if (fetchError || !conv) {
      return res.status(404).json({ error: "Conversa não encontrada" });
    }

    const hasAccess = await validateOrganizationAccess(req.user.id, conv.organization_id);
    if (!hasAccess) {
      return res.status(403).json({ error: "Sem acesso à organização" });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (Array.isArray(labels)) updates.labels = labels;
    if (typeof is_archived === "boolean") updates.is_archived = is_archived;
    if (typeof is_pinned === "boolean") updates.is_pinned = is_pinned;

    if (Object.keys(updates).length <= 1) {
      return res.status(400).json({ error: "Body deve incluir labels, is_archived ou is_pinned" });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("chat_conversations")
      .update(updates)
      .eq("id", conversationId)
      .select()
      .single();

    if (updateError) throw updateError;
    return res.json(updated);
  } catch (err) {
    console.error("[PATCH /conversations/:conversationId] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[flunx-channels-api] Rodando na porta ${PORT}`);
});
