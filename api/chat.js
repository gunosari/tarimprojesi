// api/chat.js — NL→SQL (GPT + kural yedek), 2024 oto-yıl, ürün başta-eşleşme, debug görünür
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

// Cache sistemi
const queryCache = new Map();
const MAX_CACHE_SIZE = 300;

/** ======= Yardımcılar ======= **/
const escapeSQL = (s = '') => String(s).replace(/'/g, "''");

function qToText(rows, lineFmt) {
  if (!rows || rows.length === 0) return 'Veri bulunamadı.';
  return rows.map(lineFmt).join('\n');
}

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
    else if (out.includes('Kategori')) catCol = 'Kategori';
    
    return { columns: out, catCol };
  } catch (e) {
    console.error('Şema okuma hatası:', e);
    return {
      columns: ['il', 'ilce', 'urun_cesidi', 'urun_adi', 'yil', 'uretim_alani', 'uretim_miktari', 'verim'],
      catCol: 'urun_cesidi'
    };
  }
}

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
          console.log('🚫 Güvensiz token:', token);
          return false;
        }
      }
    }
    
    return true;
  };
}

/** ======= Hibrit Ürün Eşleştirme ======= **/
function headMatchExpr(raw, urunCol = 'urun_adi') {
  const product = String(raw || '').trim().toLowerCase();
  
  const multiVarietyProducts = [
    'biber', 'domates', 'hıyar', 'kabak', 'lahana', 'marul', 'soğan', 'sarımsak', 
    'turp', 'kereviz', 'elma', 'portakal', 'mandalina', 'üzüm', 'fasulye', 
    'bakla', 'bezelye', 'börülce', 'mercimek', 'mısır', 'arpa', 'yulaf', 
    'çavdar', 'pamuk', 'ayçiçeği', 'şeker', 'fiğ', 'yonca', 'haşhaş'
  ];
  
  if (multiVarietyProducts.includes(product)) {
    const productCapitalized = product.charAt(0).toUpperCase() + product.slice(1);
    return `("${urunCol}" LIKE '${escapeSQL(productCapitalized)} %' OR "${urunCol}" LIKE '%${escapeSQL(productCapitalized)}%')`;
  }
  
  const head = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
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

/** ======= Gelişmiş Kural Tabanlı Sistem ======= **/
function ruleBasedSql(nlRaw, schema) {
  const nl = String(nlRaw || '').trim().toLowerCase();
  const { columns, catCol } = schema;
  
  console.log(`🔍 Kural analizi başlıyor: "${nlRaw}"`);
  
  // Dinamik kolon tespiti
  const ilCol = columns.find(c => ['il', 'İl', 'province'].includes(c)) || 'il';
  const ilceCol = columns.find(c => ['ilce', 'İlçe', 'district'].includes(c)) || 'ilce';
  const urunCol = columns.find(c => ['urun_adi', 'urun', 'Ürün', 'product'].includes(c)) || 'urun_adi';
  const yilCol = columns.find(c => ['yil', 'Yıl', 'year'].includes(c)) || 'yil';
  const uretimCol = columns.find(c => ['uretim_miktari', 'uretim', 'Üretim', 'production'].includes(c)) || 'uretim_miktari';
  const alanCol = columns.find(c => ['uretim_alani', 'alan', 'Alan', 'area'].includes(c)) || 'uretim_alani';
  const verimCol = columns.find(c => ['verim', 'Verim', 'yield'].includes(c)) || 'verim';
  
  // İl tespit et - daha geniş pattern
  let il = '';
  const ilPatterns = [
    /([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:\s+il[inde]*|[''`´]?[dt]e|[''`´]?[dt]a|\s|$)/,
    /([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:'de|'da|'te|'ta|de|da|te|ta)/,
    /([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:\s+ili|\s|$)/
  ];
  
  for (const pattern of ilPatterns) {
    const match = nlRaw.match(pattern);
    if (match) {
      il = match[1];
      break;
    }
  }
  
  // Yıl tespit et
  const yearMatch = nl.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : '';
  
  // Ürün tespit et - genişletilmiş liste
  const knownProducts = [
    'domates', 'biber', 'patlıcan', 'kabak', 'hıyar', 'salatalık', 'karpuz', 
    'karnabahar', 'lahana', 'marul', 'fasulye', 'soğan', 'sarımsak', 'patates', 
    'brokoli', 'ispanak', 'maydanoz', 'enginar', 'bezelye', 'bakla', 'elma', 
    'portakal', 'mandalina', 'limon', 'muz', 'zeytin', 'üzüm', 'armut', 
    'şeftali', 'kayısı', 'nar', 'incir', 'vişne', 'çilek', 'kiraz', 'kavun', 
    'ayva', 'fındık', 'ceviz', 'antep fıstığı', 'buğday', 'arpa', 'mısır', 
    'çeltik', 'pirinç', 'yulaf', 'çavdar', 'ayçiçeği', 'kanola', 'pamuk'
  ];
  
  let urun = '';
  for (const product of knownProducts) {
    if (nl.includes(product)) {
      urun = product;
      break;
    }
  }
  
  // Kategori tespit et
  let kat = '';
  if (/meyve|meyva/i.test(nl)) kat = 'Meyve';
  else if (/tah[ıi]l/i.test(nl)) kat = 'Tahıl';  
  else if (/sebze/i.test(nl)) kat = 'Sebze';
  else if (/baklagil/i.test(nl)) kat = 'Baklagil';
  
  console.log(`🔍 Tespit edilen: il="${il}", urun="${urun}", kat="${kat}", yil="${year}"`);
  
  // WHERE koşulları oluştur
  const conditions = [];
  
  if (il) conditions.push(`"${ilCol}" = '${escapeSQL(il)}'`);
  if (year) conditions.push(`"${yilCol}" = ${Number(year)}`);
  if (kat && catCol) conditions.push(`"${catCol}" = '${escapeSQL(kat)}'`);
  
  // 1. TEMEL TÜRKIYE GENELİ SORGULAR
  if (!il && /türkiye|toplam|genel/i.test(nl)) {
    if (urun) {
      // "Türkiye'de domates üretimi"
      const likeExpr = headMatchExpr(urun, urunCol);
      conditions.push(likeExpr);
      let sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      return autoYear(sql, yilCol);
    } else if (kat) {
      // "Türkiye'de sebze üretimi"
      let sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      return autoYear(sql, yilCol);
    } else {
      // "Türkiye toplam üretim"
      let sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      return autoYear(sql, yilCol);
    }
  }
  
  // 2. İL BAZLI SORGULAR
  if (il) {
    // İl + ürün
    if (urun) {
      const likeExpr = headMatchExpr(urun, urunCol);
      conditions.push(likeExpr);
      
      if (/ilçe|bölge|nerede/i.test(nl)) {
        // "Mersin'de domates hangi ilçelerde üretiliyor?"
        let sql = `SELECT "${ilceCol}", SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE}`;
        if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
        sql += ` GROUP BY "${ilceCol}" ORDER BY toplam_uretim DESC`;
        return autoYear(sql, yilCol);
      } else {
        // "Mersin domates üretimi"
        let sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
        if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
        return autoYear(sql, yilCol);
      }
    }
    
    // İl + kategori
    else if (kat) {
      if (/ilçe|bölge|nerede/i.test(nl)) {
        // "Mersin'de sebze hangi ilçelerde üretiliyor?"
        let sql = `SELECT "${ilceCol}", SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE}`;
        if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
        sql += ` GROUP BY "${ilceCol}" ORDER BY toplam_uretim DESC`;
        return autoYear(sql, yilCol);
      } else {
        // "Mersin sebze üretimi"
        let sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
        if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
        return autoYear(sql, yilCol);
      }
    }
    
    // Sadece il
    else {
      if (/en çok|hangi.*üretil|çeşit/i.test(nl)) {
        // "Mersin'de en çok hangi ürün üretiliyor?"
        let sql = `SELECT "${urunCol}", SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE}`;
        if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
        sql += ` GROUP BY "${urunCol}" ORDER BY toplam_uretim DESC LIMIT 10`;
        return autoYear(sql, yilCol);
      } else if (/alan|ekim/i.test(nl)) {
        // "Mersin toplam ekim alanı"
        let sql = `SELECT SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
        if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
        return autoYear(sql, yilCol);
      } else {
        // "Mersin toplam üretim"
        let sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
        if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
        return autoYear(sql, yilCol);
      }
    }
  }
  
  // 3. SADECE ÜRÜN SORGUSU
  if (urun && !il) {
    const likeExpr = headMatchExpr(urun, urunCol);
    conditions.push(likeExpr);
    
    if (/hangi.*il|nerede.*üretil/i.test(nl)) {
      // "Domates hangi illerde üretiliyor?"
      let sql = `SELECT "${ilCol}", SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE}`;
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      sql += ` GROUP BY "${ilCol}" ORDER BY toplam_uretim DESC LIMIT 10`;
      return autoYear(sql, yilCol);
    } else {
      // "Domates üretimi"
      let sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      return autoYear(sql, yilCol);
    }
  }
  
  // 4. SADECE KATEGORİ SORGUSU
  if (kat && !il && !urun) {
    if (/hangi.*il|nerede.*üretil/i.test(nl)) {
      // "Sebze hangi illerde üretiliyor?"
      let sql = `SELECT "${ilCol}", SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE}`;
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      sql += ` GROUP BY "${ilCol}" ORDER BY toplam_uretim DESC LIMIT 10`;
      return autoYear(sql, yilCol);
    } else {
      // "Sebze üretimi"
      let sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE}`;
      if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
      return autoYear(sql, yilCol);
    }
  }
  
  // 5. GENEL SORGULAR
  if (/en çok.*üretilen|hangi.*ürün|popüler/i.test(nl)) {
    // "En çok üretilen ürünler"
    let sql = `SELECT "${urunCol}", SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE}`;
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` GROUP BY "${urunCol}" ORDER BY toplam_uretim DESC LIMIT 10`;
    return autoYear(sql, yilCol);
  }
  
  if (/en çok.*il|hangi.*il/i.test(nl)) {
    // "En çok üretim yapan iller"
    let sql = `SELECT "${ilCol}", SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE}`;
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
    sql += ` GROUP BY "${ilCol}" ORDER BY toplam_uretim DESC LIMIT 10`;
    return autoYear(sql, yilCol);
  }
  
  console.log('🚫 Hiçbir kural eşleşmedi');
  return '';
}

/** ======= GPT Katmanı ======= **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function nlToSql_gpt(nl, schema) {
  if (!process.env.OPENAI_API_KEY) return '';
  
  const { columns, catCol } = schema;
  
  const ilCol = columns.find(c => ['il', 'İl', 'province'].includes(c)) || 'il';
  const ilceCol = columns.find(c => ['ilce', 'İlçe', 'district'].includes(c)) || 'ilce';
  const urunCol = columns.find(c => ['urun_adi', 'urun', 'Ürün', 'product'].includes(c)) || 'urun_adi';
  const yilCol = columns.find(c => ['yil', 'Yıl', 'year'].includes(c)) || 'yil';
  const uretimCol = columns.find(c => ['uretim_miktari', 'uretim', 'Üretim', 'production'].includes(c)) || 'uretim_miktari';
  const alanCol = columns.find(c => ['uretim_alani', 'alan', 'Alan', 'area'].includes(c)) || 'uretim_alani';
  
  const system = `
Sen bir NL→SQLite SQL çeviricisisin.
Tek tablo: ${TABLE}("${columns.join('","')}")

KOLON AÇIKLAMALARI:
- "${uretimCol}": ton cinsinden üretim
- "${alanCol}": dekar cinsinden alan  
- "${yilCol}": yıl (integer)
- "${catCol}": kategori kolonu (varsa)

KURALLAR:
1. Yıl belirtilmemişse tüm yılları topla; sonra 2024 enjekte edilecek
2. Genel ürün isimleri için (örn: "üzüm") TÜM ÇEŞİTLERİNİ dahil et: ("${urunCol}" LIKE 'Üzüm %' OR "${urunCol}" LIKE '%Üzüm%')
3. "Türkiye" deyince TÜM İLLERİ topla, il filtresi koyma
4. "Mersin" = "Mersin ili" = "Mersin ilinde" (hepsi aynı anlam)
5. Kategori belirtilmişse (meyve/sebze/tahıl) "${catCol}" = 'Meyve' filtresi ekle
6. "ekim alanı" için SUM("${alanCol}") kullan
7. "en çok üretilen" için SUM("${uretimCol}") ile GROUP BY ve ORDER BY
8. "hangi ilçelerde" için "${ilceCol}" ile GROUP BY
9. Tek SELECT sorgusu üret, noktalı virgül yok
10. Kolon isimlerini çift tırnak ile: "${ilCol}", "${urunCol}"
11. MUTLAKA SUM() kullan, tek satır değerleri değil toplamları ver
  `.trim();

  const user = `Soru: """${nl}"""

Tablo: ${TABLE}
Ana kolonlar: "${ilCol}", "${ilceCol}", "${urunCol}", "${yilCol}", "${uretimCol}", "${alanCol}"`;

  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system }, 
        { role: 'user', content: user }
      ],
      temperature: 0,
      max_tokens: 400
    });
    
    let sql = (r.choices[0].message.content || '')
      .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,''))
      .trim()
      .replace(/;+\s*$/,'');
    
    // Post-processing
    sql = sql.replace(new RegExp(`"${urunCol}"\\s*=\\s*'([^']+)'`, 'gi'), (_m, val) => headMatchExpr(val, urunCol));
    sql = autoYear(sql, yilCol);
    
    return sql;
  } catch (e) {
    console.error('GPT hatası:', e);
    return '';
  }
}

/** ======= Güzel cevap (opsiyonel GPT) ======= **/
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
          content: 'Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcıyla yaz. Sadece verilen verilere dayan, varsayım yapma. 1-2 cümle max.' 
        },
        { 
          role: 'user', 
          content: `Soru: ${question}\nÖrnek veri: ${JSON.stringify(sample)}\nToplam satır: ${rows.length}\n\nKısa özet yaz.` 
        }
      ],
      temperature: 0,
      max_tokens: 150
    });
    
    return (r.choices[0].message.content || '').trim();
  } catch (e) {
    console.error('Özet oluşturma hatası:', e);
    return `${rows.length} sonuç bulundu.`;
  }
}

