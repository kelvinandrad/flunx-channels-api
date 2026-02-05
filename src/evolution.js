/**
 * Cliente Evolution API: criar instância, conectar e obter QR code.
 * Evolution v1/v2: create = POST /instance/create, connect = GET /instance/connect/:instanceName
 */

const baseUrl =
  process.env.EVOLUTION_API_URL ||
  process.env.EVOLUTION_BASE_URL ||
  "https://apiwpp.flunx.com.br";
const apiKey = process.env.EVOLUTION_API_KEY || "";

function headers() {
  const h = { "Content-Type": "application/json" };
  if (apiKey) h.apikey = apiKey;
  return h;
}

/**
 * Cria uma instância na Evolution API.
 * @param {string} instanceName - Nome único da instância (slug)
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
export async function createInstance(instanceName) {
  try {
    const res = await fetch(`${baseUrl}/instance/create`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        instanceName,
        integration: "WHATSAPP-BAILEYS",
        qrcode: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${res.status}`, status: res.status };
    }
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e.message || "Evolution createInstance failed" };
  }
}

/**
 * Remove uma instância na Evolution API (rollback).
 * DELETE /instance/delete/:instanceName
 * @param {string} instanceName - Nome da instância
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function deleteInstance(instanceName) {
  try {
    const res = await fetch(`${baseUrl}/instance/delete/${encodeURIComponent(instanceName)}`, {
      method: "DELETE",
      headers: headers(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || "Evolution deleteInstance failed" };
  }
}

/**
 * Conecta a instância e retorna o QR code (base64 ou URL).
 * GET /instance/connect/:instanceName
 * @param {string} instanceName
 * @returns {Promise<{ success: boolean, qrCode?: string, connectionStatus?: string, error?: string }>}
 */
