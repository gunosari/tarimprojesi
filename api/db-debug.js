// api/db-debug.js - Veritabanı yapısını incele
export const config = { runtime: 'nodejs' };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  try {
    // SQL.js init
    const SQL = await initSqlJs({
      locateFile: (file) => {
        if (process.env.VERCEL) {
          return `/sql-wasm.wasm`;
        }
        return path.join(process.cwd(), 'node_modules/sql.js/dist', file);
      }
    });
    
    // Database yükle
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    const buffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(buffer);
    
    let output = "=== VERİTABANI YAPISI İNCELEMESİ ===\n\n";
    
    // 1. Tüm tabloları listele
    output += "1. TABLOLAR:\n";
    const tableStmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
    while (tableStmt.step()) {
      const table = tableStmt.getAsObject();
      output += `- ${table.name}\n`;
    }
    tableStmt.free();
    
    // 2. Ana tablonun yapısı
    output += "\n2. 'urunler' TABLOSU YAPISI:\n";
    try {
      const schemaStmt = db.prepare("PRAGMA table_info('urunler')");
      while (schemaStmt.step()) {
        const col = schemaStmt.getAsObject();
        output += `- ${col.name} (${col.type})\n`;
      }
      schemaStmt.free();
    } catch (e) {
      output += `Tablo bulunamadı: ${e.message}\n`;
    }
    
    // 3. Toplam satır sayısı
    output += "\n3. TOPLAM SATIR SAYISI:\n";
    try {
      const countStmt = db.prepare("SELECT COUNT(*) as total FROM urunler");
      countStmt.step();
      const count = countStmt.getAsObject();
      output += `Toplam: ${count.total} satır\n`;
      countStmt.free();
    } catch (e) {
      output += `Sayım hatası: ${e.message}\n`;
    }
    
    // 4. İlk 5 satırı göster
    output += "\n4. İLK 5 SATIR:\n";
    try {
      const sampleStmt = db.prepare("SELECT * FROM urunler LIMIT 5");
      let rowCount = 0;
      while (sampleStmt.step()) {
        const row = sampleStmt.getAsObject();
        output += `Satır ${++rowCount}: ${JSON.stringify(row)}\n`;
      }
      sampleStmt.free();
    } catch (e) {
      output += `Örnek veri hatası: ${e.message}\n`;
    }
    
    // 5. Benzersiz iller
    output += "\n5. İLLER (İlk 10):\n";
    try {
      const ilStmt = db.prepare("SELECT DISTINCT il FROM urunler LIMIT 10");
      while (ilStmt.step()) {
        const il = ilStmt.getAsObject();
        output += `- ${il.il}\n`;
      }
      ilStmt.free();
    } catch (e) {
      output += `İl listesi hatası: ${e.message}\n`;
    }
    
    // 6. Benzersiz ürünler
    output += "\n6. ÜRÜNLER (İlk 10):\n";
    try {
      const urunStmt = db.prepare("SELECT DISTINCT urun_adi FROM urunler LIMIT 10");
      while (urunStmt.step()) {
        const urun = urunStmt.getAsObject();
        output += `- ${urun.urun_adi}\n`;
      }
      urunStmt.free();
    } catch (e) {
      output += `Ürün listesi hatası: ${e.message}\n`;
    }
    
    // 7. Test sorgusu - Adana 
    output += "\n7. TEST SORGUSU - Adana:\n";
    try {
      const testStmt = db.prepare(`
        SELECT il, COUNT(*) as satir_sayisi, SUM(uretim_miktari) as toplam_uretim 
        FROM urunler 
        WHERE il='Adana'
        GROUP BY il
      `);
      
      if (testStmt.step()) {
        const result = testStmt.getAsObject();
        output += `Adana sonucu: ${JSON.stringify(result)}\n`;
      } else {
        output += "Adana'da hiç veri bulunamadı!\n";
      }
      testStmt.free();
    } catch (e) {
      output += `Adana test hatası: ${e.message}\n`;
    }
    
    // 8. Yıl kontrolü
    output += "\n8. YILLAR:\n";
    try {
      const yilStmt = db.prepare("SELECT DISTINCT yil FROM urunler ORDER BY yil");
      while (yilStmt.step()) {
        const yil = yilStmt.getAsObject();
        output += `- ${yil.yil}\n`;
      }
      yilStmt.free();
    } catch (e) {
      output += `Yıl listesi hatası: ${e.message}\n`;
    }
    
    res.status(200).send(output);
    
  } catch (error) {
    res.status(500).send(`Hata: ${error.message}\n${error.stack}`);
  }
}