/** ======= Handler ======= **/
export default async function handler(req, res) {
  // CORS
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
    
    console.log(`[${new Date().toISOString()}] Sorgu: ${raw}`);
    
    // Cache kontrolü
    const cacheKey = raw.toLowerCase();
    if (queryCache.has(cacheKey)) {
      console.log('✅ Cache hit!');
      const cached = queryCache.get(cacheKey);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: cached\n${cached}`);
      return;
    }
    
    // sql.js başlat
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });
    
    // DB yükle
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) { 
      console.error('❌ Database not found:', dbPath);
      res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' }); 
      return; 
    }
    
    console.log('✅ Database bulundu:', dbPath);
    const db = new SQL.Database(fs.readFileSync(dbPath));
    
    // Şema ve güvenlik
    const schema = getColumns(SQL, db);
    const isSafeSql = makeIsSafeSql([TABLE, ...schema.columns.map(c => `"${c}"`)]);
    
    console.log('✅ Şema yüklendi:', schema.columns.join(', '));
    
    // RULES-FIRST yaklaşım (maliyet optimizasyonu)
    let sql = '', used = 'rules', gptErr = '';
    
    // 1) Önce rule-based dene
    sql = ruleBasedSql(raw, schema);
    console.log(`🔧 Rules SQL: ${sql || '(boş)'}`);
    
    // 2) Rule-based başarısızsa GPT dene
    if (!sql || !isSafeSql(sql)) {
      if (!FORCE_GPT_ONLY) {
        console.log('🤖 GPT deneniyor...');
        try {
          sql = await nlToSql_gpt(raw, schema);
          console.log(`🔧 GPT SQL: ${sql || '(boş)'}`);
          used = 'gpt';
        } catch (e) {
          gptErr = `${e?.status || e?.code || ''} ${e?.message || String(e)}`;
          console.error('❌ GPT hatası:', gptErr);
        }
      }
    }
    
    // 3) Hala SQL yok -> hata
    if (!sql || !isSafeSql(sql)) {
      const errorMsg = `SQL oluşturulamadı veya güvenli değil.\nRule SQL: ${sql || 'boş'}\nGPT Error: ${gptErr || 'yok'}\nGüvenlik: ${sql ? 'geçmedi' : 'SQL yok'}`;
      console.error('❌', errorMsg);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(400).send(errorMsg);
      return;
    }
    
    // 4) SQL çalıştır
    let rows = [];
    try {
      console.log('🚀 SQL çalıştırılıyor:', sql);
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      console.log(`✅ ${rows.length} satır bulundu`);
    } catch (e) {
      console.error('❌ SQL çalıştırma hatası:', e);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: ${used} (model: ${MODEL})\nSQL derlenemedi.\nSQL:\n${sql}\n\nHata: ${String(e)}`);
      return;
    }
    
    // 5) Özet + Cache + Debug
    const nice = await prettyAnswer(raw, rows);
    
    // Cache'e ekle
    const cacheValue = `Soru: ${raw}\n\n${nice}\n\n${rows.length ? qToText(rows, r => '• ' + JSON.stringify(r)) : 'Veri bulunamadı.'}`;
    if (queryCache.size >= MAX_CACHE_SIZE) {
      const firstKey = queryCache.keys().next().value;
      queryCache.delete(firstKey);
    }
    queryCache.set(cacheKey, cacheValue);
    
    const debugText = DEBUG_ROWS
      ? `\n\n-- DEBUG --\nKolonlar: ${schema.columns.join(', ')}\nKategori kolonu: ${schema.catCol || 'yok'}\nSQL:\n${sql}\nİlk 3 Satır:\n${JSON.stringify(rows.slice(0,3), null, 2)}`
      : '';
    
    const response = `🧭 Mod: ${used} (model: ${MODEL})${gptErr ? ` | gptErr: ${gptErr}` : ''}\n` +
      `Soru: ${raw}\n\n${nice}\n\n` +
      (rows.length ? qToText(rows, r => '• ' + JSON.stringify(r)) : 'Veri bulunamadı.') +
      debugText;
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(response);
    
  } catch (err) {
    console.error('❌ API hata:', err);
    res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
