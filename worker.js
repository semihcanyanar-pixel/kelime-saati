// Kelime Saati — AI kelime üretici (Cloudflare Worker)
// Secret:   GEMINI_API_KEY   (Google AI Studio'dan ücretsiz anahtar)
// İsteğe bağlı değişkenler:
//   ALLOWED_ORIGIN  ör. https://kullaniciadin.github.io  (boşsa her yerden istek kabul eder)
//   GEMINI_MODEL    varsayılan: gemini-flash-latest (meşgulse yedek modellere geçer)
//
// Üç iş yapar (hepsinde isteğe bağlı  cats: [{k, n}]  ile kullanıcının kendi kategorileri gönderilebilir):
//   { topic, level, count, exclude }   → { words: [...] }      yeni kelime üretir
//   { classify: [{ w, def }] }         → { topics: { w: k } }  kelimeleri kategorilere yerleştirir
//   { match: { n }, words: [{ w, tr }] } → { words: [w, ...] }  bu kategoriye ait olan kelimeleri seçer
//   { card: "resilient", ctx? }        → { word: {...} }       tek bir kelimenin kartını hazırlar (ctx: geçtiği cümle)
//   { news: { cat } }                  → { items: [...] }      BBC haber başlıkları (KV'de 30 dk saklanır)
//   { article: { url, title, date, lv } } → { level, quiz, video } haberin bir seviyesini yazar (KV'de saklanır)
//   { story: { topic, level, len, words } } → { title, emoji, paras, used } iki dilli hikâye
//   { ytch: { ref } }                  → { id, title, thumb }  YouTube kanalını bul (@ad, link ya da UC… kimliği)
//   { ytvids: { chs: [ref, ...] } }    → { channels, videos }  kanalların son videoları (KV'de 12 saat saklanır)
//   { gloss: { w, ctx } }              → { tr, alts }          kelimenin hızlı Türkçe anlamı (okurken dokununca)
//   { tts: { text, voice } }           → Gemini ses cevabı (KV'de saklanır)
//
// İsteğe bağlı bağlantılar:
//   KS          KV namespace (haber, metin ve ses önbelleği; yoksa her şey yeniden üretilir)
//   YT_API_KEY  YouTube Data API anahtarı (haberin BBC videosunu bulmak için)
//   GROQ_API_KEY  Groq anahtarı (hızlı yedek yapay zekâ; console.groq.com, ücretsiz)
//   AI          Workers AI bağlantısı (son çare yedek; anahtar gerekmez)
//   ADMIN_EMAIL   yönetici hesabı (aile listesini yönetir)   FIREBASE_PROJECT  varsayılan: kelime-saati
// Güvenlik: her istek Firebase giriş jetonu (Authorization: Bearer …) ister.
//   Aile listesindekiler GEMINI_API_KEY ile, diğerleri kendi anahtarlarıyla (X-Gemini-Key) çalışır.
// Zamanlanmış görev (Cron): her gece 03:00–04:00 (TR) her kategoriden 2 haberi önceden hazırlar.

