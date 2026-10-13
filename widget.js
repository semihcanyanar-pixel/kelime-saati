// Kelime Saati — Scriptable widget
// Ana ekran (küçük / orta / büyük) ve kilit ekranı (dikdörtgen / satır / yuvarlak) widget'larını destekler.
// Widget'ın "Parameter" alanına  B1,B2|travel,work|30  gibi bir satır yazarsan aşağıdaki ayarları geçersiz kılar.
// Son kısım kelimenin kaç dakikada bir değişeceği: 15, 30 ya da 60.
// Konu: kategori adı (ör. Havacılık) ya da anahtarı (daily, work, travel, emotions, tech, health, society, academic)
// pub: uygulamadaki AI kelimeleri ve kategoriler (uygulama otomatik doldurur)

// KS_CONFIG_START
const CONFIG = {
  url: "https://KULLANICI_ADIN.github.io/kelime-saati/words.json",
  appUrl: "https://KULLANICI_ADIN.github.io/kelime-saati/",
  levels: ["A2", "B1", "B2", "C1"],
  topics: [],
  interval: 60,
  pub: ""
};
// KS_CONFIG_END

const GOLD = new Color("#E8793F");   // vurgu (turuncu)
const WHITE = new Color("#26221F");  // ana metin
const MUTED = new Color("#8C8077");

function parseParam(p) {
  if (!p) return null;
  const [l, t, m] = String(p).split("|");
  const levels = (l || "").split(",").map(s => s.trim().toUpperCase()).filter(s => /^(A2|B1|B2|C1)$/.test(s));
  const topics = (t || "").split(",").map(s => s.trim()).filter(Boolean);
  const iv = parseInt(m);
  return { levels, topics, interval: [15, 30, 60].includes(iv) ? iv : null };
}

async function loadWords() {
  const fm = FileManager.local();
  const path = fm.joinPath(fm.documentsDirectory(), "kelime-saati-words.json");
  const fresh = fm.fileExists(path) && (Date.now() - fm.modificationDate(path).getTime() < 6 * 3600 * 1000);
  if (!fresh) {
    try {
      const r = new Request(CONFIG.url);
      r.timeoutInterval = 8;
      const data = await r.loadJSON();
      if (Array.isArray(data) && data.length) {
        fm.writeString(path, JSON.stringify(data));
        return data;
      }
    } catch (e) {}
  }
  if (fm.fileExists(path)) {
    try { return JSON.parse(fm.readString(path)); } catch (e) {}
  }
  return [];
}

// Türkçe karakterleri sadeleştir: "Havacılık" = "havacilik"
function norm(s) {
  return String(s || "").toLocaleLowerCase("tr").replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c").replace(/\s+/g, " ").trim();
}

// Uygulamanın yayınladığı AI kelimeleri ve kategori ayarları (Firebase)
async function loadPub() {
  if (!CONFIG.pub) return null;
  const fm = FileManager.local();
  const path = fm.joinPath(fm.documentsDirectory(), "kelime-saati-pub.json");
  try {
    const r = new Request(CONFIG.pub);
    r.timeoutInterval = 8;
    const d = await r.loadJSON();
    const s = d && d.fields && d.fields.s && d.fields.s.stringValue;
    if (s) { fm.writeString(path, s); return JSON.parse(s); }
  } catch (e) {}
  if (fm.fileExists(path)) { try { return JSON.parse(fm.readString(path)); } catch (e) {} }
  return null;
}

// Hazır liste + AI kelimeleri, her kelimenin güncel kategorisiyle (uygulamadaki sırayla aynı)
function mergeWords(base, pub) {
  const map = (pub && pub.map) || {};
  const out = base.map(w => Object.assign({}, w, { c: map[w.w.toLowerCase()] || w.t }));
  const have = new Set(out.map(w => w.w.toLowerCase()));
  for (const w of (pub && pub.custom) || []) if (!have.has(w.w.toLowerCase())) out.push(w);
  return out;
}

// Parametredeki konuları kategori anahtarına çevir (ad ya da anahtar yazılabilir)
function topicKeys(topics, pub) {
  const cats = (pub && pub.cats) || [];
  return topics.map(t => {
    const hit = cats.find(c => norm(c.n) === norm(t) || norm(c.k) === norm(t));
    return hit ? hit.k : t.toLowerCase();
  });
}

