// api/chat.js — NL→SQL (GPT + kural yedek), ürün eşleşmeleri LIKE ile
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

// ===== Ayarlar =====
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Küçük yardımcılar
const escapeSQL = (s='') => String(s).replace(/'/g, "''");
function qToText(rows, lineFmt) {
  if (!rows || rows.length === 0) return 'Veri bulunamadı.';
  return rows.map(lineFmt).join('\n');
}

// Dinamik şema (PRAGMA)
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

// Güvenlik filtresi (tek SELECT, yorum yok, sadece whitelist isimler)
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

// ===== GPT Katmanı =====
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function nlToSql_gpt(nl, cols, catCol) {
  if (!process.env.OPENAI_API_KEY) return '';

  const system = `
Sen bir NL→SQLite SQL çevirmenisin.
Tek tablo: ${TABLE}("${cols.join('","')}")
- "Üretim": ton, "Alan": dekar, "Yıl": tam sayı.
- Kategori/çeşit kolonu: "${catCol}".
- Yıl verilmezse tüm yılları topla.
- Ürün adı kullanıcı tarafından genel verildiyse, "Ürün" eşleşmesini eşitlik yerine LIKE ile yap:
  "Ürün" LIKE '%' || <ürün_adı> || '%'
- Sadece TEK bir SELECT döndür ve SADECE SQL yaz.
- Kolonları double-quote ile yaz.
  `.trim();

  const user = `
Soru: """${nl}"""
"kaç ton/toplam" -> SUM("Üretim"), "alan" -> SUM("Alan"), "verim" -> SUM("Üretim")/SUM("Alan").
Gerektiğinde GROUP BY / ORDER BY / LIMIT uygula.
Tablo adı: ${TABLE}.
  `.trim();

  const r = await openai.responses.create({
    model: MODEL,
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });

  // Metni al, codeblockları soy, sondayı normalize et
  let sql = (r.output_text || '')
    .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,''))
    .trim()
    .replace(/;+\s*$/,''); // sondaki ; kaldır

  // Ürün = 'xxx' gördüysek LIKE'a çevir (domates → '%domates%')
  sql = sql.replace(/"Ürün"\s*=\s*'([^']+)'/gi, (_m, val) =>
    `"Ürün" LIKE '%' || '${escapeSQL(val)}' || '%'`
  );

  return sql;
}

