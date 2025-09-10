// api/chat.js — Türkiye Tarım Veritabanı Chatbot - Production Ready
export const config = { runtime: 'nodejs', maxDuration: 30 };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ======= CONFIG ======= **/
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DEFAULT_YEAR = 2024;
const DEBUG_MODE = false; // Production'da debug bilgiler kapalı

/** ======= RATE LIMITING ======= **/
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 dakika
const RATE_LIMIT_MAX = 15; // 15 request per dakika per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = rateLimitMap.get(ip) || [];
  const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  if (recentRequests.length >= RATE_LIMIT_MAX) return false;
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);

  // Clean old entries periodically
  if (Math.random() < 0.01) { // 1% chance
    for (const [key, value] of rateLimitMap.entries()) {
      const filtered = value.filter(time => now - time < RATE_LIMIT_WINDOW);
      if (filtered.length === 0) {
        rateLimitMap.delete(key);
      } else {
        rateLimitMap.set(key, filtered);
      }
    }
  }
  return true;
}

/** ======= SIMPLE CACHE ======= **/
const responseCache = new Map();
const CACHE_TTL = 300000; // 5 dakika
const MAX_CACHE_SIZE = 100;

function getCachedResponse(question) {
  const key = question.toLowerCase().trim();
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  responseCache.delete(key);
  return null;
}

function setCachedResponse(question, data) {
  const key = question.toLowerCase().trim();
  // Simple LRU: remove oldest if cache is full
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  responseCache.set(key, { data, timestamp: Date.now() });
}

/** ======= UTILS ======= **/
function getSchema() {
  return {
    columns: ['il', 'ilce', 'urun_cesidi', 'urun_adi', 'yil', 'uretim_alani', 'uretim_miktari', 'verim'],
    il: 'il',
    ilce: 'ilce',
    kategori: 'urun_cesidi',
    urun: 'urun_adi',
    yil: 'yil',
    alan: 'uretim_alani',
    uretim: 'uretim_miktari',
    verim: 'verim'
  };
}

function isSafeSQL(sql) {
  const s = (sql || '').trim().toLowerCase();
  if (!s.startsWith('select')) return false;
  const dangerous = ['drop', 'delete', 'update', 'insert', 'create', 'alter', 'exec', 'execute', '--', ';'];
  return !dangerous.some(word => s.includes(word));
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString('tr-TR');
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         'unknown';
}

/** ======= RANK HELPERS (kaçıncı sırada) ======= **/
const PROVINCES_TR = [
  "Adana","Adıyaman","Afyonkarahisar","Ağrı","Aksaray","Amasya","Ankara","Antalya","Ardahan","Artvin",
  "Aydın","Balıkesir","Bartın","Batman","Bayburt","Bilecik","Bingöl","Bitlis","Bolu","Burdur","Bursa",
  "Çanakkale","Çankırı","Çorum","Denizli","Diyarbakır","Düzce","Edirne","Elazığ","Erzincan","Erzurum",
  "Eskişehir","Gaziantep","Giresun","Gümüşhane","Hakkari","Hatay","Iğdır","Isparta","İstanbul","İzmir",
  "Kahramanmaraş","Karabük","Karaman","Kars","Kastamonu","Kayseri","Kilis","Kırıkkale","Kırklareli",
  "Kırşehir","Kocaeli","Konya","Kütahya","Malatya","Manisa","Mardin","Mersin","Muğla","Muş","Nevşehir",
  "Niğde","Ordu","Osmaniye","Rize","Sakarya","Samsun","Siirt","Sinop","Sivas","Şırnak","Tekirdağ",
  "Tokat","Trabzon","Tunceli","Şanlıurfa","Uşak","Van","Yalova","Yozgat","Zonguldak"
];

// Geniş ürün sözlüğü (tekil kökler, küçük harf; includes ile eşleştiriyoruz)
const KNOWN_URUN = [
  // Sebze
  'domates','biber','kapya','çarliston','patlıcan','salatalık','hıyar','kabak','lahana','karnabahar',
  'brokoli','ıspanak','marul','roka','tere','pırasa','havuç','turp','soğan','yeşil soğan','sarımsak',
  'patates','fasulye','taze fasulye','barbunya','bezelye','bakla','mantarı','mantar','kırmızı pancar',
  // Meyve
  'elma','armut','ayva','şeftali','nektarin','kayısı','erik','kiraz','vişne','incir','üzüm','nar',
  'portakal','mandalina','limon','greyfurt','muz','avokado','kivi','trabzon hurması','cennet elması',
  'zeytin','ceviz','badem','fındık','fıstık','antep fıstığı','kestane',
  // Tahıl / Yağlı tohum / Endüstri
  'buğday','arpa','mısır','yulaf','çavdar','pirinç','çeltik','tritikale','sorgum',
  'ayçiçeği','kanola','kolza','soya','pamuk','şeker pancarı','tütün','çay'
];