const LEVELS = ["A2", "B1", "B2", "C1"];
const POS = ["n.", "v.", "adj.", "adv.", "phr."];
const TOPICS = {
  daily: "daily life, home, shopping, routines",
  work: "work, career, business, office",
  travel: "travel, places, transport, holidays",
  emotions: "feelings, personality, relationships",
  tech: "technology, internet, devices, software",
  health: "health, body, sport, food and nutrition",
  society: "society, news, politics, culture, history, environment",
  academic: "study, science, ideas, abstract and academic words",
};
// Uygulama kendi kategori listesini gönderirse onu kullan, yoksa varsayılan 8 konu
function catSet(body) {
  const list = Array.isArray(body && body.cats) ? body.cats.slice(0, 40)
    .map(c => ({ k: String(c && c.k || "").slice(0, 40), n: String(c && c.n || "").slice(0, 60) }))
    .filter(c => c.k && c.n) : [];
  if (!list.length) return { keys: Object.keys(TOPICS), help: Object.keys(TOPICS).map(k => `${k} = ${TOPICS[k]}`).join("; ") };
  return {
    keys: list.map(c => c.k),
    help: list.map(c => `${c.k} = ${TOPICS[c.k] ? TOPICS[c.k] + " (" + c.n + ")" : c.n}`).join("; "),
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

class HttpError extends Error {
  constructor(status, message, detail) { super(message); this.status = status; this.detail = detail; }
}

export default {
  async scheduled(ev, env, ctx) { ctx.waitUntil(prefetch(env, ctx).catch(() => {})); },
  async fetch(req, env, ctx) {
    try {
      return await handle(req, env, ctx);
    } catch (e) {
      // Beklenmeyen her hata yine CORS başlığıyla dönsün ki uygulama mesajı görebilsin
      return new Response(JSON.stringify({ error: "Worker hatası: " + (e && e.message ? e.message : String(e)) }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};

async function handle(req, env, ctx) {
  const origin = req.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "*";
  const cors = {
    "Access-Control-Allow-Origin": allowed === "*" ? "*" : allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Gemini-Key",
    "Access-Control-Expose-Headers": "X-LLM",
    "Vary": "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST bekleniyor" }, 405, cors);
  if (allowed !== "*" && origin && origin !== allowed) return json({ error: "İzin verilmeyen kaynak" }, 403, cors);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Geçersiz JSON" }, 400, cors); }

  // Kim istiyor? (Firebase girişi) — aile üyeleri ortak anahtarı, diğerleri kendi anahtarını kullanır
  const U = await verifyFb((req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""), env).catch(() => null);
  if (!U && env.AUTH_OFF !== "1") return json({ error: "Önce uygulamaya giriş yap", auth: true }, 401, cors);
  const admin = !!U && U.email === adminEmail(env);
  const fam = admin || (!!U && (await famList(env)).includes(U.email)) || (!U && env.AUTH_OFF === "1");
  const ukey = (req.headers.get("X-Gemini-Key") || "").trim();
  const E = Object.assign(Object.create(env), {
    GKEY: fam ? (env.GEMINI_API_KEY || "") : (/^AIza[\w-]{30,}$/.test(ukey) ? ukey : ""),
    FAM: fam, ADMIN: admin, OWNKEY: !fam,
  });
  env = E;
  qMaybeFlush(env, ctx);

  try {
    if (body.me) return json({ family: fam, admin, email: U ? U.email : "", hasKey: !!E.GKEY }, 200, cors);
    if (body.fam) return json(await famOp(body.fam, E, ctx), 200, cors);
    if (body.quota) return json(await quotaInfo(body.quota, E, ctx), 200, cors);
    if (body.pfcats) return json(await pfCats(body.pfcats, E), 200, cors);
    if (body.idioms) return json(await idiomsGet(body.idioms, E, ctx), 200, cors);
    if (body.glossBatch) return json(await glossBatch(body.glossBatch, env, ctx), 200, cors);
    if (Array.isArray(body.classify)) return json(await classify(body.classify, catSet(body), env), 200, cors);
    if (typeof body.card === "string") return json(await card(body.card, catSet(body), env, body.ctx, !!body.exact), 200, cors);
    if (body.gloss) return json(await gloss(body.gloss, env, ctx), 200, cors);
    if (body.trfix) return json(await trFix(body.trfix, env), 200, cors);
    if (body.ytch) return json(await ytChannel(body.ytch, env, ctx), 200, cors);
    if (body.ytvids) return json(await ytVideos(body.ytvids, env, ctx), 200, cors);
    if (body.tts) return await tts(body.tts, env, ctx, cors);
    if (body.news) return json(await news(body.news, env, ctx), 200, cors);
    if (body.article && body.article.stream) return await articleStream(body.article, env, ctx, cors);
    if (body.article) return json(await article(body.article, env, ctx), 200, cors);
    if (body.artmeta) return json(await articleMeta(body.artmeta, env, ctx), 200, cors);
    if (body.artquiz) return json(await articleQuiz(body.artquiz, env, ctx), 200, cors);
    if (body.story && body.story.stream) return await storyStream(body.story, env, cors);
    if (body.story) return json(await story(body.story, env), 200, cors);
    if (body.match && Array.isArray(body.words)) return json(await match(body.match, body.words, env), 200, cors);
    return json(await generate(body, env), 200, cors);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, detail: e.detail, needKey: e.needKey || undefined }, e.status, cors);
    throw e;
  }
}

async function generate(body, env) {
  const topic = String(body.topic || "").trim().slice(0, 80) || "everyday life";
  const level = LEVELS.includes(body.level) ? body.level : "B1";
  const count = Math.min(Math.max(parseInt(body.count) || 10, 1), 20);
  const cs = catSet(body);
  const exclude = (Array.isArray(body.exclude) ? body.exclude : [])
    .slice(0, 800).map(s => String(s).toLowerCase().slice(0, 40));

  const prompt = `You are building an English vocabulary list for a native Turkish speaker.
Topic: "${topic}" (the topic may be written in Turkish).
CEFR level: ${level}.
Give ${count} useful English words or short phrases for this topic that fit this level.
Do NOT include any of these: ${exclude.slice(-150).join(", ")}.
Return ONLY a JSON array. Each item must be an object with exactly these keys:
{"word": the English word in lowercase,
 "turkish": its short natural Turkish TRANSLATION in Turkish words (1-4 words, alternatives separated by comma) — NOT the pronunciation,
 "ipa": American English IPA pronunciation without slashes,
 "pos": one of ${POS.join(" ")},
 "definition": simple English definition, max 14 words,
 "example": natural English example sentence, max 14 words, that contains the word,
 "category": the ONE category key that fits this word best, from: ${cs.help} (names may be Turkish)}
Example item: {"word":"grip","turkish":"tutuş, kavrama","ipa":"ɡrɪp","pos":"n.","definition":"a firm hold on something","example":"Keep a firm grip on the racket.","category":"${cs.keys[0]}"}`;

  const seen = new Set(exclude);
  const words = [];
  const take = arr => {
    if (!Array.isArray(arr)) arr = Array.isArray(arr && arr.words) ? arr.words : Array.isArray(arr && arr.items) ? arr.items : [];
    for (const raw of arr) {
      const x = normWord(raw);
      if (!okWord(x)) continue;
      const k = x.w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      const t = x.t.toLowerCase();
      words.push({ w: x.w, tr: x.tr, ipa: x.ipa, pos: POS.includes(x.pos) ? x.pos : x.pos.slice(0, 6), def: x.def, ex: x.ex, t: cs.keys.includes(t) ? t : "" });
      if (words.length >= count) break;
    }
  };
  take(await llmJSON(prompt, env, { prefer: "fast" }));
  // Hızlı model eksik/bozuk cevap verdiyse (ör. anlam yerine okunuş), Türkçesi daha iyi olan modelle tamamla
  if (words.length < Math.ceil(count * 0.7)) {
    try { take(await llmJSON(prompt, env, { prefer: "quality", hedge: 12000 })); } catch {}
  }
  return { words };
}

async function classify(list, cs, env) {
  const items = list.slice(0, 200)
    .filter(x => x && x.w)
    .map(x => ({ w: String(x.w).slice(0, 40), def: String(x.def || "").slice(0, 120) }));
  if (!items.length) return { topics: {} };

  const prompt = `Put each English word into the ONE category that fits it best.
Categories (key = meaning, names may be Turkish): ${cs.help}.
Words: ${JSON.stringify(items)}
Return ONLY a JSON object mapping each word exactly as given to its category key, e.g. {"heritage":"society"}.`;

  const res = await llmJSON(prompt, env, { prefer: "fast", obj: true, temperature: 0.2 });
  const topics = {};
  if (res && typeof res === "object" && !Array.isArray(res)) {
    for (const [w, t] of Object.entries(res)) {
      const k = String(t || "").trim();
      const hit = cs.keys.find(x => x.toLowerCase() === k.toLowerCase());
      if (hit) topics[w] = hit;
    }
  }
  return { topics };
}

// Yeni kategori: listedeki kelimelerden hangileri bu kategoriye ait?
async function match(cat, list, env) {
  const name = String(cat.n || "").trim().slice(0, 60);
  const items = list.slice(0, 250).filter(x => x && x.w)
    .map(x => ({ w: String(x.w).slice(0, 40), tr: String(x.tr || "").slice(0, 40) }));
  if (!name || !items.length) return { words: [] };

  const prompt = `A vocabulary app has a category named "${name}" (the name may be Turkish).
From the list below, pick ONLY the English words that clearly and mainly belong to this category.
Be strict: do not include general words that could just appear in this context.
List (w = English word, tr = Turkish meaning): ${JSON.stringify(items)}
Return ONLY a JSON array of the chosen words, written exactly as given. Return [] if none fit.`;

  const res = await llmJSON(prompt, env, { prefer: "fast", temperature: 0.2 });
  const arr = Array.isArray(res) ? res : Array.isArray(res && res.words) ? res.words : [];
  const valid = new Set(items.map(x => x.w));
  return { words: arr.map(x => String(x)).filter(x => valid.has(x)) };
}

// Tek kelime: kullanıcının yazdığı kelimenin kartı
async function card(input, cs, env, context, exact) {
  const q = String(input || "").trim().slice(0, 60);
  if (!q) throw new HttpError(400, "Kelime boş");
  const cx = String(context || "").trim().slice(0, 300);
  // exact: kullanıcı bu çekimli hâli ayrı bir kelime olarak istiyor (interested, boring, meeting gibi): sözlük hâline çevirme
  const form = exact
    ? `\nKeep the word EXACTLY in the form given ("${q}"). Do not change it to its base form: it is a separate dictionary word, so write its own meaning.${cx ? `\nIt appears in this sentence: "${cx}".` : ""}`
    : cx ? `
The word appears in this sentence: "${cx}". Give the dictionary form of the word and the meaning it has in this sentence. If the form has its own dictionary entry with a different meaning (for example "interested", "boring", "meeting"), keep that form.` : "";
  const prompt = `A native Turkish speaker learning English wants a vocabulary card for: "${q}".${form}
If it is misspelled, fix the spelling. If it is written in Turkish, use its most common English equivalent.
If it is not a real English word or phrase, return {"error":"not a word"}.
Otherwise return ONLY a JSON object with exactly these keys:
{"word": the English word or phrase in lowercase (dictionary form),
 "turkish": its short natural Turkish TRANSLATION in Turkish words (1-4 words, alternatives separated by comma) — NOT the pronunciation,
 "ipa": American English IPA pronunciation without slashes,
 "pos": one of ${POS.join(" ")},
 "definition": simple English definition, max 14 words,
 "example": natural English example sentence, max 14 words, that contains the word,
 "level": its CEFR level, one of A1 A2 B1 B2 C1 C2,
 "category": the ONE category key that fits this word best, from: ${cs.help} (names may be Turkish)}
Example: {"word":"grip","turkish":"tutuş, kavrama","ipa":"ɡrɪp","pos":"n.","definition":"a firm hold on something","example":"Keep a firm grip on the racket.","level":"B2","category":"${cs.keys[0]}"}`;

  const ask = async prefer => { let r = await llmJSON(prompt, env, { prefer, obj: true, temperature: 0.4, hedge: prefer === "quality" ? 12000 : 4000 }); if (Array.isArray(r)) r = r[0]; return r; };
  let raw = await ask("fast"), x = normWord(raw);
  if (!(raw && raw.error) && !okWord(x)) { try { raw = await ask("quality"); x = normWord(raw); } catch {} }
  if (!raw || raw.error || !okWord(x)) throw new HttpError(422, `"${q}" için kart hazırlanamadı, yazımını kontrol et`);
  const lvlMap = { A1: "A2", C2: "C1" };
  const lv = x.lvl.toUpperCase();
  const t = x.t.toLowerCase();
  return {
    word: {
      w: x.w,
      tr: x.tr,
      ipa: x.ipa,
      pos: POS.includes(x.pos) ? x.pos : x.pos.slice(0, 6),
      def: x.def,
      ex: x.ex,
      lvl: lvlMap[lv] || (LEVELS.includes(lv) ? lv : "B1"),
      t: cs.keys.find(k => k.toLowerCase() === t) || "",
    },
  };
}

/* ---------- KV yardımcıları ---------- */
async function sha(s) {
  const b = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function kvGet(env, key) { try { return env.KS ? await env.KS.get(key) : null; } catch { return null; } }
function kvPut(env, ctx, key, val, ttl) {
  if (!env.KS) return;
  const p = ksPut(env, key, val, { expirationTtl: ttl }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

/* ---------- Haberler (BBC RSS) ---------- */
const FEEDS = {
  top: "https://feeds.bbci.co.uk/news/rss.xml",
  world: "https://feeds.bbci.co.uk/news/world/rss.xml",
  tech: "https://feeds.bbci.co.uk/news/technology/rss.xml",
  science: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
  health: "https://feeds.bbci.co.uk/news/health/rss.xml",
  business: "https://feeds.bbci.co.uk/news/business/rss.xml",
  culture: "https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml",
};
const unx = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();

async function news(q, env, ctx) {
  const cat = FEEDS[q && q.cat] ? q.cat : "top";
  const key = "rss2:" + cat, fresh = q && q.fresh;
  const mem = MEM.get(key);
  if (!fresh && mem && Date.now() - mem.t < 30 * 60000) return withReady(mem.v, env);
  const hit = fresh ? null : await kvGet(env, key);   // "yenile" tuşu önbelleği atlar
  if (hit) { const v = JSON.parse(hit); MEM.set(key, { t: Date.now(), v }); return withReady(v, env); }
  const r = await fetch(FEEDS[cat], { headers: { "User-Agent": "Mozilla/5.0 KelimeSaati" } });
  if (!r.ok) throw new HttpError(502, "Haberler alınamadı (" + r.status + ")");
  const xml = await r.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1], g = t => { const x = it.match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)<\/" + t + ">")); return x ? unx(x[1]) : ""; };
    const link = g("link").split("?")[0];
    if (!/bbc\.(co\.uk|com)\/news\/articles\//.test(link)) continue; // canlı yayın, video ve galeri sayfalarını atla
    const th = it.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    items.push({
      id: link.split("/").pop(), title: g("title"), desc: g("description"), link,
      date: new Date(g("pubDate") || Date.now()).toISOString(), cat,
      img: th ? th[1].replace(/\/standard\/\d+\//, "/standard/800/") : "",
    });
    if (items.length >= 15) break;
  }
  const out = { items };
  MEM.set(key, { t: Date.now(), v: out });
  kvPut(env, ctx, key, JSON.stringify(out), 3600);   // 1 saat (KV yazma hakkı günde 1000)
  return withReady(out, env);
}
// Hangi haberlerin hangi seviyeleri hazır (⚡)? Sadece okuma yapar
const MEM = new Map();
async function withReady(out, env) {
  if (!env.KS) return out;
  const items = await Promise.all(out.items.map(async it => {
    const h = await sha(it.link);
    const rl = (await Promise.all([1, 2, 3].map(async n => (await kvGet(env, "art4:" + h + ":" + n)) ? n : 0))).filter(Boolean);
    return rl.length ? Object.assign({}, it, { rl }) : it;
  }));
  return { items };
}

// Haber sayfasından paragrafları çıkar (HTMLRewriter: hızlı ve az işlemci harcar)
async function articleText(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 KelimeSaati" } });
  qAdd(r.ok ? "bbc_ok" : r.status === 403 ? "bbc_403" : "bbc_x", 1);   // yönetici ekranında BBC erişimi izlensin (davranış değişmez)
  if (!r.ok) {
    qErr("bbc", r.status + " · " + url.replace(/^https:\/\/www\.bbc\.(co\.uk|com)/, "").slice(0, 60));
    throw new HttpError(502, "Haber sayfası açılamadı (" + r.status + ")");
  }
  // Önce BBC'nin metin bloklarını, olmazsa sayfadaki <article> paragraflarını al
  const A = [], B = []; let ca = null, cb = null;
  const rw = new HTMLRewriter()
    .on('[data-component="text-block"] p', { element() { ca = { t: "" }; A.push(ca); }, text(t) { if (ca) ca.t += t.text; } })
    .on('article p', { element() { cb = { t: "" }; B.push(cb); }, text(t) { if (cb) cb.t += t.text; } });
  await rw.transform(r).arrayBuffer();
  const join = arr => arr.map(p => unx(p.t).replace(/\s+/g, " ").trim()).filter(x => x.length > 1).join("\n");
  const ta = join(A), tb = join(B);
  return (ta.length >= 300 ? ta : tb.length > ta.length ? tb : ta).slice(0, 7000);
}

// BBC News kanalında, haber tarihine yakın videoları ara
async function ytCandidates(title, date, env) {
  if (!env.YT_API_KEY) return [];
  try {
    const d = new Date(date || Date.now()), a = new Date(d - 2 * 864e5).toISOString(), b = new Date(+d + 2 * 864e5).toISOString();
    const u = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=6&channelId=UC16niRr50-MSBwiO3YDb3RA"
      + "&publishedAfter=" + a + "&publishedBefore=" + b + "&q=" + encodeURIComponent(title) + "&key=" + env.YT_API_KEY;
    qAdd("yt", 100);
    const r = await fetch(u);
    if (!r.ok) return [];
    const d2 = await r.json();
    return (d2.items || []).map(x => ({ id: x.id && x.id.videoId, title: unx(x.snippet && x.snippet.title), thumb: x.snippet && x.snippet.thumbnails && (x.snippet.thumbnails.high || x.snippet.thumbnails.medium || {}).url })).filter(x => x.id);
  } catch { return []; }
}

// Haber metni (KV'de 2 gün saklanır, her seviye isteğinde sayfa tekrar indirilmesin)
async function srcText(url, h, env, ctx) {
  const k = "txt1:" + h, hit = await kvGet(env, k);
  if (hit) return hit;
  const t = await articleText(url);
  if (t.length >= 200) kvPut(env, ctx, k, t, 2 * 86400);
  return t;
}
const LV_SPEC = {
  1: "about 120 words, very simple English (CEFR A2), short sentences, present/past simple",
  2: "about 190 words, intermediate English (CEFR B1-B2)",
  3: "about 280 words, advanced English (CEFR C1), rich vocabulary, natural journalistic style",
};
const cleanParas = arr => (Array.isArray(arr) ? arr : []).map(p => {
  const en = (Array.isArray(p && p.en) ? p.en : []).map(x => noCJK(x)).filter(Boolean);
  const tr = (Array.isArray(p && p.tr) ? p.tr : []).map(x => noCJK(x));
  return { en, tr: en.map((_, i) => tr[i] || "") };
}).filter(p => p.en.length);

// Tek seviye: metin + zor kelimeler
async function artLevel(n, title, text, env) {
  const prompt = `You are writing a graded news reader for a native Turkish speaker learning English.
Source news story (title: "${String(title || "").slice(0, 200)}"):
"""${text}"""

Retell this story IN YOUR OWN WORDS: ${LV_SPEC[n]}. Do not copy sentences from the source. Keep the facts accurate; do not add facts that are not in the source.
Split it into 2-4 paragraphs. Each paragraph is a list of sentences, with a natural Turkish translation for every sentence (same count, same order).
List 5-7 ENGLISH words or phrases that appear in your English text and may be difficult at this level, with short Turkish meanings (never list Turkish words).
Then write a comprehension quiz about YOUR English text: ${LV_QUIZ[n]}
${QUIZ_RULES}
Return ONLY JSON: {"paras":[{"en":["sentence",...],"tr":["cümle",...]}],"words":[{"w":"word","tr":"anlam"}],"quiz":[{"q":"question","o":["option A","option B","option C","option D"],"a":0,"evidence":"exact sentence from your English text"}]}`;
  const res = await llmJSON(prompt, env, { prefer: "quality", obj: true, temperature: 0.4, hedge: 15000 });
  const paras = cleanParas(res && res.paras);
  if (!paras.length) throw new HttpError(503, "Haber hazırlanamadı, biraz sonra tekrar dene");
  const words = cleanWordsW((Array.isArray(res.words) ? res.words : []).filter(w => w && w.w).map(w => ({ w: String(w.w).trim(), tr: String(w.tr || "").trim() })), paras).slice(0, 8);
  let quiz = validQuiz(res.quiz, paras);
  if (quiz.length < 3) quiz = await quizFor(n, { paras, quiz }, env).catch(() => quiz);
  return { paras, words, quiz };
}

/* ---------- Haber testi: sorular seviyenin KENDİ metninden, kanıtlı ve kontrollü ---------- */
const LV_QUIZ = {
  1: "3 simple, direct questions (who / what / where / when), each under 10 words. Options are short (2-5 words).",
  2: "3 questions about details, reasons and results (why / how / what happened), each 10-16 words. Options are short paraphrased phrases (4-9 words), not copied word-for-word from the text.",
  3: "3 harder questions: one inference question (what the text suggests or what can be concluded), one main-idea or purpose question, and one vocabulary-in-context question about the meaning of a word or phrase used in the text. Questions are 12-20 words. Options are full sentences (7-14 words) that sound similar, but only one is supported by the text.",
};
const QUIZ_RULES = "Rules: every correct answer must be clearly supported by YOUR English text — never ask about names, numbers or facts that are not in your text. The four options must have clearly different meanings (never the same items in a different order, never two options that are both correct). Exactly one option is correct. For every question also give the evidence: the exact sentence copied from your English text that proves the correct answer.";
const normT = s => String(s || "").toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
// Yapay zekâ cevabını tek biçime getir: {q, o:[4], a:0-3, evidence}
function normQ(x) {
  if (!x || typeof x !== "object") return null;
  const q = pickF(x, "q", "question");
  let o = x.o || x.options || x.choices || [];
  if (o && !Array.isArray(o) && typeof o === "object") o = ["A", "B", "C", "D"].map(k => o[k] || o[k.toLowerCase()]).filter(Boolean);
  o = (Array.isArray(o) ? o : []).map(v => String(v || "").trim().replace(/^\(?[A-Da-d]\s*[).:\-–]\s+/, "")).filter(Boolean);
  let a = x.a ?? x.answer ?? x.correct ?? x.correct_index ?? x.answer_index;
  if (typeof a === "string") { const t = a.trim(); a = /^[A-Da-d]\b/.test(t) && !/^\d/.test(t) ? "ABCD".indexOf(t[0].toUpperCase()) : /^\d+$/.test(t) ? +t : o.findIndex(v => normT(v) === normT(t)); }
  return { q, o, a: Number.isInteger(+a) ? +a : -1, evidence: pickF(x, "evidence", "ev", "quote") };
}
function validQuiz(qs, paras, why) {
  const W = why || [];
  const sents = (paras || []).flatMap(p => p.en).map(normT);
  const units = sents.concat(sents.slice(1).map((x, i) => sents[i] + " " + x));   // tek cümle ya da art arda iki cümle
  const full = " " + sents.join(" ") + " ";
  const out = [], seenQ = new Set();
  for (const raw of Array.isArray(qs) ? qs : []) {
    const x = normQ(raw); if (!x) continue;
    const { q, o, a } = x;
    if (!q || o.length !== 4) { W.push("şık sayısı " + o.length); continue; }
    if (!(a >= 0 && a < 4)) { W.push("doğru şık belirsiz"); continue; }
    if (CJK_RE.test(q + o.join(""))) { W.push("yabancı karakter"); continue; }
    const sig = o.map(v => normT(v).split(" ").sort().join(" "));
    if (sig.some(v => !v) || new Set(sig).size !== 4) { W.push("aynı/benzer şık"); continue; }
    const ev = normT(x.evidence);
    const et = ev.split(" ");
    if (ev.length < 12 || !units.some(u => u.includes(ev) || et.filter(t => (" " + u + " ").includes(" " + t + " ")).length / et.length >= 0.75)) { W.push("kanıt metinde yok"); continue; }
    const must = (o[a].match(/\b(\d[\d.,]*|[A-Z][a-z]+(?:[A-Z][a-z]+)?)\b/g) || []).slice(/^[A-Z]/.test(o[a]) ? 1 : 0); // doğru şıktaki sayı ve özel isimler
    if (must.some(m => !full.includes(normT(m)))) { W.push("cevaptaki isim/sayı metinde yok"); continue; }
    const nq = normT(q); if (seenQ.has(nq)) continue; seenQ.add(nq);
    out.push({ q, o, a, evidence: x.evidence });
  }
  return out.slice(0, 3);
}
// Eksik/geçersiz soru varsa sadece soruları yeniden üret (en fazla 2 deneme), geçerlileri koru
async function quizFor(n, L, env, why) {
  let have = validQuiz(L.quiz, L.paras);
  const text = L.paras.map(p => p.en.join(" ")).join("\n\n");
  for (let t = 0; t < 2 && have.length < 3; t++) {
    const prompt = `Here is a short English news text for learners (CEFR level ${n === 1 ? "A2" : n === 2 ? "B1-B2" : "C1"}):
"""${text}"""
Write a comprehension quiz about THIS text only: ${LV_QUIZ[n]}
${QUIZ_RULES}
${have.length ? "Do not repeat these questions: " + have.map(x => x.q).join(" | ") : ""}
Return ONLY JSON: {"quiz":[{"q":"question","o":["option A","option B","option C","option D"],"a":0,"evidence":"exact sentence from the text"}]}`;
    const res = await llmJSON(prompt, env, { prefer: t === 0 ? "quality" : "fast", obj: true, temperature: 0.4, hedge: 10000 });
    const list = res && (res.quiz || res.questions || (Array.isArray(res) ? res : null));
    if (!list) (why || []).push("cevap okunamadı");
    const more = validQuiz(list, L.paras, why).filter(x => !have.some(h => normT(h.q) === normT(x.q)));
    have = have.concat(more).slice(0, 3);
  }
  return have;
}
// { artquiz: { url, lv, paras } } → { quiz, why }
// Uygulama seviye metnini kendisi gönderir (önbellekteki "yok" kaydına takılmamak için);
// sonuç metnin özetiyle önbelleğe alınır, aynı seviyeyi açan diğer kişiler için tekrar üretilmez.
async function articleQuiz(q, env, ctx) {
  const url = String(q.url || "");
  if (!/^https:\/\/www\.bbc\.(co\.uk|com)\/news\//.test(url)) throw new HttpError(400, "Geçersiz haber adresi");
  const n = [1, 2, 3].includes(+q.lv) ? +q.lv : 2;
  let paras = (Array.isArray(q.paras) ? q.paras : []).slice(0, 12).map(p => ({ en: (Array.isArray(p && p.en) ? p.en : []).slice(0, 12).map(x => noCJK(String(x)).slice(0, 400)).filter(Boolean) })).filter(p => p.en.length);
  if (!paras.length) { const hit = await kvGet(env, "art4:" + await sha(url) + ":" + n); if (hit) paras = JSON.parse(hit).paras || []; }
  if (!paras.length) throw new HttpError(404, "Seviye metni bulunamadı");
  const kQ = "aq1:" + await sha(url + "|" + n + "|" + normT(paras.map(p => p.en.join(" ")).join(" ")));
  const hit = await kvGet(env, kQ);
  if (hit) { const qz = validQuiz(JSON.parse(hit), paras); if (qz.length >= 3) return { quiz: qz }; }
  const why = [];
  const quiz = await quizFor(n, { paras, quiz: [] }, env, why);
  if (quiz.length) kvPut(env, ctx, kQ, JSON.stringify(quiz), 30 * 86400);
  return { quiz, why: quiz.length >= 3 ? undefined : [...new Set(why)].slice(0, 6) };
}

// Video eşleştirme (sorular artık her seviyenin kendi metniyle birlikte üretiliyor)
async function artMeta(q, text, env) {
  const vids = await ytCandidates(q.title, q.date, env);
  if (!vids.length) return { quiz: [], video: null };                 // aday yoksa yapay zekâya hiç sorulmaz
  const prompt = `News story (title: "${String(q.title || "").slice(0, 200)}"):
"""${text.slice(0, 3000)}"""
These are YouTube videos from the BBC News channel published near the story date:
${vids.map((v, i) => i + ": " + v.title).join("\n")}
Set "video" to the index of the video that is clearly about THE SAME specific news event, or -1 if none is clearly the same event. Be strict.
Return ONLY JSON: {"video":-1}`;
  const res = await llmJSON(prompt, env, { prefer: "fast", obj: true, temperature: 0.2 }).catch(() => null);
  const vi = parseInt(res && res.video);
  return { quiz: [], video: Number.isInteger(vi) && vi >= 0 && vids[vi] ? vids[vi] : null };
}

// { article: { url, title, date, lv } } → { lv, level, quiz, video }
// Seviye ve sorular aynı anda (paralel) üretilir; her parça ayrı saklanır
async function article(q, env, ctx) {
  const url = String(q.url || "");
  if (!/^https:\/\/www\.bbc\.(co\.uk|com)\/news\//.test(url)) throw new HttpError(400, "Geçersiz haber adresi");
  const n = [1, 2, 3].includes(+q.lv) ? +q.lv : 2;
  const h = await sha(url), kL = "art4:" + h + ":" + n, kM = "art4:" + h + ":m";
  const [hL, hM] = await Promise.all([kvGet(env, kL), kvGet(env, kM)]);
  let level = hL ? JSON.parse(hL) : null, meta = hM ? JSON.parse(hM) : null;
  if (!level || !meta) {
    const text = await srcText(url, h, env, ctx);
    if (text.length < 200) throw new HttpError(422, "Bu haberin metni alınamadı, başka bir haber dene");
    const [L, M] = await Promise.all([
      level ? level : artLevel(n, q.title, text, env),
      meta ? meta : artMeta(q, text, env).catch(() => null),
    ]);
    if (!level) { level = L; kvPut(env, ctx, kL, JSON.stringify(L), 30 * 86400); }
    if (!meta && M) { meta = M; kvPut(env, ctx, kM, JSON.stringify(M), 30 * 86400); }
  }
  return { lv: n, level, quiz: level.quiz || [], video: meta ? meta.video : null };
}

/* ---------- Canlı yazım (metin yazıldıkça uygulamaya akar) ---------- */
// Düz metin biçimi:  EN: cümle / TR: çeviri / --- (paragraf arası) / WORDS: kelime = anlam
const TR_ENX=/[wqx]|ph|th|sh|ck|ee|oo|ou|ea/i,TR_STOP=new Set(['the','and','was','were','with','that','this','from','have','has','his','they','she','you','but','are','very','what','when','where','there','would','could']);
const TR_OKW=new Set(['her','can','son','bin','ben','set','sat','ton','top','bar','dam','tam','kan','pin','din','hat','kim','pas','ara','ama','adam','kale','alt','ilk','bas','yan','ten','tek','ders','gel','koy','van','ana','eve','ole','sen','fan','bal']);
// Türkçe satırda çevrilmeden kalmış İngilizce kelimeleri bulur (ör. "nowhere.", "Ephesus")
function trLeaks(en,tr){
  const enT=new Set((String(en).match(/[A-Za-z]+/g)||[]).map(x=>x.toLowerCase())),out=[];
  for(const w of String(tr).match(/[A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]+/g)||[]){
    const lw=w.toLowerCase();
    if(/[çğıöşüâîûÇĞİÖŞÜ]/.test(w)||lw.length<3)continue;
    if(TR_OKW.has(lw))continue;
    if(TR_STOP.has(lw)||(enT.has(lw)&&(w[0]===lw[0]||TR_ENX.test(lw))))out.push(w);
  }
  return out;
}
// Türkçe satır puanı: çevrilmemiş kelime, alt çizgi (Ayşe_bir_gün), bitişik uzun kelime zinciri
function trBad(en,tr){tr=String(tr||'');return trLeaks(en,tr).length+(/_/.test(tr)?2:0)+(/[^\s_]{28,}/.test(tr)?1:0)+(tr.length>40&&!/[çğıöşüÇĞİÖŞÜ]/.test(tr)?2:0)}
const noCJK = t => String(t || "").replace(/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]+/g, "").replace(/\s{2,}/g, " ").trim();
function parseLines(t) {
  const paras = [], words = [], quiz = [], out = { paras, words, quiz, title: "", emoji: "", used: [] };
  let cur = null, inW = false, inQ = false, cq = null;
  for (let line of String(t).split("\n")) {
    line = line.trim().replace(/^\*\*|\*\*$/g, "");
    if (!line) continue;
    let m;
    if ((m = line.match(/^TITLE:\s*(.*)$/i))) { out.title = m[1]; continue; }
    if ((m = line.match(/^EMOJI:\s*(.*)$/i))) { out.emoji = m[1]; continue; }
    if ((m = line.match(/^USED:\s*(.*)$/i))) { out.used = m[1].split(",").map(x => x.trim()).filter(Boolean); continue; }
    if (/^(?:#+\s*)?QUIZ\b/i.test(line) && !/=/.test(line)) { inQ = true; inW = false; continue; }
    if (inQ) {
      if ((m = line.match(/^(?:(?:CORRECT\s+)?ANSWER|CORRECT)\s*[:\-]\s*\(?([A-Da-d])\b/i))) { if (cq) cq.a = "ABCD".indexOf(m[1].toUpperCase()); continue; }
      if ((m = line.match(/^EVIDENCE\s*[:\-]\s*(.+)$/i))) { if (cq) cq.evidence = m[1].replace(/^["“]|["”]$/g, ""); continue; }
      if ((m = line.match(/^\(?([A-Da-d])\s*[).:\-–]\s+(.+)$/)) && cq) { cq.o["ABCD".indexOf(m[1].toUpperCase())] = m[2]; continue; }
      if ((m = line.match(/^(?:Q(?:uestion)?\s*\d*|\d+)\s*[:.)\-]\s*(.+)$/i))) { cq = { q: m[1], o: [], a: -1, evidence: "" }; quiz.push(cq); continue; }
      continue;
    }
    if (/^WORDS:?$/i.test(line)) { inW = true; continue; }
    if (inW) { if ((m = line.match(/^[-*•]?\s*(.+?)\s*=\s*(.+)$/))) words.push({ w: m[1], tr: m[2] }); continue; }
    if (/^-{3,}$/.test(line) || /^#/.test(line)) { cur = null; continue; }
    if ((m = line.match(/^EN:\s*(.*)$/i))) { if (!cur) { cur = { en: [], tr: [] }; paras.push(cur); } cur.en.push(noCJK(m[1])); cur.tr.push(""); continue; }
    if ((m = line.match(/^TR:\s*(.*)$/i)) && cur && cur.en.length) { cur.tr[cur.en.length - 1] = noCJK(m[1]); continue; }
  }
  out.paras = paras.filter(p => p.en.length);
  return out;
}
function levelToLines(L) {
  return L.paras.map(p => p.en.map((e, i) => "EN: " + e + "\nTR: " + (p.tr[i] || "")).join("\n")).join("\n---\n")
    + "\nWORDS:\n" + (L.words || []).map(w => w.w + " = " + w.tr).join("\n") + "\n"
    + (L.quiz && L.quiz.length ? "QUIZ:\n" + L.quiz.map(x => "Q: " + x.q + "\n" + x.o.map((o, i) => "ABCD"[i] + ") " + o).join("\n") + "\nANSWER: " + "ABCD"[x.a] + "\nEVIDENCE: " + (x.evidence || "")).join("\n") + "\n" : "");
}
const textHead = cors => ({ "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...cors });

// Seviye metni bu kelime sayısının altındaysa yarım kalmış sayılır (uygulamadaki LV_MINW ile aynı)
const MINW = { 1: 35, 2: 50, 3: 70 };
const enWords = paras => (paras || []).reduce((s, p) => s + (p.en || []).join(" ").split(/\s+/).filter(Boolean).length, 0);
async function articleStream(q, env, ctx, cors) {
  const url = String(q.url || "");
  if (!/^https:\/\/www\.bbc\.(co\.uk|com)\/news\//.test(url)) throw new HttpError(400, "Geçersiz haber adresi");
  const n = [1, 2, 3].includes(+q.lv) ? +q.lv : 2;
  const h = await sha(url), kL = "art4:" + h + ":" + n;
  // Önbellekteki seviye yarımsa (yapay zekâ metni yarıda bırakmışsa) ya da istemci "fresh" istediyse yeniden yaz
  const hit = q.fresh ? null : await kvGet(env, kL);
  if (hit) { const c = JSON.parse(hit); if (enWords(c.paras) >= MINW[n]) return new Response(levelToLines(c), { headers: textHead(cors) }); }
  const text = await srcText(url, h, env, ctx);
  if (text.length < 200) throw new HttpError(422, "Bu haberin metni alınamadı, başka bir haber dene");
  const prompt = `You are writing a graded news reader for a native Turkish speaker learning English.
Source news story (title: "${String(q.title || "").slice(0, 200)}"):
"""${text}"""

Retell this story IN YOUR OWN WORDS: ${LV_SPEC[n]}. Do not copy sentences from the source. Keep the facts accurate; do not add facts that are not in the source. Use 2-4 paragraphs.
Write ONLY in this exact plain-text format (no JSON, no markdown, no extra text):
EN: first English sentence
TR: its natural Turkish translation (Turkish only, Latin letters, no other languages; translate EVERY word, never leave an English word in a TR line; use Turkish names of places)
EN: next English sentence
TR: its Turkish translation
---
EN: (a line with --- separates paragraphs)
TR: ...
WORDS:
word = Türkçe anlam
(after WORDS: list 5-7 ENGLISH words or phrases that appear in your English text and may be difficult at this level, one per line, as english word = Türkçe anlam; never list Turkish words)
QUIZ:
Q: question
A) option
B) option
C) option
D) option
ANSWER: the letter of the correct option
EVIDENCE: the exact sentence copied from your English text that proves the answer
(after QUIZ: write a comprehension quiz about YOUR English text in this format: ${LV_QUIZ[n]} ${QUIZ_RULES})`;
  const body = await llmStream(prompt, env, { prefer: "quality", temperature: 0.4, hedge: 8000 }, all => {
    const L = parseLines(all);
    // Yarım kalan metni saklama: yeterince uzun olmalı ve "WORDS" bölümüne ulaşmış olmalı
    if (L.paras.length && enWords(L.paras) >= MINW[n] && L.words.length) kvPut(env, ctx, kL, JSON.stringify({ paras: L.paras, words: cleanWordsW(L.words, L.paras).slice(0, 8), quiz: validQuiz(L.quiz, L.paras) }), 30 * 86400);
  });
  return new Response(body, { headers: textHead(cors) });
}

async function articleMeta(q, env, ctx) {
  const url = String(q.url || "");
  if (!/^https:\/\/www\.bbc\.(co\.uk|com)\/news\//.test(url)) throw new HttpError(400, "Geçersiz haber adresi");
  const h = await sha(url), kM = "art4:" + h + ":m";
  const hit = await kvGet(env, kM);
  if (hit) return JSON.parse(hit);
  const text = await srcText(url, h, env, ctx);
  if (text.length < 200) throw new HttpError(422, "Bu haberin metni alınamadı");
  const M = await artMeta(q, text, env);
  kvPut(env, ctx, kM, JSON.stringify(M), 30 * 86400);
  return M;
}

// Hedef kelimeler: yalnızca doğal ve doğru kullanılabiliyorsa kullanılır, uymayan atlanır (anlamı çarpıtılmaz)
const storyWordsRule = words => words.length
  ? `Use as many of these target words or phrases as fit (inflected forms are fine): ${words.join(", ")}.
Use a target word ONLY if it fits the story naturally, with its standard, correct meaning and in a collocation a native speaker would really use (for example "wage" is only for "wage a war / a campaign", never for time or money; "attrition" means gradual loss or wearing down, never a shortage). If a word does not fit, SKIP it: never twist its meaning and never bend the story just to include it. Words you skip must NOT appear in the list of used words.`
  : "";
async function storyStream(q, env, cors) {
  const level = LEVELS.includes(q.level) ? q.level : "B1";
  const topic = String(q.topic || "an everyday adventure").slice(0, 120);
  const len = q.len === "long" ? 320 : 150;
  const words = (Array.isArray(q.words) ? q.words : []).slice(0, 15).map(w => String(w && w.w || w).slice(0, 40)).filter(Boolean);
  const prompt = `Write an original short story for a native Turkish speaker learning English.
Topic / idea: "${topic}" (may be written in Turkish: understand what it means and write about that in English; never put the Turkish topic word itself into the English text, e.g. topic "Doğa" means nature and is NOT a place name).
CEFR level: ${level}. Length: about ${len} words, 3-6 paragraphs. Use vivid but level-appropriate language and natural dialogue where it fits.
${storyWordsRule(words)}
Write ONLY in this exact plain-text format (no JSON, no markdown, no extra text):
TITLE: English title
EMOJI: one emoji
EN: first English sentence
TR: its natural Turkish translation (Turkish only, Latin letters, no other languages; translate EVERY word, never leave an English word in a TR line; use Turkish names of places, e.g. Ephesus -> Efes; normal spaces between words, never underscores)
EN: next sentence
TR: its Turkish translation
---
(a line with --- separates paragraphs)
USED: comma-separated target words you actually used`;
  const body = await llmStream(prompt, env, { chain: ["gemini", "groq"], hedge: 25000, temperature: 1 }, () => {});
  return new Response(body, { headers: { ...textHead(cors), "X-LLM": body.llm || "" } });
}

// Hikâyede çevrilmeden kalan kelimeleri olan Türkçe satırları yeniden çevirir
async function trFix(q, env) {
  const items = (Array.isArray(q.items) ? q.items : []).slice(0, 20)
    .map(x => ({ en: String(x && x.en || "").slice(0, 400), tr: String(x && x.tr || "").slice(0, 500) })).filter(x => x.en);
  if (!items.length) return { tr: [] };
  const full = !!q.full;
  const prompt = `These Turkish translations of English sentences are faulty (English words left untranslated, misspelled or invented Turkish words, words from other languages, wrong meanings, or underscores instead of spaces).
Rewrite each Turkish translation so it is a complete, correct, natural Turkish translation of its English sentence.
Rules: translate EVERY word into Turkish, no English words may remain; separate words with normal spaces, never underscores (e.g. "nowhere" -> "hiçbir yer", "hitchhike" -> "otostop çekmek", "affectionate" -> "sevecen"); use the Turkish names of places (Ephesus -> Efes, London -> Londra, Athens -> Atina); keep people's names unchanged; Latin letters only.
Return ONLY JSON: {"tr":["translation 1","translation 2",...]} with exactly ${items.length} strings in the same order.
${items.map((x, i) => `${i + 1}. EN: ${x.en}\n   faulty TR: ${x.tr}`).join("\n")}`;
  for (const chain of [["gemini", "groq"]]) {
    try {
      const d = await llmJSON(prompt, env, { chain, hedge: 25000, temperature: 0.2 });
      const a = d && Array.isArray(d.tr) ? d.tr : null;
      if (!a || a.length !== items.length) continue;
      return { tr: a.map((t, i) => {
        t = noCJK(t).trim();
        const nb = trBad(items[i].en, t), ob = trBad(items[i].en, items[i].tr);
        return t && (nb < ob || (full && nb === 0)) ? t : null;
      }) };
    } catch (e) {}
  }
  return { tr: items.map(() => null) };
}

/* ---------- Günün kalıbı ----------
   Her gün (Türkiye saatiyle) bir deyim ya da günlük konuşma kalıbı, iki kişilik sohbet içinde.
   Bir kez üretilir, herkes için KV'de saklanır (idm2: tüm günlerin listesi). İlk 20 kalıp uygulamada hazır gelir (kaliplar.json). */
const IDM_STARTER = ["a piece of cake", "break the ice", "under the weather", "hit the sack", "cost an arm and a leg", "once in a blue moon", "call it a day", "a lot on my plate", "beat around the bush", "the ball is in your court", "no big deal", "I'll say", "It's up to you", "I'm all ears", "That makes sense", "Never mind", "Long time no see", "Fair enough", "Count me in", "Hang in there"];
const trDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(new Date());
async function idiomsGet(q, env, ctx) {
  let all = []; try { all = JSON.parse((await kvGet(env, "idm2")) || "[]"); } catch {}
  const day = trDay();
  const lt = String((await kvGet(env, "idmt")) || "");                 // başarısız denemeyi her istekte tekrarlama (30 dk ara)
  if (!all.some(x => x.day === day) && !(lt.startsWith(day + "|") && Date.now() - +lt.split("|")[1] < 1800e3)) {
    try {
      await ksPut(env, "idmt", day + "|" + Date.now());
      const it = await idiomMake(day, all, env);
      if (it) { all.push(it); await ksPut(env, "idm2", JSON.stringify(all)); }
    } catch {}
  }
  const have = Math.max(0, Math.min(all.length, +((q && q.have) || 0)));
  return { day, n: all.length, items: all.slice(have) };
}
function idiomOk(x, avoid) {
  if (!x || typeof x !== "object") return null;
  const str = v => noCJK(String(v || "")).trim();
  const line = l => Array.isArray(l) && l.length >= 3 ? [+l[0] === 1 ? 1 : 0, str(l[1]), str(l[2]).replace(/_+/g, m => m.length >= 3 ? m : " ")] : null;
  const it = { p: str(x.p), t: x.t === "phrase" ? "phrase" : "idiom", tr: str(x.tr), en: str(x.en),
    n: Array.isArray(x.n) && x.n.length >= 2 ? [str(x.n[0]).slice(0, 20), str(x.n[1]).slice(0, 20)] : ["Emma", "Jack"],
    d: (Array.isArray(x.d) ? x.d : []).map(line).filter(Boolean), q: (Array.isArray(x.q) ? x.q : []).map(line).filter(Boolean) };
  if (!it.p || it.p.length > 60 || !it.tr || !it.en) return null;
  if (avoid.has(it.p.toLowerCase().replace(/[.!?]+$/, ""))) return null;
  if (it.d.length < 3 || it.d.length > 8 || it.q.length < 2 || it.q.length > 3) return null;
  if (it.d.filter(l => /\*[^*]+\*/.test(l[1])).length < 1) return null;               // kalıp sohbette vurgulu geçmeli
  if (it.q.filter(l => l[1].includes("___")).length !== 1) return null;                // soru sohbetinde tek boşluk
  const trAll = [it.tr, ...it.d.map(l => l[2]), ...it.q.map(l => l[2])].join(" ");
  if (!/[çğıöşüÇĞİÖŞÜ]/.test(trAll) || it.d.some(l => !l[1] || !l[2])) return null;    // Türkçe gerçekten Türkçe olmalı
  return it;
}
async function idiomMake(day, all, env) {
  const avoid = new Set([...IDM_STARTER, ...all.map(x => x.p)].map(p => String(p).toLowerCase().replace(/[.!?]+$/, "")));
  const kind = all.length % 2 === 0 ? "idiom (deyim)" : "everyday conversational phrase (günlük konuşma kalıbı, e.g. \"no big deal\", \"I'll say\", \"fair enough\")";
  const prompt = `Pick ONE common, natural English ${kind} that is useful for a Turkish learner at B1-B2 level in everyday conversation.
Do NOT pick any of these (already used): ${[...avoid].slice(-200).join("; ")}.
Return ONLY a JSON object:
{"p":"the phrase exactly as used","t":"${all.length % 2 === 0 ? "idiom" : "phrase"}","tr":"short natural Turkish meaning","en":"short simple English explanation","n":["first name of speaker 1","first name of speaker 2"],
"d":[[0,"English line","natural Turkish translation"],[1,"English line","Turkish translation"], ... 4 to 6 lines in total],
"q":[[0,"English line","Turkish translation"],[1,"English line","Turkish translation"]]}
Rules:
- "d" is a short, natural everyday conversation between the two speakers (0 and 1). The phrase appears exactly once, wrapped in *asterisks* in the English line, and its Turkish equivalent is wrapped in *asterisks* in that line's Turkish translation.
- "q" is a DIFFERENT 2-line mini conversation for a quiz: in exactly one English line the phrase is replaced by ___ (three underscores). In that line's Turkish translation, wrap the Turkish equivalent in *asterisks*. The blank must clearly fit only this phrase.
- Modern, natural English. Turkish must be natural Turkish with correct Turkish letters (ç, ğ, ı, ö, ş, ü). Use common English first names.`;
  for (const chain of [["gemini", "groq"], ["gemini", "groq"]]) {
    try {
      const x = await llmJSON(prompt, env, { chain, hedge: 25000, obj: true, temperature: 0.8 });
      const it = idiomOk(x, avoid);
      if (it) { QE.idm = { t: Date.now(), m: "" }; return Object.assign({ id: "d" + day.replace(/-/g, ""), day }, it); }
      qErr("idm", "Yapay zekânın kalıbı denetimden geçmedi: " + JSON.stringify(x).slice(0, 110));
    } catch (e) { qErr("idm", e.message || "hata"); }
  }
  return null;
}

/* ---------- Videolar (YouTube) ---------- */
function ytRef(ref) {
  let r = String(ref || "").trim();
  const m = r.match(/youtube\.com\/(?:channel\/(UC[\w-]{22})|(@[\w.\-]+)|c\/([\w.\-]+)|user\/([\w.\-]+))/i);
  if (m) r = m[1] || m[2] || m[3] || m[4];
  if (/^UC[\w-]{22}$/.test(r)) return { id: r };
  if (!r.startsWith("@") && /^[\w.\-]+$/.test(r)) r = "@" + r;
  return { handle: r.slice(0, 80) };
}
async function ytGet(path, env) {
  if (!env.YT_API_KEY) throw new HttpError(500, "YouTube anahtarı (YT_API_KEY) tanımlı değil");
  qAdd("yt", path.startsWith("search") ? 100 : 1);
  const r = await fetch("https://www.googleapis.com/youtube/v3/" + path + (path.includes("?") ? "&" : "?") + "key=" + env.YT_API_KEY);
  if (!r.ok) throw new HttpError(r.status === 403 ? 503 : 502, "YouTube cevap vermedi (" + r.status + ")");
  return r.json();
}
async function ytChannel(q, env, ctx) {
  const ref = typeof q === "string" ? q : q.ref;
  const R = ytRef(ref), key = "ych2:" + (R.id || R.handle).toLowerCase();
  const hit = await kvGet(env, key);
  if (hit) return JSON.parse(hit);
  let d = await ytGet("channels?part=snippet&" + (R.id ? "id=" + R.id : "forHandle=" + encodeURIComponent(R.handle)), env);
  let it = d.items && d.items[0];
  if (!it && R.handle) {   // @ad bulunamazsa isimle ara (bir kez, sonuç saklanır)
    const s2 = await ytGet("search?part=snippet&type=channel&maxResults=1&q=" + encodeURIComponent(R.handle.slice(1)), env);
    const cid = s2.items && s2.items[0] && s2.items[0].snippet && s2.items[0].snippet.channelId;
    if (cid) { d = await ytGet("channels?part=snippet&id=" + cid, env); it = d.items && d.items[0]; }
  }
  if (!it) throw new HttpError(404, "Kanal bulunamadı, linki ya da @adını kontrol et");
  const out = { id: it.id, title: unx(it.snippet.title), thumb: ((it.snippet.thumbnails || {}).default || {}).url || "" };
  kvPut(env, ctx, key, JSON.stringify(out), 30 * 86400);
  return out;
}
const isoSec = d => { const m = String(d || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
async function ytVideos(q, env, ctx) {
  const refs = (Array.isArray(q.chs) ? q.chs : []).slice(0, 25);
  const channels = {}, videos = [];
  await Promise.all(refs.map(async ref => {
    try {
      const ch = await ytChannel(ref, env, ctx); channels[ref] = ch;
      const key = "ytv3:" + ch.id; let list = null;
      const hit = await kvGet(env, key);
      if (hit) list = JSON.parse(hit);
      else {
        const pl = await ytGet("playlistItems?part=contentDetails&maxResults=30&playlistId=UU" + ch.id.slice(2), env);
        const ids = (pl.items || []).map(x => x.contentDetails && x.contentDetails.videoId).filter(Boolean);
        list = [];
        if (ids.length) {
          const vd = await ytGet("videos?part=snippet,contentDetails,status,player&maxHeight=720&id=" + ids.join(","), env);
          for (const v of vd.items || []) {
            const dur = isoSec(v.contentDetails && v.contentDetails.duration);
            if (dur < 150 || dur > 1500) continue;                      // 2,5-25 dk arası (Shorts ve çok uzunlar elenir)
            if (v.snippet.liveBroadcastContent && v.snippet.liveBroadcastContent !== "none") continue;
            const th = v.snippet.thumbnails || {};
            list.push({ id: v.id, title: unx(v.snippet.title), thumb: (th.medium || th.high || th.default || {}).url || "", dur, date: v.snippet.publishedAt, emb: v.status ? v.status.embeddable !== false : true,
              vert: !!(v.player && +v.player.embedHeight > +v.player.embedWidth) });   // dikey video (büyük ekranda 9:16)
          }
        }
        kvPut(env, ctx, key, JSON.stringify(list), 24 * 3600);
      }
      for (const v of list) videos.push(Object.assign({ ch: ch.id, ref }, v));
    } catch (e) { channels[ref] = { error: e.message || "hata" }; }
  }));
  return { channels, videos };
}

/* ---------- Hızlı sözlük (okurken kelimeye dokununca) ---------- */
async function gloss(q, env, ctx) {
  const w = String(q.w || "").trim().toLowerCase().replace(/[’']s$/, "").slice(0, 60);
  if (!w) throw new HttpError(400, "Kelime boş");
  const key = "gl1:" + w, hit = await kvGet(env, key);
  if (hit) return JSON.parse(hit);
  let out = null;
  // 1) Google Çeviri (hızlı, yarım saniye civarı)
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 5000);
    const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&dt=bd&dj=1&q=" + encodeURIComponent(w),
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctl.signal }).finally(() => clearTimeout(tm));
    if (r.ok) {
      const d = await r.json();
      const tr = Array.isArray(d.sentences) ? d.sentences.map(x => x.trans || "").join("").trim() : "";
      const alts = [];
      for (const g of (Array.isArray(d.dict) ? d.dict : [])) for (const t of (g.terms || []).slice(0, 3)) if (t && t !== tr && !alts.includes(t)) alts.push(t);
      if (tr) out = { tr, alts: alts.slice(0, 5) };
    }
  } catch {}
  // 2) Olmazsa Gemini (cümledeki anlamıyla, kısa)
  if (!out) {
    const cx = String(q.ctx || "").slice(0, 300);
    const res = await llmJSON(`Give the short Turkish meaning (1-4 words) of the English word "${w}"${cx ? ` as used in: "${cx}"` : ""}. Return ONLY JSON: {"turkish":"Turkish translation (not pronunciation)","alternatives":["other Turkish meaning"]}`, env, { prefer: "fast", obj: true, temperature: 0.2 });
    const tr = res ? pickF(res, "turkish", "tr", "meaning") : "";
    if (!okTr(tr)) throw new HttpError(503, "Anlam bulunamadı");
    out = { tr, alts: (Array.isArray(res.alternatives) ? res.alternatives : Array.isArray(res.alts) ? res.alts : []).map(String).filter(okTr).slice(0, 3), ai: true };
  }
  if (out.ai) { delete out.ai; kvPut(env, ctx, key, JSON.stringify(out), 90 * 86400); } // sadece yapay zekâ cevabını sakla (KV yazma hakkı sınırlı)
  return out;
}

/* ---------- Hikâye ---------- */
async function story(q, env) {
  const level = LEVELS.includes(q.level) ? q.level : "B1";
  const topic = String(q.topic || "an everyday adventure").slice(0, 120);
  const len = q.len === "long" ? 320 : 150;
  const words = (Array.isArray(q.words) ? q.words : []).slice(0, 15).map(w => String(w && w.w || w).slice(0, 40)).filter(Boolean);
  const prompt = `Write an original short story for a native Turkish speaker learning English.
Topic / idea: "${topic}" (may be written in Turkish: understand what it means and write about that in English; never put the Turkish topic word itself into the English text, e.g. topic "Doğa" means nature and is NOT a place name).
CEFR level: ${level}. Length: about ${len} words. Use vivid but level-appropriate language and natural dialogue where it fits.
${storyWordsRule(words)}
Split the story into 3-6 paragraphs. Each paragraph is a list of sentences, with a natural Turkish translation for every sentence (same count, same order).
Return ONLY JSON:
{"title":"English title","emoji":"one emoji","paras":[{"en":["sentence",...],"tr":["cümle",...]}],"used":["target words that you actually used"]}`;
  const res = await llmJSON(prompt, env, { chain: ["gemini", "groq"], hedge: 25000, obj: true, temperature: 1 });
  const paras = (Array.isArray(res && res.paras) ? res.paras : []).map(p => {
    const en = (Array.isArray(p.en) ? p.en : []).map(x => String(x).trim()).filter(Boolean);
    const tr = (Array.isArray(p.tr) ? p.tr : []).map(x => String(x).trim());
    return { en, tr: en.map((_, i) => tr[i] || "") };
  }).filter(p => p.en.length);
  if (!paras.length) throw new HttpError(503, "Hikâye yazılamadı, tekrar dene");
  return { title: String(res.title || "Untitled").slice(0, 80), emoji: String(res.emoji || "📖").slice(0, 4), paras, used: Array.isArray(res.used) ? res.used.map(String) : words };
}

/* ---------- Ses (Gemini TTS) ---------- */
const VOICES = ["Kore", "Aoede", "Charon", "Puck", "Sulafat", "Achird"];
async function tts(q, env, ctx, cors) {
  const text = String(q.text || "").trim().slice(0, 4000);
  if (!text) throw new HttpError(400, "Metin boş");
  const voice = VOICES.includes(q.voice) ? q.voice : "Kore";
  const key = "tts1:" + await sha(voice + "|" + text);
  const head = { "Content-Type": "application/json", ...cors };
  if (env.KS) {
    try { const s = await env.KS.get(key, { type: "stream" }); if (s) return new Response(s, { headers: head }); } catch {}
  }
  if (!env.GKEY) return new Response(JSON.stringify({ error: "Doğal ses için Gemini anahtarı gerekiyor", needKey: true }), { status: 402, headers: head });
  const said = "Read this aloud as a warm, clear audiobook narrator, at a calm pace for English learners:\n\n" + text;
  const models = [...new Set([env.TTS_MODEL, "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-3.8-flash-tts"].filter(Boolean))];
  let last = "";
  for (const model of models) {
    for (const shape of ["old", "new"]) {
      const speechConfig = shape === "old" ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } : { voiceConfig: { voice } };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GKEY },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: said }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig } }),
      }).catch(() => null);
      qGem(env, "tts", r);
      if (r && r.ok) {
        // Cevabı çözmeden olduğu gibi aktar (işlemci sınırına takılmasın); bir kopyasını KV'ye yaz
        if (env.KS) {
          const [a, b] = r.body.tee();
          kvPut(env, ctx, key, b, 30 * 86400);
          return new Response(a, { headers: head });
        }
        return new Response(r.body, { headers: head });
      }
      last = model + ": " + (r ? r.status : "bağlantı");
      if (!r || r.status !== 400) break; // 400 → diğer ayar biçimini dene; 404/429/5xx → sıradaki model
    }
  }
  return new Response(JSON.stringify({ error: "Doğal ses şu an üretilemiyor (" + last + ")", quota: /429/.test(last) }), { status: 503, headers: head });
}


/* =====================================================================
   Yapay zekâ: Gemini + Groq + Workers AI, sırayla ve "bekleme sigortası" ile
   prefer: "fast"    → Groq → Gemini → Workers AI   (kelime kartı, kelime grubu)
   prefer: "quality" → Gemini → Groq → Workers AI   (haber, hikâye)
   Bir servis hata verirse beklemeden sıradakine geçilir; hedge ms içinde
   cevap/ilk kelime gelmezse sıradaki de başlatılır, hangisi önce gelirse o kullanılır.
   ===================================================================== */
const WAI_MODEL = env => env.WAI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const GEM_DEF = ["gemini-flash-latest", "gemini-flash-lite-latest"];
/* Kullanılabilir modeller Google/Groq'tan otomatik öğrenilir (günde bir), böylece kaldırılan bir model (404) uygulamayı bozmaz. */
const MODELS = { gem: null, gemT: 0, groq: null, groqT: 0 };
async function GEM_MODELS(env) {
  if (env.GEMINI_MODEL) return [...new Set([env.GEMINI_MODEL, ...GEM_DEF])];
  if (MODELS.gem && Date.now() - MODELS.gemT < 6 * 3600e3) return MODELS.gem;
  let list = null;
  try { const c = await kvGet(env, "gml1"); if (c) { const v = JSON.parse(c); if (Date.now() - v.t < 24 * 3600e3) list = v.m; } } catch {}
  if (!list && env.GKEY) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": env.GKEY } });
      if (r.ok) {
        const names = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => String(m.name).replace(/^models\//, ""));
        const has = n => names.includes(n);
        const ver = n => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
        const pick = re => names.filter(n => re.test(n) && !/preview|exp|tts|image|live|audio|thinking/i.test(n)).sort((a, b) => ver(b) - ver(a))[0];
        list = [...new Set([has("gemini-flash-latest") ? "gemini-flash-latest" : null, pick(/^gemini-[\d.]+-flash$/), has("gemini-flash-lite-latest") ? "gemini-flash-lite-latest" : null, pick(/^gemini-[\d.]+-flash-lite$/)].filter(Boolean))];
        if (list.length) ksPut(env, "gml1", JSON.stringify({ t: Date.now(), m: list })).catch(() => {}); else list = null;
      }
    } catch {}
  }
  MODELS.gem = list || GEM_DEF; MODELS.gemT = Date.now();
  return MODELS.gem;
}
const GROQ_PREF = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "moonshotai/kimi-k2-instruct-0905", "moonshotai/kimi-k2-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct", "qwen/qwen3-32b"];
async function GROQ_MODELS(env) {
  if (env.GROQ_MODEL) return [env.GROQ_MODEL];
  if (MODELS.groq && Date.now() - MODELS.groqT < 6 * 3600e3) return MODELS.groq;
  let list = null;
  try { const c = await kvGet(env, "grm1"); if (c) { const v = JSON.parse(c); if (Date.now() - v.t < 24 * 3600e3) list = v.m; } } catch {}
  if (!list && env.GROQ_API_KEY) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: "Bearer " + env.GROQ_API_KEY } });
      if (r.ok) {
        const ids = ((await r.json()).data || []).map(m => m.id);
        list = GROQ_PREF.filter(m => ids.includes(m)).slice(0, 2);
        if (list.length) ksPut(env, "grm1", JSON.stringify({ t: Date.now(), m: list })).catch(() => {}); else list = null;
      }
    } catch {}
  }
  MODELS.groq = list || GROQ_PREF.slice(0, 2); MODELS.groqT = Date.now();
  return MODELS.groq;
}
/* Düşünme ayarı: yeni Gemini modelleri "düşünme kapalı"yı (bütçe 0) reddedebiliyor; o zaman en kısa düşünmeyle dene.
   Her model için çalışan ayar hatırlanır, her istekte 400 yenmez. */
