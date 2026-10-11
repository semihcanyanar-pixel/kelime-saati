// Kelime Saati — Scriptable widget
// Ana ekran (küçük / orta / büyük) ve kilit ekranı (dikdörtgen / satır / yuvarlak) widget'larını destekler.
// Widget'ın "Parameter" alanına  B1,B2|travel,work  gibi bir satır yazarsan aşağıdaki ayarları geçersiz kılar.
// Konu anahtarları: daily, work, travel, emotions, tech, health, society, academic

// KS_CONFIG_START
const CONFIG = {
  url: "https://KULLANICI_ADIN.github.io/kelime-saati/words.json",
  appUrl: "https://KULLANICI_ADIN.github.io/kelime-saati/",
  levels: ["A2", "B1", "B2", "C1"],
  topics: []
};
// KS_CONFIG_END

const GOLD = new Color("#d9b46a");
const WHITE = new Color("#eef1f8");
const MUTED = new Color("#9aa6c4");

function parseParam(p) {
  if (!p) return null;
  const [l, t] = String(p).split("|");
  const levels = (l || "").split(",").map(s => s.trim().toUpperCase()).filter(s => /^(A2|B1|B2|C1)$/.test(s));
  const topics = (t || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return { levels, topics };
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

// Uygulamadaki "Saatin kelimesi" ile aynı algoritma
function pickWord(words, opts) {
  let pool = words.filter(w => opts.levels.includes(w.lvl) && (!opts.topics.length || opts.topics.includes(w.t)));
  if (!pool.length) pool = words;
  const n = pool.length;
  const h = Math.floor(Date.now() / 3600000);
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
  w.refreshAfterDate = new Date(Math.ceil(Date.now() / 3600000) * 3600000 + 10000);
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
  g.colors = [new Color("#1b2a55"), new Color("#0b1228")];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(14, 16, 14, 16);
  const small = family === "small";

  const top = w.addStack();
  top.centerAlignContent();
  addText(top, "✦ SAATİN KELİMESİ", Font.semiboldSystemFont(9), GOLD);
  top.addSpacer();
  addText(top, word.lvl || "", Font.boldSystemFont(9), GOLD);

  w.addSpacer();
  addText(w, word.w, new Font("Georgia-Bold", small ? 24 : 30), WHITE, { scale: 0.45 });
  addText(w, word.tr, new Font("Georgia", small ? 15 : 18), GOLD, { scale: 0.6, lines: small ? 2 : 1 });

  if (!small) {
    w.addSpacer(4);
    if (word.ipa) addText(w, "/" + word.ipa + "/", Font.systemFont(11), MUTED);
    w.addSpacer(6);
    if (family === "large") {
      addText(w, `(${word.pos}) ${word.def}`, Font.systemFont(13), WHITE, { lines: 3, scale: 0.8 });
      w.addSpacer(6);
    }
    addText(w, word.ex, Font.italicSystemFont(12), WHITE, { lines: 2, scale: 0.8, opacity: 0.85 });
  }
  w.addSpacer();
  return w;
}

const opts = parseParam(args.widgetParameter) || { levels: CONFIG.levels, topics: CONFIG.topics };
if (!opts.levels.length) opts.levels = CONFIG.levels;
const words = await loadWords();
const word = words.length ? pickWord(words, opts) : null;
const family = config.widgetFamily || "medium";
const widget = build(word, family);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
