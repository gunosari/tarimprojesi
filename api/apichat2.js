// api/apichat2.js — NeoBi Karar Destek Sistemi API (Claude API)
export const config = { runtime: 'nodejs', maxDuration: 60 };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import Anthropic from '@anthropic-ai/sdk';

/** ======= CONFIG ======= */
const DB_FILE = 'kds_vt.db';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

/** ======= RATE LIMITING ======= */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = rateLimitMap.get(ip) || [];
  const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  if (recentRequests.length >= RATE_LIMIT_MAX) return false;
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);
  return true;
}

/** ======= DATABASE ======= */
let dbInstance = null;
let sqlPromise = null;

async function getSQL() {
  if (sqlPromise) return sqlPromise;
  sqlPromise = (async () => {
    const wasmResponse = await fetch('https://sql.js.org/dist/sql-wasm.wasm');
    const wasmBinary = await wasmResponse.arrayBuffer();
    return await initSqlJs({ wasmBinary });
  })();
  return sqlPromise;
}

async function getDB() {
  if (dbInstance) return dbInstance;
  const SQL = await getSQL();
  const dbPath = path.join(process.cwd(), 'public', DB_FILE);
  const buffer = fs.readFileSync(dbPath);
  dbInstance = new SQL.Database(buffer);
  return dbInstance;
}

/** ======= SQL EXECUTION ======= */
function executeQuery(db, sql, params) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return { success: true, data: results };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getMaxYil(db) {
  const result = executeQuery(db, `SELECT MAX("Yıl") as maxYil FROM kds`, []);
  return result.success && result.data.length > 0 ? result.data[0].maxYil : 2024;
}