const THINK = [{ thinkingBudget: 0 }, { thinkingLevel: "minimal" }, { thinkingLevel: "low" }, null];
const GEMCFG = {};
/* Son hatalar (Kota durumu ekranında görünür) */
const QE = {};
function qErr(k, m) { QE[k] = { t: Date.now(), m: String(m || "").replace(/\s+/g, " ").slice(0, 600) }; }

function chainFor(o, env) {
  // Gece hazırlığı sadece Gemini kullanır (Groq hakkı gün içindeki hikâyelere kalsın)
  const all = env.PREFETCH ? ["gemini"] : o.chain ? o.chain : o.prefer === "fast" ? ["groq", "gemini", "wai"] : ["gemini", "groq", "wai"];
  return all.filter(p => p === "gemini" ? !!env.GKEY : env.OWNKEY ? false : p === "groq" ? !!env.GROQ_API_KEY : !!env.AI);
}
function needKeyErr(env) {
  const e = new HttpError(402, env.OWNKEY ? "Bu özellik için Gemini anahtarı gerekiyor" : "Yapay zekâ ayarlı değil (GEMINI_API_KEY)");
  e.needKey = !!env.OWNKEY; return e;
}
// Kendi anahtarı olmayan (aile dışı) kullanıcı yapay zekâ kullanamaz
function aiAllowed(env) { if (env.OWNKEY && !env.GKEY) throw needKeyErr(env); }

