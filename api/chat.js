// api/chat.js — Türkiye Tarım Veritabanı Chatbot v3 (Veri + Danışmanlık Router)
// Mimari: Soru -> LLM (tip + alan çıkarımı: JSON) -> [veri] JS+SQL  |  [danismanlik] bilgi JSON / grounded LLM
// İki tablo: kds (il, 2014-2025)  |  kds_ilce (ilçe + örtüaltı, 2024-2025)
export const config = { runtime: 'nodejs', maxDuration: 30 };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ===================== CONFIG ===================== **/
const DB_FILE    = 'tarimdb.sqlite';         // public/ içinde
const BILGI_FILE = 'tarim_bilgi.json';       // [YENİ] public/ içinde — danışmanlık bilgi tabanı
const T_IL    = 'kds';                       // il düzeyi, 2014-2025
const T_ILCE  = 'kds_ilce';                  // ilçe düzeyi, 2024-2025 (örtüaltı dahil)
const MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEBUG   = true;

const ALLOWED_ORIGINS = [
  'https://tarim.emomonsdijital.com',        // asıl çağıran (WordPress)
  'https://tarimprojesi.vercel.app',         // doğrudan vercel
  'http://localhost:3000'                    // geliştirme
];

/** ===================== TÜRKÇE-SAFE NORMALİZASYON ===================== **/
// SQLite LOWER() Türkçe İ/I'yı çeviremez; tüm eşleştirmeyi JS'te yapıyoruz.
function trLower(s) {
  return String(s)
    .replace(/İ/g, 'i').replace(/I/g, 'ı').replace(/Ş/g, 'ş')
    .replace(/Ğ/g, 'ğ').replace(/Ü/g, 'ü').replace(/Ö/g, 'ö').replace(/Ç/g, 'ç')
    .toLowerCase();
}
function norm(s) {
  return trLower(s).replace(/[,.\/]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** ===================== DB YÜKLEME + WHITELIST (cold start'ta 1 kez) ===================== **/
let DB = null, WL = null;   // WL = whitelist (iller, ilçeler, ürünler)

async function getDB() {
  if (DB) return DB;
  const SQL = await initSqlJs({
    locateFile: (f) => path.join(process.cwd(), 'node_modules/sql.js/dist', f)
  });
  const dbPath = path.join(process.cwd(), 'public', DB_FILE);
  if (!fs.existsSync(dbPath)) throw new Error('Veritabanı dosyası bulunamadı: ' + dbPath);
  DB = new SQL.Database(fs.readFileSync(dbPath));
  return DB;
}

function queryAll(db, sql) {
  const out = [];
  const stmt = db.prepare(sql);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// İl / ilçe / ürün whitelist'ini DB'den kur — uydurma isim imkânsız olur.
function buildWhitelist(db) {
  if (WL) return WL;
  const iller = queryAll(db, `SELECT DISTINCT "İl" il FROM ${T_IL}`).map(r => r.il);
  const ilceler = queryAll(db, `SELECT DISTINCT "İlçe" ilce, "İl" il FROM ${T_ILCE}`);
  const urunIl = queryAll(db, `SELECT DISTINCT "Ürün" u FROM ${T_IL}`).map(r => r.u);
  const urunIlce = queryAll(db, `SELECT DISTINCT "Ürün" u FROM ${T_ILCE}`).map(r => r.u);

  const ilByNorm = {};   iller.forEach(i => ilByNorm[norm(i)] = i);
  const ilceByNorm = {}; ilceler.forEach(r => { (ilceByNorm[norm(r.ilce)] ||= []).push(r.il); });
  const urunByNorm = {}; [...new Set([...urunIl, ...urunIlce])].forEach(u => urunByNorm[norm(u)] = u);

  WL = { iller, ilByNorm, ilceByNorm, urunByNorm,
         urunIlSet: new Set(urunIl), urunIlceSet: new Set(urunIlce) };
  return WL;
}

/** ===================== [YENİ] DANIŞMANLIK BİLGİ TABANI ===================== **/
// public/tarim_bilgi.json'u cold start'ta bir kez yükle, bellekte tut. Dosya yoksa -> hep LLM fallback.
let BILGI = null;
function loadBilgi() {
  if (BILGI) return BILGI;
  try {
    const p = path.join(process.cwd(), 'public', BILGI_FILE);
    BILGI = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    if (DEBUG) console.warn('tarim_bilgi.json yüklenemedi, LLM fallback kullanılacak:', e.message);
    BILGI = {};
  }
  return BILGI;
}

// Soruyu bilgi tabanındaki konularla eşleştir: en çok anahtar kelime tutan konu kazanır.
function bestBilgi(question) {
  const b = loadBilgi();
  const nq = norm(question);
  let best = null, bestScore = 0;
  for (const key in b) {
    const t = b[key];
    let score = 0;
    for (const kw of (t.anahtar_kelimeler || [])) if (nq.includes(norm(kw))) score++;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore >= 1 ? best : null;   // en az 1 anahtar kelime tutmalı
}

// Güvenlik-kritik konularda (hastalık/zararlı) UI'ya standart reçete uyarısı ekle.
const RECETE_UYARI = '\n\n⚠️ İlaç adı ve doz için ruhsatlı ürünler ve reçete sistemi gerekir; il/ilçe tarım müdürlüğü ziraat mühendisinize danışın.';

// Danışmanlık LLM fallback'i — somut ilaç/doz vermez, veri için NeoBi panele yönlendirir.
const ADVISORY_SYS = `Sen Türkiye tarımına hâkim bir ziraat danışmanısın. Türkçe yaz, sade ve uygulanabilir ol.
KURALLAR:
- Cevap kısa ve pratik olsun (en fazla ~200 kelime), çiftçinin doğrudan uygulayabileceği netlikte.
- Hastalık/zararlı/ilaç konularında ASLA somut ilaç adı, etken madde veya doz verme.
  Bunun yerine kültürel/önleyici (IPM) tedbirleri yaz ve "ruhsatlı ilaç ve doz için il/ilçe tarım müdürlüğü ziraat mühendisi ve reçete sistemi" diye yönlendir.
- Bölgesel/güncel istatistik UYDURMA; istatistik gerekiyorsa "TÜİK verisine NeoBi panelinden bakılabilir" de.
- Abartılı vaat yok, mütevazı ve doğru ol.
- Markdown KULLANMA (** , ## gibi işaretler yok). Düz metin yaz; gerekirse satır başında "-" ile maddele.`;

// Markdown artığı temizle — baloncuk düz metin gösteriyor (** ## kalmasın).
function plain(s) {
  return String(s)
    .replace(/\*\*(.*?)\*\*/g, '$1')   // **kalın** -> kalın
    .replace(/\*\*/g, '')               // tek kalan **
    .replace(/^#{1,6}\s*/gm, '')        // başlık #
    .trim();
}

async function answerAdvisory(question) {
  const hit = bestBilgi(question);
  if (hit) {   // hazır cevap — LLM maliyeti yok
    let a = plain(hit.cevap);
    if (hit.guvenlik) a += RECETE_UYARI;
    return { answer: a, source: 'bilgi', konu: hit.konu };
  }
  // uzun kuyruk -> grounded LLM
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: ADVISORY_SYS }, { role: 'user', content: question }],
    temperature: 0.3, max_tokens: 500
  });
  return { answer: plain(resp.choices[0].message.content || ''), source: 'llm' };
}

/** ===================== ÜRÜN ALIAS TABLOSU (küratörlü) ===================== **/
// Genel aile terimi -> kesin ürün listesi. Yanlış pozitifler (Yer Elması, Kara Buğday...) dışarıda.
const ALIAS = {
  'elma':    ['Elma Amasya','Elma Golden','Elma Granny Smith','Elma Starking','Diğer Elmalar'],
  'domates': ['Domates Sofralık','Domates Salçalık'],
  'buğday':  ['Durum Buğdayı','Buğday Durum Buğdayı Hariç'],
  'üzüm':    ['Sofralık Üzüm Çekirdekli','Sofralık Üzüm Çekirdeksiz','Kurutmalık Üzüm Çekirdekli','Kurutmalık Üzüm Çekirdeksiz','Şaraplık Üzümler'],
  'biber':   ['Biber Dolmalık','Biber Salçalık Kapya','Biber Sivri','Biber Kuru İşlenmemiş','Biber Çarliston'],
  'patates': ['Patates Tatlı Patates Hariç'],
  'mısır':   ['Mısır'],
  'fasulye': ['Fasulye Kuru','Fasulye Taze'],
  'soğan':   ['Soğan Kuru','Soğan Taze'],
  'arpa':    ['Arpa Diğer','Arpa Biralık'],
  'zeytin':  ['Sofralık Zeytinler'],   // yağlık adı kısalmış olabilir; fallback yakalar
  'incir':   ['İncir Yaş'],
  // Halk adı ≠ TÜİK adı olanlar
  'salatalık': ['Hıyar Sofralık','Hıyar Turşuluk'],
  'hıyar':     ['Hıyar Sofralık','Hıyar Turşuluk'],
  'pirinç':    ['Çeltik'],
  'antepfıstığı': ['Şam Fıstığı Antep Fıstığı'],
  'antep fıstığı':['Şam Fıstığı Antep Fıstığı'],
  'kolza':     ['Kanola Veya Kolza Tohumu'],
  'kanola':    ['Kanola Veya Kolza Tohumu'],
  // Çok varyantlı narenciye — fallback yerine net liste
  'mandalina': ['Mandalina Diğer','Mandalina Klemantin','Mandalina Satsuma','Mandalina King'],
  'portakal':  ['Portakal Washington','Portakal Yafa','Diğer Portakallar']
};
// Fallback substring eşleşmesinde GENEL terim için asla katılmayacaklar:
const HARIC = new Set([
  'yer elması','trabzon hurması cennet elması','frenk üzümü','kara buğday','frenk inciri hint mısır inciri',
  'tatlı patates','kuşdili bitkisi biberiye'
].map(norm));

// Grup terimleri: "sebze/meyve/tahıl/örtüaltı" ürün değil GRUP -> "Ürün Grubu" ile filtrelenir
const GROUPS = { 'sebze':'Sebze','meyve':'Meyve','tahıl':'Tahıl','tahil':'Tahıl',
  'örtüaltı':'Örtüaltı','ortualti':'Örtüaltı','sera':'Örtüaltı','tahıllar':'Tahıl' };
function resolveGrup(term) { return term ? (GROUPS[norm(term)] || null) : null; }

// Kullanıcı terimini -> kesin ürün adları listesi (o tabloda var olanlarla sınırlı)
function resolveUrun(term, tabloSet) {
  if (!term) return [];
  const n = norm(term);

  // 1) Tam eşleşme (spesifik varyete: "elma golden", "durum buğdayı", "sofralık üzüm çekirdekli")
  if (WL.urunByNorm[n] && tabloSet.has(WL.urunByNorm[n])) return [WL.urunByNorm[n]];

  // 2) Alias (genel aile)
  if (ALIAS[n]) return ALIAS[n].filter(u => tabloSet.has(u));

  // 3) Fallback: substring eşleşmesi, yanlış pozitifler + artık-kategoriler hariç
  const artik = /hariç|sınıflandırılmamış|familyası/;   // "Frenk İnciri Hariç", "Başka Yerde..." vb.
  const hit = Object.entries(WL.urunByNorm)
    .filter(([k, v]) => k.includes(n) && !HARIC.has(k) && !artik.test(k) && tabloSet.has(v))
    .map(([, v]) => v);
  return [...new Set(hit)];
}

// İl çözümle (typo toleranslı: tam -> normalize -> ilk 4 harf)
function resolveIl(term) {
  if (!term) return null;
  const n = norm(term);
  if (WL.ilByNorm[n]) return WL.ilByNorm[n];
  const pref = Object.keys(WL.ilByNorm).find(k => k.startsWith(n.slice(0, 4)));
  return pref ? WL.ilByNorm[pref] : null;
}
function resolveIlce(term) {
  if (!term) return null;
  const n = norm(term);
  if (WL.ilceByNorm[n]) return { ilce: Object.keys(WL.ilceByNorm).find(k => k === n) ? term : term, raw: n };
  return WL.ilceByNorm[n] ? n : (Object.keys(WL.ilceByNorm).find(k => k.startsWith(n.slice(0, 4))) || null);
}

/** ===================== SQL ŞABLONLARI ===================== **/
function inList(arr) { return arr.map(u => `'${u.replace(/'/g, "''")}'`).join(','); }

function buildSQL(p) {
  const { il, ilce, urunler, grup, yil, yilStart, yilEnd, intent } = p;
  const tablo = ilce ? T_ILCE : T_IL;
  const ilceFiltre = ilce ? ` AND "İlçe"='${ilce.replace(/'/g, "''")}'` : '';
  const ilFiltre = il ? ` AND "İl"='${il.replace(/'/g, "''")}'` : '';
  // Grup sorgusu ("sebze","meyve","tahıl") -> "Ürün Grubu"; aksi halde ürün IN listesi
  const urunFiltre = grup ? ` AND "Ürün Grubu"='${grup.replace(/'/g, "''")}'`
    : (urunler && urunler.length ? ` AND "Ürün" IN (${inList(urunler)})` : '');

  // 1) SIRALAMA: "X ili Y üretiminde kaçıncı" / "en çok Y üreten il" -> CTE + ROW_NUMBER
  if (intent === 'siralama') {
    const base = `SELECT "İl" il, SUM("Üretim") tpl FROM ${T_IL}
      WHERE "Yıl"=${yil}${urunFiltre} GROUP BY "İl"`;
    const cte = `WITH s AS (${base}),
      r AS (SELECT il, tpl, ROW_NUMBER() OVER (ORDER BY tpl DESC) sira FROM s)`;
    if (il) return `${cte} SELECT il, tpl, sira FROM r WHERE il='${il.replace(/'/g, "''")}'`;
    return `${cte} SELECT il, tpl, sira FROM r ORDER BY sira LIMIT 5`;   // "en çok"
  }

  // 1b) URUN_TOP: "bir il/ilçede en çok üretilen/ekilen N ürün" -> ürünleri sırala
  // metrik: üretim (ton) veya alan (dekar). ortalti filtresi de uygulanır.
  if (intent === 'urun_top') {
    const metrik = p.metrik === 'alan' ? 'SUM("Alan")' : 'SUM("Üretim")';
    const limit = p.limit && p.limit > 0 && p.limit <= 20 ? p.limit : 5;
    return `SELECT "Ürün" urun, ${metrik} deger, SUM("Alan") alan, SUM("Üretim") uretim
      FROM ${tablo}
      WHERE "Yıl"=${yil}${ilFiltre}${ilceFiltre}${urunFiltre}
      GROUP BY "Ürün" HAVING deger > 0
      ORDER BY deger DESC LIMIT ${limit}`;
  }

  // 1c) ILCE_DAGILIM: "bir ürünün il içindeki ilçelere dağılımı" -> her ilçe ayrı satır
  // Her zaman ilçe tablosundan; il filtresi + ürün filtresi zorunlu.
  if (intent === 'ilce_dagilim') {
    const metrik = p.metrik === 'alan' ? 'SUM("Alan")' : 'SUM("Üretim")';
    return `SELECT "İlçe" ilce, ${metrik} deger, SUM("Alan") alan, SUM("Üretim") uretim,
        CASE WHEN SUM("Alan")>0 THEN ROUND(CAST(SUM("Üretim") AS FLOAT)/SUM("Alan")*1000) ELSE 0 END verim
      FROM ${T_ILCE}
      WHERE "Yıl"=${yil}${ilFiltre}${urunFiltre}
      GROUP BY "İlçe" HAVING deger > 0
      ORDER BY deger DESC`;
  }

  // 1d) VERIM: verimlilik (kg/dekar) sıralaması.
  // ürün VAR + il YOK: TÜM Türkiye ilçeleri arası verim (kds_ilce, 81 il mevcut)
  // ürün VAR + il VAR: o ilin ilçeleri (kds_ilce)
  // ürün YOK + il VAR: o ilin ürünleri
  // ürün YOK + il YOK: Türkiye geneli ürünler
  if (intent === 'verim') {
    const verimExpr = `CASE WHEN SUM("Alan")>0 THEN ROUND(CAST(SUM("Üretim") AS FLOAT)/SUM("Alan")*1000) ELSE 0 END`;
    const urunVar = grup || (urunler && urunler.length);

    if (urunVar) {
      // Ürün var -> ilçe bazlı verim (il varsa o il, yoksa tüm Türkiye)
      return `SELECT "İlçe" ilce, "İl" il, ${verimExpr} verim, SUM("Üretim") uretim, SUM("Alan") alan
        FROM ${T_ILCE}
        WHERE "Yıl"=${yil}${ilFiltre}${urunFiltre}
        GROUP BY "İlçe", "İl" HAVING SUM("Alan") > 100
        ORDER BY verim DESC LIMIT 10`;
    }
    // Ürün yok -> ürünleri verime göre sırala (il varsa o il, yoksa Türkiye)
    return `SELECT "Ürün" urun, ${verimExpr} verim, SUM("Üretim") uretim, SUM("Alan") alan
      FROM ${tablo}
      WHERE "Yıl"=${yil}${ilFiltre}${ilceFiltre}
      GROUP BY "Ürün" HAVING SUM("Alan") > 100
      ORDER BY verim DESC LIMIT 10`;
  }

  // 1e) DEGISIM: iki yıl arası en çok ARTAN / AZALAN ürünler (il tablosu, 2014-2025)
  // Mutlak farka göre sıralar, yüzdeyi de hesaplar. INNER JOIN: her iki yılda da kaydı olan ürünler.
  if (intent === 'degisim') {
    const alanBazli = p.metrik === 'alan';
    const kolon = alanBazli ? '"Alan"' : '"Üretim"';
    const yon = p.yon === 'azalan' ? 'ASC' : 'DESC';
    const limit = p.limit && p.limit > 0 && p.limit <= 20 ? p.limit : 5;
    return `SELECT a."Ürün" urun, a.tpl son_deger, b.tpl ilk_deger,
        (a.tpl - b.tpl) fark,
        CASE WHEN b.tpl > 0 THEN ROUND((a.tpl - b.tpl) * 100.0 / b.tpl, 1) ELSE NULL END yuzde
      FROM (SELECT "Ürün", SUM(${kolon}) tpl FROM ${T_IL}
            WHERE "Yıl"=${yilEnd}${ilFiltre}${urunFiltre} GROUP BY "Ürün") a
      INNER JOIN (SELECT "Ürün", SUM(${kolon}) tpl FROM ${T_IL}
            WHERE "Yıl"=${yilStart}${ilFiltre}${urunFiltre} GROUP BY "Ürün") b
        ON a."Ürün" = b."Ürün"
      WHERE (a.tpl + b.tpl) > 0
      ORDER BY fark ${yon} LIMIT ${limit}`;
  }

  // 1f) URUN_KARSILASTIRMA: tek il (veya Türkiye) içinde 2+ ürünü yan yana kıyasla
  // p.urunListesi = [{etiket:'limon', urunler:['Limon Ve Misket Limonu']}, {etiket:'portakal', urunler:[...]}]
  if (intent === 'urun_karsilastirma' && p.urunListesi && p.urunListesi.length >= 2) {
    // Her grup için CASE dalı; hepsinin ürünleri tek IN listesinde
    const daller = p.urunListesi
      .map(g => `WHEN "Ürün" IN (${inList(g.urunler)}) THEN '${g.etiket.replace(/'/g, "''")}'`)
      .join(' ');
    const tumUrunler = [...new Set(p.urunListesi.flatMap(g => g.urunler))];
    return `SELECT CASE ${daller} END etiket,
        SUM("Üretim") uretim, SUM("Alan") alan,
        CASE WHEN SUM("Alan")>0 THEN ROUND(CAST(SUM("Üretim") AS FLOAT)/SUM("Alan")*1000) ELSE 0 END verim
      FROM ${tablo}
      WHERE "Yıl"=${yil}${ilFiltre}${ilceFiltre} AND "Ürün" IN (${inList(tumUrunler)})
      GROUP BY etiket HAVING etiket IS NOT NULL
      ORDER BY uretim DESC`;
  }

  // 2) TREND: çok yıllı üretim (sadece il tablosu, 2014-2025)
  if (intent === 'trend') {
    return `SELECT "Yıl" yil, SUM("Üretim") tpl, SUM("Alan") alan
      FROM ${T_IL} WHERE "Yıl" BETWEEN ${yilStart} AND ${yilEnd}${ilFiltre}${urunFiltre}
      GROUP BY "Yıl" ORDER BY "Yıl"`;
  }

  // 3) ALAN
  if (intent === 'alan') {
    return `SELECT SUM("Alan") alan FROM ${tablo}
      WHERE "Yıl"=${yil}${ilFiltre}${ilceFiltre}${urunFiltre}`;
  }

  // 4) ÜRETİM (varsayılan) — üretim + alan + verim
  return `SELECT SUM("Üretim") uretim, SUM("Alan") alan,
      CASE WHEN SUM("Alan")>0 THEN ROUND(CAST(SUM("Üretim") AS FLOAT)/SUM("Alan")*1000) ELSE 0 END verim
      FROM ${tablo} WHERE "Yıl"=${yil}${ilFiltre}${ilceFiltre}${urunFiltre}`;
}

/** ===================== LLM: SORU -> TİP + ALAN ÇIKARIMI (JSON) ===================== **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function extractFields(question, maxYil) {
  const illerStr = WL.iller.join(', ');
  const sys = `Türkiye tarım sorgularını JSON alanlara ayır. SADECE JSON döndür, açıklama yok.
Alanlar:
- "tip": Sorunun türü. "veri" = istatistik/üretim/alan/sıralama/trend/karşılaştırma (sayısal TÜİK verisi). "danismanlik" = nasıl yetiştirilir, hastalık/zararlı mücadelesi, gübreleme, sulama, destek/mevzuat gibi BİLGİ soruları. "kazanc" = kârlılık, net kâr, kazanç, "ne ekmeli / hangi ürün kârlı", bir ürünün veya ilin EKONOMİK DEĞERİ gibi para/kârlılık soruları. Emin değilsen "veri" yaz.
- "il": Soruda geçen il adı (yoksa null). Geçerli iller: ${illerStr}
- "il2": Karşılaştırma varsa İKİNCİ il (yoksa null).
- "ilce": Soruda ilçe geçiyorsa adı (yoksa null). İlçe geçerse il düzeyi değil ilçe verisi kullanılır.
- "urun": Ürün/ürün ailesi terimi, kullanıcının yazdığı sade haliyle (örn "elma","sofralık üzüm","durum buğdayı"). Yoksa null.
- "ortualti": Soru sera/örtüaltı içeriyorsa true, değilse false.
- "yil": Tek yıl geçiyorsa (örn 2023) o sayı; geçmiyorsa null.
- "yilStart","yilEnd": Aralık/trend varsa (örn "son 5 yıl","2020-2024 arası") başlangıç ve bitiş; yoksa null.
- "intent": "uretim" | "alan" | "siralama" | "urun_top" | "ilce_dagilim" | "verim" | "trend" | "karsilastirma". (tip="danismanlik" ise önemsiz, "uretim" yazabilirsin.)
   * İKİ İL karşılaştırması (aynı ürün, farklı iller): "Adana Antalya domates karşılaştır","Konya mı Ankara mı buğday" -> "karsilastirma"
   * İKİ+ ÜRÜN karşılaştırması (aynı il, farklı ürünler): "Mersin'de limon mu portakal mı daha çok","domates biber salatalık Mersin'de","hangisi daha fazla üretiliyor limon mu muz mu" -> "urun_karsilastirma"
   * BİR ÜRÜNÜ en çok üreten/ekilen İLLER (ürün belli, il aranıyor): "en çok elma üreten il","limon üretiminde kaçıncı" -> "siralama"
   * BİR İL/İLÇEDE en çok üretilen/ekilen ÜRÜNLER (il belli, ürünler listeleniyor): "Mersin'de en çok üretilen 5 ürün","Tarsus'ta en çok ekilen ürünler","Konya'da hangi ürünler öne çıkıyor" -> "urun_top"
   * BİR ÜRÜNÜN bir ilin İLÇELERİNE dağılımı (il + ürün belli, ilçeler listeleniyor): "Mersin ilçelerinde domates","limon hangi ilçelerde","Mersin'de domates ilçe dağılımı","hangi ilçe en çok üretiyor" -> "ilce_dagilim"
   * VERİMLİLİK (kg/dekar, "en verimli","verim","dekar başına"): "Mersin'de en verimli ürün","hangi ilçe domateste en verimli","verimi en yüksek" -> "verim"
   * EN ÇOK ARTAN/AZALAN ÜRÜNLER (ürünler sıralanıyor, tek ürünün serisi değil): "en çok artan ürün","hangi ürün düşüşte","en çok azalan 5 ürün","yükselen ürünler" -> "degisim"
   * TEK ÜRÜNÜN yıllara göre serisi: "Mersin limon trendi","son 5 yılda buğday üretimi","yıllara göre değişim" -> "trend"
   * tek ürünün "alan","kaç dekar","ekili alan" değeri -> "alan"
   * diğer hepsi -> "uretim"
- "metrik": intent="urun_top" | "ilce_dagilim" | "degisim" için. "uretim" (varsayılan, ton) veya "alan" (dekar). "en çok ekilen","alana göre","en geniş alan" -> "alan"; "en çok üretilen","en çok yetişen" -> "uretim".
- "limit": intent="urun_top" veya "degisim" için kaç ürün istendiği (örn "ilk 5"->5, "en çok 10 ürün"->10). Belirtilmezse 5.
- "yon": SADECE intent="degisim" için. "artan" (varsayılan) veya "azalan". "düşüşte","gerileyen","azalan","kaybeden" -> "azalan"; "artan","yükselen","büyüyen" -> "artan".
- "urunListesi": SADECE intent="urun_karsilastirma" için. Karşılaştırılan ürün adlarının dizisi, en az 2 eleman (örn ["limon","portakal"]). Ürünleri kullanıcının yazdığı sade haliyle yaz. Bu alan doluysa "urun" alanını null bırak.
Kurallar: Yazım hatalarını düzelt (anakara->ankara, kaysı->kayısı). En güncel yıl ${maxYil}.
NOT: "ilce_dagilim" için bir il ADI ŞART (ilçeleri o ile göre listeleriz). "ilce" alanı null olmalı — çünkü tek ilçe değil TÜM ilçeler isteniyor.
Örnekler:
Soru: "Mersin limon üretimi" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":"limon","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Mersin sebze üretimi" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":"sebze","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Not: "sebze","meyve","tahıl" birer üründür değil GRUP'tur; yine de "urun" alanına o kelimeyi yaz.
Soru: "Tarsus'ta domates" -> {"tip":"veri","il":"Mersin","ilce":"Tarsus","urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Mersin ilçelerinde üretilen domates" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"ilce_dagilim","metrik":"uretim"}
Soru: "Limon Mersin'de hangi ilçelerde en çok ekiliyor" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":"limon","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"ilce_dagilim","metrik":"alan"}
Soru: "Afyonkarahisar buğday üretiminde kaçıncı sırada" -> {"tip":"veri","il":"Afyonkarahisar","ilce":null,"urun":"buğday","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"siralama"}
Soru: "En çok elma üreten il" -> {"tip":"veri","il":null,"ilce":null,"urun":"elma","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"siralama"}
Soru: "Mersin'de en çok üretilen 5 ürün" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":null,"ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"urun_top","metrik":"uretim","limit":5}
Soru: "Konya'da en çok ekilen ürünler" -> {"tip":"veri","il":"Konya","ilce":null,"urun":null,"ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"urun_top","metrik":"alan","limit":5}
Soru: "Tarsus'ta alana göre ilk 10 ürün" -> {"tip":"veri","il":"Mersin","ilce":"Tarsus","urun":null,"ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"urun_top","metrik":"alan","limit":10}
Soru: "Mersin'de en verimli ürün" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":null,"ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"verim"}
Soru: "Hangi ilçe domateste en verimli" -> {"tip":"veri","il":null,"ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"verim"}
Soru: "Mersin'de hangi ilçe domateste en verimli" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"verim"}
Soru: "Adana'da son 5 yılda en çok artan ürün" -> {"tip":"veri","il":"Adana","ilce":null,"urun":null,"ortualti":false,"yil":null,"yilStart":${maxYil-4},"yilEnd":${maxYil},"intent":"degisim","metrik":"uretim","yon":"artan","limit":5}
Soru: "Mersin'de hangi ürün düşüşte" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":null,"ortualti":false,"yil":null,"yilStart":${maxYil-4},"yilEnd":${maxYil},"intent":"degisim","metrik":"uretim","yon":"azalan","limit":5}
Soru: "Türkiye'de 2020'den beri en çok artan 10 ürün" -> {"tip":"veri","il":null,"ilce":null,"urun":null,"ortualti":false,"yil":null,"yilStart":2020,"yilEnd":${maxYil},"intent":"degisim","metrik":"uretim","yon":"artan","limit":10}
Soru: "Mersin'de limon mu portakal mı daha çok" -> {"tip":"veri","il":"Mersin","ilce":null,"urun":null,"urunListesi":["limon","portakal"],"ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"urun_karsilastirma"}
Soru: "Adana'da domates biber salatalık" -> {"tip":"veri","il":"Adana","ilce":null,"urun":null,"urunListesi":["domates","biber","salatalık"],"ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"urun_karsilastirma"}
Soru: "Adana Antalya domates karşılaştır" -> {"tip":"veri","il":"Adana","il2":"Antalya","ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"karsilastirma"}
Soru: "Antalya domates son 5 yıl trend" -> {"tip":"veri","il":"Antalya","ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":${maxYil - 4},"yilEnd":${maxYil},"intent":"trend"}
Soru: "Antalya örtüaltı domates" -> {"tip":"veri","il":"Antalya","ilce":null,"urun":"domates","ortualti":true,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Adana Antalya domates karşılaştır" -> {"tip":"veri","il":"Adana","il2":"Antalya","ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"karsilastirma"}
Soru: "Domates nasıl yetiştirilir, verimi nasıl artırırım" -> {"tip":"danismanlik","il":null,"ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Domates yapraklarında sarı leke var ne yapmalıyım" -> {"tip":"danismanlik","il":null,"ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Bu yıl tarlama ne eksem kârlı olur" -> {"tip":"kazanc","il":null,"ilce":null,"urun":null,"ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Mersin'de ekonomik değeri en yüksek ürün nedir" -> {"tip":"kazanc","il":"Mersin","ilce":null,"urun":null,"ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Sera domatesi dekara kaç para kazandırır" -> {"tip":"kazanc","il":null,"ilce":null,"urun":"domates","ortualti":true,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}`;

  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: `Soru: "${question}"` }],
    temperature: 0, max_tokens: 200, response_format: { type: 'json_object' }
  });
  return JSON.parse(resp.choices[0].message.content || '{}');
}

/** ===================== CEVAP ÜRETİMİ ===================== **/
function fmt(n) { return Number(n || 0).toLocaleString('tr-TR'); }

/** Türkçe ek uyumu — özel adlara kesme işaretiyle ek getirir */
const SERT = new Set(['f','s','t','k','ç','ş','h','p']);   // FıSTıKÇı ŞaHaP
function sonUnlu(s) {
  const u = 'aeıioöuü';
  for (let i = s.length - 1; i >= 0; i--) if (u.includes(s[i].toLowerCase())) return s[i].toLowerCase();
  return 'a';
}
// İlgi hali: Adana'nın, Mersin'in, Ordu'nun, Düzce'nin
function ekIn(ad) {
  if (!ad) return '';
  const son = ad[ad.length - 1].toLowerCase();
  const unluSon = 'aeıioöuü'.includes(son);
  const v = sonUnlu(ad);
  const ek = v === 'a' || v === 'ı' ? 'ın' : v === 'e' || v === 'i' ? 'in' : v === 'o' || v === 'u' ? 'un' : 'ün';
  return `${ad}'${unluSon ? 'n' : ''}${ek}`;
}
// Ayrılma hali: Adana'dan, Mersin'den, Tokat'tan
function ekDen(ad) {
  if (!ad) return '';
  const son = ad[ad.length - 1].toLowerCase();
  const v = sonUnlu(ad);
  const kalin = 'aıou'.includes(v);
  const d = SERT.has(son) ? 't' : 'd';
  return `${ad}'${d}${kalin ? 'an' : 'en'}`;
}

function buildAnswer(p, rows) {
  if (!rows || rows.length === 0) return 'Bu sorguya uygun veri bulunamadı.';
  const yer = p.ilce ? `${p.ilce} (${p.il})` : (p.il || 'Türkiye');
  const urunAd = p.urunEtiket || 'ürün';

  if (p.intent === 'karsilastirma') {
    if (rows.length < 2) return `Karşılaştırma için iki ilin de ${urunAd} verisi gerekli; biri bulunamadı.`;
    const [a, b] = rows;   // üretime göre azalan sıralı
    let cumle;
    if (b.tpl <= 0) {
      cumle = `${b.il}'de ${p.yil} yılında ${urunAd} üretim kaydı yok.`;
    } else {
      const kat = a.tpl / b.tpl;
      // 2 kattan fazlaysa "kat" daha okunur; altındaysa yüzde
      cumle = kat >= 2
        ? `${a.il}, ${ekIn(b.il)} yaklaşık ${kat.toFixed(1).replace('.', ',')} katı üretiyor (${fmt(a.tpl - b.tpl)} ton fazla).`
        : `${a.il}, ${ekDen(b.il)} %${Math.round((a.tpl - b.tpl) / b.tpl * 100)} daha fazla üretiyor (${fmt(a.tpl - b.tpl)} ton).`;
    }
    return `${p.yil} yılı ${urunAd} üretimi karşılaştırması:\n` +
      `• ${a.il}: ${fmt(a.tpl)} ton (${fmt(a.alan)} dekar)\n` +
      `• ${b.il}: ${fmt(b.tpl)} ton (${fmt(b.alan)} dekar)\n` +
      cumle;
  }
  if (p.intent === 'siralama') {
    if (p.il && rows[0].sira) return `${rows[0].il}, ${p.yil} yılı ${urunAd} üretiminde ${rows[0].sira}. sırada (${fmt(rows[0].tpl)} ton).`;
    const lst = rows.map((r, i) => `${i + 1}. ${r.il} (${fmt(r.tpl)} ton)`).join('\n');
    return `${p.yil} yılı en çok ${urunAd} üreten iller:\n${lst}`;
  }
  if (p.intent === 'urun_top') {
    const alanBazli = p.metrik === 'alan';
    const baslik = alanBazli ? 'en çok ekilen' : 'en çok üretilen';
    const lst = rows.map((r, i) => {
      const ana = alanBazli ? `${fmt(r.alan)} dekar` : `${fmt(r.uretim)} ton`;
      return `${i + 1}. ${r.urun} (${ana})`;
    }).join('\n');
    return `${yer} ${p.yil} yılı ${baslik} ${rows.length} ürün:\n${lst}`;
  }
  if (p.intent === 'ilce_dagilim') {
    const alanBazli = p.metrik === 'alan';
    const toplam = rows.reduce((s, r) => s + (alanBazli ? r.alan : r.uretim), 0);
    const birim = alanBazli ? 'ekili alanı' : 'üretimi';
    const lst = rows.map((r, i) => {
      const ana = alanBazli ? `${fmt(r.alan)} dekar` : `${fmt(r.uretim)} ton`;
      const pay = toplam > 0 ? Math.round((alanBazli ? r.alan : r.uretim) / toplam * 100) : 0;
      return `${i + 1}. ${r.ilce}: ${ana} (%${pay})`;
    }).join('\n');
    const toplamStr = alanBazli ? `${fmt(toplam)} dekar` : `${fmt(toplam)} ton`;
    return `${p.il} ilçelerinde ${p.yil} yılı ${urunAd} ${birim} (toplam ${toplamStr}):\n${lst}`;
  }
  if (p.intent === 'verim') {
    // Ürün varsa ilçe bazlı (r.ilce + r.il), ürün yoksa ürün bazlı (r.urun)
    if (rows[0] && rows[0].ilce !== undefined) {
      const lst = rows.map((r, i) => {
        // İl belirtilmemişse "İlçe (İl)", belirtilmişse sadece "İlçe"
        const yerAd = p.il ? r.ilce : `${r.ilce} (${r.il})`;
        return `${i + 1}. ${yerAd}: ${fmt(r.verim)} kg/dekar (${fmt(r.uretim)} ton)`;
      }).join('\n');
      const kapsam = p.il ? `${p.il} ilçelerinde` : 'Türkiye ilçelerinde';
      return `${kapsam} ${p.yil} yılı ${urunAd} veriminde en yüksek:\n${lst}`;
    }
    const lst = rows.map((r, i) => `${i + 1}. ${r.urun}: ${fmt(r.verim)} kg/dekar`).join('\n');
    return `${yer} ${p.yil} yılı en verimli ürünler (kg/dekar):\n${lst}`;
  }
  if (p.intent === 'degisim') {
    const alanBazli = p.metrik === 'alan';
    const birim = alanBazli ? 'dekar' : 'ton';
    const azalan = p.yon === 'azalan';
    const lst = rows.map((r, i) => {
      const isaret = r.fark >= 0 ? '+' : '';       // azalanlarda fark negatif
      const yzd = r.yuzde === null || r.yuzde === undefined ? '' : ` / %${isaret}${fmt(r.yuzde)}`;
      return `${i + 1}. ${r.urun}: ${isaret}${fmt(r.fark)} ${birim}${yzd}  (${fmt(r.ilk_deger)} → ${fmt(r.son_deger)})`;
    }).join('\n');
    const baslik = azalan ? 'en çok azalan' : 'en çok artan';
    const olcu = alanBazli ? 'ekili alan' : 'üretim';
    return `${yer} ${p.yilStart}-${p.yilEnd} arası ${olcu} bakımından ${baslik} ürünler:\n${lst}`;
  }
  if (p.intent === 'urun_karsilastirma') {
    const lst = rows.map((r, i) =>
      `${i + 1}. ${r.etiket}: ${fmt(r.uretim)} ton (alan ${fmt(r.alan)} dekar, verim ${fmt(r.verim)} kg/dekar)`
    ).join('\n');
    // Sorulan ama sonuçta yer almayan ürünler — iki farklı sebep
    const gelen = rows.map(r => r.etiket);
    const verisiYok = (p.urunListesi || []).map(g => g.etiket).filter(e => !gelen.includes(e));
    const notlar = [];
    if (verisiYok.length) notlar.push(`${verisiYok.join(', ')} için ${yer} ${p.yil} yılında üretim kaydı yok`);
    if (p.cozulmeyenUrun && p.cozulmeyenUrun.length) notlar.push(`"${p.cozulmeyenUrun.join('", "')}" ürün olarak tanınmadı`);
    const eksikNot = notlar.length ? `\n\n(${notlar.join('; ')}.)` : '';

    let sonuc = '';
    if (rows.length >= 2 && rows[1].uretim > 0) {
      const kat = rows[0].uretim / rows[1].uretim;
      const fark = rows[0].uretim - rows[1].uretim;
      sonuc = kat >= 1.15
        ? `\n\n${rows[0].etiket}, ${rows[1].etiket} üretiminin yaklaşık ${kat.toFixed(1).replace('.', ',')} katı (${fmt(fark)} ton fazla).`
        : `\n\nİkisi birbirine yakın; ${rows[0].etiket} ${fmt(fark)} ton önde.`;
    }
    return `${yer} ${p.yil} yılı üretim karşılaştırması:\n${lst}${sonuc}${eksikNot}`;
  }
  if (p.intent === 'trend') {
    const lst = rows.map(r => `${r.yil}: ${fmt(r.tpl)} ton`).join('\n');
    return `${yer} ${urunAd} üretimi (${p.yilStart}-${p.yilEnd}):\n${lst}`;
  }
  if (p.intent === 'alan') return `${yer} ${p.yil} yılı ${urunAd} ekili alanı: ${fmt(rows[0].alan)} dekar.`;

  const r = rows[0];
  if (!r.uretim) return 'Bu sorguya uygun veri bulunamadı.';
  return `${yer} ${p.yil} yılı ${urunAd} üretimi: ${fmt(r.uretim)} ton (alan ${fmt(r.alan)} dekar, verim ${fmt(r.verim)} kg/dekar).`;
}

/** ===================== RATE LIMIT + CACHE ===================== **/
const rl = new Map(); const RL_WIN = 60000, RL_MAX = 15;
function rateOk(ip) {
  const now = Date.now(); const a = (rl.get(ip) || []).filter(t => now - t < RL_WIN);
  if (a.length >= RL_MAX) return false; a.push(now); rl.set(ip, a); return true;
}
const cache = new Map(); const TTL = 300000, CMAX = 100;
const cKey = q => norm(q);
function cGet(q) { const c = cache.get(cKey(q)); if (c && Date.now() - c.t < TTL) return c.d; cache.delete(cKey(q)); return null; }
function cSet(q, d) { if (cache.size >= CMAX) cache.delete(cache.keys().next().value); cache.set(cKey(q), { d, t: Date.now() }); }

/** ===================== MAIN HANDLER ===================== **/
export default async function handler(req, res) {
  const t0 = Date.now();
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Sadece POST' });

  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  if (!rateOk(ip)) return res.status(429).json({ error: 'Dakikada en fazla 15 soru.' });

  try {
    const { question } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'Soru gerekli' });

    const hit = cGet(question);
    if (hit) return res.status(200).json({ ...hit, cached: true, processingTime: Date.now() - t0 });

    const db = await getDB();
    buildWhitelist(db);

    // Dinamik en güncel yıl
    const maxYil = queryAll(db, `SELECT MAX("Yıl") y FROM ${T_IL}`)[0].y;

    // 1) LLM: tip + alan çıkarımı (tek çağrı)
    const f = await extractFields(question, maxYil);
    if (DEBUG) console.log('LLM fields:', JSON.stringify(f));

    // 1.5) [YENİ] ROUTER
    // Kazanç/kârlılık sorusu -> "Ne Ekeceğim" widget'ına yönlendir (bot net kâr rakamı vermez)
    if (f.tip === 'kazanc') {
      const out = { success: true, mode: 'kazanc', processingTime: Date.now() - t0,
        answer: 'Kârlılık ve "ne ekmeli" tahminleri için "Ne Ekeceğim, Ne Kazanacağım" aracımıza bakın — orada ürün başına tahmini net kâr, risk ve başabaş fiyatı yer alıyor. Ben üretim, alan, verim ve sıralama sorularında yardımcı olabilirim.',
        debug: DEBUG ? { fields: f } : null };
      cSet(question, out);
      return res.status(200).json(out);
    }
    // Danışmanlık sorusu -> bilgi tabanı / grounded LLM
    if (f.tip === 'danismanlik') {
      const adv = await answerAdvisory(question);
      const out = { success: true, answer: adv.answer, mode: 'danismanlik',
        source: adv.source, processingTime: Date.now() - t0,
        debug: DEBUG ? { fields: f, konu: adv.konu || null } : null };
      cSet(question, out);
      return res.status(200).json(out);
    }
    // tip="veri" (veya boş) -> aşağıdaki mevcut SQL path aynen çalışır

    // 2) Deterministik çözümleme
    const il = resolveIl(f.il);
    const il2 = resolveIl(f.il2);                        // karşılaştırma için ikinci il
    const ilce = f.ilce ? f.ilce : null;                 // ilçe adı varsa kds_ilce'ye gideriz
    const yil = f.yil || (f.intent === 'trend' ? null : maxYil);
    const yilStart = f.yilStart || (maxYil - 4);
    const yilEnd = f.yilEnd || maxYil;

    // Grup mu, ürün mü? ("sebze/meyve/tahıl/örtüaltı" -> grup)
    const grup = resolveGrup(f.urun);

    // Ürün çözümle — grup değilse; örtüaltı/ilçe varsa kds_ilce ürün seti
    const ilceSet = (ilce || f.ortualti || grup === 'Örtüaltı');
    let urunler = grup ? [] : resolveUrun(f.urun, ilceSet ? WL.urunIlceSet : WL.urunIlSet);
    // Örtüaltı ürün: adları "Örtüaltı " önekine çevir
    if (f.ortualti && !grup) {
      urunler = resolveUrun(f.urun, WL.urunIlceSet).map(u => 'Örtüaltı ' + u).filter(u => WL.urunIlceSet.has(u));
    }

    // Çoklu ürün karşılaştırma: her terimi ayrı ayrı çözümle, etiketiyle sakla
    // [{etiket:'limon', urunler:['Limon Ve Misket Limonu']}, ...] — çözümlenemeyenler ayrıca not edilir
    let urunListesi = null, cozulmeyenUrun = [];
    if (f.intent === 'urun_karsilastirma' && Array.isArray(f.urunListesi)) {
      const set = ilceSet ? WL.urunIlceSet : WL.urunIlSet;
      const hepsi = f.urunListesi.map(t => ({ etiket: String(t).trim(), urunler: resolveUrun(t, set) }));
      urunListesi = hepsi.filter(g => g.etiket && g.urunler.length);
      cozulmeyenUrun = hepsi.filter(g => g.etiket && !g.urunler.length).map(g => g.etiket);
    }

    const p = {
      il, il2, ilce: ilce || null, urunler, grup, urunListesi, cozulmeyenUrun,
      urunEtiket: grup ? norm(f.urun) : (f.urun || 'ürün'),
      yil, yilStart, yilEnd, intent: f.intent || 'uretim',
      metrik: f.metrik || 'uretim', limit: f.limit || 5, yon: f.yon || 'artan'
    };

    // Çoklu karşılaştırmada en az 2 ürün çözümlenmeli
    if (p.intent === 'urun_karsilastirma' && (!urunListesi || urunListesi.length < 2)) {
      return res.status(200).json({ success: true, processingTime: Date.now() - t0,
        answer: cozulmeyenUrun.length
          ? `Karşılaştırma için en az iki ürün gerekli; "${cozulmeyenUrun.join('", "')}" için eşleşen ürün bulunamadı.`
          : 'Karşılaştırma için en az iki ürün belirtin (örn "Mersin\'de limon mu portakal mı").' });
    }

    // urun_top: ürün belirtmeye gerek yok (tüm ürünleri sıralıyoruz) — "bulunamadı" kontrolünü atla
    if (!grup && !f.ortualti && !urunler.length && f.urun && p.intent !== 'urun_top')
      return res.status(200).json({ success: true, answer: `"${f.urun}" için eşleşen ürün bulunamadı. Daha genel bir ad deneyin (örn "elma","domates","sebze").`, processingTime: Date.now() - t0 });

    // 3) SQL kur
    let sql;
    const ilGeneliOrtu = (f.ortualti || grup === 'Örtüaltı') && !ilce;
    const prodFiltre = grup ? ` AND "Ürün Grubu"='${grup.replace(/'/g, "''")}'`
      : (urunler.length ? ` AND "Ürün" IN (${inList(urunler)})` : '');

    if (p.intent === 'karsilastirma' && il && il2) {
      // İki ili yan yana: kds (il düzeyi), tek sorgu
      sql = `SELECT "İl" il, SUM("Üretim") tpl, SUM("Alan") alan
        FROM ${T_IL} WHERE "Yıl"=${yil} AND "İl" IN ('${il.replace(/'/g, "''")}','${il2.replace(/'/g, "''")}')${prodFiltre}
        GROUP BY "İl" ORDER BY tpl DESC`;
    } else if (p.intent === 'ilce_dagilim') {
      // İlçe dağılımı her zaman buildSQL'de kds_ilce üzerinden — örtüaltı dalına düşmesin
      sql = buildSQL(p);
    } else if (p.intent === 'verim') {
      // Verim sıralaması buildSQL'de ele alınıyor — örtüaltı dalına düşmesin
      sql = buildSQL(p);
    } else if (p.intent === 'degisim') {
      // Artan/azalan ürün sıralaması il tablosunda (2014-2025) — örtüaltı dalına düşmesin
      sql = buildSQL(p);
    } else if (p.intent === 'urun_karsilastirma') {
      // Çoklu ürün karşılaştırma buildSQL'de CASE WHEN ile — örtüaltı dalına düşmesin
      sql = buildSQL(p);
    } else if (ilGeneliOrtu) {
      const ilFiltre = il ? ` AND "İl"='${il.replace(/'/g, "''")}'` : '';
      sql = `SELECT SUM("Üretim") uretim, SUM("Alan") alan,
        CASE WHEN SUM("Alan")>0 THEN ROUND(CAST(SUM("Üretim") AS FLOAT)/SUM("Alan")*1000) ELSE 0 END verim
        FROM ${T_ILCE} WHERE "Yıl"=${yil}${ilFiltre}${prodFiltre}`;
    } else {
      sql = buildSQL(p);
    }
    if (DEBUG) console.log('SQL:', sql);

    // 4) Çalıştır
    let rows = [];
    try { rows = queryAll(db, sql); }
    catch (e) { console.error('SQL hatası:', e); return res.status(400).json({ error: 'Sorgu çalıştırılamadı', detail: DEBUG ? e.message : undefined }); }

    const answer = buildAnswer(p, rows);
    const out = { success: true, answer, mode: 'veri', data: rows.slice(0, 10), totalRows: rows.length,
      processingTime: Date.now() - t0, debug: DEBUG ? { fields: f, sql, urunler } : null };
    cSet(question, out);
    res.status(200).json(out);

  } catch (e) {
    console.error('Genel hata:', e.message);
    res.status(500).json({ error: 'Sunucu hatası', detail: DEBUG ? e.message : 'Geçici sorun' });
  }
}
