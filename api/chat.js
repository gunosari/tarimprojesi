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
const DEBUG_MODE = true; // Test için debug açık

/** ======= RATE LIMITING ======= **/
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 dakika
const RATE_LIMIT_MAX = 15; // 15 request per dakika per IP
function checkRateLimit(ip) {
  const now = Date.now();
  const requests = rateLimitMap.get(ip) || [];
  const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);

  if (recentRequests.length >= RATE_LIMIT_MAX) {
    return false;
  }

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

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

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

  responseCache.set(key, {
    data: data,
    timestamp: Date.now()
  });
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
ÖNEMLİ: YAZIM HATALARINI OTOMATIK DÜZELT!
- "kaysı" → "kayısı", "anakara" → "ankara", "domates" → "domates"
- "adanna" → "adana", "mersinn" → "mersin", "izmirr" → "izmir"
- İl/ürün isimlerindeki typo'ları düzelt
KRİTİK KURALLAR:
1. ÜRÜN EŞLEŞME:
   - Yazım hatalarını düzelt: "kaysı" → "kayısı" olarak işle
   - Tekli: "üzüm" → LOWER("${urun}") LIKE '%üzüm%' OR "${urun}" LIKE '%Üzüm%'
   - Çoklu: "sofralık üzüm çekirdekli" → Her kelimeyi ayrı kontrol:
     LOWER("${urun}") LIKE '%sofralık%' AND LOWER("${urun}") LIKE '%üzüm%' AND LOWER("${urun}") LIKE '%çekirdekli%'
2. İL/İLÇE EŞLEŞME:
   - Yazım hatalarını düzelt: "anakara" → "ankara" olarak işle
   - "Mersin'de" → "${il}"='Mersin'
   - "Tarsus'ta" → "${ilce}"='Tarsus'
   - "Türkiye'de" → İl filtresi koyma
3. YIL KURALI:
   - Yıl yok → Otomatik ${DEFAULT_YEAR} eklenecek
   - "2023'te" → "${yil}"=2023
4. AGGREGATION:
   - SUM() kullan, "en çok" → ORDER BY DESC
5. SIRALAMA SORULARI:
   - Soru "kaçıncı" içeriyorsa:
     - TÜM İLLERİ ilgili ürünün üretim miktarına göre sırala
     - ZORUNLU OLARAK RANK() OVER (ORDER BY SUM(uretim_miktari) DESC) KULLANARAK her ilin sıralama pozisyonunu hesapla
     - İlgili ilin sıralamasını döndürmek için HAVING ile o ili filtrele
     - Sıralama sadece ilgili il için tek bir satır döndürmeli
     - HATALI OLARAK SADECE BİR İLİN ÜRETİMİNİ HESAPLAMA, TÜM İLLERİ KARŞILAŞTIR
