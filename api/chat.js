// api/chat.js — NL→SQL (GPT + kural yedek), TR-dostu ürün/il eşleşmesi, akıllı yıl enjeksi, güvenli SELECT denetimi
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ======= Ayarlar ======= **/
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_YEAR = 2024;                    // veriniz tek yıl ise 2024
const AUTO_INJECT_DEFAULT_YEAR = true;        // doğal cümlede yıl yoksa yıl ekle
const FORCE_GPT_ONLY = false;                 // sadece GPT çıktısını test etmek istersen true
const DEBUG_ROWS = true;                      // debug metni açık/kapat

/** ======= Yardımcılar ======= **/
const escapeSQL = (s = '') => String(s).replace(/'/g, "''");
const qToText = (rows, lineFmt) => (!rows || rows.length === 0) ? 'Veri bulunamadı.' : rows.map(lineFmt).join('\n');

// Türkçe büyük-küçük harf güvenli baş harf düzeltici
function trCap(s) {
  if (!s) return s;
  return s[0].toLocaleUpperCase('tr-TR') + s.slice(1).toLocaleLowerCase('tr-TR');
}

// PRAGMA ile tablo kolonlarını oku (dinamik şema)
function getColumns(SQL, db) {
  try {
    const cols = [];
    const stmt = db.prepare(`PRAGMA table_info("${TABLE}");`);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      cols.push(row.name);
      console.log('Kolon:', row.name, '| Tür:', row.type);
    }
    stmt.free();

    // Kategori kolonu (varsa)
    let catCol = null;
    const candidates = ['kategori', 'Kategori', 'urun_cesidi', 'Ürün Çeşidi'];
    for (const c of candidates) if (cols.includes(c)) { catCol = c; break; }

    console.log('Kategori kolonu:', catCol || '(yok)');
    return { columns: cols, catCol };
  } catch (e) {
    console.error('Şema okuma hatası:', e);
    return {
      columns: ['il', 'ilce', 'urun_cesidi', 'urun_adi', 'yil', 'uretim_alani', 'uretim_miktari', 'verim'],
      catCol: 'urun_cesidi'
    };
  }
}

/** ======= Güvenlik: yalnız tek SELECT ve bilinen kolonlar =======
 *  - DDL/DML, yorum, noktalı virgül YASAK
 *  - FROM urunler zorunlu
 *  - Kolonlar çift tırnak içinde ve şema içinden olmalı
 */
