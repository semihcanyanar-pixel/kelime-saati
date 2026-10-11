// Kelime Saati — AI kelime üretici (Cloudflare Worker)
// Secret:   GEMINI_API_KEY   (Google AI Studio'dan ücretsiz anahtar)
// İsteğe bağlı değişkenler:
//   ALLOWED_ORIGIN  ör. https://kullaniciadin.github.io  (boşsa her yerden istek kabul eder)
//   GEMINI_MODEL    varsayılan: gemini-2.5-flash

const LEVELS = ["A2", "B1", "B2", "C1"];
const POS = ["n.", "v.", "adj.", "adv.", "phr."];

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": allowed === "*" ? "*" : allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return json({ error: "POST bekleniyor" }, 405, cors);
    if (allowed !== "*" && origin && origin !== allowed) return json({ error: "İzin verilmeyen kaynak" }, 403, cors);
    if (!env.GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY tanımlı değil" }, 500, cors);

    let body;
    try { body = await req.json(); } catch { return json({ error: "Geçersiz JSON" }, 400, cors); }

    const topic = String(body.topic || "").trim().slice(0, 80) || "everyday life";
    const level = LEVELS.includes(body.level) ? body.level : "B1";
    const count = Math.min(Math.max(parseInt(body.count) || 10, 1), 20);
    const exclude = (Array.isArray(body.exclude) ? body.exclude : [])
      .slice(0, 800).map(s => String(s).toLowerCase().slice(0, 40));

    const prompt = `You are building an English vocabulary list for a native Turkish speaker.
Topic: "${topic}" (the topic may be written in Turkish).
CEFR level: ${level}.
Give ${count} useful English words or short phrases for this topic that fit this level.
Do NOT include any of these: ${exclude.join(", ")}.
Return ONLY a JSON array. Each item must be:
{"w": English word in lowercase,
 "tr": short natural Turkish meaning (1-4 words, alternatives separated by comma),
 "ipa": American English IPA without slashes,
 "pos": one of ${POS.join(" ")},
 "def": simple English definition, max 14 words,
 "ex": natural example sentence, max 14 words, that contains the word}`;

    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.9 },
        }),
      });
    } catch (e) {
      return json({ error: "AI servisine ulaşılamadı" }, 502, cors);
    }
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return json({ error: `AI hatası (${r.status})`, detail }, 502, cors);
    }

    const d = await r.json();
    const text = (d?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("") || "[]";
    let arr;
    try { arr = JSON.parse(text); }
    catch {
      const m = text.match(/\[[\s\S]*\]/);
      try { arr = m ? JSON.parse(m[0]) : []; } catch { arr = []; }
    }
    if (!Array.isArray(arr)) arr = Array.isArray(arr?.words) ? arr.words : [];

    const seen = new Set(exclude);
    const words = [];
    for (const x of arr) {
      if (!x || !x.w || !x.tr || !x.def || !x.ex) continue;
      const w = String(x.w).trim();
      if (seen.has(w.toLowerCase())) continue;
      seen.add(w.toLowerCase());
      words.push({
        w,
        tr: String(x.tr).trim(),
        ipa: String(x.ipa || "").trim().replace(/^\/|\/$/g, ""),
        pos: POS.includes(x.pos) ? x.pos : String(x.pos || "").slice(0, 6),
        def: String(x.def).trim(),
        ex: String(x.ex).trim(),
      });
      if (words.length >= count) break;
    }
    return json({ words }, 200, cors);
  },
};
