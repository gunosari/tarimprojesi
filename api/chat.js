// api/chat.js — NL→SQL (GPT + kural yedek), 2024 oto-yıl, ürün başta-eşleşme, debug görünür
export const config = { runtime: 'nodejs' };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ======= Ayarlar ======= **/
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_YEAR = 2024; // veriniz tek yıl ise burada ayarlayın
const AUTO_INJECT_DEFAULT_YEAR = true; // doğal cümlede yıl yoksa otomatik bu yılı ekle
const FORCE_GPT_ONLY = false; // sadece GPT çıktısını test etmek istersen true yap
const DEBUG_ROWS = true; // debug metni açık/kapat

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
      console.log('Kolon bulundu:', row.name, '- Tür:', row.type); // Debug
    }
    stmt.free();
    
    // Kategori kolonu belirle (önce Kategori, sonra urun_cesidi)
    let catCol = null;
    if (out.includes('kategori')) catCol = 'kategori';
    else if (out.includes('urun_cesidi')) catCol = 'urun_cesidi';
    else if (out.includes('Kategori')) catCol = 'Kategori';
    else if (out.includes('Ürün Çeşidi')) catCol = 'Ürün Çeşidi';
    
    console.log('Kategori kolonu:', catCol); // Debug
    console.log('Tüm kolonlar:', out.join(', ')); // Debug
    
    return { columns: out, catCol };
  } catch (e) {
    console.error('Şema okuma hatası:', e);
    // Varsayılan şema (güvenlik için)
    return {
      columns: ['il', 'ilce', 'urun_cesidi', 'urun_adi', 'yil', 'uretim_alani', 'uretim_miktari', 'verim'],
      catCol: 'urun_cesidi'
    };
  }
}