// cümleden il adını yakala (81 il üzerinden)
function extractIl(q) {
  const txt = String(q || '');
  for (const il of PROVINCES_TR) {
    const re = new RegExp(`\\b${il}\\b`, 'i');
    if (re.test(txt)) return il;
  }
  return '';
}

// cümleden ürün kökünü yakala (sözlük üzerinden, includes ile)
function extractUrun(q) {
  const low = String(q || '').toLowerCase();
  for (const u of KNOWN_URUN) {
    if (low.includes(u)) return u;
  }
  return '';
}

// "kaçıncı sırada" için deterministik SQL üret (rank tüm iller üzerinde)
function buildRankSQL(il, urun, s) {
  const u = urun.toLowerCase().replace(/'/g, "''");
  const i = il.replace(/'/g, "''");
  return `
WITH t AS (
  SELECT "${s.il}" AS il, SUM("${s.uretim}") AS uretim
  FROM ${TABLE}
  WHERE LOWER("${s.urun}") LIKE '%${u}%'
    AND "${s.yil}"=${DEFAULT_YEAR}
  GROUP BY "${s.il}"
)
SELECT rank FROM (
  SELECT il, uretim, DENSE_RANK() OVER (ORDER BY uretim DESC) AS rank
  FROM t
)
WHERE il='${i}'
  `.trim();
}

/** ======= GPT LAYER ======= **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function nlToSQL(question, schema) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI API key eksik');

  const { il, ilce, urun, yil, uretim, alan, verim, kategori } = schema;

  const system = `Sen bir SQL uzmanısın. Türkiye tarım verileri için doğal dil sorgularını SQL'e çevir.

TABLO: ${TABLE}
KOLONLAR:
- "${il}": İl adı (TEXT)
- "${ilce}": İlçe adı (TEXT)
- "${kategori}": Ürün kategorisi (Meyve/Sebze/Tahıl) (TEXT)
- "${urun}": Ürün adı (TEXT)
- "${yil}": Yıl (INTEGER, 2020-2024 arası)
- "${alan}": Üretim alanı, dekar cinsinden (INTEGER)
- "${uretim}": Üretim miktarı, ton cinsinden (INTEGER)
- "${verim}": Verim, ton/dekar (INTEGER)

ÖNEMLİ: YAZIM HATALARINI OTOMATİK DÜZELT!
- "kaysı" → "kayısı", "anakara" → "ankara"
- "adanna" → "adana", "mersinn" → "mersin", "izmirr" → "izmir"
- İl/ürün isimlerindeki typo'ları düzelt

KRİTİK KURALLAR:
1) ÜRÜN EŞLEŞME:
   - Tekli: "üzüm" → LOWER("${urun}") LIKE '%üzüm%'
   - Çoklu: "sofralık üzüm çekirdekli" → tüm kelimeler AND ile aranır.
2) İL/İLÇE EŞLEŞME:
   - "Mersin'de" → "${il}"='Mersin'
   - "Tarsus'ta" → "${ilce}"='Tarsus'
   - "Türkiye'de" → il filtresi koyma
3) YIL:
   - Yıl verilmediyse ${DEFAULT_YEAR} kullan
4) Aggregation:
   - SUM() kullan; "en çok" → ORDER BY DESC
5) "kaçıncı sırada / sıralaması" soruları:
   - RANK, TÜM iller için hesaplanır; sonra hedef il WHERE ile süzülür.
   - İl filtresini rank hesaplanmadan önce uygularsan sonuç hep 1 olur. Bunu yapma.

ÖRNEKLER:
Soru: "mersinn kaysı üretimi"
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE "${il}"='Mersin' AND LOWER("${urun}") LIKE '%kayısı%'

Soru: "elma üretimi"
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE}
WHERE (LOWER("${urun}") LIKE '%elma%') AND LOWER("${urun}") NOT LIKE '%trabzon hurması%' AND LOWER("${urun}") NOT LIKE '%cennet elması%' AND LOWER("${urun}") NOT LIKE '%yer elması%'

Soru: "Adana muz üretiminde kaçıncı sırada?"
SQL:
WITH t AS (
  SELECT "${il}" AS il, SUM("${uretim}") AS uretim
  FROM ${TABLE}
  WHERE LOWER("${urun}") LIKE '%muz%' AND "${yil}"=${DEFAULT_YEAR}
  GROUP BY "${il}"
)
SELECT rank FROM (
  SELECT il, uretim, DENSE_RANK() OVER (ORDER BY uretim DESC) AS rank
  FROM t
)
WHERE il='Adana'

ÇIKTI: Sadece SELECT (veya WITH ... SELECT) sorgusu, noktalama yok.`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Soru: "${question}"\n\nSQL:` }
      ],
      temperature: 0,
      max_tokens: 200
    });

    let sql = (response.choices[0].message.content || '')
      .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').trim())
      .trim()
      .replace(/;+\s*$/, '');

    // Yıl otomatik ekleme (rank örneklerinde zaten var; yine de güvenlik için)
    if (sql && !sql.includes(`"${yil}"`)) {
      if (sql.match(/\bWHERE\b/i)) {
        sql = sql.replace(/WHERE/i, `WHERE "${yil}"=${DEFAULT_YEAR} AND`);
      } else if (sql.match(/\b(GROUP BY|ORDER BY)\b/i)) {
        const match = sql.match(/\b(GROUP BY|ORDER BY)\b/i);
        sql = sql.slice(0, match.index) + `WHERE "${yil}"=${DEFAULT_YEAR} ` + sql.slice(match.index);
      } else {
        sql += ` WHERE "${yil}"=${DEFAULT_YEAR}`;
      }
    }

    return sql;
  } catch (e) {
    console.error('OpenAI hatası:', e.message);
    throw new Error(`GPT servisi geçici olarak kullanılamıyor: ${e.message}`);
  }
}

async function generateAnswer(question, rows, sql) {
  if (!rows || rows.length === 0) return 'Bu sorguya uygun veri bulunamadı.';

  // Basit cevaplar için hızlı return
  if (rows.length === 1) {
    const row = rows[0];
    const keys = Object.keys(row);
    if (keys.length === 1) {
      const [key, value] = Object.entries(row)[0];
      if (value === null || value === undefined || value === 0) {
        return 'Bu sorguya uygun veri bulunamadı.';
      }
      if (key.includes('alan')) return `${formatNumber(value)} dekar`;
      else if (key.includes('verim')) return `${formatNumber(value)} ton/dekar`;
      else if (key.includes('uretim') || key.includes('toplam')) return `${formatNumber(value)} ton`;
      return formatNumber(value);
    }
  }

  // Karmaşık cevaplar için GPT kullan
  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [{
          role: 'system',
          content: 'Tarım verileri uzmanısın. Kısa Türkçe cevap ver. Sayıları binlik ayraçla yaz.'
        }, {
          role: 'user',
          content: `Soru: ${question}\nVeri: ${JSON.stringify(rows.slice(0, 5))}`
        }],
        temperature: 0,
        max_tokens: 100
      });
      return response.choices[0].message.content?.trim() || 'Cevap oluşturulamadı.';
    } catch (e) {
      console.error('GPT cevap hatası:', e);
      return `${rows.length} sonuç bulundu: ${JSON.stringify(rows[0])}`;
    }
  }
  return `${rows.length} sonuç bulundu.`;
}

/** ======= MAIN HANDLER ======= **/
export default async function handler(req, res) {
  const startTime = Date.now();
  const clientIP = getClientIP(req);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Sadece POST metodu desteklenir' });

  // Rate limiting
  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({
      error: 'Çok fazla istek',
      detail: 'Dakikada maksimum 15 soru sorabilirsiniz. Lütfen bekleyin.'
    });
  }

  try {
    const { question } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'Soru parametresi gerekli' });

    // Cache kontrolü
    const cached = getCachedResponse(question);
    if (cached) {
      console.log(`[CACHE HIT] ${question}`);
      return res.status(200).json({ ...cached, cached: true, processingTime: Date.now() - startTime });
    }

    console.log(`[${new Date().toISOString()}] IP: ${clientIP}, Soru: ${question}`);

    // SQLite initialize
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file)
    });
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) throw new Error('Veritabanı dosyası bulunamadı');
    const dbBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(dbBuffer);

    // SQL oluştur
    let sql;
    const schema = getSchema();

    // "kaçıncı sırada / sıralaması" sorularına deterministik yol
    if (/(kaçıncı\s*sırada|sıralaması)/i.test(question)) {
      const il = extractIl(question);
      const urun = extractUrun(question);
      if (il && urun) {
        sql = buildRankSQL(il, urun, schema);
      }
    }

    if (!sql) {
      try {
        sql = await nlToSQL(question, schema);
        if (DEBUG_MODE) console.log('SQL:', sql);
      } catch (e) {
        return res.status(400).json({ error: 'Soru anlayılamadı', detail: e.message });
      }
    }

    // Güvenlik
    if (!isSafeSQL(sql)) return res.status(400).json({ error: 'Güvenli olmayan sorgu' });

    // SQL çalıştır
    let rows = [];
    try {
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      console.log(`Sonuç: ${rows.length} satır`);
    } catch (e) {
      console.error('SQL hatası:', e);
      return res.status(400).json({ error: 'Sorgu çalıştırılamadı', detail: 'Veritabanı sorgu hatası' });
    } finally {
      db.close();
    }

    // Cevap oluştur
    const answer = await generateAnswer(question, rows, sql);

    const response = {
      success: true,
      answer,
      data: rows.slice(0, 10),
      totalRows: rows.length,
      processingTime: Date.now() - startTime,
      debug: DEBUG_MODE ? { sql, sampleRows: rows.slice(0, 2) } : null
    };

    // Cache
    setCachedResponse(question, response);
    res.status(200).json(response);

  } catch (error) {
    console.error('Genel hata:', error.message);
    res.status(500).json({
      error: 'Sunucu hatası',
      detail: DEBUG_MODE ? error.message : 'Geçici bir sorun oluştu',
      processingTime: Date.now() - startTime
    });
  }
}