// ===== Kural Tabanlı Yedek =====
function ruleBasedSql(nlRaw, cols, catCol) {
  const nl = String(nlRaw || '').trim();

  // İl
  const mIl = nl.match(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:[’'`´]?[dt]e|[’'`´]?[dt]a|\s|$)/);
  const il = mIl ? mIl[1] : '';

  // Yıl
  const year = (nl.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';

  // Ürün anahtarları (geniş liste)
  const known = /(domates|biber|patlıcan|kabak|hıyar|salatalık|karpuz|karnabahar|lahana|marul|fasulye|soğan|sarımsak|patates|brokoli|ispanak|maydanoz|enginar|bezelye|bakla|elma|portakal|mandalina|limon|muz|zeytin|üzüm|armut|şeftali|kayısı|nar|incir|vişne|çilek|kiraz|kavun|ayva|fındık|ceviz|antep fıstığı|buğday|arpa|mısır|çeltik|pirinç|yulaf|çavdar|ayçiçeği|kanola)/i;
  let urun = (nl.match(known) || [])[1] || '';
  if (!urun) {
    const mu = nl.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*üretimi/i);
    if (mu) urun = mu[1];
  }
  urun = (urun || '').replace(/["'’`´]+/g,'').trim();

  // Kategori (Ürün Çeşidi / Kategori)
  let kat = '';
  if (/sebze/i.test(nl)) kat = 'Sebze';
  else if (/meyve/i.test(nl)) kat = 'Meyve';
  else if (/tah[ıi]l/i.test(nl)) kat = 'Tahıl';

  // 1) toplam üretim (sebze/meyve/tahıl olabilir)
  if (il && (/kaç\s+ton/i.test(nl) || /toplam.*üretim/i.test(nl)) && !urun) {
    return `
      SELECT SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
    `.trim();
  }

  // 2) belli bir ürün üretimi
  if (il && urun && /üretim/i.test(nl)) {
    return `
      SELECT SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        AND "Ürün" LIKE '%' || '${escapeSQL(urun)}' || '%'
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
    `.trim();
  }

  // 3) toplam ekim alanı
  if (il && /(toplam)?.*(ekim )?alan/i.test(nl)) {
    return `
      SELECT SUM("Alan") AS toplam_alan
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
    `.trim();
  }

  // 4) ilde en çok üretilen N ürün
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

  // 5) ürün en çok hangi ilçelerde?
  if (il && urun && /en çok hangi ilçelerde/i.test(nl)) {
    return `
      SELECT "İlçe" AS ilce, SUM("Üretim") AS uretim, SUM("Alan") AS alan
      FROM ${TABLE}
      WHERE "İl"='${escapeSQL(il)}'
        AND "Ürün" LIKE '%' || '${escapeSQL(urun)}' || '%'
        ${year ? `AND "Yıl"=${Number(year)}` : ''}
      GROUP BY "İlçe"
      ORDER BY uretim DESC
      LIMIT 10
    `.trim();
  }

  // 6) ortalama verim
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

// ===== Güzel cevap (opsiyonel GPT) =====
async function prettyAnswer(question, rows) {
  if (!process.env.OPENAI_API_KEY) {
    if (!rows?.length) return 'Veri bulunamadı.';
    if (rows.length === 1) return Object.entries(rows[0]).map(([k,v]) => `${k}: ${v}`).join(' • ');
    return `${rows.length} satır döndü.`;
  }
  const sample = Array.isArray(rows) ? rows.slice(0, 5) : [];
  const r = await openai.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: 'Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcıyla yaz.' },
      { role: 'user', content: `Soru: ${question}\nÖrnek veri: ${JSON.stringify(sample)}\nToplam satır: ${rows.length}\n1-2 cümle özet yaz.` }
    ],
  });
  return (r.output_text || '').trim();
}

// ===== Handler =====
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
    const hasCesit    = COLS.includes('Ürün Çeşidi');
    const catCol = hasKategori ? 'Kategori' : (hasCesit ? 'Ürün Çeşidi' : 'Kategori');
    const isSafeSql = makeIsSafeSql([TABLE, ...COLS.map(c => `"${c}"`)]);

    // Kısa yol: "İl, Ürün" -> ilçe top10 (LIKE)
    if (raw.includes(',')) {
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      const stmt = db.prepare(`
        SELECT "İlçe" AS ilce, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM ${TABLE}
        WHERE "İl" = ? AND "Ürün" LIKE '%' || ? || '%'
        GROUP BY "İlçe"
        ORDER BY uretim DESC
        LIMIT 10;
      `);
      const rows = [];
      stmt.bind([ilInput, urunInput]);
      while (stmt.step()) rows.push(stmt.getAsObject());
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

    // 2) Uygunsuz/boşsa kural tabanlı
    if (!sql || !isSafeSql(sql)) {
      const rb = ruleBasedSql(raw, COLS, catCol);
      if (rb && isSafeSql(rb)) { sql = rb; used = 'rules'; }
    }

    // 3) Hâlâ SQL yoksa: il adına göre top ürünler
    if (!sql) {
      const ilInput = raw;
      const stmt = db.prepare(`
        SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM ${TABLE}
        WHERE "İl" = ?
        GROUP BY "Ürün"
        ORDER BY uretim DESC
        LIMIT 10;
      `);
      const rows = [];
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

    // 5) Özet
    const nice = await prettyAnswer(raw, rows);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(
      `🧭 Mod: ${used} (model: ${MODEL})${gptErr ? ` | gptErr: ${gptErr}` : ''}\n` +
      `Soru: ${raw}\nSQL: ${sql}\n\n${nice}\n\n` +
      (rows.length ? qToText(rows, r => '• ' + JSON.stringify(r)) : 'Veri bulunamadı.')
    );

  } catch (err) {
    console.error('API hata:', err);
    res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
