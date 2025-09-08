// api/chat.js — GPT-Only Tarım Bot
export const config = { runtime: 'nodejs' };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ======= CONFIG ======= **/
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_YEAR = 2024;
const DEBUG_ROWS = true;
const FORCE_GPT_ONLY = true;

/** ======= UTILS ======= **/
function getSchema(db) {
  try {
    const cols = [];
    const stmt = db.prepare(`PRAGMA table_info("${TABLE}");`);
    while (stmt.step()) {
      cols.push(stmt.getAsObject().name);
    }
    stmt.free();
    
    return {
      columns: cols,
      il: cols.find(c => ['il', 'İl'].includes(c)) || 'il',
      ilce: cols.find(c => ['ilce', 'İlçe'].includes(c)) || 'ilce', 
      urun: cols.find(c => ['urun_adi', 'urun'].includes(c)) || 'urun_adi',
      yil: cols.find(c => ['yil', 'Yıl'].includes(c)) || 'yil',
      uretim: cols.find(c => ['uretim_miktari', 'uretim'].includes(c)) || 'uretim_miktari',
      alan: cols.find(c => ['uretim_alani', 'alan'].includes(c)) || 'uretim_alani',
      verim: cols.find(c => ['verim', 'Verim'].includes(c)) || 'verim',
      kategori: cols.find(c => ['urun_cesidi', 'kategori'].includes(c)) || 'urun_cesidi'
    };
  } catch (e) {
    console.error('Schema hatası:', e);
    return {
      columns: ['il', 'ilce', 'urun_adi', 'yil', 'uretim_miktari', 'uretim_alani', 'verim', 'urun_cesidi'],
      il: 'il', ilce: 'ilce', urun: 'urun_adi', yil: 'yil', 
      uretim: 'uretim_miktari', alan: 'uretim_alani', verim: 'verim', kategori: 'urun_cesidi'
    };
  }
}

function isSafeSQL(sql) {
  const s = (sql || '').trim().toLowerCase();
  if (!s.startsWith('select')) return false;
  if (s.includes('--') || s.includes('/*') || s.includes(';')) return false;
  
  const dangerous = ['drop', 'delete', 'update', 'insert', 'create', 'alter'];
  return !dangerous.some(word => s.includes(word));
}

