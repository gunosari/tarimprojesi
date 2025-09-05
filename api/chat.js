// api/chat.js — Optimize NL→SQL: Rules-first, Cache, Limited GPT
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

// Optimizasyon ayarları
const PRETTY_ON = true;
const PRETTY_MAX_ROWS = 50;
const CACHE_SIZE = 300;

/** ======= Önbellek ======= **/
const CACHE = new Map();

function cacheKey(nl, cols) {
  return nl.toLowerCase().trim() + '|' + cols.join(',');
}

function cacheSet(key, val) {
  if (CACHE.size >= CACHE_SIZE) {
    const firstKey = CACHE.keys().next().value;
    CACHE.delete(firstKey);
  }
  CACHE.set(key, val);
}

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
      console.log('Kolon bulundu:', row.name, '- Tür:', row.type);
    }
    stmt.free();
    
    let catCol = null;
    if (out.includes('kategori')) catCol = 'kategori';
    else if (out.includes('urun_cesidi')) catCol = 'urun_cesidi';
    else if (out.includes('Kategori')) catCol = 'Kategori';
    else if (out.includes('Ürün Çeşidi')) catCol = 'Ürün Çeşidi';
    
    console.log('Kategori kolonu:', catCol);
    console.log('Tüm kolonlar:', out.join(', '));
    
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
          console.log('Güvensiz token:', token);
          return false;
        }
      }
    }
    
    return true;
  };
}

