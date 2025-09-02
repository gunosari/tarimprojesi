// pages/api/chat.js

import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Sadece GET isteklerine izin verilir');
  }

  const soru = req.query.q;
  if (!soru) {
    return res.status(400).send('Soru parametresi gerekli');
  }

  const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
  const sqlite3 = require('sqlite3').verbose();
  const db = new sqlite3.Database(dbPath);

  let mode = "";
  let results = [];

  // Basit örnek: il ismi varsa en çok üretilen ürünleri getir
  const iller = ["Adana", "Mersin", "Antalya", "İzmir", "Bursa", "Konya"];
  const secilenIl = iller.find(il => soru.includes(il));

  if (secilenIl) {
    mode = "il_top_urun";

    const query = `
      SELECT urun, SUM(uretim_miktari) as uretim, SUM(alan) as alan
      FROM sebze_uretim
      WHERE il = ?
      GROUP BY urun
      ORDER BY uretim DESC
      LIMIT 5
    `;

    await new Promise((resolve, reject) => {
      db.all(query, [secilenIl], (err, rows) => {
        if (err) reject(err);
        results = rows;
        resolve();
      });
    });

    db.close();

    // HTML çıktı hazırla
    const htmlOutput = `
      <h2>${secilenIl} ili için en çok üretilen ürünler:</h2>
      <ul>
        ${results.map(r => `
          <li>
            <strong>${r.urun.trim()}</strong><br/>
            Üretim: ${r.uretim.toLocaleString()} ton<br/>
            Alan: ${r.alan.toLocaleString()} dekar
          </li>
        `).join('')}
      </ul>
    `;

    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(htmlOutput);
  }

  // İl tanınmadıysa:
  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`<p>Maalesef "${soru}" hakkında bilgi bulunamadı. Lütfen il ismini doğru yazdığınızdan emin olun.</p>`);
}
