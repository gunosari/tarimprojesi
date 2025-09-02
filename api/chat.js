// api/chat.js — NL→SQL, SQLite çalıştırma, doğal cümle döndürme
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

// =================== Ayarlar ===================
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // <— buradan modeli yönet

// ====== Yardımcılar ======
function qToText(rows, lineFmt) {
  if (!rows || rows.length === 0) return 'Veri bulunamadı.';
  return rows.map(lineFmt).join('\n');
}

// Basit ama işe yarar bir SQL doğrulaması (sadece SELECT, tek ifade, whitelist kolonlar)
const TABLE = 'sebze';
const COLS = ['İl', 'İlçe', 'Ürün', 'Yıl', 'Alan', 'Üretim'];
function isSafeSql(sql) {
  const s = sql.trim().toLowerCase();
  if (!s.startsWith('select')) return false;
  if (s.includes(';')) return false;               // tek ifade
  if (s.includes('--') || s.includes('/*')) return false; // yorum hilesi yok
  // yalnızca bizim tablo ve kolonlar
  const rawCols = COLS.map(c => `"${c}"`.toLowerCase());
  const allowed = [TABLE.toLowerCase(), ...rawCols];
  // kaba bir beyaz liste kontrolü:
  const tokens = s.replace(/[^a-z0-9_ğüşöçıİĞÜŞÖÇ" ]/gi,' ').split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    // stringler, sayılar zaten elenir; kalan isimlerde sadece allowed olsun
    if (/^[a-zıiöüçğ_"]+$/i.test(t) && !allowed.includes(t)) {
      // SQL anahtar kelimelerini es geç
      if (!['select','sum','from','where','and','or','group','by','order','desc','asc','limit','as','having','avg','count','min','max'].includes(t))
        return false;
    }
  }
  return true;
}

// ====== GPT Katmanı: NL → SQL ======
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function nlToSql(nl) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY tanımlı değil');
  }

  const system = `
Sen bir NL→SQLite SQL çevirmenisin.
Sadece şu tablo var: ${TABLE}("${COLS.join('","')}")
- "Üretim": ton, "Alan": dekar. 
- Yıl filtrelenmemişse tüm yıllar toplanır.
- Sadece güvenli, tek bir SELECT üret.
- ÇIKTIYI SADECE SQL OLARAK ver (başka açıklama yok).
  `;
  const user = `
Soru: """${nl}"""
Lütfen yalnızca geçerli bir SQLite SELECT sorgusu döndür.
Double quote ile kolon isimlerini yaz ("İl", "İlçe" ...). 
Eğer “kaç ton” veya “toplam” vb. geçiyorsa SUM("Üretim") kullan.
Eğer “alan” soruluyorsa SUM("Alan") kullan.
Mantıklıysa GROUP BY ve ORDER BY ekle, LIMIT uygula.
  `;

  const resp = await openai.responses.create({
    model: MODEL, // <— burada
    input: [{ role: "system", content: system }, { role: "user", content: user }],
  });

  const text = resp.output_text?.trim() || '';
  // Kod bloklarını temizle
  const sql = text.replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').replace(/```/g,'')).trim();
  return sql;
}

// ====== GPT Katmanı: veriyi doğal cümleye çevir ======
async function prettyAnswer(question, rows) {
  if (!process.env.OPENAI_API_KEY) return '';
  const sample = Array.isArray(rows) ? rows.slice(0, 5) : [];
  const resp = await openai.responses.create({
    model: MODEL, // <— burada da aynı model
    input: [
      { role: "system", content: "Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcı ile yaz." },
      { role: "user", content: `Soru: ${question}\nVeri örneği (JSON): ${JSON.stringify(sample)}\nVeri toplam satır: ${rows.length}\nBu veriye göre 1-2 cümlelik insani cevap yaz.` }
    ],
  });
  return (resp.output_text || '').trim();
}

// ====== Handler ======
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

    // 0) Basit kısa yollar (performans & sağlamlık için)
    // "İl, Ürün"  => ilde ürünün en çok üretildiği 10 ilçe
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

    // 1) Doğal dil → SQL
    let sql = await nlToSql(raw);

    // 2) Güvenlik filtresi; geçmezse yedek kurallara dön
    if (!isSafeSql(sql)) {
      // Basit yedek: sadece il adı girilmiş olabilir
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

    // 3) SQL'i çalıştır
    let rows = [];
    try {
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
    } catch (e) {
      res.status(200).send(`🧭 Mod: nl2sql\nSQL derlenemedi.\nSQL:\n${sql}\n\nHata: ${String(e)}`);
      return;
    }

    // 4) Güzel cümle
    const nice = await prettyAnswer(raw, rows);

    // 5) Ham tablo + güzel cümle birlikte döndür (debug kolay olsun)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(
      `🧭 Mod: nl2sql\nSoru: ${raw}\nSQL: ${sql}\n\n${nice}\n\n` +
      (rows.length ? qToText(rows, r => '• ' + JSON.stringify(r)) : 'Veri bulunamadı.')
    );

  } catch (err) {
    console.error('API hata:', err);
    res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