/** ======= Ürün Eşleştirme ======= **/
function headMatchExpr(raw, urunCol = 'urun_adi') {
  const product = String(raw || '').trim().toLowerCase();
  
  // TÜİK çeşitlendirilen ürünler (sadece 23 ana ürün)
  const multiVarietyProducts = [
    // Sebzeler (10)
    'biber', 'domates', 'hıyar', 'kabak', 'lahana', 'marul', 'soğan', 'sarımsak', 
    'turp', 'kereviz',
    // Meyveler (4)
    'elma', 'portakal', 'mandalina', 'üzüm',
    // Baklagiller (5)
    'fasulye', 'bakla', 'bezelye', 'börülce', 'mercimek',
    // Tahıllar (4)
    'mısır', 'arpa', 'yulaf', 'çavdar'
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

/** ======= KURAL TABANLI SİSTEM (ÖNCELİK) ======= **/
function ruleBasedSql(nlRaw, schema) {
  const nl = String(nlRaw || '').trim().toLowerCase();
  const { columns, catCol } = schema;
  
  // Dinamik kolon tespiti
  const ilCol = columns.find(c => ['il', 'İl', 'province'].includes(c)) || 'il';
  const ilceCol = columns.find(c => ['ilce', 'İlçe', 'district'].includes(c)) || 'ilce';
  const urunCol = columns.find(c => ['urun_adi', 'urun', 'Ürün', 'product'].includes(c)) || 'urun_adi';
  const yilCol = columns.find(c => ['yil', 'Yıl', 'year'].includes(c)) || 'yil';
  const uretimCol = columns.find(c => ['uretim_miktari', 'uretim', 'Üretim', 'production'].includes(c)) || 'uretim_miktari';
  const alanCol = columns.find(c => ['uretim_alani', 'alan', 'Alan', 'area'].includes(c)) || 'uretim_alani';
  
  // İl tespit et
  let il = '';
  const ilPattern = /([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:\s+il[inde]*|[''`´]?[dt]e|[''`´]?[dt]a|\s|$)/;
  const mIl = nlRaw.match(ilPattern);
  if (mIl) {
    il = mIl[1];
  }
  
  // Yıl tespit et
  const year = (nlRaw.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';
  
  // Ürün tespit et
  const known = /(domates|biber|patlıcan|kabak|hıyar|salatalık|karpuz|karnabahar|lahana|marul|fasulye|soğan|sarımsak|patates|brokoli|ispanak|maydanoz|enginar|bezelye|bakla|elma|portakal|mandalina|limon|muz|zeytin|üzüm|armut|şeftali|kayısı|nar|incir|vişne|çilek|kiraz|kavun|ayva|fındık|ceviz|antep fıstığı|buğday|arpa|mısır|çeltik|pirinç|yulaf|çavdar|ayçiçeği|kanola)/i;
  let urun = (nlRaw.match(known) || [])[1] || '';
  
  if (!urun) {
    const mu = nlRaw.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*üretimi/i);
    if (mu) urun = mu[1];
  }
  urun = (urun || '').replace(/["''`´]+/g,'').trim();
  
  // Kategori tespit et
  let kat = '';
  if (/meyve/i.test(nl)) kat = 'Meyve';
  else if (/tah[ıi]l/i.test(nl)) kat = 'Tahıl';  
  else if (/sebze/i.test(nl)) kat = 'Sebze';
  
  const yearFilter = year ? `AND "${yilCol}"=${Number(year)}` : `AND "${yilCol}"=${DEFAULT_YEAR}`;
  const catFilter = (kat && catCol) ? `AND "${catCol}"='${escapeSQL(kat)}'` : '';
  
  console.log(`Kural analizi: il=${il}, urun=${urun}, kat=${kat}, year=${year}`);
  
  // *** YENİ: Kategori sorguları için özel kural ***
  if (il && kat && /üretim|kaç ton|toplam/.test(nl)) {
    console.log('Kategori sorgusu tespit edildi');
    return `
      SELECT SUM("${uretimCol}") AS toplam_uretim
      FROM ${TABLE}
      WHERE "${ilCol}"='${escapeSQL(il)}'
        ${catFilter}
        ${yearFilter}
    `.trim().replace(/\s+/g, ' ');
  }
  
  // Spesifik ürün sorguları
  if (il && urun && /üretim|kaç ton|toplam/.test(nl)) {
    console.log('✅ Spesifik ürün sorgusu tespit edildi');
    const likeHead = headMatchExpr(urun, urunCol);
    const sql = `SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan FROM ${TABLE} WHERE "${ilCol}"='${escapeSQL(il)}' AND ${likeHead} ${yearFilter} ${catFilter}`.trim().replace(/\s+/g, ' ');
    console.log(`🔧 Üretilen SQL: ${sql}`);
    return sql;
  }
  
  // Türkiye geneli sorguları
  if ((urun || kat) && /türkiye|toplam|genel/.test(nl) && /üretim/.test(nl)) {
    console.log('✅ Türkiye geneli sorgusu tespit edildi');
    let whereClause = `"${yilCol}"=${DEFAULT_YEAR}`;
    
    if (urun) {
      const likeHead = headMatchExpr(urun, urunCol);
      whereClause += ` AND ${likeHead}`;
    }
    
    if (kat && catCol) {
      whereClause += ` AND "${catCol}"='${escapeSQL(kat)}'`;
    }
    
    const sql = `SELECT SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE} WHERE ${whereClause}`.trim().replace(/\s+/g, ' ');
    console.log(`🔧 Üretilen SQL: ${sql}`);
    return sql;
  }
  
  // En çok üretilen ürünler
  if (/en (çok|fazla).*üret/.test(nl) && il) {
    console.log('✅ En çok üretilen sorgusu tespit edildi');
    const sql = `SELECT "${urunCol}" AS urun, SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE} WHERE "${ilCol}"='${escapeSQL(il)}' ${yearFilter} ${catFilter} GROUP BY "${urunCol}" ORDER BY toplam_uretim DESC LIMIT 10`.trim().replace(/\s+/g, ' ');
    console.log(`🔧 Üretilen SQL: ${sql}`);
    return sql;
  }
  
  // *** YENİ: Hangi ilçelerde sorguları ***
  if (/hangi.*ilçe/.test(nl) && il) {
    console.log('✅ İlçe bazında sorgu tespit edildi');
    let sql = '';
    
    if (urun) {
      // Spesifik ürün için ilçe bazında
      const likeHead = headMatchExpr(urun, urunCol);
      sql = `SELECT "${ilceCol}" AS ilce, SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE} WHERE "${ilCol}"='${escapeSQL(il)}' AND ${likeHead} ${yearFilter} GROUP BY "${ilceCol}" ORDER BY toplam_uretim DESC LIMIT 10`;
    } else if (kat) {
      // Kategori için ilçe bazında
      sql = `SELECT "${ilceCol}" AS ilce, SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE} WHERE "${ilCol}"='${escapeSQL(il)}' ${catFilter} ${yearFilter} GROUP BY "${ilceCol}" ORDER BY toplam_uretim DESC LIMIT 10`;
    } else {
      // Genel ilçe bazında
      sql = `SELECT "${ilceCol}" AS ilce, SUM("${uretimCol}") AS toplam_uretim FROM ${TABLE} WHERE "${ilCol}"='${escapeSQL(il)}' ${yearFilter} GROUP BY "${ilceCol}" ORDER BY toplam_uretim DESC LIMIT 10`;
    }
    
    sql = sql.trim().replace(/\s+/g, ' ');
    console.log(`🔧 Üretilen SQL: ${sql}`);
    return sql;
  }
  
  console.log('❌ Hiçbir kural eşleşmedi');
  return '';
}

/** ======= GPT Katmanı (YEDEK) ======= **/
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
- "${catCol}": kategori kolonu (Meyve/Sebze/Tahıl)

KURALLAR:
1. Yıl belirtilmemişse 2024 kullan
2. İl filtreleri için: "${ilCol}"='Mersin' (basit eşitlik)
3. Kategori sorguları için:
   - "sebze" → "${catCol}" = 'Sebze'
   - "meyve" → "${catCol}" = 'Meyve'  
   - "tahıl" → "${catCol}" = 'Tahıl'
4. Ürün filtreleri için basit eşitlik: "${urunCol}"='Mısır' (post-processing düzeltecek)
5. MUTLAKA SUM() kullan, toplam değerler ver
6. Tek SELECT sorgusu, noktalı virgül yok
7. Kolon isimlerini çift tırnak ile sar
  `.trim();

  const user = `Soru: """${nl}"""`;

  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system }, 
        { role: 'user', content: user }
      ],
      temperature: 0,
      max_tokens: 300
    });
    
    let sql = (r.choices[0].message.content || '')
      .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,''))
      .trim()
      .replace(/;+\s*$/,'');
    
    // Post-processing sadece ürün eşitliklerini düzelt
    sql = sql.replace(new RegExp(`"${urunCol}"\\s*=\\s*'([^']+)'`, 'g'), 
      (match, val) => {
        console.log(`Post-processing ürün eşitliği: ${val}`);
        return headMatchExpr(val, urunCol);
      });
    
    sql = autoYear(sql, yilCol);
    
    console.log('GPT SQL:', sql);
    return sql;
  } catch (e) {
    console.error('GPT hatası:', e);
    return '';
  }
}

