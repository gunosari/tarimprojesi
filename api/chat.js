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
const DEBUG_MODE = true;

/** ======= RATE LIMITING ======= **/
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 15;

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = rateLimitMap.get(ip) || [];
  const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
 
  if (recentRequests.length >= RATE_LIMIT_MAX) {
    return false;
  }
 
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);
 
  if (Math.random() < 0.01) {
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
const CACHE_TTL = 300000;
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

/** ======= BİLGİ NOTU OLUŞTURMA ======= **/
function createBilgiNotu(question, rows, sql) {
  if (!question.toLowerCase().includes('bilgi notu')) {
    return null;
  }
  
  const ilMatch = sql.match(/["']il["']\s*=\s*['"]([^'"]+)['"]/i) || 
                  sql.match(/il\s*=\s*['"]([^'"]+)['"]/i);
  const urunMatch = sql.match(/LIKE\s+['"]%([^%]+)%['"]/i) || 
                    sql.match(/urun_adi['"]\s*LIKE\s+['"]%([^%]+)%['"]/i);
  
  const il = ilMatch ? ilMatch[1] : 'Türkiye';
  const urun = urunMatch ? urunMatch[1] : 'Genel';
  
  const toplam = rows[0]?.toplam_uretim || rows[0]?.uretim_miktari || 0;
  const alan = rows[0]?.toplam_alan || rows[0]?.uretim_alani || 0;
  const verim = rows[0]?.verim || 0;
  
  const tarih = new Date().toLocaleDateString('tr-TR', {
    day: '2-digit',
    month: '2-digit', 
    year: 'numeric'
  });
  
  let degerlendirme = '';
  if (toplam > 1000000) {
    degerlendirme = 'Türkiye\'nin en önemli üretim merkezlerinden';
  } else if (toplam > 100000) {
    degerlendirme = 'Önemli bir üretim merkezi';
  } else if (toplam > 10000) {
    degerlendirme = 'Orta ölçekli üretici';
  } else {
    degerlendirme = 'Yerel üretici';
  }
  
  const bilgiNotu = `📋 TARIM BİLGİ NOTU
═══════════════════════
📅 Tarih: ${tarih}
📍 İl: ${il}
🌾 Ürün: ${urun.charAt(0).toUpperCase() + urun.slice(1).toLowerCase()}

📊 TEMEL GÖSTERGELER:
- Üretim: ${formatNumber(toplam)} ton
- Alan: ${formatNumber(alan)} dekar
- Verim: ${verim} kg/dekar

💡 DEĞERLENDİRME:
${il} ili ${urun} üretiminde ${degerlendirme}.

📈 VERİ KAYNAĞI:
- Yıl: ${DEFAULT_YEAR}
- Kaynak: TÜİK

─────────────────
NeoBi Tarım İstatistikleri
www.neobi.com.tr`;

  return bilgiNotu;
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
     - Önce tüm illerin üretim toplamını hesapla (subquery ile)
     - Sonra RANK() OVER (ORDER BY toplam_uretim DESC) kullanarak sıralama pozisyonunu hesapla
     - En dışta ilgili il için filtrele, böylece rank tüm illere göre doğru olsun

ÖRNEKLER:
Soru: "mersinn kaysı üretimi" (yazım hatalı)
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE "${il}"='Mersin' AND LOWER("${urun}") LIKE '%kayısı%'

Soru: "Ankara elma üretimi"
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE "${il}"='Ankara' AND (LOWER("${urun}") LIKE '%elma%' OR "${urun}" LIKE '%Elma%')

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
   
    return sql;
  } catch (e) {
    console.error('OpenAI hatası:', e.message);
    throw new Error(`GPT servisi geçici olarak kullanılamıyor: ${e.message}`);
  }
}

async function generateAnswer(question, rows, sql) {
  // Önce bilgi notu kontrolü
  const bilgiNotu = createBilgiNotu(question, rows, sql);
  if (bilgiNotu) {
    return bilgiNotu;
  }
  
  if (!rows || rows.length === 0) {
    return 'Bu sorguya uygun veri bulunamadı.';
  }
 
  if (question.toLowerCase().includes('kaçıncı') && rows.length === 1 && rows[0].siralama) {
    const sira = rows[0].siralama;
    return `${rows[0].il} ${sira}. sırada.`;
  }
 
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
   
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file)
    });
   
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      throw new Error('Veritabanı dosyası bulunamadı');
    }
   
    const dbBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(dbBuffer);
   
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
   
    if (!isSafeSQL(sql)) {
      return res.status(400).json({ error: 'Güvenli olmayan sorgu' });
    }
   
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
   
    const answer = await generateAnswer(question, rows, sql);
   
    // WhatsApp linki (bilgi notu için)
    let whatsappLink = null;
    if (question.toLowerCase().includes('bilgi notu')) {
      const encodedText = encodeURIComponent(answer);
      whatsappLink = `https://wa.me/?text=${encodedText}`;
    }
   
    const response = {
      success: true,
      answer: answer,
      data: rows.slice(0, 10),
      totalRows: rows.length,
      whatsappLink: whatsappLink,
      isBilgiNotu: question.toLowerCase().includes('bilgi notu'),
      processingTime: Date.now() - startTime,
      debug: DEBUG_MODE ? { sql, sampleRows: rows.slice(0, 2) } : null
    };
   
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
