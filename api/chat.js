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
const FORCE_GPT_ONLY = true; // Kural tabanlıyı kapat, sadece GPT çalışsın
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
    const st = db.prepare(`PRAGMA table_info("${TABLE}");`);
    while (st.step()) out.push(st.getAsObject().name);
    st.free();
    // Eğer urun_cesidi yoksa, hata mesajı ekle (debug için)
    if (!out.includes('urun_cesidi')) {
      console.log('Uyarı: urun_cesidi kolonu bulunamadı. Kategorizasyon yapılamıyor.');
    }
    return out;
  } catch {
    return ['il', 'ilce', 'urun_cesidi', 'urun_adi', 'yil', 'uretim_alani', 'uretim_miktari', 'verim'];
  }
}
// Basit güvenlik filtresi
function makeIsSafeSql(allowedNames) {
  const allow = new Set(allowedNames.map(s => s.toLowerCase()));
  return (sql) => {
    const s = (sql || '').trim().toLowerCase();
    if (!s.startsWith('select')) return false;
    if (s.includes('--') || s.includes('/*')) return false;
    const toks = s.replace(/[^a-z0-9_ğüşöçıİĞÜŞÖÇ" ]/gi, ' ').split(/\s+/).filter(Boolean);
    for (const t of toks) {
      if (/^[a-zıiöüçğ_"]+$/i.test(t) && !allow.has(t)) {
        if (!['select', 'sum', 'avg', 'count', 'min', 'max',
               'from', 'where', 'and', 'or', 'group', 'by', 'order',
               'desc', 'asc', 'limit', 'as', 'having', 'like', 'between', 'in', 'distinct'].includes(t)) {
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
  const H = String(raw || '').trim();
  const head = H.charAt(0).toUpperCase() + H.slice(1).toLowerCase();
  return `("urun_adi" LIKE '%${escapeSQL(H)}%' OR "urun_adi" LIKE '%${escapeSQL(head)}%')`;
}
function autoYear(sql) {
  if (!AUTO_INJECT_DEFAULT_YEAR) return sql;
  if (!sql) return sql;
  const hasWhere = /where/i.test(sql);
  const hasYear = /"yil"\s*=/.test(sql);
  if (hasYear) return sql;
  if (hasWhere) {
    return sql.replace(/where/i, `WHERE "yil" = ${DEFAULT_YEAR} AND `);
  } else {
    const m = sql.match(/\b(order|group|limit)\b/i);
    if (!m) return `${sql} WHERE "yil" = ${DEFAULT_YEAR}`;
    const idx = m.index;
    return `${sql.slice(0, idx)} WHERE "yil" = ${DEFAULT_YEAR} ${sql.slice(idx)}`;
  }
}
async function nlToSql_gpt(nl, cols, catCol) {
  if (!process.env.OPENAI_API_KEY) return '';
  const system = `
You are an NL→SQLite SQL translator.
Single table: ${TABLE}("${cols.join('","')}")
- "uretim_miktari": tons (production amount), "uretim_alani": decares (cultivated area), "yil": integer, "verim": tons/decares.
- Category/variety column: "${catCol}" (if exists).
- If year is not specified, aggregate all years; however, 2024 can be injected later.
- For general product names (e.g., "üzüm", "portakal", "domates"), extract the product name from the question and use HEAD-MATCH: "urun_adi" LIKE '%[product_name]%' OR "urun_adi" LIKE '%[Product_Name]%' to include all variants (e.g., "Sofralık Üzüm", "Şaraplık Üzüm").
- If the question asks for "üretim" (production), use SUM("uretim_miktari") without GROUP BY to get the total production for all variants of the product.
- If the question asks for "ekim alanı" (cultivated area), use SUM("uretim_alani") without GROUP BY to get the total area for all variants of the product.
- If the question asks "hangi ilçelerde" (which districts), use SUM("uretim_miktari") with GROUP BY "ilce" and ORDER BY SUM("uretim_miktari") DESC without LIMIT to list all relevant districts.
- If the question asks for "en çok üretilen" with a number (e.g., "en çok üretilen 5 ürün"), use SUM("uretim_miktari") with GROUP BY "urun_adi" and ORDER BY SUM("uretim_miktari") DESC LIMIT [number].
- If the question specifies a year (e.g., "2022"), filter by "yil" = [year].
- If the question specifies a category (e.g., "sebze" for vegetables), filter by "${catCol}" = 'Sebze' or equivalent.
- Return a SINGLE SELECT statement for EACH question provided, separated by newlines. Ensure each SQL is valid with FROM clause and proper syntax (e.g., SELECT ... FROM urunler ...).
- Use double-quotes for column names.
  `.trim();
  const user = `
Question: """${nl}"""
- Process each question separately and return one SQL statement per question, separated by newlines.
- Extract the product name, year, and category (if any) from each question.
- For "Mersin’de kaç ton sebze üretilmiş?": Use SUM("uretim_miktari") without GROUP BY, filter by "il" = 'Mersin' and "urun_cesidi" = 'Sebze'.
- For "Adana’da en çok üretilen 5 ürün": Use SUM("uretim_miktari") with GROUP BY "urun_adi" ORDER BY SUM("uretim_miktari") DESC LIMIT 5, filter by "il" = 'Adana'.
- For "Antalya’da domates en çok hangi ilçelerde üretiliyor?": Use SUM("uretim_miktari") with GROUP BY "ilce" ORDER BY SUM("uretim_miktari") DESC, filter by "il" = 'Antalya' and "urun_adi" LIKE '%domates%'.
- For "İzmir’de toplam ekim alanı (dekar)": Use SUM("uretim_alani") without GROUP BY, filter by "il" = 'Izmir'.
- For "Mersin 2022 biber üretimi": Use SUM("uretim_miktari") without GROUP BY, filter by "il" = 'Mersin', "yil" = 2022, and "urun_adi" LIKE '%biber%'.
- Use HEAD-MATCH for product names (e.g., "urun_adi" LIKE '%domates%' OR "urun_adi" LIKE '%Domates%').
- Table name: ${TABLE}.
  `.trim();
  const r = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  let sqls = (r.choices[0].message.content || '')
    .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,''))
    .trim()
    .split('\n')
    .map(s => s.trim())
    .filter(s => s);
  return sqls.length > 0 ? sqls.join('\n') : '';
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
    const mu = nl.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*(?:ekim alanı|üretim)/i);
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
      SELECT "urun_adi" AS urun, SUM("uretim_miktari") AS toplam_uretim
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
      GROUP BY "urun_adi"
      ORDER BY toplam_uretim DESC
      LIMIT 1
    `.trim();
  }
  // 2) "ekim alanı" için
  if (il && /(ekim )?alan/i.test(nl)) {
    const likeHead = urun ? `("urun_adi" LIKE '%${escapeSQL(urun)}%' OR "urun_adi" LIKE '%${escapeSQL(urun.charAt(0).toUpperCase() + urun.slice(1))}%')` : '';
    return `
      SELECT "urun_adi" AS urun, SUM("uretim_alani") AS toplam_alan
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
      GROUP BY "urun_adi"
      ORDER BY toplam_alan DESC
      LIMIT 1
    `.trim();
  }
  // 3) "üretim" için
  if (il && /üretim/i.test(nl)) {
    const likeHead = urun ? `("urun_adi" LIKE '%${escapeSQL(urun)}%' OR "urun_adi" LIKE '%${escapeSQL(urun.charAt(0).toUpperCase() + urun.slice(1))}%')` : '';
    return `
      SELECT SUM("uretim_miktari") AS toplam_uretim
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
    `.trim();
  }
  // 4) "ne oldu" gibi genel sorgular için varsayılan üretim toplamı
  if (il && /ne oldu/i.test(nl)) {
    const likeHead = urun ? headMatchExpr(urun) : '';
    return `
      SELECT SUM("uretim_miktari") AS toplam_uretim
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
    `.trim();
  }
  // 5) toplam üretim (sebze/meyve/tahıl olabilir)
  if (il && (/kaç\s+ton/i.test(nl) || /toplam.*üretim/i.test(nl)) && !urun) {
    return `
      SELECT SUM("uretim_miktari") AS toplam_uretim
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
    `.trim();
  }
  // 6) belli bir ürün üretimi
  if (il && urun && /üretim/i.test(nl)) {
    const likeHead = headMatchExpr(urun);
    return `
      SELECT SUM("uretim_miktari") AS toplam_uretim
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        AND ${likeHead}
        ${year ? `AND "yil"=${Number(year)}` : ''}
        ${/sebze|meyve|tah[ıi]l/i.test(nl) ? `AND "${catCol}"='${/sebze/i.test(nl) ? 'Sebze' : /meyve/i.test(nl) ? 'Meyve' : 'Tahıl'}'` : ''}
    `.trim();
  }
  // 7) toplam ekim alanı
  if (il && /(toplam)?.*(ekim )?alan/i.test(nl)) {
    return `
      SELECT SUM("uretim_alani") AS toplam_alan
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
    `.trim();
  }
  // 8) ilde en çok üretilen N ürün
  const topN = (nl.match(/en çok üretilen\s+(\d+)/i) || [])[1] || 10;
  if (il && /(en çok üretilen\s+\d+\s+ürün|en çok üretilen ürün)/i.test(nl)) {
    return `
      SELECT "urun_adi" AS urun, SUM("uretim_miktari") AS uretim, SUM("uretim_alani") AS alan
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
      GROUP BY "urun_adi"
      ORDER BY uretim DESC
      LIMIT ${Number(topN)}
    `.trim();
  }
  // 9) ürün en çok hangi ilçelerde?
  if (il && urun && /en çok hangi ilçelerde/i.test(nl)) {
    const likeHead = headMatchExpr(urun);
    return `
      SELECT "ilce" AS ilce, SUM("uretim_miktari") AS uretim, SUM("uretim_alani") AS alan
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        AND ${likeHead}
        ${year ? `AND "yil"=${Number(year)}` : ''}
      GROUP BY "ilce"
      ORDER BY uretim DESC
      LIMIT 10
    `.trim();
  }
  // 10) ortalama verim
  if (il && /verim/i.test(nl)) {
    return `
      SELECT CASE WHEN SUM("uretim_alani")>0 THEN ROUND(SUM("uretim_miktari")/SUM("uretim_alani"), 4) ELSE NULL END AS ort_verim
      FROM urunler
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
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
  const year = rows.length > 0 ? rows[0].yil : DEFAULT_YEAR; // SQL'den yılı al
  const r = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcıyla yaz. Sadece verilen verilere ve belirtilen yıla (eğer varsa) dayan, varsayım yapma.' },
      { role: 'user', content: `Soru: ${question}\nÖrnek veri: ${JSON.stringify(sample)}\nToplam satır: ${rows.length}\nYıl: ${year}\n1-2 cümle özet yaz, yılı yalnızca verilen yıl olarak kullan.` }
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
    const hasUrunCesidi = COLS.includes('urun_cesidi');
    const catCol = hasUrunCesidi ? 'urun_cesidi' : 'urun_cesidi'; // Varsayılan olarak urun_cesidi
    const isSafeSql = makeIsSafeSql([TABLE, ...COLS.map(c => `"${c}"`)]);
    // Debug için sorguyu log'la
    console.log(`Sorgu: ${raw}`);
    // Kısa yol: "İl, Ürün" -> ilçe top10 (başta-eşleşme)
    if (raw.includes(',')) {
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      const stmt = db.prepare(`
        SELECT "ilce" AS ilce, SUM("uretim_miktari") AS uretim, SUM("uretim_alani") AS alan
        FROM urunler
        WHERE "il" = ? AND ${headMatchExpr(urunInput)}
        GROUP BY "ilce"
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
        SELECT "urun_adi" AS urun, SUM("uretim_miktari") AS uretim, SUM("uretim_alani") AS alan
        FROM urunler
        WHERE "il" = ?
        GROUP BY "urun_adi"
        ORDER BY uretim DESC
        LIMIT 10
      `.trim();
      tmp = AUTO_INJECT_DEFAULT_YEAR ? tmp.replace('WHERE "il" = ?', `WHERE "yil"=${DEFAULT_YEAR} AND "il" = ?`) : tmp;
      const rows = [];
      const stmt = db.prepare(tmp);
      stmt.bind([ilInput]);
      while (stmt.step()) rows.push(st.getAsObject());
      stmt.free();
      const text = qToText(rows, r => `• ${r.urun?.trim?.()}: ${r.uretim} ton, ${r.alan} dekar`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: fallback_il_top_urun\nİl: ${ilInput}\n\n${text}`);
      return;
    }
    // 4) SQL'i çalıştır (çoklu SQL desteği)
    let rows = [];
    const sqls = sql.split('\n').map(s => s.trim()).filter(s => s);
    for (const singleSql of sqls) {
      try {
        const st = db.prepare(singleSql);
        while (st.step()) rows.push(st.getAsObject());
        st.free();
      } catch (e) {
        console.error(`SQL hatası: ${singleSql}\nHata: ${String(e)}`);
      }
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
