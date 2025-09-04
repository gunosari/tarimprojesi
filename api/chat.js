// api/chat.js — NL→SQL (GPT + kural yedek), optimize edilmiş tutarlı versiyon
export const config = { runtime: 'nodejs' };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ======= Ayarlar ======= **/
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_YEAR = 2024;
const AUTO_INJECT_DEFAULT_YEAR = true;
const FORCE_GPT_ONLY = false;
const DEBUG_ROWS = true;

/** ======= Yardımcılar ======= **/
const escapeSQL = (s = '') => String(s).replace(/'/g, "''");
function qToText(rows, lineFmt) {
  if (!rows || rows.length === 0) return 'Veri bulunamadı.';
  return rows.map(lineFmt).join('\n');
}

// PRAGMA ile tablo kolonlarını oku (dinamik şema)
function getColumns(SQL, db) {
  try {
    const out = [];
    const stmt = db.prepare(`PRAGMA table_info("${TABLE}");`);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      out.push(row.name);
    }
    stmt.free();
    
    let catCol = null;
    if (out.includes('urun_cesidi')) catCol = 'urun_cesidi';
    else if (out.includes('kategori')) catCol = 'kategori';
    
    return { columns: out, catCol };
  } catch (e) {
    console.error('Şema okuma hatası:', e);
    return {
      columns: ['il', 'ilce', 'urun_cesidi', 'urun_adi', 'yil', 'uretim_alani', 'uretim_miktari', 'verim'],
      catCol: 'urun_cesidi'
    };
  }
}

