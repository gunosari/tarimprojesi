// api/chat.js — DEBUG (soru zorunlu değil)
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

function ok(res, data) { return res.status(200).json({ ok: true, ...data }); }
function bad(res, msg, code = 400) { return res.status(code).json({ ok: false, error: msg }); }

function execRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const cols = stmt.getColumnNames();
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return { columns: cols, rows };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return bad(res, 'Method Not Allowed', 405);

    const { question } = req.body || {};
    const raw = String(question ?? '').trim();

    const SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });

    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) return bad(res, 'tarimdb.sqlite bulunamadı', 500);
    const db = new SQL.Database(fs.readFileSync(dbPath));

    // --- ŞEMA & ÖRNEKLER (teşhis) ---
    const tables = execRows(db, "SELECT name FROM sqlite_master WHERE type='table'");
    const schemaSebze = execRows(db, "PRAGMA table_info(sebze)");
    const sampleSebze = execRows(db, "SELECT * FROM sebze LIMIT 5");
    const distinct_Il    = execRows(db, 'SELECT DISTINCT "İl"  FROM sebze LIMIT 20');
    const distinct_il    = execRows(db, 'SELECT DISTINCT il   FROM sebze LIMIT 20');
    const distinct_Urun  = execRows(db, 'SELECT DISTINCT "Ürün" FROM sebze LIMIT 20');
    const distinct_urun  = execRows(db, 'SELECT DISTINCT urun FROM sebze LIMIT 20');

    // --- Normal sorgu (varsa) ---
    let mode = 'debug_only', results = [];
    if (raw) {
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
      } else {
        mode = 'il_top_urun';
        const ilInput = raw;
        results = execRows(db, `
          SELECT "Ürün" AS urun, SUM("Üretim") AS uretim, SUM("Alan") AS alan
          FROM sebze WHERE "İl" = ?
          GROUP BY "Ürün" ORDER BY uretim DESC LIMIT 10
        `, [ilInput]).rows;
      }
    }

    return ok(res, {
      mode,
      query: { question: raw || null },
      results,
      debug: {
        tables: tables.rows.map(r => r.name),
        schema_sebze: schemaSebze.rows,   // {cid,name,type,...}
        sample_sebze: sampleSebze.rows,
        distinct_Il: distinct_Il.rows,
        distinct_il: distinct_il.rows,
        distinct_Urun: distinct_Urun.rows,
        distinct_urun: distinct_urun.rows
      }
    });

  } catch (err) {
    console.error('API hata:', err);
    return res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