ÖRNEKLER:
Soru: "Mersin avokado üretiminde kaçıncı"
SQL: SELECT il, RANK() OVER (ORDER BY SUM(uretim_miktari) DESC) AS siralama FROM ${TABLE} WHERE LOWER(urun_adi) LIKE '%avokado%' AND yil=${DEFAULT_YEAR} GROUP BY il HAVING il='Mersin'
Soru: "mersinn kaysı üretimi" (yazım hatalı)
İşle: "mersin kayısı üretimi" (düzeltilmiş)
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE "${il}"='Mersin' AND LOWER("${urun}") LIKE '%kayısı%'
...
ÇIKTI: Sadece SELECT sorgusu, noktalama yok.`;
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
   
    if (DEBUG_MODE) console.log('Generated SQL:', sql); // Ek hata ayıklama
    
    // Yıl otomatik ekleme
    if (sql && !sql.includes(`"${yil}"`)) {
      if (sql.includes('WHERE')) {
        sql = sql.replace(/WHERE/i, `WHERE "${yil}"=${DEFAULT_YEAR} AND`);
      } else if (sql.includes('GROUP BY') || sql.includes('ORDER BY')) {
        const match = sql.match(/\b(GROUP BY|ORDER BY)/i);
        if (match) {
          sql = sql.slice(0, match.index) + `WHERE "${yil}"=${DEFAULT_YEAR} ` + sql.slice(match.index);
        }
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
  if (!rows || rows.length === 0) {
    return 'Bu sorguya uygun veri bulunamadı.';
  }

  // Sıralama soruları için özel mantık
  if (question.toLowerCase().includes('kaçıncı') && rows.length === 1 && rows[0].siralama) {
    const sira = rows[0].siralama;
    if (DEBUG_MODE) console.log('Ranking result:', rows[0]); // Ek hata ayıklama
    return `${rows[0].il} ${sira}. sırada.`;
  } else if (question.toLowerCase().includes('kaçıncı') && (!rows[0].siralama || rows.length > 1)) {
    if (DEBUG_MODE) console.log('Ranking failed - Rows:', rows); // Ek hata ayıklama
    return 'Sıralama hesaplanamadı. Lütfen verileri kontrol edin.';
  }
 
  // Basit cevaplar için hızlı return
  if (rows.length === 1) {
    const row = rows[0];
    const keys = Object.keys(row);
   
    if (keys.length === 1) {
      const [key, value] = Object.entries(row)[0];
     
      if (value === null || value === undefined || value === 0) {
        return 'Bu sorguya uygun veri bulunamadı.';
      }
     
      if (key.includes('alan')) {
        return `${formatNumber(value)} dekar`;
      } else if (key.includes('verim')) {
        return `${formatNumber(value)} ton/dekar`;
      } else if (key.includes('uretim') || key.includes('toplam')) {
        return `${formatNumber(value)} ton`;
      }
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Sadece POST metodu desteklenir' });
  }

  // Rate limiting
  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({
      error: 'Çok fazla istek',
      detail: 'Dakikada maksimum 15 soru sorabilirsiniz. Lütfen bekleyin.'
    });
  }

  try {
    const { question } = req.body || {};

    if (!question?.trim()) {
      return res.status(400).json({ error: 'Soru parametresi gerekli' });
    }

    // Cache kontrolü (test için geçici olarak devre dışı)
    const cached = getCachedResponse(question);
    if (cached) {
      console.log(`[CACHE HIT] ${question}`);
      return res.status(200).json({
        ...cached,
        cached: true,
        processingTime: Date.now() - startTime
      });
    }

    console.log(`[${new Date().toISOString()}] IP: ${clientIP}, Soru: ${question}`);

    // SQLite initialize
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file)
    });

    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      throw new Error('Veritabanı dosyası bulunamadı');
    }

    const dbBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(dbBuffer);

    // SQL oluştur
    let sql;
    try {
      sql = await nlToSQL(question, getSchema());
      if (DEBUG_MODE) console.log('SQL:', sql);
    } catch (e) {
      return res.status(400).json({
        error: 'Soru anlayılamadı',
        detail: e.message
      });
    }

    // Güvenlik
    if (!isSafeSQL(sql)) {
      return res.status(400).json({ error: 'Güvenli olmayan sorgu' });
    }

    // SQL çalıştır
    let rows = [];
    try {
      const stmt = db.prepare(sql);
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      console.log(`Sonuç: ${rows.length} satır`);
    } catch (e) {
      console.error('SQL hatası:', e);
      return res.status(400).json({
        error: 'Sorgu çalıştırılamadı',
        detail: 'Veritabanı sorgu hatası'
      });
    } finally {
      db.close();
    }

    // Cevap oluştur
    const answer = await generateAnswer(question, rows, sql);

    const response = {
      success: true,
      answer: answer,
      data: rows.slice(0, 10),
      totalRows: rows.length,
      processingTime: Date.now() - startTime,
      debug: DEBUG_MODE ? { sql, sampleRows: rows.slice(0, 2) } : null
    };

    // Cache'e kaydet
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
