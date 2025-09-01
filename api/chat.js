// api/chat.js — Vercel Node.js Serverless Function
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

/**
 * Girdi kuralları:
 *  - "Adana"                  -> İL'de en çok üretilen 10 ürün
 *  - "Adana / Ceyhan"         -> İL/İLÇE'de ürün listesi (Üretim ve Alan)
 *  - "Adana, Domates Sofralık"-> İL'de verilen ÜRÜN için en çok üretim yapan 10 ilçe
 *
 * Not: Kolon adları: "İl", "İlçe", "Ürün", "Yıl", "Alan", "Üretim"
 */

function ok(res, data) {
  return res.status(200).json({ ok: true, ...data });
}
function bad(res, msg, code = 400) {
  return res.status(code).json({ ok: false, error: msg });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return bad(res, 'Method Not Allowed', 405);

    const { question } = req.body || {};
    if (!question || !String(question).trim()) {
      return bad(res, 'question alanı zorunlu');
    }

    // sql.js wasm dosyasını bul
    const SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });

    // DB dosyasını public klasöründen oku
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      return bad(res, 'tarimdb.sqlite bulunamadı', 500);
    }
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // --- Sorgu Yorumlama ---
    const raw = String(question).trim();

    // "İl, Ürün" -> il bazında bu ürün için en çok üretim yapan 10 ilçe
    if (raw.includes(',')) {
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      if (!ilInput || !urunInput) return bad(res, 'Biçim: "İl, Ürün"');

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

      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();

      return ok(res, {
        mode: 'il_urun_ilce_top',
        query: { il: ilInput, urun: urunInput },
        results: rows,
      });
    }

    // "İl / İlçe" -> ilçe içinde ürün listesi
    if (raw.includes('/')) {
      const [ilInput, ilceInput] = raw.split('/').map(s => s.trim());
      if (!ilInput || !ilceInput) return bad(res, 'Biçim: "İl / İlçe"');

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

      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();

      return ok(res, {
        mode: 'il_ilce_urun_listesi',
        query: { il: ilInput, ilce: ilceInput },
        results: rows,
      });
    }

    // Sadece "İl" -> ilde en çok üretilen 10 ürün
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

    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();

    return ok(res, {
      mode: 'il_top_urun',
      query: { il: ilInput },
      results: rows,
    });

  } catch (err) {
    console.error('API hata:', err);
    return res.status(500).json({
      ok: false,
      error: 'FUNCTION_INVOCATION_FAILED',
      detail: String(err),
    });
  }
}
