// api/chat2.js — NeoBi Karar Destek Sistemi API (Claude API)
export const config = { runtime: 'nodejs', maxDuration: 60 };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import Anthropic from '@anthropic-ai/sdk';

/** ======= CONFIG ======= */
const DB_FILE = 'kds_vt.db';
const TABLE = 'kds';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

/** ======= RATE LIMITING ======= */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 dakika
const RATE_LIMIT_MAX = 10; // 10 request/dakika/IP

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = rateLimitMap.get(ip) || [];
  const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= RATE_LIMIT_MAX) {
    return false;
  }
  
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);
  return true;
}

/** ======= DATABASE ======= */
let dbInstance = null;

async function getDB() {
  if (dbInstance) return dbInstance;
  
  const SQL = await initSqlJs();
  const dbPath = path.join(process.cwd(), 'public', DB_FILE);
  const buffer = fs.readFileSync(dbPath);
  dbInstance = new SQL.Database(buffer);
  
  return dbInstance;
}

/** ======= PREDEFINED QUERIES ======= */
// İl bazlı analiz için 10 soru
const IL_SORULARI = [
  { id: 1, soru: "Bu ilde en çok üretilen 5 ürün nedir?", sql: `SELECT "Ürün", SUM("Üretim") as toplam FROM kds WHERE "İl" = ? GROUP BY "Ürün" ORDER BY toplam DESC LIMIT 5` },
  { id: 2, soru: "Son 3 yılda üretim trendi nasıl?", sql: `SELECT "Yıl", SUM("Üretim") as toplam FROM kds WHERE "İl" = ? AND "Yıl" >= 2022 GROUP BY "Yıl" ORDER BY "Yıl"` },
  { id: 3, soru: "Verim ortalaması Türkiye ortalamasının üstünde mi?", sql: `SELECT "Ürün Grubu", AVG("Verim") as il_verim, (SELECT AVG("Verim") FROM kds WHERE "Ürün Grubu" = k."Ürün Grubu") as tr_verim FROM kds k WHERE "İl" = ? GROUP BY "Ürün Grubu"` },
  { id: 4, soru: "Hangi ürün grubunda en güçlü?", sql: `SELECT "Ürün Grubu", SUM("Üretim") as toplam, SUM("Alan") as alan FROM kds WHERE "İl" = ? GROUP BY "Ürün Grubu" ORDER BY toplam DESC LIMIT 1` },
  { id: 5, soru: "Üretimi en çok artan ürün hangisi?", sql: `SELECT "Ürün", (SELECT SUM("Üretim") FROM kds WHERE "İl" = ? AND "Ürün" = k."Ürün" AND "Yıl" = 2024) - (SELECT SUM("Üretim") FROM kds WHERE "İl" = ? AND "Ürün" = k."Ürün" AND "Yıl" = 2020) as fark FROM kds k WHERE "İl" = ? GROUP BY "Ürün" ORDER BY fark DESC LIMIT 3` },
  { id: 6, soru: "Üretimi en çok azalan ürün hangisi?", sql: `SELECT "Ürün", (SELECT SUM("Üretim") FROM kds WHERE "İl" = ? AND "Ürün" = k."Ürün" AND "Yıl" = 2024) - (SELECT SUM("Üretim") FROM kds WHERE "İl" = ? AND "Ürün" = k."Ürün" AND "Yıl" = 2020) as fark FROM kds k WHERE "İl" = ? GROUP BY "Ürün" ORDER BY fark ASC LIMIT 3` },
  { id: 7, soru: "Toplam ekim alanı ne kadar?", sql: `SELECT "Yıl", SUM("Alan") as toplam_alan FROM kds WHERE "İl" = ? GROUP BY "Yıl" ORDER BY "Yıl" DESC LIMIT 5` },
  { id: 8, soru: "Ürün çeşitliliği ne durumda?", sql: `SELECT COUNT(DISTINCT "Ürün") as urun_sayisi, COUNT(DISTINCT "Ürün Grubu") as grup_sayisi FROM kds WHERE "İl" = ?` },
  { id: 9, soru: "En verimli ürünler hangileri?", sql: `SELECT "Ürün", AVG("Verim") as ort_verim FROM kds WHERE "İl" = ? AND "Verim" > 0 GROUP BY "Ürün" ORDER BY ort_verim DESC LIMIT 5` },
  { id: 10, soru: "Yıllık üretim değişim oranı nedir?", sql: `SELECT "Yıl", SUM("Üretim") as uretim, LAG(SUM("Üretim")) OVER (ORDER BY "Yıl") as onceki FROM kds WHERE "İl" = ? GROUP BY "Yıl" ORDER BY "Yıl"` }
];