function makeIsSafeSql(allowedCols) {
  const forbidden = /(;|--|\/\*|\b(insert|update|delete|drop|alter|attach|detach|pragma|create|vacuum|replace|grant|revoke|analyze)\b)/i;
  const allowedSet = new Set(allowedCols.map(c => `"${c}"`.toLowerCase()));

  return (sql) => {
    if (!sql || typeof sql !== 'string') return false;
    const s = sql.trim();

    // Tek SELECT
    if (!/^select\b/i.test(s)) return false;
    if (forbidden.test(s)) return false;

    // Zorunlu tablo
    const fromMatch = s.match(/\bfrom\s+([a-zA-Z0-9_"]+)/i);
    if (!fromMatch) return false;
    const tbl = fromMatch[1].replace(/"/g, '').toLowerCase();
    if (tbl !== TABLE) return false;

    // Tırnaklı kolonlar şemada mı?
    const quotedCols = s.match(/"[^"]+"/g) || [];
    for (const qc of quotedCols) {
      const low = qc.toLowerCase();
      if (low !== `"${TABLE}"` && !allowedSet.has(low)) {
        // Fonksiyon isimleri veya string literaller çift tırnakla gelmez, o yüzden burası kolon kontrolü için güvenli.
        console.log('Güvenlik: bilinmeyen alan:', qc);
        return false;
      }
    }
    return true;
  };
}

/** ======= İl tespiti ======= **/
const TR_ILLER = ["Adana","Adıyaman","Afyonkarahisar","Ağrı","Aksaray","Amasya","Ankara","Antalya","Ardahan","Artvin","Aydın",
"Balıkesir","Bartın","Batman","Bayburt","Bilecik","Bingöl","Bitlis","Bolu","Burdur","Bursa","Çanakkale","Çankırı","Çorum",
"Denizli","Diyarbakır","Düzce","Edirne","Elazığ","Erzincan","Erzurum","Eskişehir","Gaziantep","Giresun","Gümüşhane",
"Hakkâri","Hatay","Iğdır","Isparta","İstanbul","İzmir","Kahramanmaraş","Karabük","Karaman","Kars","Kastamonu","Kayseri",
"Kırıkkale","Kırklareli","Kırşehir","Kilis","Kocaeli","Konya","Kütahya","Malatya","Manisa","Mardin","Mersin","Muğla","Muş",
"Nevşehir","Niğde","Ordu","Osmaniye","Rize","Sakarya","Samsun","Siirt","Sinop","Sivas","Şanlıurfa","Şırnak","Tekirdağ",
"Tokat","Trabzon","Tunceli","Uşak","Van","Yalova","Yozgat","Zonguldak"];

function detectIl(nl) {
  for (const il of TR_ILLER) {
    const re = new RegExp(`\\b${il}(?:\\s+ili|['’]?[dt][ea])?\\b`, 'i');
    if (re.test(nl)) return il;
  }
  return '';
}

/** ======= Ürün başta-eşleşme + bazı ürünlerde içerde arama ======= **/
function headMatchExpr(raw, urunCol = 'urun_adi') {
  const product = String(raw || '').trim().toLocaleLowerCase('tr-TR');
  const multi = new Set([
    // Sebze
    'biber','domates','hıyar','kabak','lahana','marul','soğan','sarımsak','turp','kereviz',
    // Meyve
    'elma','portakal','mandalina','üzüm',
    // Baklagil
    'fasulye','bakla','bezelye','börülce','mercimek',
    // Tahıl
    'mısır','arpa','yulaf','çavdar',
    // Diğer
    'pamuk','ayçiçeği','şeker','fiğ','yonca','haşhaş'
  ]);

  const head = trCap(product);
  const likeHead = `${escapeSQL(head)} %`;

  if (multi.has(product)) {
    return `("${urunCol}" LIKE '${likeHead}' OR "${urunCol}" LIKE '%${escapeSQL(head)}%')`;
  }
  return `("${urunCol}" LIKE '${likeHead}' OR "${urunCol}"='${escapeSQL(head)}')`;
}

/** ======= Yıl enjeksi: yıl yoksa WHERE "yil" = DEFAULT_YEAR ekle ======= **/
function autoYear(sql, yilCol = 'yil') {
  if (!AUTO_INJECT_DEFAULT_YEAR || !sql) return sql;

  const hasAnyYear =
    new RegExp(`"${yilCol}"\\s*(=|in|between|>=|<=|>|<)`, 'i').test(sql) ||
    /\bgroup\s+by\b[^;]*\b"yil"\b/i.test(sql);

  if (hasAnyYear) return sql;

  if (/\bwhere\b/i.test(sql)) {
    return sql.replace(/\bwhere\b/i, `WHERE "${yilCol}" = ${DEFAULT_YEAR} AND `);
  }
  const m = sql.match(/\b(order|group|limit)\b/i);
  return m
    ? `${sql.slice(0, m.index)} WHERE "${yilCol}" = ${DEFAULT_YEAR} ${sql.slice(m.index)}`
    : `${sql} WHERE "${yilCol}" = ${DEFAULT_YEAR}`;
}

/** ======= GPT Katmanı ======= **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function nlToSql_gpt(nl, schema) {
  if (!process.env.OPENAI_API_KEY) return '';

  const { columns, catCol } = schema;

  // Dinamik kolonlar
  const ilCol    = columns.find(c => ['il','İl','province'].includes(c)) || 'il';
  const ilceCol  = columns.find(c => ['ilce','İlçe','district'].includes(c)) || 'ilce';
  const urunCol  = columns.find(c => ['urun_adi','urun','Ürün','product'].includes(c)) || 'urun_adi';
  const yilCol   = columns.find(c => ['yil','Yıl','year'].includes(c)) || 'yil';
  const uretimCol= columns.find(c => ['uretim_miktari','uretim','Üretim','production'].includes(c)) || 'uretim_miktari';
  const alanCol  = columns.find(c => ['uretim_alani','alan','Alan','area'].includes(c)) || 'uretim_alani';
  const verimCol = columns.find(c => ['verim','Verim','yield'].includes(c)) || 'verim';

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
1) Yıl belirtilmemişse tüm yılları topla; (handler 2024'ü otomatik enjekte edecek)
2) Genel ürün isimlerinde sadece LIKE kullan:
   "mısır": ("${urunCol}" LIKE 'Mısır %' OR "${urunCol}" LIKE '%Mısır%')
   "domates": ("${urunCol}" LIKE 'Domates %' OR "${urunCol}" LIKE '%Domates%')
3) "Türkiye" tüm illerin toplamıdır; il filtresi koyma.
4) "en çok" istenirse SUM("${uretimCol}") ile ORDER BY DESC + LIMIT
5) Tek bir SELECT üret, noktalı virgül yok.
6) Kolon isimleri daima çift tırnak içinde.
7) Mümkün olduğunca SUM() ile toplanmış değerler dön.
`.trim();

  const user = `Soru: """${nl}"""

Tablo: ${TABLE}
Ana kolonlar: "${ilCol}", "${ilceCol}", "${urunCol}", "${yilCol}", "${uretimCol}", "${alanCol}"`;

  try {
    const r = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      max_tokens: 400,
      timeout: 20000
    });

    let sql = (r.choices[0].message.content || '')
      .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g, '').replace(/```/g, ''))
      .trim()
      .replace(/;+\s*$/, '');

    // Ürün eşitliklerini LIKE’a çevir (post-process)
    sql = sql.replace(new RegExp(`"${urunCol}"\\s*=\\s*'([^']+)'`, 'g'),
      (_match, val) => headMatchExpr(val, urunCol));

    sql = autoYear(sql, yilCol);
    console.log('GPT SQL (post):', sql);
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

  const ilCol    = columns.find(c => ['il','İl','province'].includes(c)) || 'il';
  const ilceCol  = columns.find(c => ['ilce','İlçe','district'].includes(c)) || 'ilce';
  const urunCol  = columns.find(c => ['urun_adi','urun','Ürün','product'].includes(c)) || 'urun_adi';
  const yilCol   = columns.find(c => ['yil','Yıl','year'].includes(c)) || 'yil';
  const uretimCol= columns.find(c => ['uretim_miktari','uretim','Üretim','production'].includes(c)) || 'uretim_miktari';
  const alanCol  = columns.find(c => ['uretim_alani','alan','Alan','area'].includes(c)) || 'uretim_alani';

  const isTurkey = /\bTürkiye\b/i.test(nl);
  const il = isTurkey ? '' : detectIl(nl);

  // Yıl
  const year = (nl.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';

  // Ürün
  const known = /(domates|biber|patlıcan|kabak|hıyar|salatalık|karpuz|karnabahar|lahana|marul|fasulye|soğan|sarımsak|patates|brokoli|ispanak|maydanoz|enginar|bezelye|bakla|elma|portakal|mandalina|limon|muz|zeytin|üzüm|armut|şeftali|kayısı|nar|incir|vişne|çilek|kiraz|kavun|ayva|fındık|ceviz|antep fıstığı|buğday|arpa|mısır|çeltik|pirinç|yulaf|çavdar|ayçiçeği|kanola)/i;
  let urun = (nl.match(known) || [])[1] || '';
  if (!urun) {
    const mu = nl.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*üretimi/i);
    if (mu) urun = mu[1];
  }
  urun = (urun || '').replace(/["''`´]+/g, '').trim();

  // Kategori
  let kat = '';
  if (/meyve/i.test(nl)) kat = 'Meyve';
  else if (/tah[ıi]l/i.test(nl)) kat = 'Tahıl';
  else if (/sebze/i.test(nl)) kat = 'Sebze';

  const where = [];
  if (il) where.push(`"${ilCol}"='${escapeSQL(il)}'`);
  if (urun) where.push(headMatchExpr(urun, urunCol));
  if (year) where.push(`"${yilCol}"=${Number(year)}`);
  if (kat && catCol) where.push(`"${catCol}"='${escapeSQL(kat)}'`);

  // “en çok” → ilçe bazında top-N
  if (/en\s+çok|ilk\s+\d+|top\s*\d+/i.test(nl) && /ilçe/i.test(nl)) {
    const limit = Number((nl.match(/(ilk|top)\s*(\d+)/i) || [])[2] || 10);
    const base = `
      SELECT "${ilceCol}" AS ilce, SUM("${uretimCol}") AS toplam_uretim
      FROM ${TABLE}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY "${ilceCol}"
      ORDER BY toplam_uretim DESC
      LIMIT ${limit}
    `;
    return base.trim().replace(/\s+/g, ' ');
  }

  // Genel: toplam üretim & alan
  if (urun && /üretim|toplam|ne\s*kadar/i.test(nl)) {
    const base = `
      SELECT SUM("${uretimCol}") AS toplam_uretim, SUM("${alanCol}") AS toplam_alan
      FROM ${TABLE}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `;
    return base.trim().replace(/\s+/g, ' ');
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
        { role: 'system', content: 'Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcıyla yaz. Sadece verilen verilere dayan, varsayım yapma. 1-2 cümle.' },
        { role: 'user', content: `Soru: ${question}\nÖrnek veri: ${JSON.stringify(sample)}\nToplam satır: ${rows.length}\n\nKısa özet yaz.` }
      ],
      temperature: 0,
      max_tokens: 120,
      timeout: 20000
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
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

    console.log(`[${new Date().toISOString()}] Soru: ${raw}`);

    // sql.js başlat — ÖNEMLİ: sql-wasm.wasm dosyasını public/ altına kopyala.
    // package.json "postinstall": "cp node_modules/sql.js/dist/sql-wasm.wasm public/sql-wasm.wasm"
    const SQL = await initSqlJs({
      locateFile: () => path.join(process.cwd(), 'public', 'sql-wasm.wasm'),
    });

    // DB yükle
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' });
      return;
    }
    const db = new SQL.Database(fs.readFileSync(dbPath));

    // Şema + güvenlik
    const schema = getColumns(SQL, db);
    const isSafeSql = makeIsSafeSql(schema.columns);

    // 1) GPT ile dene
    let used = 'nl2sql-gpt', gptErr = '', sql = '';
    try {
      sql = await nlToSql_gpt(raw, schema);
    } catch (e) {
      gptErr = `${e?.status || e?.code || ''} ${e?.message || String(e)}`;
      used = 'fallback-rules';
    }

    // 2) Güvenli değilse/boşsa kural tabanlı
    if (!sql || !isSafeSql(sql)) {
      if (FORCE_GPT_ONLY) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(`🧭 Mod: gpt-only | GPT SQL geçersiz/boş\nSQL:\n${sql || '(yok)'}`);
        return;
      }
      const rb = ruleBasedSql(raw, schema);
      if (rb && isSafeSql(rb)) { sql = rb; used = 'rules'; }
    }

    // 3) Hâlâ SQL yok
    if (!sql) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(400).send('SQL oluşturulamadı. Sorunuzu yeniden formüle edin.');
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
      console.error('SQL derleme/çalıştırma hatası:', e);
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