const soft = (name, msg) => Object.assign(new Error(name + ": " + msg), { soft: true });

// --- tek seferlik (akışsız) cevaplar ---
async function gemCall(model, prompt, env, o, stream, errs) {
  let i = GEMCFG[model] || 0, last = "";
  for (; i < THINK.length; i++) {
    const gc = Object.assign({ temperature: o.temperature ?? 0.9 }, o.json && !stream ? { responseMimeType: "application/json" } : {}, THINK[i] ? { thinkingConfig: THINK[i] } : {});
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GKEY },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gc }),
    }).catch(e => { last = "bağlantı: " + (e && e.message || ""); return null; });
    qGem(env, "gem", r);
    if (r && r.ok) { GEMCFG[model] = i; return r; }
    const st = r ? r.status : 0, det = r ? (await r.text().catch(() => "")).slice(0, 300) : last;
    let msg = det; try { msg = JSON.parse(det).error.message || det; } catch {}
    last = model + ": " + (st || "") + " " + msg;
    if (st === 429 && /PerDay|per day/i.test(det)) QD.e429d_gem = Date.now();   // günlük kota doldu
    if (st === 400 && !/API key|API_KEY/i.test(det)) continue;            // bu düşünme ayarı desteklenmiyor: sıradakini dene
    if (st === 400 || st === 401 || st === 403) {
      if (/API key|API_KEY|permission/i.test(det) || st !== 400) {
        qErr("gem", [...errs, last].join(" | "));
        if (env.OWNKEY) { const e = new HttpError(402, "Gemini anahtarın geçersiz görünüyor, Ayarlar'dan kontrol et"); e.needKey = true; e.hard = true; throw e; }
        throw soft("gemini", "anahtar hatası " + st);
      }
    }
    break;                                                               // 404 / 429 / 5xx: sıradaki modele
  }
  errs.push(last.slice(0, 140));
  return null;
}
async function gemText(prompt, env, o) {
  const errs = [];
  for (const model of await GEM_MODELS(env)) {
    const r = await gemCall(model, prompt, env, o, false, errs);
    if (!r) continue;
    const d = await r.json().catch(() => ({}));
    const t = ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join("");
    if (t) return t;
    errs.push(model + ": boş cevap");
  }
  if (/\b404\b/.test(errs.join(" "))) MODELS.gemT = 0;                // model kaldırılmış olabilir: listeyi yenile
  qErr("gem", errs.join(" | ")); throw soft("gemini", errs.join(" | ") || "hata");
}
async function groqText(prompt, env, o) {
  let last = "";
  for (const model of await GROQ_MODELS(env)) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.GROQ_API_KEY },
      body: JSON.stringify(Object.assign({ model, messages: [{ role: "user", content: prompt }], temperature: Math.min(o.temperature ?? 0.9, 1.2), max_tokens: 4096 },
        o.json && o.obj ? { response_format: { type: "json_object" } } : {})),
    }).catch(() => null);
    qGroq(r);
    if (r && r.ok) { const d = await r.json().catch(() => ({})); const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content; if (t) return t; }
    last = (last ? last + " | " : "") + model + ": " + (r ? r.status : "bağlantı");
  }
  if (/\b404\b/.test(last)) MODELS.groqT = 0;
  qErr("groq", last); throw soft("groq", last);
}
async function waiText(prompt, env, o) {
  try {
    qAdd("wai", 1); const d = await env.AI.run(WAI_MODEL(env), { messages: [{ role: "user", content: prompt }], max_tokens: 4096, temperature: Math.min(o.temperature ?? 0.9, 1) });
    const t = d && (typeof d.response === "string" ? d.response : d.response ? JSON.stringify(d.response) : "");
    if (t) return t;
  } catch (e) { qErr("wai", e.message); throw soft("wai", e.message || "hata"); }
  throw soft("wai", "boş");
}
const TEXT = { gemini: gemText, groq: groqText, wai: waiText };