// Ürün bazlı analiz için 10 soru
const URUN_SORULARI = [
  { id: 1, soru: "Bu ürünü en çok üreten 5 il hangisi?", sql: `SELECT "İl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? GROUP BY "İl" ORDER BY toplam DESC LIMIT 5` },
  { id: 2, soru: "Son 5 yılda Türkiye geneli üretim trendi nasıl?", sql: `SELECT "Yıl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" >= 2020 GROUP BY "Yıl" ORDER BY "Yıl"` },
  { id: 3, soru: "Ortalama verim ne kadar?", sql: `SELECT "Yıl", AVG("Verim") as ort_verim FROM kds WHERE "Ürün" = ? GROUP BY "Yıl" ORDER BY "Yıl" DESC LIMIT 5` },
  { id: 4, soru: "Toplam ekim alanı ne kadar?", sql: `SELECT "Yıl", SUM("Alan") as toplam_alan FROM kds WHERE "Ürün" = ? GROUP BY "Yıl" ORDER BY "Yıl" DESC LIMIT 5` },
  { id: 5, soru: "Üretimi en çok artan iller hangileri?", sql: `SELECT "İl", (SELECT SUM("Üretim") FROM kds WHERE "Ürün" = ? AND "İl" = k."İl" AND "Yıl" = 2024) - (SELECT SUM("Üretim") FROM kds WHERE "Ürün" = ? AND "İl" = k."İl" AND "Yıl" = 2020) as fark FROM kds k WHERE "Ürün" = ? GROUP BY "İl" ORDER BY fark DESC LIMIT 5` },
  { id: 6, soru: "Üretimi en çok azalan iller hangileri?", sql: `SELECT "İl", (SELECT SUM("Üretim") FROM kds WHERE "Ürün" = ? AND "İl" = k."İl" AND "Yıl" = 2024) - (SELECT SUM("Üretim") FROM kds WHERE "Ürün" = ? AND "İl" = k."İl" AND "Yıl" = 2020) as fark FROM kds k WHERE "Ürün" = ? GROUP BY "İl" ORDER BY fark ASC LIMIT 5` },
  { id: 7, soru: "Kaç ilde üretiliyor?", sql: `SELECT COUNT(DISTINCT "İl") as il_sayisi FROM kds WHERE "Ürün" = ?` },
  { id: 8, soru: "En verimli iller hangileri?", sql: `SELECT "İl", AVG("Verim") as ort_verim FROM kds WHERE "Ürün" = ? AND "Verim" > 0 GROUP BY "İl" ORDER BY ort_verim DESC LIMIT 5` },
  { id: 9, soru: "Türkiye toplam üretimi ne kadar?", sql: `SELECT "Yıl", SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? GROUP BY "Yıl" ORDER BY "Yıl" DESC LIMIT 1` },
  { id: 10, soru: "Yıllık büyüme oranı nedir?", sql: `SELECT "Yıl", SUM("Üretim") as uretim FROM kds WHERE "Ürün" = ? GROUP BY "Yıl" ORDER BY "Yıl"` }
];

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

/** ======= AI ANALYSIS ======= */
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateAnalysis(secim, tip, sorular, sonuclar) {
  // tip: "il" veya "urun"
  const context = tip === 'il' 
    ? `${secim} ili için tarımsal analiz yapıyorsun.`
    : `${secim} ürünü için Türkiye geneli analiz yapıyorsun.`;

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

Yanıtını Türkçe ver. Sayısal verileri kullan, genel konuşma yapma.`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'user', content: systemPrompt }]
  });

  return response.content[0].text;
}

/** ======= HELPER: Get Lists ======= */
async function getIller(db) {
  const result = executeQuery(db, `SELECT DISTINCT "İl" FROM kds ORDER BY "İl"`, []);
  return result.success ? result.data.map(r => r['İl']) : [];
}

async function getUrunler(db) {
  const result = executeQuery(db, `SELECT DISTINCT "Ürün" FROM kds ORDER BY "Ürün"`, []);
  return result.success ? result.data.map(r => r['Ürün']) : [];
}

/** ======= MAIN HANDLER ======= */
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Çok fazla istek. Lütfen 1 dakika bekleyin.' });
  }

  try {
    const db = await getDB();
    
    // GET: Liste endpoint'leri
    if (req.method === 'GET') {
      const { action } = req.query;
      
      if (action === 'iller') {
        const iller = await getIller(db);
        return res.status(200).json({ success: true, data: iller });
      }
      
      if (action === 'urunler') {
        const urunler = await getUrunler(db);
        return res.status(200).json({ success: true, data: urunler });
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

      // Sorguları seç
      const sorular = tip === 'il' ? IL_SORULARI : URUN_SORULARI;
      
      // Tüm sorguları çalıştır
      const sonuclar = [];
      for (const s of sorular) {
        // Parametreleri hazırla (bazı sorgularda 3 parametre var)
        const paramCount = (s.sql.match(/\?/g) || []).length;
        const params = Array(paramCount).fill(secim);
        
        const result = executeQuery(db, s.sql, params);
        sonuclar.push(result);
      }

      // AI analizi oluştur
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY tanımlı değil' });
      }

      const analiz = await generateAnalysis(secim, tip, sorular, sonuclar);

      return res.status(200).json({
        success: true,
        secim,
        tip,
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