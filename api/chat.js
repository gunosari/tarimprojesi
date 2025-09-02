// api/chat.js — NL→SQL (GPT + kural tabanlı yedek), SQLite çalıştırma, doğal cümle
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

// =================== Ayarlar ===================
const TABLE = 'sebze';
const COLS  = ['İl', 'İlçe', 'Ürün', 'Yıl', 'Alan', 'Üretim'];
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // <— modeli buradan yönet

// ====== Yardımcılar ======
function qToText(rows, lineFmt) {
  if (!rows || rows.length === 0) return 'Veri bulunamadı.';
  return rows.map(lineFmt).join('\n');
}

// Basit güvenlik: sadece SELECT, tek ifade, sadece bizim tablo/kolonlar
function isSafeSql(sql) {
  const s = (sql || '').trim().toLowerCase();
  if (!s.startsWith('select')) return false;
  if (s.includes('--') || s.includes('/*')) return false;

  const rawCols = COLS.map(c => `"${c}"`.toLowerCase());
  const allowed = [TABLE.toLowerCase(), ...rawCols];

  const tokens = s.replace(/[^a-z0-9_ğüşöçıİĞÜŞÖÇ" ]/gi, ' ')
                  .split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (/^[a-zıiöüçğ_"]+$/i.test(t) && !allowed.includes(t)) {
      if (!['select','sum','avg','count','min','max',
             'from','where','and','or','group','by','order',
             'desc','asc','limit','as','having','like'].includes(t)) {
        return false;
      }
    }
  }
  return true;
}

// =================== Kural tabanlı basit NL→SQL (fallback) ===================
function ruleBasedSql(nlRaw) {
  const nl = String(nlRaw || '').trim();

  // İl: cümledeki ilk büyük harfle başlayan kelime (Mersin, Adana ...)
  const ilMatch = nl.match(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:[’'`´]?[dt]e|[’'`´]?[dt]a|\s|$)/);
  const il = ilMatch ? ilMatch[1] : '';

  // Yıl
  const year = (nl.match(/\b(20\d{2}|19\d{2})\b/) || [])[1] || '';

  // Ürün adı (bilinenlerden ya da “… ürün(ü) üretimi” kalıbından)
  const known = /(domates|biber|patlıcan|kabak|hıyar|salatalık|karpuz|karnabahar|lahana|marul|fasulye|soğan|sarımsak|patates)/i;
  let urun = (nl.match(known) || [])[1] || '';
  if (!urun) {
    const mu = nl.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*üretimi/i);
    if (mu) urun = mu[1];
  }
  urun = (urun || '').replace(/["'’`´]+/g, '').trim();

  // 1) “… kaç ton sebze …”
  if (il && /kaç\s+ton.*sebze/i.test(nl)) {
    return `
      SELECT SUM("Üretim") AS toplam_uretim
      FROM ${TABLE}
      WHERE "İl"='${il}' ${year ? `AND "Yıl"=${year}` : ''}
    `.trim();
  }

  // 2) “İl 20xx ürün üretimi” / “İl’de ürün üretimi”
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
      WHERE "İl"='${il}' ${year ? `AND "Yıl"=${year}` : ''}
    `.trim();
  }

  // 4) “İl’de en çok üretilen 5 ürün”
  const topN = (nl.match(/en çok üretilen\s+(\d+)/i) || [])[1] || 10;
  if (il && /(en çok üretilen\s+\d+\s+ürün|en çok üretilen ürün)/i.test(nl)) {
    return `
      SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
      FROM ${TABLE}
      WHERE "İl"='${il}' ${year ? `AND "Yıl"=${year}` : ''}
      GROUP BY "Ürün"
      ORDER BY uretim DESC
      LIMIT ${topN}
    `.trim();
  }

  // 5) “İl’de domates en çok hangi ilçelerde…”
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

  return '';
}

// =================== GPT Katmanı ===================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function nlToSql_gpt(nl) {
  if (!process.env.OPENAI_API_KEY) return '';

  const system = `
Sen bir NL→SQLite SQL çevirmenisin.
Tek tablo: ${TABLE}("${COLS.join('","')}")
- "Üretim": ton, "Alan": dekar.
- Yıl verilmemişse tüm yılları topla.
- Sadece TEK bir SELECT üret ve sadece SQL döndür.
  `;
  const user = `
Soru: """${nl}"""
Double quote ile kolon isimlerini yaz ("İl","İlçe","Ürün","Yıl","Alan","Üretim").
"kaç ton/toplam" -> SUM("Üretim"), "alan" -> SUM("Alan").
Gerekiyorsa GROUP BY / ORDER BY / LIMIT kullan.
  `;

  const resp = await openai.responses.create({
    model: MODEL,
    input: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });

  // metni al, codeblock'ları soy, sondaki ; işaretini temizle
  let text = (resp.output_text || '').trim();
  let sql = text
    .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,'')) // ```sql``` bloklarını soy
    .trim()
    .replace(/;+\s*$/,''); // sondaki ; karakter(ler)ini kaldır
  return sql;
}

async function prettyAnswer(question, rows) {
  if (!process.env.OPENAI_API_KEY) {
    if (!rows?.length) return 'Veri bulunamadı.';
    if (rows.length === 1) return Object.entries(rows[0]).map(([k,v]) => `${k}: ${v}`).join(' • ');
    return `${rows.length} satır döndü.`;
  }
  const sample = Array.isArray(rows) ? rows.slice(0, 5) : [];
  const resp = await openai.responses.create({
    model: MODEL,
    input: [
      { role: 'system', content: 'Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcı ile yaz.' },
      { role: 'user', content: `Soru: ${question}\nVeri örneği (JSON): ${JSON.stringify(sample)}\nToplam satır: ${rows.length}\n1-2 cümlelik insani özet yaz.` }
    ],
  });
  return (resp.output_text || '').trim();
}

// =================== Handler ===================
export default async function handler(req, res) {
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

    // DB
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' });
      return;
    }
    const db = new SQL.Database(fs.readFileSync(dbPath));

    // 0) Hızlı kısa yol: "İl, Ürün"  => ilde ürünün en çok üretildiği 10 ilçe
    if (raw.includes(',')) {
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      const stmt = db.prepare(`
        SELECT "İlçe" AS ilce, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM ${TABLE}
        WHERE "İl" = ? AND "Ürün" = ?
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

    // 1) Önce GPT ile NL→SQL dene
    let used = 'nl2sql-gpt';
    let gptErr = '';
    let sql = '';
    try {
      sql = await nlToSql_gpt(raw);
    } catch (e) {
      gptErr = `${e?.status || e?.code || ''} ${e?.message || String(e)}`;
      used = 'fallback-rules';
    }

    // 2) GPT boş/uygunsuz ise kural tabanlıya geç
    if (!sql || !isSafeSql(sql)) {
      const rb = ruleBasedSql(raw);
      if (rb && isSafeSql(rb)) { sql = rb; used = 'rules'; }
    }

    // 3) Hâlâ SQL yoksa en basit fallback: il adına göre top ürünler
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
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
    } catch (e) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: ${used} (model: ${MODEL})\nSQL derlenemedi.\nSQL:\n${sql}\n\nHata: ${String(e)}`);
      return;
    }

    // 5) Özet (API varsa güzel cümle, yoksa mekanik)
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