function hedgeRace(chain, runOne, hedge) {
  return new Promise((resolve, reject) => {
    let i = 0, running = 0, done = false, timer = null; const errs = [];
    const next = () => {
      if (done) return;
      if (i >= chain.length) { if (!running) reject(new HttpError(503, "Yapay zekâ şu an yoğun, biraz sonra tekrar dene (" + errs.join(", ") + ")")); return; }
      const name = chain[i++]; running++;
      clearTimeout(timer); timer = setTimeout(next, hedge);
      runOne(name).then(v => {
        running--;
        if (done) { if (v && v.cancel) v.cancel(); return; }
        done = true; clearTimeout(timer); resolve(v);
      }, e => {
        running--; errs.push(e.message);
        if (done) return;
        if (e.hard) { done = true; clearTimeout(timer); return reject(e); }
        next();
      });
    };
    next();
  });
}
async function llmText(prompt, env, o) {
  aiAllowed(env);
  const chain = chainFor(o, env);
  if (!chain.length) throw needKeyErr(env);
  return hedgeRace(chain, name => TEXT[name](prompt, env, o), o.hedge || 4000);
}
function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const t = String(text || "").replace(/^```(?:json)?|```$/gm, "");
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}
async function llmJSON(prompt, env, o) {
  return parseJSON(await llmText(prompt, env, Object.assign({ json: true }, o)));
}