/** ======= Güzel Cevap (Koşullu) ======= **/
async function prettyAnswer(question, rows) {
  if (!PRETTY_ON || !process.env.OPENAI_API_KEY || !rows?.length || rows.length > PRETTY_MAX_ROWS) {
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
  
  const sample = rows.slice(0, 3);
  
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
          content: `Soru: ${question}\nVeri: ${JSON.stringify(sample)}\nToplam: ${rows.length}\n\nÖzet yaz.` 
        }
      ],
      temperature: 0,
      max_tokens: 100
    });
    
    return (r.choices[0].message.content || '').trim();
  } catch (e) {
    console.error('Özet hatası:', e);
    return `${rows.length} sonuç bulundu.`;
  }
}

/** ======= Debug Fonksiyonu ======= **/
function debugManualSQL(db, il, urun, schema) {
  try {
    const { columns } = schema;
    const urunCol = columns.find(c => ['urun_adi', 'urun', 'Ürün'].includes(c)) || 'urun_adi';
    const uretimCol = columns.find(c => ['uretim_miktari', 'uretim'].includes(c)) || 'uretim_miktari';
    
    const sql = `SELECT "${urunCol}" AS urun_adi, "${uretimCol}" AS uretim_miktari 
                 FROM ${TABLE} 
                 WHERE "il"='${il}' AND "${urunCol}" LIKE '%${urun}%'`;
    
    console.log('DEBUG Manuel SQL:', sql);
    
    const stmt = db.prepare(sql);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    
    const toplam = results.reduce((sum, row) => sum + (row.uretim_miktari || 0), 0);
    console.log('DEBUG Toplam:', toplam);
    console.log('DEBUG Ürünler:', results.map(r => r.urun_adi));
    
    return { results, toplam };
  } catch (e) {
    console.error('DEBUG hatası:', e);
    return null;
  }
}

