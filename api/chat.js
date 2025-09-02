// api/chat.js — NL→SQL (GPT + kural yedek), tek tablo: urunler (İl, İlçe, Ürün Çeşidi/Kategori, Ürün, Yıl, Alan, Üretim, Verim)
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

// ============ Genel Ayarlar ============
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function qToText(rows, lineFmt) {
  if (!rows || rows.length === 0) return 'Veri bulunamadı.';
  return rows.map(lineFmt).join('\n');
}

// ============ Dinamik şema (PRAGMA) ============
function getColumns(SQL, db) {
  try {
    const cols = [];
    const stmt = db.prepare(`PRAGMA table_info("${TABLE}");`);
    while (stmt.step()) {
      const o = stmt.getAsObject();
      cols.push(o.name);
    }
    stmt.free();
    return cols;
  } catch {
    // Varsayılan şema (sende bu var)
    return ['İl', 'İlçe', 'Ürün Çeşidi', 'Ürün', 'Yıl', 'Alan', 'Üretim', 'Verim'];
  }
}

// Güvenlik filtresi (tek SELECT, yorum yok, sadece whitelist isimler)
function makeIsSafeSql(allowedNames) {
  const allow = new Set(allowedNames.map(s => s.toLowerCase()));
  return (sql) => {
    const s = (sql || '').trim().toLowerCase();
    if (!s.startsWith('select')) return false;
    if (s.includes('--') || s.includes('/*')) return false;
    const tokens = s.replace(/[^a-z0-9_ğüşöçıİĞÜŞÖÇ" ]/gi, ' ').split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (/^[a-zıiöüçğ_"]+$/i.test(t) && !allow.has(t)) {
        if (!['select','sum','avg','count','min','max','from','where','and','or','group','by',
               'order','desc','asc','limit','as','having','like','between','in','distinct'].includes(t)) {
          return false;
        }
      }
    }
    return true;
  };
}

// ============ GPT Katmanı ============
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function nlToSql_gpt(nl, cols, catColName) {
  if (!process.env.OPENAI_API_KEY) return '';

  const system = `
Sen bir NL→SQLite SQL çevirmenisin.
Tek tablo: ${TABLE}("${cols.join('","')}")
- "Üretim": ton, "Alan": dekar, "Yıl": tam sayı.
- Kategori için kolon adı "${catColName}".
- Yıl belirtilmemişse tüm yılları topla.
- Sadece TEK bir SELECT dön ve sadece SQL yaz.
- Kolonları double-quote ile yaz ("İl","İlçe","${catColName}","Ürün","Yıl","Alan","Üretim","Verim").
  `.trim();

  const user = `
Soru: """${nl}"""
"kaç ton/toplam" -> SUM("Üretim"), "alan" -> SUM("Alan"), "verim" -> AVG("Verim") veya SUM("Üretim")/SUM("Alan").
Gerektiğinde GROUP BY / ORDER BY / LIMIT kullan.
Tablo adı: ${TABLE}.
  `.trim();

  const r = await openai.responses.create({
    model: MODEL,
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });

  let text = (r.output_text || '').trim();
  let sql = text
    .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,'')) // ```sql``` bloklarını soy
    .trim()
    .replace(/;+\s*$/,''); // sondaki ; kaldır
  return sql;
}