// --- akışlı cevaplar (metin yazıldıkça) ---
function sseMap(body, pick) {
  const dec = new TextDecoder(), enc = new TextEncoder(); let buf = "";
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") continue;
        try { const t = pick(JSON.parse(raw)); if (t) ctl.enqueue(enc.encode(t)); } catch {}
      }
    },
  }));
}
async function gemStream(prompt, env, o) {
  const errs = [];
  for (const model of await GEM_MODELS(env)) {
    const r = await gemCall(model, prompt, env, o, true, errs);
    if (r) return sseMap(r.body, d => ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || []).filter(p => !p.thought).map(p => p.text || "").join(""));
  }
  if (/\b404\b/.test(errs.join(" "))) MODELS.gemT = 0;
  qErr("gem", errs.join(" | ")); throw soft("gemini", errs.join(" | ") || "hata");
}
async function groqStream(prompt, env, o) {
  let last = "";
  for (const model of await GROQ_MODELS(env)) {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.GROQ_API_KEY },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: Math.min(o.temperature ?? 0.9, 1.2), max_tokens: 4096, stream: true }),
    }).catch(() => null);
    qGroq(r);
    if (r && r.ok) return sseMap(r.body, d => d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content || "");
    last = (last ? last + " | " : "") + model + ": " + (r ? r.status : "bağlantı");
  }
  if (/\b404\b/.test(last)) MODELS.groqT = 0;
  qErr("groq", last); throw soft("groq", last);
}
async function waiStream(prompt, env, o) {
  try {
    qAdd("wai", 1); const s = await env.AI.run(WAI_MODEL(env), { messages: [{ role: "user", content: prompt }], max_tokens: 4096, temperature: Math.min(o.temperature ?? 0.9, 1), stream: true });
    return sseMap(s, d => typeof d.response === "string" ? d.response : "");
  } catch (e) { throw soft("wai", e.message || "hata"); }
}
const STREAM = { gemini: gemStream, groq: groqStream, wai: waiStream };