// Uygulamadaki "Saatin kelimesi" ile aynı algoritma
function pickWord(words, opts) {
  let pool = words.filter(w => opts.levels.includes(w.lvl) && (!opts.topics.length || opts.topics.includes(w.c || w.t)));
  if (!pool.length) pool = words;
  const n = pool.length;
  const h = Math.floor(Date.now() / (SLOT_MIN * 60000));
  return pool[(((h * 7919 + 13) % n) + n) % n];
}

function addText(stack, text, font, color, opts = {}) {
  const t = stack.addText(text);
  t.font = font;
  if (color) t.textColor = color;
  t.lineLimit = opts.lines || 1;
  t.minimumScaleFactor = opts.scale || 0.6;
  if (opts.opacity) t.textOpacity = opts.opacity;
  return t;
}

function build(word, family) {
  const w = new ListWidget();
  const ms = SLOT_MIN * 60000;
  w.refreshAfterDate = new Date(Math.ceil(Date.now() / ms) * ms + 10000);
  if (word) w.url = CONFIG.appUrl + "?w=" + encodeURIComponent(word.w);

  if (!word) {
    addText(w, "Kelimeler yüklenemedi", Font.systemFont(12), WHITE, { lines: 2 });
    return w;
  }

  if (family === "accessoryInline") {
    w.addText(`${word.w} · ${word.tr}`);
    return w;
  }

  if (family === "accessoryCircular") {
    w.addAccessoryWidgetBackground = true;
    const s = w.addStack();
    s.layoutVertically();
    s.centerAlignContent();
    const a = addText(s, word.w, Font.boldSystemFont(13), null, { scale: 0.4 });
    a.centerAlignText();
    return w;
  }

  if (family === "accessoryRectangular") {
    addText(w, word.w, Font.boldSystemFont(16), null, { scale: 0.6 });
    addText(w, word.tr, Font.systemFont(13), null, { scale: 0.7 });
    if (word.ipa) addText(w, "/" + word.ipa + "/", Font.systemFont(11), null, { opacity: 0.7 });
    return w;
  }

  // Ana ekran
  const g = new LinearGradient();
  g.colors = [new Color("#FFF8F1"), new Color("#F9E4D2")];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 16, 14, 16);
  const small = family === "small";

  const top = w.addStack();
  top.centerAlignContent();
  addText(top, SLOT_MIN === 60 ? "⏰ SAATİN KELİMESİ" : `⏰ ${SLOT_MIN} DK KELİMESİ`, Font.heavySystemFont(9), GOLD);
  top.addSpacer();
  addText(top, word.lvl || "", Font.boldSystemFont(9), GOLD);

  w.addSpacer();
  addText(w, word.w, Font.heavySystemFont(small ? 24 : 30), WHITE, { scale: 0.45 });
  addText(w, word.tr, Font.semiboldSystemFont(small ? 15 : 18), GOLD, { scale: 0.6, lines: small ? 2 : 1 });

  if (!small) {
    w.addSpacer(4);
    if (word.ipa) addText(w, "/" + word.ipa + "/", Font.systemFont(11), MUTED);
    w.addSpacer(6);
    if (family === "large") {
      addText(w, `(${word.pos}) ${word.def}`, Font.systemFont(13), WHITE, { lines: 3, scale: 0.8 });
      w.addSpacer(6);
    }
    addText(w, word.ex, Font.systemFont(12), MUTED, { lines: 2, scale: 0.8 });
  }
  w.addSpacer();
  return w;
}

const opts = parseParam(args.widgetParameter) || { levels: CONFIG.levels, topics: CONFIG.topics, interval: null };
if (!opts.levels.length) opts.levels = CONFIG.levels;
const SLOT_MIN = opts.interval || ([15, 30, 60].includes(CONFIG.interval) ? CONFIG.interval : 60);
const pub = await loadPub();
const words = mergeWords(await loadWords(), pub);
opts.topics = topicKeys(opts.topics, pub);
const word = words.length ? pickWord(words, opts) : null;
const family = config.widgetFamily || "medium";
const widget = build(word, family);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
