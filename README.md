# Kelime Saati

Saat başı değişen İngilizce kelime kartları, konu/seviye kategorileri, alıştırma ve iPhone ana ekran + kilit ekranı widget'ı.

## Dosyalar
| Dosya | Nereye |
|---|---|
| index.html, words.json, widget.js, manifest.json, sw.js, icon-180/192/512.png | GitHub repo (GitHub Pages) |
| worker.js | Cloudflare Worker (AI kelime üretimi) |

## 1. Uygulama (GitHub Pages)
1. `kelime-saati` adında repo aç, yukarıdaki dosyaları yükle.
2. Settings → Pages → Branch: `main` / root → Save.
3. iPhone'da Safari ile `https://KULLANICI_ADIN.github.io/kelime-saati/` aç → Paylaş → **Ana Ekrana Ekle**.

## 2. Widget (Scriptable)
1. App Store'dan **Scriptable** indir.
2. Uygulamada **Widget** sekmesi → **Widget kodunu kopyala** (adresler ve seviyeler otomatik doldurulur).
3. Scriptable → `+` → yapıştır → adı `Kelime Saati`.
4. Ana ekran: basılı tut → `+` → Scriptable → boyut seç → widget'a dokun → Script: Kelime Saati.
5. Kilit ekranı: basılı tut → Özelleştir → Kilit Ekranı → Scriptable (dikdörtgen/satır) → Script: Kelime Saati.
6. İstersen widget'ın **Parameter** alanına `B1,B2|travel,work` gibi bir satır yaz; o widget sadece bu seviye/konulardan kelime gösterir.

Konu anahtarları: `daily, work, travel, emotions, tech, health, society, academic`

## 3. AI ile kelime üretme (Cloudflare Worker)
1. https://aistudio.google.com → **Get API key** (ücretsiz).
2. Cloudflare → Workers & Pages → Create → Worker → adı `kelime-saati-ai` → `worker.js` içeriğini yapıştır → Deploy.
3. Worker → Settings → Variables and Secrets:
   - `GEMINI_API_KEY` (Secret) = anahtarın
   - `ALLOWED_ORIGIN` (Text, önerilir) = `https://KULLANICI_ADIN.github.io`
   - `GEMINI_MODEL` (isteğe bağlı, varsayılan `gemini-flash-latest`) — model adı değişirse buradan güncellenir
4. Uygulamada ⚙️ → Worker adresi → yapıştır. Konu + seviye seçip **Kelime üret**.

AI kelimeleri telefonda saklanır, "AI kelimelerim" grubunda ve alıştırmada çıkar; widget yalnızca `words.json` içindeki kelimeleri kullanır.

## Kelime eklemek
`words.json` içine aynı formatta satır ekle:
```json
{"w":"forgo","tr":"vazgeçmek","ipa":"fɔːrˈɡoʊ","pos":"v.","def":"To give up something you would like to have.","ex":"We forgo dessert on weekdays.","lvl":"C1","t":"daily"}
```
`lvl`: A2 / B1 / B2 / C1 — `t`: konu anahtarı. Widget en geç 6 saatte bir listeyi yeniler.
