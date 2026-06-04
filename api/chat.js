// api/chat.js — Türkiye Tarım Veritabanı Chatbot v2 (Production Ready)
// Mimari: Soru -> LLM (alan çıkarımı: JSON) -> JS deterministik çözümleme -> şablon SQL -> SQLite
// İki tablo: kds (il, 2014-2025)  |  kds_ilce (ilçe + örtüaltı, 2024-2025)
export const config = { runtime: 'nodejs', maxDuration: 30 };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ===================== CONFIG ===================== **/
const DB_FILE = 'tarimdb.sqlite';          // public/ içinde
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
  'incir':   ['İncir Yaş']
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

/** ===================== LLM: SORU -> ALAN ÇIKARIMI (JSON) ===================== **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function extractFields(question, maxYil) {
  const illerStr = WL.iller.join(', ');
  const sys = `Türkiye tarım sorgularını JSON alanlara ayır. SADECE JSON döndür, açıklama yok.
Alanlar:
- "il": Soruda geçen il adı (yoksa null). Geçerli iller: ${illerStr}
- "il2": Karşılaştırma varsa İKİNCİ il (yoksa null).
- "ilce": Soruda ilçe geçiyorsa adı (yoksa null). İlçe geçerse il düzeyi değil ilçe verisi kullanılır.
- "urun": Ürün/ürün ailesi terimi, kullanıcının yazdığı sade haliyle (örn "elma","sofralık üzüm","durum buğdayı"). Yoksa null.
- "ortualti": Soru sera/örtüaltı içeriyorsa true, değilse false.
- "yil": Tek yıl geçiyorsa (örn 2023) o sayı; geçmiyorsa null.
- "yilStart","yilEnd": Aralık/trend varsa (örn "son 5 yıl","2020-2024 arası") başlangıç ve bitiş; yoksa null.
- "intent": "uretim" | "alan" | "siralama" | "trend" | "karsilastirma".
   * "karşılaştır","kıyasla","hangisi daha çok","X mi Y mi" + iki il -> "karsilastirma"
   * "kaçıncı","sıralama","en çok","lider" -> "siralama"
   * "trend","yıllara göre","son N yıl","değişim","artış" -> "trend"
   * "alan","kaç dekar","ekili alan" -> "alan"
   * diğer hepsi -> "uretim"
Kurallar: Yazım hatalarını düzelt (anakara->ankara, kaysı->kayısı). En güncel yıl ${maxYil}.
Örnekler:
Soru: "Mersin limon üretimi" -> {"il":"Mersin","ilce":null,"urun":"limon","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Mersin sebze üretimi" -> {"il":"Mersin","ilce":null,"urun":"sebze","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Not: "sebze","meyve","tahıl" birer üründür değil GRUP'tur; yine de "urun" alanına o kelimeyi yaz.
Soru: "Tarsus'ta domates" -> {"il":"Mersin","ilce":"Tarsus","urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Afyonkarahisar buğday üretiminde kaçıncı sırada" -> {"il":"Afyonkarahisar","ilce":null,"urun":"buğday","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"siralama"}
Soru: "En çok elma üreten il" -> {"il":null,"ilce":null,"urun":"elma","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"siralama"}
Soru: "Antalya domates son 5 yıl trend" -> {"il":"Antalya","ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":${maxYil - 4},"yilEnd":${maxYil},"intent":"trend"}
Soru: "Antalya örtüaltı domates" -> {"il":"Antalya","ilce":null,"urun":"domates","ortualti":true,"yil":null,"yilStart":null,"yilEnd":null,"intent":"uretim"}
Soru: "Adana Antalya domates karşılaştır" -> {"il":"Adana","il2":"Antalya","ilce":null,"urun":"domates","ortualti":false,"yil":null,"yilStart":null,"yilEnd":null,"intent":"karsilastirma"}`;

  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: `Soru: "${question}"` }],
    temperature: 0, max_tokens: 200, response_format: { type: 'json_object' }
  });
  return JSON.parse(resp.choices[0].message.content || '{}');
}

/** ===================== CEVAP ÜRETİMİ ===================== **/
function fmt(n) { return Number(n || 0).toLocaleString('tr-TR'); }

function buildAnswer(p, rows) {
  if (!rows || rows.length === 0) return 'Bu sorguya uygun veri bulunamadı.';
  const yer = p.ilce ? `${p.ilce} (${p.il})` : (p.il || 'Türkiye');
  const urunAd = p.urunEtiket || 'ürün';

  if (p.intent === 'karsilastirma') {
    if (rows.length < 2) return `Karşılaştırma için iki ilin de ${urunAd} verisi gerekli; biri bulunamadı.`;
    const [a, b] = rows;   // üretime göre azalan sıralı
    const fark = b.tpl > 0 ? Math.round((a.tpl - b.tpl) / b.tpl * 100) : 0;
    return `${p.yil} yılı ${urunAd} üretimi karşılaştırması:\n` +
      `• ${a.il}: ${fmt(a.tpl)} ton (${fmt(a.alan)} dekar)\n` +
      `• ${b.il}: ${fmt(b.tpl)} ton (${fmt(b.alan)} dekar)\n` +
      `${a.il}, ${b.il}'den %${fark} daha fazla üretiyor.`;
  }
  if (p.intent === 'siralama') {
    if (p.il && rows[0].sira) return `${rows[0].il}, ${p.yil} yılı ${urunAd} üretiminde ${rows[0].sira}. sırada (${fmt(rows[0].tpl)} ton).`;
    const lst = rows.map((r, i) => `${i + 1}. ${r.il} (${fmt(r.tpl)} ton)`).join('\n');
    return `${p.yil} yılı en çok ${urunAd} üreten iller:\n${lst}`;
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

    // 1) LLM alan çıkarımı
    const f = await extractFields(question, maxYil);
    if (DEBUG) console.log('LLM fields:', JSON.stringify(f));

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

    const p = {
      il, il2, ilce: ilce || null, urunler, grup,
      urunEtiket: grup ? norm(f.urun) : (f.urun || 'ürün'),
      yil, yilStart, yilEnd, intent: f.intent || 'uretim'
    };

    // "Bulunamadı" sadece: grup değil, örtüaltı değil, ürün verilmiş ama eşleşme yok
    if (!grup && !f.ortualti && !urunler.length && f.urun)
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
    const out = { success: true, answer, data: rows.slice(0, 10), totalRows: rows.length,
      processingTime: Date.now() - t0, debug: DEBUG ? { fields: f, sql, urunler } : null };
    cSet(question, out);
    res.status(200).json(out);

  } catch (e) {
    console.error('Genel hata:', e.message);
    res.status(500).json({ error: 'Sunucu hatası', detail: DEBUG ? e.message : 'Geçici sorun' });
  }
}
