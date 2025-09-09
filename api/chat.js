// api/chat.js — Türkiye Tarım Veritabanı Chatbot
export const config = { runtime: 'nodejs' };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ======= CONFIG ======= **/
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DEFAULT_YEAR = 2024;
const DEBUG_MODE = true;

/** ======= UTILS ======= **/
function getSchema() {
  // Veritabanı kolonları sabit olduğu için direkt döndürüyoruz
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
  
  // SQL injection koruması
  const dangerous = ['drop', 'delete', 'update', 'insert', 'create', 'alter', 'exec', 'execute'];
  return !dangerous.some(word => s.includes(word));
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString('tr-TR');
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

KRİTİK KURALLAR:

1. ÜRÜN EŞLEŞME:
   - Ürünler veritabanında şu formatlarda: "Elma Golden", "Elma Starking", "Domates Sofralık", "Biber Sivri"
   - "elma" sorgusu → "${urun}" LIKE '%elma%' (case insensitive için LOWER kullan)
   - "domates" → LOWER("${urun}") LIKE '%domates%'
   - "biber" → LOWER("${urun}") LIKE '%biber%'
   - Özel çeşit belirtilmişse: "golden elma" → "${urun}" LIKE '%Golden%'

2. İL/İLÇE EŞLEŞME:
   - "Mersin'de", "Mersinde", "Mersin ili" → "${il}"='Mersin'
   - "Adana'da" → "${il}"='Adana'
   - İlçe: "Tarsus'ta" → "${ilce}"='Tarsus'
   - "Türkiye geneli", "Türkiye'de" → İL FİLTRESİ KOYMA

3. YIL KURALI:
   - Yıl belirtilmemişse → HİÇBİR YIL FİLTRESİ KOYMA (kod otomatik ekleyecek)
   - "2023'te", "2023 yılında" → "${yil}"=2023
   - "son 3 yıl" → "${yil}" IN (2022, 2023, 2024)

4. AGGREGATION KURALLARI:
   - Üretim/alan soruları için her zaman SUM() kullan
   - "en çok", "en fazla" → ORDER BY ... DESC
   - "en az" → ORDER BY ... ASC
   - "ilk 5", "top 10" → LIMIT 5, LIMIT 10

ÖRNEKLER:

Soru: "Mersin'de elma üretimi"
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE "${il}"='Mersin' AND LOWER("${urun}") LIKE '%elma%'

Soru: "Antalya'da en çok üretilen 5 ürün"
SQL: SELECT "${urun}", SUM("${uretim}") AS toplam FROM ${TABLE} WHERE "${il}"='Antalya' GROUP BY "${urun}" ORDER BY toplam DESC LIMIT 5

Soru: "Türkiye'de domates üretimi"
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE LOWER("${urun}") LIKE '%domates%'

Soru: "Tarsus'ta sebze üretimi"
SQL: SELECT SUM("${uretim}") AS toplam FROM ${TABLE} WHERE "${ilce}"='Tarsus' AND "${kategori}"='Sebze'

Soru: "2023 yılında Adana'da meyve üretim alanı"
SQL: SELECT SUM("${alan}") AS toplam_alan FROM ${TABLE} WHERE "${il}"='Adana' AND "${kategori}"='Meyve' AND "${yil}"=2023

Soru: "Mersinde mi Adana da mı biber üretimi fazla"
SQL: SELECT "${il}", SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE ("${il}"='Mersin' OR "${il}"='Adana') AND LOWER("${urun}") LIKE '%biber%' GROUP BY "${il}" ORDER BY toplam_uretim DESC

ÇIKTI:
- Sadece SELECT sorgusu döndür
- Açıklama veya yorum ekleme
- Noktalı virgül kullanma`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Soru: "${question}"\n\nSQL sorgusu oluştur:` }
      ],
      temperature: 0,
      max_tokens: 300
    });
    
    let sql = (response.choices[0].message.content || '')
      .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').trim())
      .trim()
      .replace(/;+\s*$/, '');
    
    // Yıl belirtilmemişse otomatik ekle
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
    console.error('GPT SQL üretim hatası:', e);
    throw new Error('SQL sorgusu oluşturulamadı');
  }
}