/** ======= DYNAMIC QUERIES ======= */
// maxYil parametresiyle sorguları oluştur
function getIlSorulari(Y) {
  // Y = maxYil (örn: 2024), Y4 = 4 yıl öncesi (örn: 2020)
  const Y4 = Y - 4;
  return [
    { 
      id: 1, 
      soru: `Bu ilde ${Y} yılında en çok üretilen 5 ürün nedir?`, 
      sql: `SELECT "Ürün", SUM("Üretim") as toplam FROM kds WHERE "İl" = ? AND "Yıl" = ? GROUP BY "Ürün" ORDER BY toplam DESC LIMIT 5`,
      params: (secim) => [secim, Y]
    },
    { 
      id: 2, 
      soru: "Son 3 yılda üretim trendi nasıl?", 
      sql: `SELECT "Yıl", SUM("Üretim") as toplam FROM kds WHERE "İl" = ? AND "Yıl" >= ? GROUP BY "Yıl" ORDER BY "Yıl"`,
      params: (secim) => [secim, Y - 2]
    },
    { 
      id: 3, 
      soru: `${Y} yılında verim ortalaması Türkiye ortalamasının üstünde mi?`, 
      sql: `SELECT "Ürün Grubu", AVG("Verim") as il_verim, (SELECT AVG("Verim") FROM kds WHERE "Ürün Grubu" = k."Ürün Grubu" AND "Yıl" = ?) as tr_verim FROM kds k WHERE "İl" = ? AND "Yıl" = ? GROUP BY "Ürün Grubu"`,
      params: (secim) => [Y, secim, Y]
    },
    { 
      id: 4, 
      soru: `${Y} yılında hangi ürün grubunda en güçlü?`, 
      sql: `SELECT "Ürün Grubu", SUM("Üretim") as toplam, SUM("Alan") as alan FROM kds WHERE "İl" = ? AND "Yıl" = ? GROUP BY "Ürün Grubu" ORDER BY toplam DESC LIMIT 1`,
      params: (secim) => [secim, Y]
    },
    { 
      id: 5, 
      soru: `${Y4}-${Y} arası üretimi en çok artan 3 ürün hangisi?`, 
      sql: `SELECT a."Ürün", (a.toplam - b.toplam) as fark, a.toplam as son_yil, b.toplam as ilk_yil
            FROM (SELECT "Ürün", SUM("Üretim") as toplam FROM kds WHERE "İl" = ? AND "Yıl" = ? GROUP BY "Ürün") a
            INNER JOIN (SELECT "Ürün", SUM("Üretim") as toplam FROM kds WHERE "İl" = ? AND "Yıl" = ? GROUP BY "Ürün") b
            ON a."Ürün" = b."Ürün"
            ORDER BY fark DESC LIMIT 3`,
      params: (secim) => [secim, Y, secim, Y4]
    },
    { 
      id: 6, 
      soru: `${Y4}-${Y} arası üretimi en çok azalan 3 ürün hangisi?`, 
      sql: `SELECT a."Ürün", (a.toplam - b.toplam) as fark, a.toplam as son_yil, b.toplam as ilk_yil
            FROM (SELECT "Ürün", SUM("Üretim") as toplam FROM kds WHERE "İl" = ? AND "Yıl" = ? GROUP BY "Ürün") a
            INNER JOIN (SELECT "Ürün", SUM("Üretim") as toplam FROM kds WHERE "İl" = ? AND "Yıl" = ? GROUP BY "Ürün") b
            ON a."Ürün" = b."Ürün"
            ORDER BY fark ASC LIMIT 3`,
      params: (secim) => [secim, Y, secim, Y4]
    },
    { 
      id: 7, 
      soru: "Son 5 yılda toplam ekim alanı trendi", 
      sql: `SELECT "Yıl", SUM("Alan") as toplam_alan FROM kds WHERE "İl" = ? AND "Yıl" >= ? GROUP BY "Yıl" ORDER BY "Yıl"`,
      params: (secim) => [secim, Y4]
    },
    { 
      id: 8, 
      soru: `${Y} yılında ürün çeşitliliği ne durumda?`, 
      sql: `SELECT COUNT(DISTINCT "Ürün") as urun_sayisi, COUNT(DISTINCT "Ürün Grubu") as grup_sayisi FROM kds WHERE "İl" = ? AND "Yıl" = ?`,
      params: (secim) => [secim, Y]
    },
    { 
      id: 9, 
      soru: `${Y} yılında en verimli 5 ürün hangileri?`, 
      sql: `SELECT "Ürün", AVG("Verim") as ort_verim FROM kds WHERE "İl" = ? AND "Yıl" = ? AND "Verim" > 0 GROUP BY "Ürün" ORDER BY ort_verim DESC LIMIT 5`,
      params: (secim) => [secim, Y]
    },
    { 
      id: 10, 
      soru: "Son 5 yılda yıllık üretim değişim oranı nedir?", 
      sql: `SELECT "Yıl", SUM("Üretim") as uretim FROM kds WHERE "İl" = ? AND "Yıl" >= ? GROUP BY "Yıl" ORDER BY "Yıl"`,
      params: (secim) => [secim, Y4]
    }
  ];
}

