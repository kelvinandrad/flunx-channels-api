/**
 * Script de investigação: testa Evolution API findChats e findContacts.
 * Uso: node scripts/test-evolution-api.mjs <instanceName>
 * Carrega .env do diretório pai.
 */
import "dotenv/config";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "..", ".env") });

const baseUrl = process.env.EVOLUTION_BASE_URL || "https://apiwpp.flunx.com.br";
const apiKey = process.env.EVOLUTION_API_KEY || "";

const instanceName = process.argv[2] || "flunx-kelvin-andrade-6tt3ojaf";

async function test(desc, url, options = {}) {
  console.log("\n---", desc, "---");
  console.log("URL:", url);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify(options.body || {}),
      ...options,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    console.log("Status:", res.status);
    console.log("Response (raw length):", text.length);
    if (typeof data === "object") {
      if (Array.isArray(data)) {
        console.log("Array length:", data.length);
        if (data.length > 0) {
          console.log("First item keys:", Object.keys(data[0]));
          console.log("First item sample:", JSON.stringify(data[0], null, 2).slice(0, 500));
        }
      } else {
        console.log("Response keys:", Object.keys(data));
        if (data.chats) console.log("chats length:", data.chats?.length);
        if (data.data) console.log("data type:", Array.isArray(data.data) ? `array[${data.data.length}]` : typeof data.data);
        if (data.contacts) console.log("contacts length:", data.contacts?.length);
        console.log("Full response (truncated):", JSON.stringify(data, null, 2).slice(0, 1500));
      }
    } else {
      console.log("Response:", String(data).slice(0, 300));
    }
    return { res, data };
  } catch (e) {
    console.error("Error:", e.message);
  }
}

async function main() {
  console.log("Evolution API investigation");
  console.log("Base URL:", baseUrl);
  console.log("Instance:", instanceName);
  console.log("API Key set:", !!apiKey);

  await test(
    "findChats",
    `${baseUrl}/chat/findChats/${encodeURIComponent(instanceName)}`,
    { body: {} }
  );

  await test(
    "findContacts",
    `${baseUrl}/chat/findContacts/${encodeURIComponent(instanceName)}`,
    { body: {} }
  );

  console.log("\n--- webhook get (Find Webhook) ---");
  try {
    const res = await fetch(`${baseUrl}/webhook/get/${encodeURIComponent(instanceName)}`, {
      method: "GET",
      headers: { apikey: apiKey },
    });
    const data = await res.json().catch(() => res.text());
    console.log("Status:", res.status);
    console.log("Webhook config:", JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Error:", e.message);
  }
}

main().catch(console.error);