// İlk kelime gelene kadar bekler (sigorta burada çalışır), sonra akışın tamamını uygulamaya aktarır
async function llmStream(prompt, env, o, onDone) {
  aiAllowed(env);
  const chain = chainFor(o, env);
  if (!chain.length) throw needKeyErr(env);
  const win = await hedgeRace(chain, async name => {
    const rd = (await STREAM[name](prompt, env, o)).getReader();
    const first = await rd.read();
    if (first.done) throw soft(name, "boş cevap");
    return { rd, first: first.value, name, cancel: () => rd.cancel().catch(() => {}) };
  }, o.hedge || 4000);
  const dec = new TextDecoder(); let all = dec.decode(win.first, { stream: true });
  const out = new ReadableStream({
    start(ctl) { ctl.enqueue(win.first); },
    async pull(ctl) {
      try {
        const { done, value } = await win.rd.read();
        if (done) { try { onDone(all); } catch {} ctl.close(); return; }
        all += dec.decode(value, { stream: true }); ctl.enqueue(value);
      } catch (e) { ctl.error(e); }
    },
    cancel() { win.rd.cancel().catch(() => {}); },
  });
  out.llm = win.name;   // hangi model yazdı (hikâyede çeviri kalitesi için istemciye bildirilir)
  return out;
}

/* ---------- Kimlik: Firebase giriş jetonunu doğrula ---------- */
let JWKS = null, JWKS_T = 0;
async function fbKeys() {
  if (JWKS && Date.now() - JWKS_T < 3600e3) return JWKS;
  const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
  const d = await r.json(); JWKS = d.keys || []; JWKS_T = Date.now(); return JWKS;
}
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function verifyFb(tok, env) {
  const proj = env.FIREBASE_PROJECT || "kelime-saati";
  const parts = String(tok || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts, td = new TextDecoder();
  let H, P; try { H = JSON.parse(td.decode(b64u(h))); P = JSON.parse(td.decode(b64u(p))); } catch { return null; }
  const now = Date.now() / 1000;
  if (H.alg !== "RS256" || P.aud !== proj || P.iss !== "https://securetoken.google.com/" + proj || !(P.exp > now) || !(P.iat < now + 300) || !P.sub) return null;
  let jwk = (await fbKeys()).find(k => k.kid === H.kid);
  if (!jwk) { JWKS = null; jwk = (await fbKeys()).find(k => k.kid === H.kid); }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p));
  return ok ? { uid: P.sub, email: String(P.email || "").toLowerCase() } : null;
}

/* ---------- Aile listesi (yönetici ekler / çıkarır) ---------- */
const adminEmail = env => String(env.ADMIN_EMAIL || "admin@example.com").toLowerCase();
let FAM = null, FAM_T = 0;
async function famRaw(env) {
  if (FAM && Date.now() - FAM_T < 60000) return FAM;
  const h = await kvGet(env, "fam1");
  FAM = h ? JSON.parse(h) : []; FAM_T = Date.now(); return FAM;
}
async function famOp(q, env, ctx) {
  if (!env.ADMIN) throw new HttpError(403, "Bu işlem sadece yönetici içindir");
  let list = (await famRaw(env)).slice();
  const em = String(q.email || "").trim().toLowerCase();
  if (q.op === "add" || q.op === "del") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new HttpError(400, "Geçerli bir e-posta yaz");
    if (q.op === "add" && !list.some(x => x === em || (x && x.e === em))) list.push({ e: em, t: Date.now() });
    if (q.op === "del") list = list.filter(x => (x.e || x) !== em);
    if (!env.KS) throw new HttpError(500, "KV bağlı değil");
    await ksPut(env, "fam1", JSON.stringify(list));
    FAM = list; FAM_T = Date.now();
  }
  return { admin: adminEmail(env), list };
}
// Kayıtlar {e, t} biçiminde; üyelik kontrolü için sadece e-postalar
async function famList(env) { return (await famRaw(env)).map(x => x.e || x); }