function getUrunSorulari(Y) {
  const Y4 = Y - 4;
  return [
    { 
      id: 1, 
      soru: `${Y} yılında bu ürünü en çok üreten 5 il hangisi?`, 
      sql: `SELECT "İl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" = ? GROUP BY "İl" ORDER BY toplam DESC LIMIT 5`,
      params: (secim) => [secim, Y]
    },
    { 
      id: 2, 
      soru: "Son 5 yılda Türkiye geneli üretim trendi nasıl?", 
      sql: `SELECT "Yıl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" >= ? GROUP BY "Yıl" ORDER BY "Yıl"`,
      params: (secim) => [secim, Y4]
    },
    { 
      id: 3, 
      soru: "Son 5 yılda ortalama verim ne kadar?", 
      sql: `SELECT "Yıl", AVG("Verim") as ort_verim FROM kds WHERE "Ürün" = ? AND "Yıl" >= ? AND "Verim" > 0 GROUP BY "Yıl" ORDER BY "Yıl"`,
      params: (secim) => [secim, Y4]
    },
    { 
      id: 4, 
      soru: "Son 5 yılda toplam ekim alanı ne kadar?", 
      sql: `SELECT "Yıl", SUM("Alan") as toplam_alan FROM kds WHERE "Ürün" = ? AND "Yıl" >= ? GROUP BY "Yıl" ORDER BY "Yıl"`,
      params: (secim) => [secim, Y4]
    },
    { 
      id: 5, 
      soru: `${Y4}-${Y} arası üretimi en çok artan 5 il hangileri?`, 
      sql: `SELECT a."İl", (a.toplam - b.toplam) as fark, a.toplam as son_yil, b.toplam as ilk_yil
            FROM (SELECT "İl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" = ? GROUP BY "İl") a
            INNER JOIN (SELECT "İl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" = ? GROUP BY "İl") b
            ON a."İl" = b."İl"
            ORDER BY fark DESC LIMIT 5`,
      params: (secim) => [secim, Y, secim, Y4]
    },
    { 
      id: 6, 
      soru: `${Y4}-${Y} arası üretimi en çok azalan 5 il hangileri?`, 
      sql: `SELECT a."İl", (a.toplam - b.toplam) as fark, a.toplam as son_yil, b.toplam as ilk_yil
            FROM (SELECT "İl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" = ? GROUP BY "İl") a
            INNER JOIN (SELECT "İl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" = ? GROUP BY "İl") b
            ON a."İl" = b."İl"
            ORDER BY fark ASC LIMIT 5`,
      params: (secim) => [secim, Y, secim, Y4]
    },
    { 
      id: 7, 
      soru: `${Y} yılında kaç ilde üretiliyor?`, 
      sql: `SELECT COUNT(DISTINCT "İl") as il_sayisi FROM kds WHERE "Ürün" = ? AND "Yıl" = ?`,
      params: (secim) => [secim, Y]
    },
    { 
      id: 8, 
      soru: `${Y} yılında en verimli 5 il hangileri?`, 
      sql: `SELECT "İl", AVG("Verim") as ort_verim FROM kds WHERE "Ürün" = ? AND "Yıl" = ? AND "Verim" > 0 GROUP BY "İl" ORDER BY ort_verim DESC LIMIT 5`,
      params: (secim) => [secim, Y]
    },
    { 
      id: 9, 
      soru: `${Y} yılında Türkiye toplam üretimi ne kadar?`, 
      sql: `SELECT SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" = ?`,
      params: (secim) => [secim, Y]
    },
    { 
      id: 10, 
      soru: "Yıllık büyüme oranı nedir?", 
      sql: `SELECT "Yıl", SUM("Üretim") as uretim FROM kds WHERE "Ürün" = ? AND "Yıl" >= ? GROUP BY "Yıl" ORDER BY "Yıl"`,
      params: (secim) => [secim, Y4]
    }
  ];
}

/** ======= AI ANALYSIS ======= */
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateAnalysis(secim, tip, sorular, sonuclar, maxYil) {
  const context = tip === 'il' 
    ? `${secim} ili için ${maxYil} yılı tarımsal analiz yapıyorsun.`
    : `${secim} ürünü için ${maxYil} yılı Türkiye geneli analiz yapıyorsun.`;

  const dataContext = sorular.map((s, i) => {
    const sonuc = sonuclar[i];
    return `**${s.soru}**\nVeri: ${JSON.stringify(sonuc.data || sonuc.error)}`;
  }).join('\n\n');

  const systemPrompt = `Sen bir tarım ekonomisti ve karar destek uzmanısın. 
${context}

Aşağıdaki verilere dayanarak KARAR KARTI formatında analiz yap:

${dataContext}

KARAR KARTI FORMATI:
1. **Genel Değerlendirme** (2-3 cümle özet)
2. **Güçlü Yönler** (3 madde)
3. **Zayıf Yönler / Riskler** (3 madde)
4. **Trend Analizi** (Yükseliş/Düşüş/Durağan + açıklama)
5. **Önerilen Aksiyonlar** (3-5 somut öneri)
6. **Risk Seviyesi** (Düşük/Orta/Yüksek)
7. **Güven Düzeyi** (%70-%95 arası, veri kalitesine göre)

ÖNEMLİ:
- Yanıtını Türkçe ver
- Sayısal verileri kullan, genel konuşma yapma
- Üretim miktarlarını ton olarak belirt
- Verim değerlerini kg/dekar olarak belirt
- Veri yılı: ${maxYil}
- Verideki rakamları olduğu gibi kullan, kendi hesaplama yapma`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: systemPrompt }]
  });

  return response.content[0].text;
}