/** ======= ANA HANDLER ======= **/
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Sadece POST desteklenir' }); 
      return;
    }
    
    const { question } = req.body || {};
    const raw = String(question ?? '').trim();
    if (!raw) { 
      res.status(400).json({ ok: false, error: 'question alanı zorunlu' }); 
      return; 
    }
    
    console.log(`[${new Date().toISOString()}] Sorgu: ${raw}`);
    
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
    
    // Önbellek kontrolü
    const key = cacheKey(raw, schema.columns);
    let sql = '', used = '';
    
    if (CACHE.has(key)) {
      sql = CACHE.get(key);
      used = 'cache';
      console.log('Önbellekten alındı');
    } else {
      // *** YENİ AKIŞ: ÖNCE KURALLAR, SONRA GPT ***
      used = 'rules';
      sql = ruleBasedSql(raw, schema);
      
      if (!sql || !isSafeSql(sql)) {
        console.log('Kurallar başarısız, GPT deneniyor...');
        used = 'nl2sql-gpt';
        try {
          sql = await nlToSql_gpt(raw, schema);
        } catch (e) {
          console.error('GPT hatası:', e);
          sql = '';
        }
      }
      
      // Son güvenlik kontrolü
      if (!sql || !isSafeSql(sql)) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(400).send('SQL oluşturulamadı. Sorunuzu farklı şekilde ifade edin.');
        return;
      }
      
      // Başarılı SQL'i önbelleğe ekle
      cacheSet(key, sql);
    }
    
    // Debug için manuel kontrol
    if (raw.toLowerCase().includes('mısır')) {
      const ilName = raw.toLowerCase().includes('adana') ? 'Adana' : 'Mersin';
      const debugResult = debugManualSQL(db, ilName, 'Mısır', schema);
      if (debugResult) {
        console.log('=== MÍSIR DEBUG ===');
        console.log('Toplam:', debugResult.toplam);
      }
    }
    
    // SQL çalıştır
    let rows = [];
    try {
      console.log('Çalıştırılan SQL:', sql);
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
    } catch (e) {
      console.error('SQL hatası:', e);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`SQL hatası: ${String(e)}\nSQL: ${sql}`);
      return;
    }
    
    // Özet ve debug
    const nice = await prettyAnswer(raw, rows);
    const debugText = DEBUG_ROWS
      ? `\n\n-- DEBUG --\nKolonlar: ${schema.columns.join(', ')}\nKategori: ${schema.catCol || 'yok'}\nSQL: ${sql}\nİlk 3: ${JSON.stringify(rows.slice(0,3), null, 2)}`
      : '';
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(
      `🧭 Mod: ${used} (model: ${MODEL})\n` +
      `Soru: ${raw}\n\n${nice}\n\n` +
      (rows.length ? qToText(rows, r => '• ' + JSON.stringify(r)) : 'Veri bulunamadı.') +
      debugText
    );
    
  } catch (err) {
    console.error('API hatası:', err);
    res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
