// Kleiner Server für den Lernhelfer.
// Er nimmt die Anfrage der Website entgegen, hängt den geheimen Mistral-Schlüssel an
// und leitet die Antwort der KI Stück für Stück an die Website weiter.
// Der Schlüssel liegt nur in Vercel (Umgebungsvariable MISTRAL_API_KEY) und ist nie im Browser sichtbar.

export const config = { runtime: "edge" };

const MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";
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

  const key = process.env.MISTRAL_API_KEY;
  if (!key) return text("MISTRAL_API_KEY fehlt in den Vercel-Einstellungen.", 500);

  let body;
  try { body = await req.json(); } catch { return text("Ungültige Anfrage.", 400); }

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .slice(-20)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 150000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return text("Keine Frage erhalten.", 400);

  const images = (Array.isArray(body.images) ? body.images : [])
    .filter((s) => typeof s === "string" && s.startsWith("data:image/"))
    .slice(0, 6);
  if (images.length) {
    const last = messages[messages.length - 1];
    last.content = [{ type: "text", text: last.content }, ...images.map((u) => ({ type: "image_url", image_url: u }))];
  }

  const payload = {
    model: MODEL,
    messages: [{ role: "system", content: SYSTEM }, ...messages],
    stream: true,
    temperature: 0.4,
    max_tokens: 4000,
  };
  if (body.json) payload.response_format = { type: "json_object" };

  let up;
  try {
    up = await fetch("https://api.mistral.ai/v1/chat/completions", {
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