// ============ Kural Tabanlı Yedek ============
function ruleBasedSql(nlRaw, cols, catColName) {
  const nl = String(nlRaw || '').trim();

  // İl
  const mIl = nl.match(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:[’'`´]?[dt]e|[’'`´]?[dt]a|\s|$)/);
  const il = mIl ? mIl[1] : '';

  // Yıl
  const year = (nl.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';

  // Ürün anahtarları (geniş liste – sebze/meyve/tahıl karışık)
  const known = /(domates|biber|patlıcan|kabak|hıyar|salatalık|karpuz|karnabahar|lahana|marul|fasulye|soğan|sarımsak|patates|brokoli|ispanak|maydanoz|enginar|bezelye|bakla|elma|portakal|mandalina|limon|muz|zeytin|üzüm|armut|şeftali|kayısı|nar|incir|vişne|çilek|kiraz|kavun|ayva|fındık|ceviz|antep fıstığı|buğday|arpa|mısır|çeltik|pirinç|yulaf|çavdar|ayçiçeği|kanola)/i;
  let urun = (nl.match(known) || [])[1] || '';
  if (!urun) {
    const mu = nl.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*üretimi/i);
    if (mu) urun = mu[1];
  }
  urun = (urun || '').replace(/["'’`´]+/g,'').trim();

  // Kategori (sende "Ürün Çeşidi" kolonuna yansıyor)
  let kat = '';
  if (/sebze/i.test(nl)) kat = 'Sebze';
  else if (/meyve/i.test(nl)) kat = 'Meyve';
  else if (/tah[ıi]l/i.test(nl)) kat = 'Tahıl';

  // 1) “… kaç ton sebze …” veya “… toplam meyve üretimi …”
  if (il && (/kaç\s+ton/i.test(nl) || /toplam.*üretim/i.test(nl)) && !urun) {
    return `
      SELECT SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${il}' ${kat ? `AND "${catColName}"='${kat}'` : ''} ${year ? `AND "Yıl"=${year}` : ''}
    `.trim();
  }

  // 2) “İl 20xx ürün üretimi” / “İl’de domates üretimi”
  if (il && urun && /üretim/i.test(nl)) {
    return `
      SELECT SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${il}' AND "Ürün"='${urun}' ${year ? `AND "Yıl"=${year}` : ''}
    `.trim();
  }

  // 3) “İl’de toplam ekim alanı”
  if (il && /(toplam)?.*(ekim )?alan/i.test(nl)) {
    return `
      SELECT SUM("Alan") AS toplam_alan
      FROM ${TABLE}
      WHERE "İl"='${il}' ${kat ? `AND "${catColName}"='${kat}'` : ''} ${year ? `AND "Yıl"=${year}` : ''}
    `.trim();
  }

  // 4) “İl’de en çok üretilen 5 ürün”
  const topN = (nl.match(/en çok üretilen\s+(\d+)/i) || [])[1] || 10;
  if (il && /(en çok üretilen\s+\d+\s+ürün|en çok üretilen ürün)/i.test(nl)) {
    return `
      SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
      FROM ${TABLE}
      WHERE "İl"='${il}' ${kat ? `AND "${catColName}"='${kat}'` : ''} ${year ? `AND "Yıl"=${year}` : ''}
      GROUP BY "Ürün"
      ORDER BY uretim DESC
      LIMIT ${topN}
    `.trim();
  }

  // 5) “İl’de domates en çok hangi ilçelerde …”
  if (il && urun && /en çok hangi ilçelerde/i.test(nl)) {
    return `
      SELECT "İlçe" AS ilce, SUM("Üretim") AS uretim, SUM("Alan") AS alan
      FROM ${TABLE}
      WHERE "İl"='${il}' AND "Ürün"='${urun}' ${year ? `AND "Yıl"=${year}` : ''}
      GROUP BY "İlçe"
      ORDER BY uretim DESC
      LIMIT 10
    `.trim();
  }

  // 6) “İl’de ortalama verim” (Alan/Üretim’den)
  if (il && /verim/i.test(nl)) {
    return `
      SELECT CASE WHEN SUM("Alan")>0 THEN ROUND(SUM("Üretim")/SUM("Alan"), 4) ELSE NULL END AS ort_verim
      FROM ${TABLE}
      WHERE "İl"='${il}' ${kat ? `AND "${catColName}"='${kat}'` : ''} ${year ? `AND "Yıl"=${year}` : ''}
    `.trim();
  }

  return '';
}

// ============ Güzel cevap (opsiyonel GPT) ============
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

// ============ Handler ============
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Sadece POST isteklerine izin verilir' }); return;
    }

    const { question } = req.body || {};
    const raw = String(question ?? '').trim();
    if (!raw) { res.status(400).json({ ok: false, error: 'question alanı zorunlu' }); return; }

    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });

    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) { res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' }); return; }
    const db = new SQL.Database(fs.readFileSync(dbPath));

    // Dinamik kolon seti + güvenlik filtresi
    const COLS = getColumns(SQL, db);
    const hasKategori = COLS.includes('Kategori');
    const hasUrunCesidi = COLS.includes('Ürün Çeşidi');
    const catColName = hasKategori ? 'Kategori' : (hasUrunCesidi ? 'Ürün Çeşidi' : 'Kategori'); // prompt için isim
    const isSafeSql = makeIsSafeSql([TABLE, ...COLS.map(c => `"${c}"`)]);

    // Hızlı kısa yol: "İl, Ürün" -> ilçe kırılımı top 10
    if (raw.includes(',')) {
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      const stmt = db.prepare(`
        SELECT "İlçe" AS ilce, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM ${TABLE}
        WHERE "İl"=? AND "Ürün"=?
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

    // 1) GPT ile deneriz
    let used = 'nl2sql-gpt', gptErr = '', sql = '';
    try {
      sql = await nlToSql_gpt(raw, COLS, catColName);
    } catch (e) {
      gptErr = `${e?.status || e?.code || ''} ${e?.message || String(e)}`;
      used = 'fallback-rules';
    }

    // 2) Uygunsuz/boşsa kural tabanlı
    if (!sql || !isSafeSql(sql)) {
      const rb = ruleBasedSql(raw, COLS, catColName);
      if (rb && isSafeSql(rb)) { sql = rb; used = 'rules'; }
    }

    // 3) Hâlâ SQL yoksa: il adına göre top ürünler (debug dostu)
    if (!sql) {
      const ilInput = raw;
      const stmt = db.prepare(`
        SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM ${TABLE}
        WHERE "İl"=?
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
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
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