/** ======= GPT LAYER ======= **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function nlToSQL(question, schema) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI API key eksik');
  
  const { il, ilce, urun, yil, uretim, alan, verim, kategori } = schema;
  
  const system = `SEN BİR SQL UZMANISSIN. Türkiye tarım verileri için NL→SQL çevirici.

TABLO: ${TABLE}
KOLONLAR: "${il}", "${ilce}", "${urun}", "${yil}", "${uretim}", "${alan}", "${verim}", "${kategori}"

VERİ AÇIKLAMA:
- "${uretim}": ton cinsinden üretim miktarı
- "${alan}": dekar cinsinden ekim alanı  
- "${yil}": yıl (2020-2024 arası)
- "${verim}": ton/dekar verim
- "${kategori}": Meyve/Sebze/Tahıl

KRİTİK KURALLAR:

1. ÜRÜN EŞLEŞME (ÇOK ÖNEMLİ):
   - "domates" → ("${urun}" LIKE 'Domates %' OR "${urun}" LIKE '%Domates%')
   - "biber" → ("${urun}" LIKE 'Biber %' OR "${urun}" LIKE '%Biber%') 
   - "lahana" → ("${urun}" LIKE 'Lahana %' OR "${urun}" LIKE '%Lahana%')
   - "üzüm" → ("${urun}" LIKE 'Üzüm %' OR "${urun}" LIKE '%Üzüm%')
   - Genel: Ürün adının baş harfini büyük yap, hem başlangıç hem içinde ara

2. İL EŞLEŞME:
   - "Mersin'de" = "Mersinde" = "Mersin ili" → "${il}"='Mersin'
   - "Adana'da" → "${il}"='Adana'
   - "Türkiye" = "Türkiye'de" → HİÇBİR İL FİLTRESİ KOYMA

3. YIL KURALI:
   - Yıl belirtilmemişse → HİÇBİR YIL FİLTRESİ KOYMA (otomatik 2024 eklenecek)
   - "2022'de" → "${yil}"=2022

4. TOPLAM KURALI:
   - MUTLAKA SUM() kullan: SUM("${uretim}"), SUM("${alan}")
   - Tek satır değeri değil, toplamları hesapla

ÖRNEK SQL'LER:

Soru: "Mersin'de domates üretimi"
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE "${il}"='Mersin' AND ("${urun}" LIKE 'Domates %' OR "${urun}" LIKE '%Domates%')

Soru: "Adana'da en çok üretilen 5 ürün"
SQL: SELECT "${urun}", SUM("${uretim}") AS toplam FROM ${TABLE} WHERE "${il}"='Adana' GROUP BY "${urun}" ORDER BY toplam DESC LIMIT 5

Soru: "Türkiye'de biber üretimi"
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE ("${urun}" LIKE 'Biber %' OR "${urun}" LIKE '%Biber%')

Soru: "Antalya'da domates en çok hangi ilçelerde"
SQL: SELECT "${ilce}", SUM("${uretim}") AS toplam FROM ${TABLE} WHERE "${il}"='Antalya' AND ("${urun}" LIKE 'Domates %' OR "${urun}" LIKE '%Domates%') GROUP BY "${ilce}" ORDER BY toplam DESC

ÇIKTI FORMAT:
- Sadece SQL döndür, açıklama yok
- Tek SELECT sorgusu
- Noktalı virgül kullanma`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Soru: "${question}"\n\nYukarıdaki kurallara göre SQL oluştur.` }
      ],
      temperature: 0,
      max_tokens: 300
    });
    
    let sql = (response.choices[0].message.content || '')
      .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,''))
      .trim()
      .replace(/;+\s*$/, '');
    
    // Yıl otomatik ekleme
    if (sql && !sql.includes(`"${yil}"`)) {
      if (sql.includes('WHERE')) {
        sql = sql.replace(/WHERE/i, `WHERE "${yil}"=${DEFAULT_YEAR} AND `);
      } else if (sql.includes('GROUP BY') || sql.includes('ORDER BY')) {
        const match = sql.match(/\b(GROUP BY|ORDER BY)/i);
        const index = match.index;
        sql = `${sql.slice(0, index)}WHERE "${yil}"=${DEFAULT_YEAR} ${sql.slice(index)}`;
      } else {
        sql += ` WHERE "${yil}"=${DEFAULT_YEAR}`;
      }
    }
    
    return sql;
  } catch (e) {
    console.error('GPT hatası:', e);
    throw e;
  }
}

async function generateAnswer(question, rows) {
  if (!rows?.length) return 'Veri bulunamadı.';
  
  if (!process.env.OPENAI_API_KEY) {
    if (rows.length === 1) {
      const entries = Object.entries(rows[0]);
      if (entries.length === 1) {
        const [key, value] = entries[0];
        return `${key}: ${Number(value || 0).toLocaleString('tr-TR')} ton`;
      }
    }
    return `${rows.length} sonuç bulundu.`;
  }
  
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{
        role: 'system',
        content: 'Kısa Türkçe cevap ver. Sayıları binlik ayraçla yaz. 1-2 cümle max.'
      }, {
        role: 'user', 
        content: `Soru: ${question}\nVeri: ${JSON.stringify(rows.slice(0,3))}\nSatır: ${rows.length}`
      }],
      temperature: 0,
      max_tokens: 100
    });
    
    return response.choices[0].message.content?.trim() || `${rows.length} sonuç bulundu.`;
  } catch (e) {
    return `${rows.length} sonuç bulundu.`;
  }
}

/** ======= MAIN HANDLER ======= **/
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Sadece POST' });
  
  try {
    const { question } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'Soru gerekli' });
    
    console.log(`[${new Date().toISOString()}] Soru: ${question}`);
    
    // DB başlat
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file)
    });
    
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      return res.status(500).json({ error: 'DB bulunamadı' });
    }
    
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const schema = getSchema(db);
    
    // GPT ile SQL üret
    let sql;
    try {
      sql = await nlToSQL(question, schema);
    } catch (e) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(400).send(`GPT hatası: ${e.message}\nLütfen sorunuzu farklı formüle edin.`);
    }
    
    // Güvenlik kontrolü
    if (!sql || !isSafeSQL(sql)) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(400).send(`Güvenli olmayan SQL: ${sql}\nLütfen sorunuzu farklı formüle edin.`);
    }
    
    // SQL çalıştır
    let rows = [];
    try {
      console.log('SQL:', sql);
      const stmt = db.prepare(sql);
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
    } catch (e) {
      console.error('SQL hatası:', e);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(400).send(`SQL hatası: ${e.message}\n\nSQL: ${sql}`);
    }
    
    // Cevap oluştur
    const answer = await generateAnswer(question, rows);
    const debug = DEBUG_ROWS ? `\n\nDEBUG:\nSQL: ${sql}\nSonuç: ${rows.length} satır` : '';
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(`${answer}\n\n${JSON.stringify(rows.slice(0,5), null, 2)}${debug}`);
    
  } catch (err) {
    console.error('Genel hata:', err);
    res.status(500).json({ error: 'Sunucu hatası', detail: String(err) });
  }
}
