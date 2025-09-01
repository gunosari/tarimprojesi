// api/chat.js  — Vercel Node.js Serverless Function
export const config = { runtime: 'nodejs' };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { question } = req.body || {};
    if (!question) {
      return res.status(400).json({ error: 'question alanı zorunlu' });
    }

    // sql.js wasm dosyasını node_modules içinden buldur
    const SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });

    // DB dosyasını public klasöründen oku
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      return res.status(500).json({ error: 'tarimdb.sqlite bulunamadı' });
    }
    const fileBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(fileBuffer);

    // Basit test: tablo adlarını döndür
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = tables?.[0]?.values?.map(v => v[0]) ?? [];

    return res.status(200).json({
      ok: true,
      echo: question,
      db_tables: tableNames
    });
  } catch (err) {
    console.error('API hata:', err);
    return res.status(500).json({
      error: 'FUNCTION_INVOCATION_FAILED',
      detail: String(err)
    });
  }
}