// Basit güvenlik filtresi
function makeIsSafeSql(allowedNames) {
  const allow = new Set([...allowedNames.map(s => s.toLowerCase()), TABLE]);
  
  return (sql) => {
    const s = (sql || '').trim().toLowerCase();
    if (!s.startsWith('select')) return false;
    if (s.includes('--') || s.includes('/*')) return false;
    if (s.includes(';')) return false; // Çoklu sorgu engelle
    
    // SQL anahtar kelimeleri
    const sqlKeywords = [
      'select', 'sum', 'avg', 'count', 'min', 'max', 'round', 'case', 'when', 'then', 'else', 'end',
      'from', 'where', 'and', 'or', 'group', 'by', 'order', 'desc', 'asc', 'limit', 'as', 
      'having', 'like', 'between', 'in', 'distinct', 'null', 'not', 'is'
    ];
    
    // Token analizi
    const tokens = s.replace(/[^a-z0-9_ğüşöçıİĞÜŞÖÇ" ]/gi, ' ')
                   .split(/\s+/)
                   .filter(t => t.length > 0);
    
    for (const token of tokens) {
      // Sayıları atla
      if (/^\d+(\.\d+)?$/.test(token)) continue;
      
      // String literalleri atla ('')
      if (/^'.*'$/.test(token)) continue;
      
      // Alfanumerik kontrol
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

/** ======= GPT Katmanı ======= **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// *** DÜZELTİLMİŞ ÜRÜN EŞLEŞME FONKSİYONU ***
function headMatchExpr(raw, urunCol = 'urun_adi') {
  const product = String(raw || '').trim().toLowerCase();
  
  // TÜİK'te çok çeşitli olan ürünler - geniş arama yap
  const multiVarietyProducts = [
    'üzüm', 'elma', 'portakal', 'mandalina', 'domates', 'biber', 
    'marul', 'lahana', 'zeytin', 'limon', 'kavun', 'karpuz',
    'salatalık', 'hıyar', 'fasulye', 'soğan', 'patates'
  ];
  
  // Eğer çok çeşitli bir ürünse, geniş arama (tüm çeşitlerini bul)
  if (multiVarietyProducts.includes(product)) {
    const productCapitalized = product.charAt(0).toUpperCase() + product.slice(1);
    return `"${urunCol}" LIKE '%${escapeSQL(productCapitalized)}%'`;
  }
  
  // Diğer ürünler için dar arama (eski sistem)
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

async function nlToSql_gpt(nl, schema) {
  if (!process.env.OPENAI_API_KEY) return '';
  
  const { columns, catCol } = schema;
  
  // Dinamik kolon tespiti
  const ilCol = columns.find(c => ['il', 'İl', 'province'].includes(c)) || 'il';
  const ilceCol = columns.find(c => ['ilce', 'İlçe', 'district'].includes(c)) || 'ilce';
  const urunCol = columns.find(c => ['urun_adi', 'urun', 'Ürün', 'product'].includes(c)) || 'urun_adi';
  const yilCol = columns.find(c => ['yil', 'Yıl', 'year'].includes(c)) || 'yil';
  const uretimCol = columns.find(c => ['uretim_miktari', 'uretim', 'Üretim', 'production'].includes(c)) || 'uretim_miktari';
  const alanCol = columns.find(c => ['uretim_alani', 'alan', 'Alan', 'area'].includes(c)) || 'uretim_alani';
  const verimCol = columns.find(c => ['verim', 'Verim', 'yield'].includes(c)) || 'verim';
  
  const system = `
Sen bir NL→SQLite SQL çeviricisisin.
Tek tablo: ${TABLE}("${columns.join('","')}")

KOLON AÇIKLAMALARI:
- "${uretimCol}": ton cinsinden üretim
- "${alanCol}": dekar cinsinden alan  
- "${yilCol}": yıl (integer)
- "${verimCol}": ton/dekar verim
- "${catCol}": kategori kolonu (varsa)

KURALLAR:
1. Yıl belirtilmemişse tüm yılları topla; sonra 2024 enjekte edilecek
2. Genel ürün isimleri için (örn: "üzüm") TÜM ÇEŞİTLERİNİ dahil et: "${urunCol}" LIKE '%Üzüm%'
3. Kategori belirtilmişse (meyve/sebze/tahıl) "${catCol}" = 'Meyve' filtresi ekle
4. "ekim alanı" için SUM("${alanCol}") kullan
5. "en çok üretilen" için SUM("${uretimCol}") ile GROUP BY ve ORDER BY
6. "hangi ilçelerde" için "${ilceCol}" ile GROUP BY
7. Tek SELECT sorgusu üret, noktalı virgül yok
8. Kolon isimlerini çift tırnak ile: "${ilCol}", "${urunCol}"
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

/** ======= Kural Tabanlı Yedek ======= **/
function ruleBasedSql(nlRaw, schema) {
  const nl = String(nlRaw || '').trim();
  const { columns, catCol } = schema;
  
  // Dinamik kolon tespiti
  const ilCol = columns.find(c => ['il', 'İl', 'province'].includes(c)) || 'il';
  const ilceCol = columns.find(c => ['ilce', 'İlçe', 'district'].includes(c)) || 'ilce';
  const urunCol = columns.find(c => ['urun_adi', 'urun', 'Ürün', 'product'].includes(c)) || 'urun_adi';
  const yilCol = columns.find(c => ['yil', 'Yıl', 'year'].includes(c)) || 'yil';
  const uretimCol = columns.find(c => ['uretim_miktari', 'uretim', 'Üretim', 'production'].includes(c)) || 'uretim_miktari';
  const alanCol = columns.find(c => ['uretim_alani', 'alan', 'Alan', 'area'].includes(c)) || 'uretim_alani';
  
  // İl tespit et
  const mIl = nl.match(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:[''`´]?[dt]e|[''`´]?[dt]a|\s|$)/);
  const il = mIl ? mIl[1] : '';
  
  // Yıl tespit et
  const year = (nl.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';
  
  // Ürün tespit et
  const known = /(domates|biber|patlıcan|kabak|hıyar|salatalık|karpuz|karnabahar|lahana|marul|fasulye|soğan|sarımsak|patates|brokoli|ispanak|maydanoz|enginar|bezelye|bakla|elma|portakal|mandalina|limon|muz|zeytin|üzüm|armut|şeftali|kayısı|nar|incir|vişne|çilek|kiraz|kavun|ayva|fındık|ceviz|antep fıstığı|buğday|arpa|mısır|çeltik|pirinç|yulaf|çavdar|ayçiçeği|kanola)/i;
  let urun = (nl.match(known) || [])[1] || '';
  
  if (!urun) {
    const mu = nl.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*üretimi/i);
    if (mu) urun = mu[1];
  }
  urun = (urun || '').replace(/["''`´]+/g,'').trim();
  
  // Kategori tespit et
  let kat = '';
  if (/meyve/i.test(nl)) kat = 'Meyve';
  else if (/tah[ıi]l/i.test(nl)) kat = 'Tahıl';  
  else if (/sebze/i.test(nl)) kat = 'Sebze';
  
  const yearFilter = year ? `AND "${yilCol}"=${Number(year)}` : '';
  const catFilter = (kat && catCol) ? `AND "${catCol}"='${escapeSQL(kat)}'` : '';
  
  // 1) "en çok üretilen" sorgular
  if (il && /en çok üretilen/i.test(nl)) {
    const likeHead = urun ? headMatchExpr(urun, urunCol) : '';
    const limit = (nl.match(/(\d+)/) || ['', '5'])[1];
    
    return `
      SELECT "${urunCol}" AS urun, SUM("${uretimCol}") AS toplam_uretim
      FROM ${TABLE}
      WHERE "${ilCol}"='${escapeSQL(il)}'
        ${catFilter}
        ${likeHead ? `AND ${likeHead}` : ''}
        ${yearFilter}
      GROUP BY "${urunCol}"
      ORDER BY toplam_uretim DESC
      LIMIT ${limit}
    `.trim().replace(/\s+/g, ' ');
  }
  
  // 2) "ekim alanı" sorgular
  if (il && /(ekim )?alan/i.test(nl)) {
    if (urun) {
      const likeHead = headMatchExpr(urun, urunCol);
      return `
        SELECT "${urunCol}" AS urun, SUM("${alanCol}") AS toplam_alan
        FROM ${TABLE}
        WHERE "${ilCol}"='${escapeSQL(il)}'
          AND ${likeHead}
          ${yearFilter}
          ${catFilter}
        GROUP BY "${urunCol}"
        ORDER BY toplam_alan DESC
        LIMIT 1
      `.trim().replace(/\s+/g, ' ');
    } else {
      return `
        SELECT SUM("${alanCol}") AS toplam_alan
        FROM ${TABLE}
        WHERE "${ilCol}"='${escapeSQL(il)}'
          ${catFilter}
          ${yearFilter}
      `.trim().replace(/\s+/g, ' ');
    }
  }
  
  // 3) Üretim miktarı sorgular
  if (il && (/kaç\s+ton/i.test(nl) || /üretim/i.test(nl))) {
    if (urun) {
      const likeHead = headMatchExpr(urun, urunCol);
      return `
        SELECT SUM("${uretimCol}") AS toplam_uretim
        FROM ${TABLE}
        WHERE "${ilCol}"='${escapeSQL(il)}'
          AND ${likeHead}
          ${yearFilter}
          ${catFilter}
      `.trim().replace(/\s+/g, ' ');
    } else if (kat) {
      return `
        SELECT SUM("${uretimCol}") AS toplam_uretim
        FROM ${TABLE}
        WHERE "${ilCol}"='${escapeSQL(il)}'
          ${catFilter}
          ${yearFilter}
      `.trim().replace(/\s+/g, ' ');
    }
  }
  
  // 4) "hangi ilçelerde" sorgular
  if (il && urun && /hangi ilçelerde/i.test(nl)) {
    const likeHead = headMatchExpr(urun, urunCol);
    return `
      SELECT "${ilceCol}" AS ilce, SUM("${uretimCol}") AS uretim, SUM("${alanCol}") AS alan
      FROM ${TABLE}
      WHERE "${ilCol}"='${escapeSQL(il)}'
        AND ${likeHead}
        ${yearFilter}
      GROUP BY "${ilceCol}"
      ORDER BY uretim DESC
      LIMIT 10
    `.trim().replace(/\s+/g, ' ');
  }
  
  // 5) Genel il-ürün top listesi
  if (il) {
    const limit = (nl.match(/(\d+)/) || ['', '10'])[1];
    return `
      SELECT "${urunCol}" AS urun, SUM("${uretimCol}") AS uretim, SUM("${alanCol}") AS alan
      FROM ${TABLE}
      WHERE "${ilCol}"='${escapeSQL(il)}'
        ${catFilter}
        ${yearFilter}
      GROUP BY "${urunCol}"
      ORDER BY uretim DESC
      LIMIT ${limit}
    `.trim().replace(/\s+/g, ' ');
  }
  
  return '';
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
    
    // sql.js başlat
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });
    
    // DB yükle
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) { 
      res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' }); 
      return; 
    }
    
    const db = new SQL.Database(fs.readFileSync(dbPath));
    
    // Şema ve güvenlik
    const schema = getColumns(SQL, db);
    const isSafeSql = makeIsSafeSql([TABLE, ...schema.columns.map(c => `"${c}"`)]);
    
    // Kısa yol: "İl, Ürün" -> ilçe top10
    if (raw.includes(',')) {
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      const urunCol = schema.columns.find(c => ['urun_adi', 'urun', 'Ürün'].includes(c)) || 'urun_adi';
      const ilceCol = schema.columns.find(c => ['ilce', 'İlçe'].includes(c)) || 'ilce';
      const uretimCol = schema.columns.find(c => ['uretim_miktari', 'uretim'].includes(c)) || 'uretim_miktari';
      const alanCol = schema.columns.find(c => ['uretim_alani', 'alan'].includes(c)) || 'uretim_alani';
      
      const sql = `
        SELECT "${ilceCol}" AS ilce, SUM("${uretimCol}") AS uretim, SUM("${alanCol}") AS alan
        FROM ${TABLE}
        WHERE "il" = ? AND ${headMatchExpr(urunInput, urunCol)}
        GROUP BY "${ilceCol}"
        ORDER BY uretim DESC
        LIMIT 10
      `;
      
      const stmt = db.prepare(sql);
      const rows = [];
      stmt.bind([ilInput]);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      
      const text = qToText(rows, r => `• ${r.ilce}: ${Number(r.uretim || 0).toLocaleString('tr-TR')} ton, ${Number(r.alan || 0).toLocaleString('tr-TR')} dekar`);
      
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: il_urun_ilce_top\nİl: ${ilInput} | Ürün: ${urunInput}\n\n${text}`);
      return;
    }
    
    // 1) GPT ile dene
    let used = 'nl2sql-gpt', gptErr = '', sql = '';
    
    try {
      sql = await nlToSql_gpt(raw, schema);
    } catch (e) {
      gptErr = `${e?.status || e?.code || ''} ${e?.message || String(e)}`;
      used = 'fallback-rules';
    }
    
    // 2) Güvenli değilse kural tabanlı
    if (!sql || !isSafeSql(sql)) {
      if (FORCE_GPT_ONLY) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(`🧭 Mod: gpt-only | GPT SQL geçersiz/boş\nSQL:\n${sql || '(yok)'}`);
        return;
      }
      
      const rb = ruleBasedSql(raw, schema);
      if (rb && isSafeSql(rb)) { 
        sql = rb; 
        used = 'rules'; 
      }
    }
    
    // 3) Hala SQL yok -> genel fallback
    if (!sql) {
      const ilInput = raw;
      const urunCol = schema.columns.find(c => ['urun_adi', 'urun'].includes(c)) || 'urun_adi';
      const uretimCol = schema.columns.find(c => ['uretim_miktari', 'uretim'].includes(c)) || 'uretim_miktari';
      const alanCol = schema.columns.find(c => ['uretim_alani', 'alan'].includes(c)) || 'uretim_alani';
      const yilCol = schema.columns.find(c => ['yil', 'Yıl'].includes(c)) || 'yil';
      
      let fallbackSql = `
        SELECT "${urunCol}" AS urun, SUM("${uretimCol}") AS uretim, SUM("${alanCol}") AS alan
        FROM ${TABLE}
        WHERE "il" = ?
        GROUP BY "${urunCol}"
        ORDER BY uretim DESC
        LIMIT 10
      `;
      
      fallbackSql = AUTO_INJECT_DEFAULT_YEAR ? 
        fallbackSql.replace('WHERE "il" = ?', `WHERE "${yilCol}"=${DEFAULT_YEAR} AND "il" = ?`) : 
        fallbackSql;
      
      const rows = [];
      const stmt = db.prepare(fallbackSql);
      stmt.bind([ilInput]);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      
      const text = qToText(rows, r => `• ${r.urun?.trim?.()}: ${Number(r.uretim || 0).toLocaleString('tr-TR')} ton, ${Number(r.alan || 0).toLocaleString('tr-TR')} dekar`);
      
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: fallback_il_top_urun\nİl: ${ilInput}\n\n${text}`);
      return;
    }
    
    // 4) SQL çalıştır
    let rows = [];
    try {
      console.log('Çalıştırılan SQL:', sql);
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
    } catch (e) {
      console.error('SQL çalıştırma hatası:', e);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: ${used} (model: ${MODEL})\nSQL derlenemedi.\nSQL:\n${sql}\n\nHata: ${String(e)}`);
      return;
    }
    
    // 5) Özet + Debug
    const nice = await prettyAnswer(raw, rows);
    const debugText = DEBUG_ROWS
      ? `\n\n-- DEBUG --\nKolonlar: ${schema.columns.join(', ')}\nKategori kolonu: ${schema.catCol || 'yok'}\nSQL:\n${sql}\nİlk 3 Satır:\n${JSON.stringify(rows.slice(0,3), null, 2)}`
      : '';
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(
      `🧭 Mod: ${used} (model: ${MODEL})${gptErr ? ` | gptErr: ${gptErr}` : ''}\n` +
      `Soru: ${raw}\n\n${nice}\n\n` +
      (rows.length ? qToText(rows, r => '• ' + JSON.stringify(r)) : 'Veri bulunamadı.') +
      debugText
    );
    
  } catch (err) {
    console.error('API hata:', err);
    res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
