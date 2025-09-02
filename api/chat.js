// api/chat.js — POST + sql.js (WASM) ile SQLite okuma
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

function qToText(rows, lineFmt) {
  if (!rows || rows.length === 0) return 'Veri bulunamadı.';
  return rows.map(lineFmt).join('\n');
}

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

    // sql.js'i başlat (Vercel'de wasm dosyasını node_modules içinden buldur)
    const SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });

    // DB dosyasını public klasöründen oku
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' });
      return;
    }
    const db = new SQL.Database(fs.readFileSync(dbPath));

    // --- Sorgu modları ---
    // Kolonlar: "İl", "İlçe", "Ürün", "Yıl", "Alan", "Üretim"
    let mode = '';
    let rows = [];

    // "İl, Ürün" -> o ilde bu ürünü en çok üreten 10 ilçe
    if (raw.includes(',')) {
      mode = 'il_urun_ilce_top';
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());

      const stmt = db.prepare(`
        SELECT "İlçe" AS ilce,
               SUM("Üretim") AS uretim,
               SUM("Alan")   AS alan
        FROM sebze
        WHERE "İl" = ? AND "Ürün" = ?
        GROUP BY "İlçe"
        ORDER BY uretim DESC
        LIMIT 10;
      `);
      stmt.bind([ilInput, urunInput]);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();

      const text = qToText(rows, r => `• ${r.ilce}: ${r.uretim} ton, ${r.alan} dekar`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(
        `🧭 Mod: ${mode}\nİl: ${ilInput} | Ürün: ${urunInput}\n\n` + text
      );
      return;
    }

    // "İl / İlçe" -> o ilçedeki ürün listesi
    if (raw.includes('/')) {
      mode = 'il_ilce_urun_listesi';
      const [ilInput, ilceInput] = raw.split('/').map(s => s.trim());

      const stmt = db.prepare(`
        SELECT "Ürün" AS urun,
               SUM("Üretim") AS uretim,
               SUM("Alan")   AS alan
        FROM sebze
        WHERE "İl" = ? AND "İlçe" = ?
        GROUP BY "Ürün"
        ORDER BY uretim DESC, alan DESC;
      `);
      stmt.bind([ilInput, ilceInput]);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();

      const text = qToText(rows, r => `• ${r.urun.trim()}: ${r.uretim} ton, ${r.alan} dekar`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(
        `🧭 Mod: ${mode}\nİl: ${ilInput} | İlçe: ${ilceInput}\n\n` + text
      );
      return;
    }

    // Sadece "İl" -> ilde en çok üretilen 10 ürün
    mode = 'il_top_urun';
    const ilInput = raw;

    const stmt = db.prepare(`
      SELECT "Ürün" AS urun,
             SUM("Üretim") AS uretim,
             SUM("Alan")   AS alan
      FROM sebze
      WHERE "İl" = ?
      GROUP BY "Ürün"
      ORDER BY uretim DESC
      LIMIT 10;
    `);
    stmt.bind([ilInput]);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();

    const text = qToText(rows, r => `• ${r.urun.trim()}: ${r.uretim} ton, ${r.alan} dekar`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(`🧭 Mod: ${mode}\nİl: ${ilInput}\n\n` + text);
  } catch (err) {
    console.error('API hata:', err);
    res.status(500).json({
      ok: false,
      error: 'FUNCTION_INVOCATION_FAILED',
      detail: String(err),
    });
  }
}