async function generateAnswer(question, rows, sql) {
  if (!rows || rows.length === 0) {
    return 'Bu sorguya uygun veri bulunamadı.';
  }
  
  // Karşılaştırma soruları için özel mantık
  const isComparison = question.toLowerCase().includes(' mi ') || 
                       question.toLowerCase().includes(' mı ') ||
                       question.toLowerCase().includes(' mu ') ||
                       question.toLowerCase().includes(' mü ') ||
                       question.toLowerCase().includes('fazla') ||
                       question.toLowerCase().includes('daha') ||
                       question.toLowerCase().includes('hangi');
  
  // Basit tek değerli sonuçlar için
  if (rows.length === 1) {
    const row = rows[0];
    const keys = Object.keys(row);
    
    if (keys.length === 1) {
      const [key, value] = Object.entries(row)[0];
      
      // Önce alan kontrolü - daha spesifik
      if (key.includes('alan')) {
        return `${formatNumber(value)} dekar`;
      } else if (key.includes('verim')) {
        return `${formatNumber(value)} ton/dekar`;
      } else if (key.includes('uretim') || key.includes('toplam')) {
        return `${formatNumber(value)} ton`;
      }
      return formatNumber(value);
    }
    
    // Karşılaştırma sorularında tek sonuç varsa özel mesaj
    if (isComparison && row.il) {
      const value = row.toplam_uretim || row.toplam || row.toplam_alan;
      if (value) {
        return `${row.il} ilinde üretim mevcut: ${formatNumber(value)} ${key.includes('alan') ? 'dekar' : 'ton'}. Diğer il/illerde bu ürünün üretimi bulunmuyor.`;
      }
    }
  }
  
  // GPT ile cevap oluştur
  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [{
          role: 'system',
          content: `Tarım verileri uzmanısın. Kısa, net Türkçe cevaplar ver. 
                    Sayıları binlik ayraçla yaz. Birimler: üretim=ton, alan=dekar, verim=ton/dekar.
                    Maximum 2-3 cümle kullan.
                    
                    ÖZEL KURALLARI:
                    - Karşılaştırma sorularında (mi/mı, fazla, daha, hangi) net karşılaştırma yap
                    - Tek sonuç varsa diğer yerlerde üretim olmadığını belirt
                    - "Veriye göre" gibi gereksiz ifadeler kullanma`
        }, {
          role: 'user',
          content: `Soru: ${question}
                    Veri (ilk 10 satır): ${JSON.stringify(rows.slice(0, 10))}
                    Toplam satır: ${rows.length}`
        }],
        temperature: 0,
        max_tokens: 150
      });
      
      return response.choices[0].message.content?.trim() || formatDefaultAnswer(rows);
    } catch (e) {
      console.error('GPT cevap hatası:', e);
      return formatDefaultAnswer(rows);
    }
  }
  
  return formatDefaultAnswer(rows);
}

function formatDefaultAnswer(rows) {
  console.log('formatDefaultAnswer çağrıldı, rows:', rows?.length);
  
  if (rows.length === 1) {
    return JSON.stringify(rows[0], null, 2);
  }
  return `${rows.length} sonuç bulundu. İlk 5 sonuç:\n${JSON.stringify(rows.slice(0, 5), null, 2)}`;
}

/** ======= MAIN HANDLER ======= **/
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Sadece POST metodu desteklenir' });
  }
  
  try {
    const { question } = req.body || {};
    
    if (!question?.trim()) {
      return res.status(400).json({ error: 'Soru parametresi gerekli' });
    }
    
    console.log(`[${new Date().toISOString()}] Soru: ${question}`);
    
    // Özel debug: "hangi ilde" pattern'i
    if (question.toLowerCase().includes('hangi ilde')) {
      console.log('*** HANGİ İLDE pattern algılandı ***');
    }
    
    // SQLite başlat
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file)
    });
    
    // Veritabanı dosyasını kontrol et
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      console.error('Veritabanı bulunamadı:', dbPath);
      return res.status(500).json({ error: 'Veritabanı dosyası bulunamadı' });
    }
    
    // Veritabanını aç
    const dbBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(dbBuffer);
    
    // Schema bilgisini al
    const schema = getSchema();
    
    // SQL oluştur
    let sql;
    try {
      sql = await nlToSQL(question, schema);
      console.log('Oluşturulan SQL:', sql);
    } catch (e) {
      return res.status(400).json({ 
        error: 'SQL sorgusu oluşturulamadı', 
        detail: e.message 
      });
    }
    
    // Güvenlik kontrolü
    if (!sql || !isSafeSQL(sql)) {
      return res.status(400).json({ 
        error: 'Güvenli olmayan SQL sorgusu',
        sql: sql
      });
    }
    
    // SQL'i çalıştır
    let rows = [];
    try {
      const stmt = db.prepare(sql);
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      console.log(`Sonuç: ${rows.length} satır bulundu`);
    
    // Eğer lahana sorgusu ise ve sonuç varsa, detayları göster
    if (DEBUG_MODE && sql.includes('Lahana %') && rows.length > 0) {
      console.log('Lahana sorgusu sonucu:', rows[0]);
    }
    } catch (e) {
      console.error('SQL çalıştırma hatası:', e);
      return res.status(400).json({ 
        error: 'SQL sorgusu çalıştırılamadı',
        detail: e.message,
        sql: sql
      });
    } finally {
      db.close();
    }
    
    // Cevap oluştur
    const       answer = await generateAnswerNew(question, rows, sql);
    
    // Debug bilgisi
    const debugInfo = DEBUG_MODE ? {
      sql: sql,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 3)
    } : null;
    
    // Yanıt gönder
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({
      success: true,
      answer: answer,
      data: rows.slice(0, 10), // İlk 10 satır
      totalRows: rows.length,
      debug: debugInfo
    });
    
  } catch (error) {
    console.error('Genel hata:', error);
    res.status(500).json({ 
      error: 'Sunucu hatası', 
      detail: error.message 
    });
  }
}