// Güvenlik filtresi
function makeIsSafeSql(allowedNames) {
  const allow = new Set([...allowedNames.map(s => s.toLowerCase()), TABLE]);
  
  return (sql) => {
    const s = (sql || '').trim().toLowerCase();
    if (!s.startsWith('select')) return false;
    if (s.includes('--') || s.includes('/*')) return false;
    if (s.includes(';')) return false;
    
    const sqlKeywords = [
      'select', 'sum', 'avg', 'count', 'min', 'max', 'round', 'case', 'when', 'then', 'else', 'end',
      'from', 'where', 'and', 'or', 'group', 'by', 'order', 'desc', 'asc', 'limit', 'as', 
      'having', 'like', 'between', 'in', 'distinct', 'null', 'not', 'is'
    ];
    
    const tokens = s.replace(/[^a-z0-9_ğüşöçıİĞÜŞÖÇ" ]/gi, ' ')
                   .split(/\s+/)
                   .filter(t => t.length > 0);
    
    for (const token of tokens) {
      if (/^\d+(\.\d+)?$/.test(token)) continue;
      if (/^'.*'$/.test(token)) continue;
      
      if (/^[a-zıiöüçğ_"]+$/i.test(token)) {
        const cleanToken = token.replace(/"/g, '');
        if (!allow.has(cleanToken) && !sqlKeywords.includes(cleanToken)) {
          return false;
        }
      }
    }
    
    return true;
  };
}

/** ======= GPT Katmanı ======= **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// AKILLI ürün eşleşme - spesifik çeşit vs genel ürün
function headMatchExpr(raw, urunCol = 'urun_adi') {
  const rawText = String(raw || '').trim();
  const product = rawText.toLowerCase();
  
  // TÜİK çok çeşitli ürünler
  const multiVarietyProducts = [
    'biber', 'domates', 'hıyar', 'kabak', 'lahana', 'marul', 'soğan', 'sarımsak', 
    'turp', 'kereviz', 'elma', 'portakal', 'mandalina', 'üzüm', 'fasulye', 'bakla', 
    'bezelye', 'börülce', 'mercimek', 'mısır', 'arpa', 'yulaf', 'çavdar',
    'pamuk', 'ayçiçeği', 'şeker', 'fiğ', 'yonca', 'haşhaş', 'buğday'
  ];
  
  // SPESIFIK ÇEŞIT KONTROLÜ
  // Eğer 2+ kelimeli bir isimse (Yafa Portakal, Durum Buğdayı), tam eşleşme yap
  if (rawText.includes(' ') || rawText.length > 8) {
    return `"${urunCol}" LIKE '%${escapeSQL(rawText)}%'`;
  }
  
  // GENEL ÜRÜN İSMI - çeşitli ürünse geniş ara
  if (multiVarietyProducts.includes(product)) {
    const productCapitalized = product.charAt(0).toUpperCase() + product.slice(1);
    return `("${urunCol}" LIKE '${escapeSQL(productCapitalized)} %' OR "${urunCol}" LIKE '%${escapeSQL(productCapitalized)}%')`;
  }
  
  // Diğer ürünler için dar arama
  const head = rawText.charAt(0).toUpperCase() + rawText.slice(1).toLowerCase();
  return `("${urunCol}" LIKE '${escapeSQL(head)} %' OR "${urunCol}"='${escapeSQL(head)}')`;
}

function autoYear(sql, yilCol = 'yil') {
  if (!AUTO_INJECT_DEFAULT_YEAR) return sql;
  if (!sql) return sql;
  
  const hasWhere = /where/i.test(sql);
  const hasYear = new RegExp(`"${yilCol}"\\s*=`).test(sql);
  
  if (hasYear) return sql;
  
  if (hasWhere) {
    return sql.replace(/where/i, `WHERE "${yilCol}" = ${DEFAULT_YEAR} AND `);
  } else {
    const m = sql.match(/\b(order|group|limit)\b/i);
    if (!m) return `${sql} WHERE "${yilCol}" = ${DEFAULT_YEAR}`;
    const idx = m.index;
    return `${sql.slice(0, idx)} WHERE "${yilCol}" = ${DEFAULT_YEAR} ${sql.slice(idx)}`;
  }
}

// TUTARLILIK İÇİN GELİŞTİRİLMİŞ GPT PROMPT
async function nlToSql_gpt(nl, schema) {
  if (!process.env.OPENAI_API_KEY) return '';
  
  const { columns, catCol } = schema;
  
  const ilCol = columns.find(c => ['il', 'İl', 'province'].includes(c)) || 'il';
  const ilceCol = columns.find(c => ['ilce', 'İlçe', 'district'].includes(c)) || 'ilce';
  const urunCol = columns.find(c => ['urun_adi', 'urun', 'Ürün', 'product'].includes(c)) || 'urun_adi';
  const yilCol = columns.find(c => ['yil', 'Yıl', 'year'].includes(c)) || 'yil';
  const uretimCol = columns.find(c => ['uretim_miktari', 'uretim', 'Üretim', 'production'].includes(c)) || 'uretim_miktari';
  const alanCol = columns.find(c => ['uretim_alani', 'alan', 'Alan', 'area'].includes(c)) || 'uretim_alani';
  
  // TUTARLILIK İÇİN SIKI KURALLAR
  const system = `Sen bir SQLite SQL uzmanısın. MUTLAKA şu kurallara uy:

TABLO: ${TABLE}("${columns.join('","')}")

ZORUNLU KURALLAR:
1. İl filtreleri: SADECE "${ilCol}" = 'İlAdı' kullan
2. Ürün filtreleri: SADECE ("${urunCol}" LIKE 'Ürün %' OR "${urunCol}" LIKE '%Ürün%')
3. MUTLAKA SUM() kullan: SUM("${uretimCol}"), SUM("${alanCol}")
4. Yıl yok ise 2024 kullan: "${yilCol}" = 2024
5. İlçe sorguları: "${ilceCol}" ile GROUP BY yap
6. En çok üretilen: GROUP BY "${urunCol}" ORDER BY SUM("${uretimCol}") DESC
7. Noktalı virgül kullanma, tek SELECT

ÖRNEKLER:
"Mersin lahana üretimi" → SELECT SUM("uretim_miktari") AS toplam FROM urunler WHERE "il"='Mersin' AND ("urun_adi" LIKE 'Lahana %' OR "urun_adi" LIKE '%Lahana%') AND "yil"=2024

"Antalya domates hangi ilçelerde" → SELECT "ilce", SUM("uretim_miktari") FROM urunler WHERE "il"='Antalya' AND ("urun_adi" LIKE 'Domates %' OR "urun_adi" LIKE '%Domates%') AND "yil"=2024 GROUP BY "ilce" ORDER BY SUM("uretim_miktari") DESC LIMIT 10`;

  const user = `SORU: ${nl}

SADECE SQL döndür, açıklama yok:`;

  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system }, 
        { role: 'user', content: user }
      ],
      temperature: 0, // TUTARLILIK İÇİN 0
      max_tokens: 300
    });
    
    let sql = (r.choices[0].message.content || '')
      .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,''))
      .trim()
      .replace(/;+\s*$/,'');
    
    // Post-processing - ürün eşleşmelerini düzelt
    sql = sql.replace(new RegExp(`"${urunCol}"\\s*=\\s*'([^']+)'`, 'gi'), (_m, val) => headMatchExpr(val, urunCol));
    sql = autoYear(sql, yilCol);
    
    return sql;
  } catch (e) {
    console.error('GPT hatası:', e);
    return '';
  }
}

// YEDEK KURAL SİSTEMİ (basit ama etkili)
function ruleBasedSql(nlRaw, schema) {
  const nl = String(nlRaw || '').trim().toLowerCase();
  const { columns, catCol } = schema;
  
  const ilCol = 'il';
  const ilceCol = 'ilce';
  const urunCol = 'urun_adi';
  const yilCol = 'yil';
  const uretimCol = 'uretim_miktari';
  const alanCol = 'uretim_alani';
  
  // Basit pattern matching - sadece açık sorgular için
  
  // "Mersin lahana" gibi basit sorgular
  if (nl.includes('mersin') && nl.includes('lahana') && nl.includes('üretim')) {
    return `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE} WHERE "${ilCol}"='Mersin' AND ("${urunCol}" LIKE 'Lahana %' OR "${urunCol}" LIKE '%Lahana%') AND "${yilCol}"=2024`;
  }
  
  // Diğer yaygın kombinasyonları buraya ekleyebilirsin
  
  return ''; // GPT'ye bırak
}

// Güzel cevap
async function prettyAnswer(question, rows) {
  if (!process.env.OPENAI_API_KEY) {
    if (!rows?.length) return 'Veri bulunamadı.';
    if (rows.length === 1) {
      const entries = Object.entries(rows[0]);
      if (entries.length === 1) {
        const [key, value] = entries[0];
        return `${key}: ${Number(value || 0).toLocaleString('tr-TR')}`;
      }
    }
    return `${rows.length} sonuç bulundu.`;
  }
  
  const sample = Array.isArray(rows) ? rows.slice(0, 3) : [];
  
  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { 
          role: 'system', 
          content: 'Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcıyla yaz. 1-2 cümle max.' 
        },
        { 
          role: 'user', 
          content: `Soru: ${question}\nVeri: ${JSON.stringify(sample)}\nSatır: ${rows.length}\nÖzet:` 
        }
      ],
      temperature: 0,
      max_tokens: 100
    });
    
    return (r.choices[0].message.content || '').trim();
  } catch (e) {
    return `${rows.length} sonuç bulundu.`;
  }
}

/** ======= Handler ======= **/
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Sadece POST isteklerine izin verilir' }); 
      return;
    }
    
    const { question } = req.body || {};
    const raw = String(question ?? '').trim();
    if (!raw) { 
      res.status(400).json({ ok: false, error: 'question alanı zorunlu' }); 
      return; 
    }
    
    // sql.js başlat
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });
    
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) { 
      res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' }); 
      return; 
    }
    
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const schema = getColumns(SQL, db);
    const isSafeSql = makeIsSafeSql([TABLE, ...schema.columns.map(c => `"${c}"`)]);
    
    // 1) GPT ile dene (tutarlılık için optimize edildi)
    let used = 'nl2sql-gpt', gptErr = '', sql = '';
    
    try {
      sql = await nlToSql_gpt(raw, schema);
    } catch (e) {
      gptErr = `${e?.status || e?.code || ''} ${e?.message || String(e)}`;
      used = 'fallback-rules';
    }
    
    // 2) Güvenli değilse kural tabanlı
    if (!sql || !isSafeSql(sql)) {
      const rb = ruleBasedSql(raw, schema);
      if (rb && isSafeSql(rb)) { 
        sql = rb; 
        used = 'rules'; 
      }
    }
    
    // 3) Son çare fallback
    if (!sql) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`❌ Sorgu işlenemedi: "${raw}"\n\nÖrnek format: "[İl] [ürün] üretimi" veya "[İl] en çok üretilen ürünler"`);
      return;
    }
    
    // 4) SQL çalıştır
    let rows = [];
    try {
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      db.close();
    } catch (e) {
      console.error('SQL çalıştırma hatası:', e);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: ${used}\nSQL hatası: ${String(e)}\nSQL: ${sql}`);
      return;
    }
    
    // 5) Sonuç
    const nice = await prettyAnswer(raw, rows);
    const debugText = DEBUG_ROWS
      ? `\n\n-- DEBUG --\nSQL: ${sql}\nSatır: ${rows.length}`
      : '';
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(
      `🧭 Mod: ${used}${gptErr ? ` | GPT hata: ${gptErr}` : ''}\n` +
      `Soru: ${raw}\n\n${nice}\n\n` +
      (rows.length ? qToText(rows, r => '• ' + JSON.stringify(r)) : 'Veri bulunamadı.') +
      debugText
    );
    
  } catch (err) {
    console.error('API hata:', err);
    res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