/* ---------- Toplu sözlük: metindeki tüm kelimeler tek seferde ---------- */
async function gtxBatch(words) {
  const map = {};
  const chunks = []; for (let i = 0; i < words.length; i += 120) chunks.push(words.slice(i, i + 120));
  await Promise.all(chunks.map(async ch => {
    try {
      const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=tr&dt=t&dj=1", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "Mozilla/5.0" },
        body: "q=" + encodeURIComponent(ch.join("\n")),
      });
      if (!r.ok) return;
      const d = await r.json();
      const src = [], dst = [];
      for (const x of d.sentences || []) { if (x.orig != null) { src.push(x.orig); dst.push(x.trans || ""); } }
      // Satır satır eşleştir (bazen bir cümle birden fazla satırı içerir)
      const O = src.join("").split("\n"), T = dst.join("").split("\n");
      if (O.length === T.length) O.forEach((o, i) => { const k = o.trim().toLowerCase(), v = (T[i] || "").trim(); if (k && v && v.toLowerCase() !== k) map[k] = v; });
    } catch {}
  }));
  return map;
}
async function glossBatch(q, env, ctx) {
  const words = [...new Set((Array.isArray(q.words) ? q.words : []).map(w => String(w).toLowerCase().trim()).filter(w => /^[a-z][a-z'’\-]{1,30}$/.test(w)))].slice(0, 600);
  const key = q.key ? "gls1:" + await sha(String(q.key)) : null;
  if (key) { const h = await kvGet(env, key); if (h) return { map: JSON.parse(h) }; }
  const map = words.length ? await gtxBatch(words) : {};
  // Google cevap vermezse (ör. Cloudflare'i engellerse) hızlı yapay zekâyla tek seferde çevir
  const miss = words.filter(w => !map[w]);
  if (miss.length && miss.length > words.length * 0.3) {
    try {
      const res = await llmJSON(`For each English word below, give its most common short Turkish meaning (1-3 words).
Words: ${miss.slice(0, 150).join(", ")}
Return ONLY a JSON object mapping each word exactly as given to its Turkish meaning, e.g. {"distant":"uzak"}.`, env, { prefer: "fast", obj: true, temperature: 0.2, hedge: 6000 });
      if (res && typeof res === "object") for (const [k, v] of Object.entries(res)) { const kk = String(k).toLowerCase().trim(); if (v && miss.includes(kk) && okTr(v)) map[kk] = String(v).trim(); }
    } catch {}
  }
  if (key && q.keep && Object.keys(map).length > 10) kvPut(env, ctx, key, JSON.stringify(map), 30 * 86400);
  return { map };
}

/* ---------- Gece hazırlığı (Cron) ---------- */
// Her çalışmada en fazla 3 iş yapar; her gece 03:00–04:00 arası 2 dakikada bir çalışınca
// Seçili kategorilerden 5 haber × (3 seviye + sorular + sözlük) tamamlanır. Hazır olanı tekrar yapmaz.
// Gece hazırlanacak haberler: yöneticinin seçtiği kategorilerden sırayla en güncel PF_N haber (aynı haber iki kez sayılmaz)
const PF_N = 5;
async function pfItems(env, ctx) {
  let cats = []; try { cats = JSON.parse((await kvGet(env, "pfc1")) || "[]"); } catch {}
  cats = (Array.isArray(cats) ? cats : []).filter(c => FEEDS[c]); if (!cats.length) cats = Object.keys(FEEDS);
  const lists = [];
  for (const c of cats) { try { lists.push((await news({ cat: c }, env, ctx)).items || []); } catch {} }
  const out = [], seen = new Set();
  for (let i = 0; out.length < PF_N && i < 20; i++)
    for (const L of lists) { const it = L[i]; if (it && out.length < PF_N && !seen.has(it.link)) { seen.add(it.link); out.push(it); } }
  return out;
}
async function pfCats(q, env) {
  if (!env.ADMIN) throw new HttpError(403, "Sadece yönetici");
  const cats = (Array.isArray(q) ? q : []).map(String).filter(c => FEEDS[c]);
  const v = JSON.stringify(cats), old = await kvGet(env, "pfc1");
  if (cats.length && v !== old) await ksPut(env, "pfc1", v);
  return { ok: true, cats };
}
async function prefetch(env0, ctx) {
  if (!env0.KS) return;
  try { await prefetchRun(env0, ctx); } finally { qMaybeFlush(env0, ctx); }
}
async function prefetchRun(env0, ctx) {
  const env = Object.assign(Object.create(env0), { GKEY: env0.GEMINI_API_KEY || "", FAM: true, ADMIN: false, OWNKEY: false, PREFETCH: true });
  // Gemini'nin GÜNLÜK kotası bu Google gününde (Pasifik saati) dolduysa gece hazırlığı durur; kalan hak hikâyelere
  let qs = {}; try { qs = JSON.parse((await kvGet(env0, "qst1")) || "{}"); } catch {}
  const dfull = Math.max(qs.e429d_gem || 0, QD.e429d_gem || 0), ptOf = t => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(t));
  if (dfull && ptOf(dfull) === ptOf(Date.now())) return;
  try { await idiomsGet({ have: 1e9 }, env, ctx); } catch {}          // günün kalıbı (gece hazır olsun)
  let budget = 3;
  {
    const items = await pfItems(env, ctx);
    for (const it of items) {
      const h = await sha(it.link);
      const has = async k => !!(await kvGet(env, k));
      let text = null;
      const src = async () => text || (text = await srcText(it.link, h, env, ctx));
      for (const n of [2, 1, 3]) {
        const ex = await kvGet(env, "art4:" + h + ":" + n);
        if (ex) {
          const L0 = JSON.parse(ex);
          if (validQuiz(L0.quiz, L0.paras).length >= 3 || (L0.qt && Date.now() - L0.qt < 20 * 3600e3)) continue;   // hazır ya da bu gece zaten denendi
          if (budget-- <= 0) return;
          try { const qz = await quizFor(n, L0, env); if (qz.length) L0.quiz = qz; } catch {}
          L0.qt = Date.now();
          await ksPut(env, "art4:" + h + ":" + n, JSON.stringify(L0), { expirationTtl: 30 * 86400 }).catch(() => {});
          continue;
        }
        if (budget-- <= 0) return;
        try { const t = await src(); if (t.length < 200) break; const L = await artLevel(n, it.title, t, env); await ksPut(env, "art4:" + h + ":" + n, JSON.stringify(L), { expirationTtl: 30 * 86400 }); } catch {}
      }
      if (!(await has("art4:" + h + ":m"))) {
        if (budget-- <= 0) return;
        try { const t = await src(); if (t.length >= 200) { const M = await artMeta({ title: it.title, date: it.date }, t, env); await ksPut(env, "art4:" + h + ":m", JSON.stringify(M), { expirationTtl: 30 * 86400 }); } } catch {}
      }
      const gk = "gls1:" + await sha(it.link);
      if (!(await has(gk))) {
        const lv = (await Promise.all([1, 2, 3].map(n => kvGet(env, "art4:" + h + ":" + n)))).filter(Boolean).map(x => JSON.parse(x));
        if (lv.length === 3) {
          if (budget-- <= 0) return;
          const words = lv.flatMap(L => L.paras.flatMap(p => p.en.join(" ").toLowerCase().match(/[a-z][a-z'’\-]+/g) || []));
          try { const map = await gtxBatch([...new Set(words)].slice(0, 600)); if (Object.keys(map).length) await ksPut(env, gk, JSON.stringify(map), { expirationTtl: 30 * 86400 }); } catch {}
        }
      }
    }
  }
}

/* ---------- Kota sayaçları (sadece yönetici görür) ----------
   Sayılar hafızada birikir, saatte bir tek kayıtla (KV "qst1") saklanır.
   Gemini ve YouTube günü Kaliforniya gece yarısında (TR 10:00/11:00), Cloudflare günü UTC'de başlar. */
const QD = {}; let QLAST = Date.now(), QFLUSHING = false;
const dayIn = tz => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const QPT = new Set(["gem", "tts", "yt"]);
function qAdd(k, n) { QD[k] = (QD[k] || 0) + (n || 1); }
function qGem(env, k, r) {
  if (env.OWNKEY) return;                         // kullanıcının kendi anahtarı: senin kotan değil
  if (r && r.ok) qAdd(k, 1);
  else if (r && r.status === 429) { QD["e429_" + k] = Date.now(); }
}
function ksPut(env, key, val, opt) { qAdd("kvw", 1); return env.KS.put(key, val, opt); }
let GROQ_RL = null;
function qGroq(r) {
  qAdd("groq", 1);
  if (!r) return;
  const h = n => r.headers.get(n);
  if (h("x-ratelimit-limit-requests")) GROQ_RL = { limit: +h("x-ratelimit-limit-requests"), left: +h("x-ratelimit-remaining-requests"), reset: h("x-ratelimit-reset-requests") || "", t: Date.now() };
  if (r.status === 429) QD.e429_groq = Date.now();
}
async function qFlush(env) {
  if (!env.KS || QFLUSHING) return null;
  QFLUSHING = true;
  try {
    let st = {}; try { st = JSON.parse((await env.KS.get("qst1")) || "{}"); } catch {}
    const pt = dayIn("America/Los_Angeles"), utc = dayIn("UTC");
    if (!st.pt || st.pt.d !== pt) st.pt = { d: pt };
    if (!st.utc || st.utc.d !== utc) st.utc = { d: utc };
    const delta = Object.assign({}, QD); for (const k in QD) delete QD[k];
    for (const [k, v] of Object.entries(delta)) {
      if (k.startsWith("e429")) { st[k] = Math.max(st[k] || 0, v); continue; }
      const b = QPT.has(k) ? st.pt : st.utc; b[k] = (b[k] || 0) + v;
    }
    if (GROQ_RL) st.groqRL = GROQ_RL;
    st.err = Object.assign({}, st.err || {}, QE);
    st.saved = Date.now();
    st.utc.kvw = (st.utc.kvw || 0) + 1;            // bu kaydın kendisi de bir yazma
    await env.KS.put("qst1", JSON.stringify(st));
    QLAST = Date.now();
    return st;
  } finally { QFLUSHING = false; }
}
function qMaybeFlush(env, ctx) {
  if (Date.now() - QLAST < 3600e3 || (!Object.keys(QD).length && !Object.keys(QE).length)) return;
  QLAST = Date.now();
  const p = qFlush(env).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}
// Yönetici denemesi: aday haber kaynaklarının RSS'i ve bir haber sayfası Worker'dan (Cloudflare) açılıyor mu? Sadece okur, hiçbir şey kaydetmez.
const PROBE_SRC = [
  ["NPR", "https://feeds.npr.org/1001/rss.xml"],
  ["ABC Australia", "https://www.abc.net.au/news/feed/2942460/rss.xml"],
  ["CBC", "https://www.cbc.ca/webfeed/rss/rss-topstories"],
  ["Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"],
  ["UN News", "https://news.un.org/feed/subscribe/en/news/all/rss.xml"],
];
async function probeSources() {
  const H = { headers: { "User-Agent": "KelimeSaati/1.0" } };
  return Promise.all(PROBE_SRC.map(async ([n, u]) => {
    const o = { n, rss: 0, art: 0, chars: 0, link: "" };
    try {
      const r = await fetch(u, Object.assign({ signal: AbortSignal.timeout(12000) }, H)); o.rss = r.status;
      if (!r.ok) return o;
      const links = [...(await r.text()).matchAll(/<item>[\s\S]*?<link>([\s\S]*?)<\/link>/g)].map(m => unx(m[1]).split("?")[0]).filter(l => /^https?:\/\//.test(l) && !/\/video\/|\/livestream|\/podcast/i.test(l));
      o.link = links[0] || "";
      if (!o.link) return o;
      const a = await fetch(o.link, Object.assign({ signal: AbortSignal.timeout(12000) }, H)); o.art = a.status;
      if (!a.ok) return o;
      const P = []; let c = null;
      await new HTMLRewriter().on("article p", { element() { c = { t: "" }; P.push(c); }, text(t) { if (c) c.t += t.text; } }).transform(a).arrayBuffer();
      o.chars = P.map(p => unx(p.t).replace(/\s+/g, " ").trim()).filter(x => x.length > 1).join("\n").length;
    } catch (e) { o.err = String(e.message || e).slice(0, 80); }
    return o;
  }));
}
async function quotaInfo(q, env, ctx) {
  if (!env.ADMIN) throw new HttpError(403, "Bu bilgi sadece yönetici içindir");
  if (q && q.probe) return { probe: await probeSources() };
  if (q && q.now && env.GROQ_API_KEY) {           // Groq'un kesin kalan sayısı için küçük bir istek
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.GROQ_API_KEY },
      body: JSON.stringify({ model: (await GROQ_MODELS(env))[0], messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    }).catch(() => null);
    qGroq(r);
  }
  let st = null;
  if (q && q.now) st = await qFlush(env);
  if (!st) { try { st = JSON.parse((await kvGet(env, "qst1")) || "{}"); } catch { st = {}; } }
  // Bu gece hazırlanan haberler (seçili kategorilerden 5)
  let total = 0, ready = 0;
  try {
    {
      const items = await pfItems(env, ctx);
      for (const it of items) { total++; const h = await sha(it.link); if (await kvGet(env, "art4:" + h + ":m") && await kvGet(env, "art4:" + h + ":3")) ready++; }
    }
  } catch {}
  const pt = dayIn("America/Los_Angeles"), utc = dayIn("UTC");
  const P = st.pt && st.pt.d === pt ? st.pt : {}, U = st.utc && st.utc.d === utc ? st.utc : {};
  const live = Object.assign({}, QD);               // henüz kaydedilmemiş olanlar da görünsün
  const v = k => (QPT.has(k) ? (P[k] || 0) : (U[k] || 0)) + (live[k] || 0);
  return {
    saved: st.saved || 0, now: Date.now(),
    groq: { used: v("groq"), rl: GROQ_RL || st.groqRL || null, e429: Math.max(st.e429_groq || 0, live.e429_groq || 0) },
    gem: { used: v("gem"), limit: +(env.GEM_RPD || 250), e429: Math.max(st.e429_gem || 0, live.e429_gem || 0) },
    tts: { used: v("tts"), limit: +(env.TTS_RPD || 15), e429: Math.max(st.e429_tts || 0, live.e429_tts || 0) },
    wai: { used: v("wai") },
    err: Object.assign({}, st.err || {}, QE),
    kvw: { used: v("kvw"), limit: 1000 },
    yt: { used: v("yt"), limit: 10000 },
    night: { ready, total },
    bbc: { ok: v("bbc_ok"), e403: v("bbc_403"), other: v("bbc_x") },
    hasGroq: !!env.GROQ_API_KEY, hasAI: !!env.AI,
  };
}

/* ---------- Kelime verisi doğrulama ----------
   Bazı modeller "tr" alanını okunuşla (ör. grɪp) doldurabiliyor ya da Türkçe kelime listeleyebiliyor.
   Kaydedilmeden önce her kelime kontrol edilir; bozuk olanlar elenir ya da daha iyi modelle yeniden istenir. */
const IPA_RE = /[ɪəʃʒθðŋæʊɔɑʌːˈˌɜɒɐɛɹɾʔɡ]/;
const CJK_RE = /[⺀-鿿가-힯豈-﫿＀-￯]/;
function okTr(tr) {
  const t = String(tr || "").trim();
  return !!t && t.length <= 80 && !IPA_RE.test(t) && !CJK_RE.test(t) && !/^\/.*\/$/.test(t) && /[a-zA-ZçğıöşüÇĞİÖŞÜ]/.test(t);
}
function pickF(x, ...ks) { for (const k of ks) if (x && x[k] != null && String(x[k]).trim()) return String(x[k]).trim(); return ""; }
function normWord(x) {
  return {
    w: pickF(x, "word", "w", "english"), tr: pickF(x, "turkish", "tr", "meaning"),
    ipa: pickF(x, "ipa", "pronunciation").replace(/^\/|\/$/g, ""), pos: pickF(x, "pos", "part_of_speech"),
    def: pickF(x, "definition", "def"), ex: pickF(x, "example", "ex"), lvl: pickF(x, "level", "lvl"), t: pickF(x, "category", "t"),
  };
}
function okWord(x) {
  return !!x && /^[a-z][a-z'’\- ]{0,40}$/i.test(x.w) && okTr(x.tr) && !!x.def && !!x.ex && !CJK_RE.test(x.def + x.ex);
}
// Zor kelimeler: sadece İngilizce metinde gerçekten geçen İngilizce kelimeler
function cleanWordsW(ws, paras) {
  const txt = " " + (paras || []).flatMap(p => p.en).join(" ").toLowerCase().replace(/[^a-z'’\- ]+/g, " ") + " ";
  const seen = new Set();
  return (ws || []).filter(w => {
    const x = String(w && w.w || "").toLowerCase().trim();
    if (!x || !/^[a-z][a-z'’\- ]*$/.test(x) || seen.has(x) || !okTr(w.tr)) return false;
    seen.add(x);
    const first = x.split(" ")[0], st = first.length > 4 ? first.replace(/(e|y|s)$/, "") : first;
    return txt.includes(" " + st);
  });
}