/** ======= HELPER: Get Lists ======= */
function getIller(db) {
  const result = executeQuery(db, `SELECT DISTINCT "İl" FROM kds ORDER BY "İl"`, []);
  return result.success ? result.data.map(r => r['İl']) : [];
}

function getUrunler(db) {
  const result = executeQuery(db, `SELECT DISTINCT "Ürün" FROM kds ORDER BY "Ürün"`, []);
  return result.success ? result.data.map(r => r['Ürün']) : [];
}

/** ======= MAIN HANDLER ======= */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Çok fazla istek. Lütfen 1 dakika bekleyin.' });
  }

  try {
    const db = await getDB();
    
    // GET: Liste endpoint'leri
    if (req.method === 'GET') {
      const { action } = req.query;
      
      if (action === 'test') {
        try {
          const tables = db.exec('SELECT name FROM sqlite_master WHERE type="table"');
          const tableList = tables.length > 0 ? tables[0].values.flat() : [];
          let columns = [];
          let sampleData = [];
          if (tableList.length > 0) {
            const colInfo = db.exec(`PRAGMA table_info("${tableList[0]}")`);
            columns = colInfo.length > 0 ? colInfo[0].values.map(c => c[1]) : [];
            const sample = db.exec(`SELECT * FROM "${tableList[0]}" LIMIT 3`);
            sampleData = sample.length > 0 ? sample[0].values : [];
          }
          const maxYil = getMaxYil(db);
          return res.status(200).json({ success: true, tables: tableList, columns, sampleData, maxYil });
        } catch (e) {
          return res.status(200).json({ success: false, error: e.message });
        }
      }
      
      if (action === 'iller') {
        return res.status(200).json({ success: true, data: getIller(db) });
      }
      
      if (action === 'urunler') {
        return res.status(200).json({ success: true, data: getUrunler(db) });
      }
      
      return res.status(400).json({ error: 'Geçersiz action parametresi' });
    }

    // POST: Analiz endpoint'i
    if (req.method === 'POST') {
      const { tip, secim } = req.body;
      
      if (!tip || !secim) {
        return res.status(400).json({ error: 'tip ve secim parametreleri gerekli' });
      }
      if (!['il', 'urun'].includes(tip)) {
        return res.status(400).json({ error: 'tip "il" veya "urun" olmalı' });
      }

      // Önce en son yılı al
      const maxYil = getMaxYil(db);
      
      // Sorguları dinamik oluştur
      const sorular = tip === 'il' ? getIlSorulari(maxYil) : getUrunSorulari(maxYil);
      
      // Sorguları çalıştır
      const sonuclar = [];
      for (const s of sorular) {
        const params = s.params(secim);
        const result = executeQuery(db, s.sql, params);
        sonuclar.push(result);
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY tanımlı değil' });
      }

      const analiz = await generateAnalysis(secim, tip, sorular, sonuclar, maxYil);

      return res.status(200).json({
        success: true,
        secim,
        tip,
        yil: maxYil,
        analiz,
        veriler: sorular.map((s, i) => ({
          soru: s.soru,
          sonuc: sonuclar[i]
        }))
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('API Hatası:', error);
    return res.status(500).json({ error: error.message });
  }
}
