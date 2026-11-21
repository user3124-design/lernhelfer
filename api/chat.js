// Kleiner Server für den Lernhelfer.
// Er nimmt die Anfrage der Website entgegen, hängt den geheimen KI-Schlüssel an
// und leitet die Antwort der KI Stück für Stück an die Website weiter.
// Der Schlüssel liegt nur in Vercel (Umgebungsvariable GROQ_API_KEY) und ist nie im Browser sichtbar.

export const config = { runtime: "edge" };

const URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.GROQ_VISION_MODEL || ""; // leer = Fotos werden nicht unterstützt
const MAX_INPUT = 14000; // Zeichen – das Gratis-Kontingent erlaubt nur wenige tausend Tokens pro Minute
const SYSTEM =
  "Du bist ein freundlicher Lernhelfer für Schülerinnen und Schüler in Österreich. " +
  "Du hilfst nur beim Lernen: zusammenfassen, erklären, üben, abfragen. " +
  "Antworte auf Deutsch, sachlich richtig und altersgerecht. Wenn du etwas nicht sicher weißt, sag das.";

const text = (msg, status) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export default async function handler(req) {
  if (req.method !== "POST") return text("Nur POST erlaubt.", 405);

  // Optionaler Zugangscode, damit nicht jeder Fremde dein Gratis-Kontingent aufbraucht.
  const needCode = process.env.ACCESS_CODE;
  if (needCode && req.headers.get("x-access-code") !== needCode) return text("Falscher Zugangscode.", 401);

  const key = process.env.GROQ_API_KEY;
  if (!key) return text("GROQ_API_KEY fehlt in den Vercel-Einstellungen.", 500);

  let body;
  try { body = await req.json(); } catch { return text("Ungültige Anfrage.", 400); }

  // Nachrichten kürzen: ältere Teile fallen zuerst weg, die letzte Frage bleibt.
  let budget = MAX_INPUT;
  const messages = [];
  for (const m of (Array.isArray(body.messages) ? body.messages : []).slice(-10).reverse()) {
    if (budget <= 0) break;
    const c = String(m.content || "");
    const part = c.length > budget ? c.slice(0, budget) + "\n[… gekürzt]" : c;
    budget -= part.length;
    messages.unshift({ role: m.role === "assistant" ? "assistant" : "user", content: part });
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") return text("Keine Frage erhalten.", 400);

  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((s) => typeof s === "string" && s.startsWith("data:image/"))
    .slice(0, 5);
  let model = MODEL;
  if (images.length) {
    if (!VISION_MODEL) return text("Fotos und eingescannte PDFs gehen hier leider nicht. Bitte füg den Text ein oder nimm ein PDF mit Text.", 400);
    model = VISION_MODEL;
    const last = messages[messages.length - 1];
    last.content = [{ type: "text", text: last.content }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } }))];
  }

  const payload = {
    model,
    messages: [{ role: "system", content: SYSTEM }, ...messages],
    stream: true,
    temperature: 0.4,
    max_tokens: 2500,
  };
  if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";
  if (body.json) payload.response_format = { type: "json_object" };

  let up;
  try {
    up = await fetch(URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return text("Die KI ist gerade nicht erreichbar.", 502);
  }
  if (up.status === 429) return text("Gerade zu viele Anfragen.", 429);
  if (!up.ok) return text("KI-Fehler: " + (await up.text()).slice(0, 300), 502);

  return new Response(up.body, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