export async function connectInstance(instanceName) {
  try {
    const res = await fetch(`${baseUrl}/instance/connect/${instanceName}`, {
      method: "GET",
      headers: headers(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${res.status}` };
    }
    // Evolution já retorna base64 com prefixo data:image/png;base64, - não duplicar
    const qr = data?.base64 || data?.code || data?.qrCode || null;
    const state = data?.state || data?.connectionStatus || "pending";
    return { success: true, qrCode: qr, connectionStatus: state };
  } catch (e) {
    return { success: false, error: e.message || "Evolution connect failed" };
  }
}

/**
 * Estado da conexão da instância.
 * GET /instance/connectionState/:instanceName
 */
export async function getConnectionState(instanceName) {
  try {
    const res = await fetch(`${baseUrl}/instance/connectionState/${instanceName}`, {
      method: "GET",
      headers: headers(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { success: false, state: "error" };
    const state = (data?.state || data?.instance?.state || "").toLowerCase();
    const connected = state === "open" || state === "connected";
    return { success: true, state: connected ? "connected" : "pending" };
  } catch (e) {
    return { success: false, state: "error" };
  }
}

/**
 * Configura settings da instância (Reject Calls, Ignore Groups, etc. = false).
 * Evolution v2: POST /settings/set/{instanceName}
 */
export async function setInstanceSettings(instanceName) {
  try {
    const body = {
      rejectCalls: false,
      ignoreGroups: false,
      alwaysOnline: false,
      readMessages: false,
      syncFullHistory: false,
      readStatus: false,
    };
    const res = await fetch(`${baseUrl}/settings/set/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || "Evolution setInstanceSettings failed" };
  }
}

/**
 * Busca informações completas de uma instância conectada.
 * GET /instance/fetchInstances?instanceName=xxx
 * Retorna: profileName, profilePicUrl, ownerJid, _count.Contact, _count.Chat
 * @param {string} instanceName - Nome da instância
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
export async function fetchInstanceInfo(instanceName) {
  try {
    const res = await fetch(`${baseUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`, {
      method: "GET",
      headers: headers(),
    });
    const data = await res.json().catch(() => ([]));
    if (!res.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${res.status}` };
    }
    // API retorna array, pegamos o primeiro
    const instance = Array.isArray(data) ? data[0] : data;
    if (!instance) {
      return { success: false, error: "Instance not found" };
    }
    return { success: true, data: instance };
  } catch (e) {
    return { success: false, error: e.message || "Evolution fetchInstanceInfo failed" };
  }
}

/**
 * Desconecta (logout) uma instância sem deletá-la.
 * DELETE /instance/logout/:instanceName
 * @param {string} instanceName - Nome da instância
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function logoutInstance(instanceName) {
  try {
    const res = await fetch(`${baseUrl}/instance/logout/${encodeURIComponent(instanceName)}`, {
      method: "DELETE",
      headers: headers(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${res.status}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || "Evolution logoutInstance failed" };
  }
}

/**
 * Formata um número de telefone brasileiro para exibição.
 * Ex: 5562999288205 -> (62) 99928-8205
 * @param {string} jid - JID completo (ex: 5562999288205@s.whatsapp.net)
 * @returns {string} Número formatado
 */
export function formatBrazilianPhone(jid) {
  if (!jid) return "";
  // Remove @s.whatsapp.net e 55 do início
  const number = jid.replace(/@.*$/, "").replace(/^55/, "");
  if (number.length === 11) {
    // Celular: (XX) XXXXX-XXXX
    return `(${number.slice(0, 2)}) ${number.slice(2, 7)}-${number.slice(7)}`;
  } else if (number.length === 10) {
    // Fixo: (XX) XXXX-XXXX
    return `(${number.slice(0, 2)}) ${number.slice(2, 6)}-${number.slice(6)}`;
  }
  return number;
}

/**
 * Envia mensagem de texto via Evolution API.
 * POST /message/sendText/{instanceName}
 * @param {string} instanceName - Nome da instância Evolution
 * @param {string} number - Número com DDI (ex.: 5511999999999), sem @s.whatsapp.net
 * @param {string} text - Texto da mensagem
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
export async function sendText(instanceName, number, text) {
  if (!instanceName || !number || text == null) {
    return { success: false, error: "instanceName, number and text are required" };
  }
  try {
    const res = await fetch(`${baseUrl}/message/sendText/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ number: String(number).trim(), text: String(text) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { success: false, error: data?.message || data?.error || `HTTP ${res.status}`, status: res.status };
    }
    return { success: true, data };
  } catch (e) {
    return { success: false, error: e.message || "Evolution sendText failed" };
  }
}

/**
 * Busca todos os chats da instância Evolution.
 * POST /chat/findChats/{instanceName}
 * Retorna lista de chats com id, remoteJid, name, unreadCount, etc.
 * @param {string} instanceName - Nome da instância
 * @returns {Promise<{ success: boolean, chats?: array, error?: string }>}
 */
export async function findChats(instanceName) {
  if (!instanceName) {
    return { success: false, error: "instanceName is required" };
  }
  try {
    const res = await fetch(`${baseUrl}/chat/findChats/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        success: false,
        error: data?.message || data?.error || `HTTP ${res.status}`,
        status: res.status,
      };
    }
    const chats = Array.isArray(data) ? data : data?.chats ?? data?.data ?? [];
    return { success: true, chats };
  } catch (e) {
    return { success: false, error: e.message || "Evolution findChats failed" };
  }
}

/**
 * Busca todos os contatos da instância Evolution.
 * POST /chat/findContacts/{instanceName}
 * Retorna lista de contatos com id, remoteJid, pushName, profilePicUrl, etc.
 * Usado para sincronização de conversas (findChats retorna poucos chats).
 * @param {string} instanceName - Nome da instância
 * @returns {Promise<{ success: boolean, contacts?: array, error?: string }>}
 */
export async function findContacts(instanceName) {
  if (!instanceName) {
    return { success: false, error: "instanceName is required" };
  }
  try {
    const res = await fetch(`${baseUrl}/chat/findContacts/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        success: false,
        error: data?.message || data?.error || `HTTP ${res.status}`,
        status: res.status,
      };
    }
    const contacts = Array.isArray(data) ? data : data?.contacts ?? data?.data ?? [];
    return { success: true, contacts };
  } catch (e) {
    return { success: false, error: e.message || "Evolution findContacts failed" };
  }
}

/**
 * Busca todos os grupos da instância Evolution.
 * GET /group/fetchAllGroups/{instanceName}
 * Retorna lista de grupos com id (remoteJid), subject (nome), etc.
 * @param {string} instanceName - Nome da instância
 * @returns {Promise<{ success: boolean, groups?: array, error?: string }>}
 */
export async function fetchAllGroups(instanceName) {
  if (!instanceName) {
    return { success: false, error: "instanceName is required" };
  }
  try {
    const res = await fetch(`${baseUrl}/group/fetchAllGroups/${encodeURIComponent(instanceName)}`, {
      method: "GET",
      headers: headers(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        success: false,
        error: data?.message || data?.error || `HTTP ${res.status}`,
        status: res.status,
      };
    }
    const groups = Array.isArray(data) ? data : data?.groups ?? data?.data ?? [];
    return { success: true, groups };
  } catch (e) {
    return { success: false, error: e.message || "Evolution fetchAllGroups failed" };
  }
}

/**
 * Busca mensagens de um chat na Evolution.
 * POST /chat/findMessages/{instanceName}
 * Body: { where: { key: { remoteJid: "..." } }, limit?: number }
 * @param {string} instanceName - Nome da instância
 * @param {string} remoteJid - JID do chat (ex: 5562999999999@s.whatsapp.net)
 * @param {number} [limit=50] - Limite de mensagens
 * @returns {Promise<{ success: boolean, messages?: array, error?: string }>}
 */
export async function findMessages(instanceName, remoteJid, limit = 50) {
  if (!instanceName || !remoteJid) {
    return { success: false, error: "instanceName and remoteJid are required" };
  }
  try {
    const body = {
      where: { key: { remoteJid } },
      limit: Math.min(Math.max(limit, 1), 100),
    };
    const res = await fetch(`${baseUrl}/chat/findMessages/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        success: false,
        error: data?.message || data?.error || `HTTP ${res.status}`,
        status: res.status,
      };
    }
    const messages = Array.isArray(data) ? data : data?.messages ?? data?.data ?? [];
    return { success: true, messages };
  } catch (e) {
    return { success: false, error: e.message || "Evolution findMessages failed" };
  }
}

/**
 * Busca foto de perfil do contato (Especificação § 6).
 * POST /chat/fetchProfilePictureUrl/:instanceName
 * @param {string} instanceName - Nome da instância
 * @param {string} remoteJid - JID (ex.: 5511999999999@s.whatsapp.net)
 * @returns {Promise<string|null>} URL da foto ou null
 */
export async function fetchProfilePicture(instanceName, remoteJid) {
  if (!instanceName || !remoteJid) return null;
  try {
    const res = await fetch(
      `${baseUrl}/chat/fetchProfilePictureUrl/${encodeURIComponent(instanceName)}`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ number: remoteJid }),
      }
    );
    const data = await res.json().catch(() => ({}));
    return data?.profilePictureUrl ?? data?.profilePicture ?? null;
  } catch {
    return null;
  }
}

/** Alias para compatibilidade com a especificação (§ 6). */
export { sendText as sendTextMessage };

export { baseUrl as evolutionBaseUrl };
