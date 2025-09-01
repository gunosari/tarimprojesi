// api/chat.js — DEBUG SÜRÜMÜ (şemayı ve örnek veriyi de döndürür)
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

function ok(res, data) { return res.status(200).json({ ok: true, ...data }); }
function bad(res, msg, code = 400) { return res.status(code).json({ ok: false, error: msg }); }

// Küçük yardımcı: sql.js çıktısını {rows:[...], columns:[...]}'a çevir
function execRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return { columns: cols, rows };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return bad(res, 'Method Not Allowed', 405);
    const { question } = req.body || {};
    const SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });

    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) return bad(res, 'tarimdb.sqlite bulunamadı', 500);
    const db = new SQL.Database(fs.readFileSync(dbPath));

    // --- ŞEMA & ÖRNEKLER (teşhis için) ---
    const tables = execRows(db, "SELECT name FROM sqlite_master WHERE type='table'");
    const schemaSebze = execRows(db, "PRAGMA table_info(sebze)");
    const sampleSebze = execRows(db, "SELECT * FROM sebze LIMIT 5");
    const distinctIl = execRows(db, 'SELECT DISTINCT "İl" FROM sebze LIMIT 20');
    const distinctIl_alt = execRows(db, 'SELECT DISTINCT il FROM sebze LIMIT 20'); // ASCII olasılığı

    // --- Normal Sorgu (ilk deneme: Türkçe başlıklar) ---
    let mode = 'il_top_urun', results = [];
    const raw = String(question || '').trim();

    if (raw.includes(',')) {
      mode = 'il_urun_ilce_top';
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      results = execRows(db, `
        SELECT "İlçe" AS ilce, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM sebze WHERE "İl" = ? AND "Ürün" = ?
        GROUP BY "İlçe" ORDER BY uretim DESC LIMIT 10
      `, [ilInput, urunInput]).rows;
    } else if (raw.includes('/')) {
      mode = 'il_ilce_urun_listesi';
      const [ilInput, ilceInput] = raw.split('/').map(s => s.trim());
      results = execRows(db, `
        SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM sebze WHERE "İl" = ? AND "İlçe" = ?
        GROUP BY "Ürün" ORDER BY uretim DESC, alan DESC
      `, [ilInput, ilceInput]).rows;
    } else if (raw) {
      mode = 'il_top_urun';
      const ilInput = raw;
      results = execRows(db, `
        SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
        FROM sebze WHERE "İl" = ?
        GROUP BY "Ürün" ORDER BY uretim DESC LIMIT 10
      `, [ilInput]).rows;
    }

    return ok(res, {
      mode, query: { question: raw || null },
      results,
      // --- DEBUG VERİSİ ---
      debug: {
        tables: tables.rows.map(r => r.name),
        schema_sebze: schemaSebze.rows,            // -> {cid, name, type, ...}
        sample_sebze: sampleSebze.rows,            // ilk 5 satır
        distinct_Il: distinctIl.rows,              // "İl" kolonu varsa
        distinct_il_ascii: distinctIl_alt.rows     // "il" kolonu varsa
      }
    });
  } catch (err) {
    console.error('API hata:', err);
    return res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
