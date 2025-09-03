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
const escapeSQL = (s='') => String(s).replace(/'/g, "''");
function qToText(rows, lineFmt) {
  if (!rows || rows.length === 0) return 'Veri bulunamadı.';
  return rows.map(lineFmt).join('\n');
}
// PRAGMA ile tablo kolonlarını oku (dinamik şema)
function getColumns(SQL, db) {
  try {
    const out = [];
    const st = db.prepare(`PRAGMA table_info("${TABLE}");`);
    while (st.step()) out.push(st.getAsObject().name);
    st.free();
    return out;
  } catch {
    return ['İl','İlçe','Ürün Çeşidi','Ürün','Yıl','Alan','Üretim','Verim'];
  }
}
// Basit güvenlik filtresi
function makeIsSafeSql(allowedNames) {
  const allow = new Set(allowedNames.map(s => s.toLowerCase()));
  return (sql) => {
    const s = (sql || '').trim().toLowerCase();
    if (!s.startsWith('select')) return false;
    if (s.includes('--') || s.includes('/*')) return false;
    const toks = s.replace(/[^a-z0-9_ğüşöçıİĞÜŞÖÇ" ]/gi,' ').split(/\s+/).filter(Boolean);
    for (const t of toks) {
      if (/^[a-zıiöüçğ_"]+$/i.test(t) && !allow.has(t)) {
        if (!['select','sum','avg','count','min','max',
               'from','where','and','or','group','by','order',
               'desc','asc','limit','as','having','like','between','in','distinct'].includes(t)) {
          return false;
        }
      }
    }
    return true;
  };
}
/** ======= GPT Katmanı ======= **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
function headMatchExpr(raw) {
  // "biber" -> "Biber"
  const H = String(raw||'').trim();
  const head = H.charAt(0).toUpperCase() + H.slice(1).toLowerCase();
  // "Ürün" LIKE 'Biber %' OR "Ürün"='Biber'
  return `("Ürün" LIKE '${escapeSQL(head)} %' OR "Ürün"='${escapeSQL(head)}')`;
}
function autoYear(sql) {
  if (!AUTO_INJECT_DEFAULT_YEAR) return sql;
  if (!sql) return sql;
  const hasWhere = /where/i.test(sql);
  const hasYear = /"Yıl"\s*=/.test(sql);
  if (hasYear) return sql;
  if (hasWhere) {
    return sql.replace(/where/i, `WHERE "Yıl" = ${DEFAULT_YEAR} AND `);
  } else {
    // ORDER/GROUP/LIMIT gelirse onlardan önce ekle
    const m = sql.match(/\b(order|group|limit)\b/i);
    if (!m) return `${sql} WHERE "Yıl" = ${DEFAULT_YEAR}`;
    const idx = m.index;
    return `${sql.slice(0, idx)} WHERE "Yıl" = ${DEFAULT_YEAR} ${sql.slice(idx)}`;
  }
}
async function nlToSql_gpt(nl, cols, catCol) {
  if (!process.env.OPENAI_API_KEY) return '';
  const system = `
You are an NL→SQLite SQL translator.
Single table: ${TABLE}("${cols.join('","')}")
- "Üretim": tons, "Alan": decares, "Yıl": integer.
- Category/variety column: "${catCol}" (if exists).
- If year is not specified, aggregate all years; however, 2024 can be injected later.
- For general product names, use HEAD-MATCH: "Ürün" LIKE 'Xxx %' OR "Ürün"='Xxx'.
- If the question specifies a category (e.g., "meyve" for fruit, "tahıl" for grain), filter by "${catCol}" = 'Meyve' or equivalent.
- For phrases like "en çok üretilen", use SUM("Üretim") with GROUP BY "Ürün" and ORDER BY "Toplam Üretim" DESC LIMIT 1.
- For "hangi ilçelerde", group by district.
- Return a SINGLE SELECT statement and ONLY SQL. Use double-quotes for column names.
  `.trim();
  const user = `
Question: """${nl}"""
- "en çok üretilen" -> SUM("Üretim") with GROUP BY "Ürün" ORDER BY SUM("Üretim") DESC LIMIT 1.
- Apply filters for category if mentioned (e.g., "meyve" -> "${catCol}" = 'Meyve').
- Table name: ${TABLE}.
  `.trim();
  const r = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  let sql = (r.choices[0].message.content || '')
    .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,''))
    .trim()
    .replace(/;+\s*$/,'');
  sql = sql.replace(/"Ürün"\s*=\s*'([^']+)'/gi, (_m, val) => headMatchExpr(val));
  sql = autoYear(sql);
  return sql;
}
/** ======= Kural Tabanlı Yedek ======= **/
function ruleBasedSql(nlRaw, cols, catCol) {
  const nl = String(nlRaw || '').trim();
  const mIl = nl.match(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:[’'`´]?[dt]e|[’'`´]?[dt]a|\s|$)/);
  const il = mIl ? mIl[1] : '';
  const year = (nl.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';
  const known = /(domates|biber|patlıcan|kabak|hıyar|salatalık|karpuz|karnabahar|lahana|marul|fasulye|soğan|sarımsak|patates|brokoli|ispanak|maydanoz|enginar|bezelye|bakla|elma|portakal|mandalina|limon|muz|zeytin|üzüm|armut|şeftali|kayısı|nar|incir|vişne|çilek|kiraz|kavun|ayva|fındık|ceviz|antep fıstığı|buğday|arpa|mısır|çeltik|pirinç|yulaf|çavdar|ayçiçeği|kanola)/i;
  let urun = (nl.match(known) || [])[1] || '';
  if (!urun) {
    const mu = nl.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*üretimi/i);
    if (mu) urun = mu[1];
  }
  urun = (urun || '').replace(/["'’`´]+/g,'').trim();
  let kat = '';
  if (/meyve/i.test(nl)) kat = 'Meyve';
  else if (/tah[ıi]l/i.test(nl)) kat = 'Tahıl';
  else if (/sebze/i.test(nl)) kat = 'Sebze';

  // 1) "en çok üretilen" için kategori filtresi
  if (il && /en çok üretilen/i.test(nl)) {
    const likeHead = urun ? headMatchExpr(urun) : '';
    return `
      SELECT "Ürün" AS urun, SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
      GROUP BY "Ürün"
      ORDER BY toplam_uretim DESC
      LIMIT 1
    `.trim();
  }
  // 2) "ne oldu" gibi genel sorgular için varsayılan üretim toplamı
  if (il && /ne oldu/i.test(nl)) {
    const likeHead = urun ? headMatchExpr(urun) : '';
    return `
      SELECT SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
    `.trim();
  }
  // 3) toplam üretim (sebze/meyve/tahıl olabilir)
  if (il && (/kaç\s+ton/i.test(nl) || /toplam.*üretim/i.test(nl)) && !urun) {
    return `
      SELECT SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
    `.trim();
  }
  // 4) belli bir ürün üretimi
  if (il && urun && /üretim/i.test(nl)) {
    const likeHead = headMatchExpr(urun);
    return `
      SELECT SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        AND ${likeHead}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
        ${/sebze|meyve|tah[ıi]l/i.test(nl) ? `AND "${catCol}"='${/sebze/i.test(nl) ? 'Sebze' : /meyve/i.test(nl) ? 'Meyve' : 'Tahıl'}'` : ''}
    `.trim();
  }
  // 5) toplam ekim alanı
  if (il && /(toplam)?.*(ekim )?alan/i.test(nl)) {
    return `
      SELECT SUM("Alan") AS toplam_alan
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
    `.trim();
  }
  // 6) ilde en çok üretilen N ürün
  const topN = (nl.match(/en çok üretilen\s+(\d+)/i) || [])[1] || 10;
  if (il && /(en çok üretilen\s+\d+\s+ürün|en çok üretilen ürün)/i.test(nl)) {
    return `
      SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
      GROUP BY "Ürün"
      ORDER BY uretim DESC
      LIMIT ${Number(topN)}
    `.trim();
  }
  // 7) ürün en çok hangi ilçelerde?
  if (il && urun && /en çok hangi ilçelerde/i.test(nl)) {
    const likeHead = headMatchExpr(urun);
    return `
      SELECT "İlçe" AS ilce, SUM("Üretim") AS uretim, SUM("Alan") AS alan
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        AND ${likeHead}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
      GROUP BY "İlçe"
      ORDER BY uretim DESC
      LIMIT 10
    `.trim();
  }
  // 8) ortalama verim
  if (il && /verim/i.test(nl)) {
    return `
      SELECT CASE WHEN SUM("Alan")>0 THEN ROUND(SUM("Üretim")/SUM("Alan"), 4) ELSE NULL END AS ort_verim
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
    `.trim();
  }
  return '';
}
/** ======= Güzel cevap (opsiyonel GPT) ======= **/
async function prettyAnswer(question, rows) {
  if (!process.env.OPENAI_API_KEY) {
    if (!rows?.length) return 'Veri bulunamadı.';
    if (rows.length === 1) return Object.entries(rows[0]).map(([k,v]) => `${k}: ${v}`).join(' • ');
    return `${rows.length} satır döndü.`;
  }
  const sample = Array.isArray(rows) ? rows.slice(0, 5) : [];
  const r = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcıyla yaz. Sadece verilen verilere dayan, varsayım yapma.' },
      { role: 'user', content: `Soru: ${question}\nÖrnek veri: ${JSON.stringify(sample)}\nToplam satır: ${rows.length}\n1-2 cümle özet yaz, yıl olarak sadece SQL'deki yılı kullan.` }
    ],
  });
  return (r.choices[0].message.content || '').trim();
}
/** ======= Handler ======= **/
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Sadece POST isteklerine izin verilir' }); return;
    }
    const { question } = req.body || {};
    const raw = String(question ?? '').trim();
    if (!raw) { res.status(400).json({ ok: false, error: 'question alanı zorunlu' }); return; }
    // sql.js başlat
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });
    // DB
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) { res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' }); return; }
    const db = new SQL.Database(fs.readFileSync(dbPath));
    // Şema ve güvenlik
    const COLS = getColumns(SQL, db);
    const hasKategori = COLS.includes('Kategori');
    const hasCesit = COLS.includes('Ürün Çeşidi');
    const catCol = hasKategori ? 'Kategori' : (hasCesit ? 'Ürün Çeşidi' : 'Kategori');
    const isSafeSql = makeIsSafeSql([TABLE, ...COLS.map(c => `"${c}"`)]);
    // Debug için sorguyu log'la
    console.log(`Sorgu: ${raw}`);
    // Kısa yol: "İl, Ürün" -> ilçe top10 (başta-eşleşme)
    if (raw.includes(',')) {
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      const stmt = db.prepare(`
        SELECT "İlçe" AS ilce, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM ${TABLE}
        WHERE "İl" = ? AND ${headMatchExpr(urunInput)}
        GROUP BY "İlçe"
        ORDER BY uretim DESC
        LIMIT 10;
      `);
      const rows = [];
      stmt.bind([ilInput]);
      while (stmt.step()) rows.push(st.getAsObject());
      stmt.free();
      const text = qToText(rows, r => `• ${r.ilce}: ${r.uretim} ton, ${r.alan} dekar`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: il_urun_ilce_top\nİl: ${ilInput} | Ürün: ${urunInput}\n\n${text}`);
      return;
    }
    // 1) GPT ile dene
    let used = 'nl2sql-gpt', gptErr = '', sql = '';
    try {
      sql = await nlToSql_gpt(raw, COLS, catCol);
    } catch (e) {
      gptErr = `${e?.status || e?.code || ''} ${e?.message || String(e)}`;
      used = 'fallback-rules';
    }
    // 2) Uygunsuz/boşsa (ve GPT-only mod kapalıysa) kural tabanlı
    if (!sql || !isSafeSql(sql)) {
      if (FORCE_GPT_ONLY) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(`🧭 Mod: gpt-only | GPT SQL geçersiz/boş\nSQL:\n${sql || '(yok)'}`);
        return;
      }
      const rb = ruleBasedSql(raw, COLS, catCol);
      if (rb && isSafeSql(rb)) { sql = rb; used = 'rules'; }
    }
    // 3) Hâlâ SQL yoksa: il adına göre top ürünler (debug dostu)
    if (!sql) {
      const ilInput = raw;
      let tmp = `
        SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM ${TABLE}
        WHERE "İl" = ?
        GROUP BY "Ürün"
        ORDER BY uretim DESC
        LIMIT 10
      `.trim();
      tmp = AUTO_INJECT_DEFAULT_YEAR ? tmp.replace('WHERE "İl" = ?', `WHERE "Yıl"=${DEFAULT_YEAR} AND "İl" = ?`) : tmp;
      const rows = [];
      const stmt = db.prepare(tmp);
      stmt.bind([ilInput]);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      const text = qToText(rows, r => `• ${r.urun?.trim?.()}: ${r.uretim} ton, ${r.alan} dekar`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: fallback_il_top_urun\nİl: ${ilInput}\n\n${text}`);
      return;
    }
    // 4) SQL'i çalıştır
    let rows = [];
    try {
      const st = db.prepare(sql);
      while (st.step()) rows.push(st.getAsObject());
      st.free();
    } catch (e) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: ${used} (model: ${MODEL})\nSQL derlenemedi.\nSQL:\n${sql}\n\nHata: ${String(e)}`);
      return;
    }
    // 5) Özet + Debug
    const nice = await prettyAnswer(raw, rows);
    const debugText = DEBUG_ROWS
      ? `\n\n-- DEBUG --\nKolonlar: ${COLS.join(', ')}\nSQL:\n${sql}\nİlk 5 Satır:\n${JSON.stringify(rows.slice(0,5), null, 2)}`
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
