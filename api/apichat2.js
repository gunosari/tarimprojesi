// api/apichat2.js — NeoBi Karar Destek Sistemi API (Claude API)
// v2.1 — system/user ayrımı, safeJson, WASM lokal, whitelist, IP parse
export const config = { runtime: 'nodejs', maxDuration: 60 };

import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import Anthropic from '@anthropic-ai/sdk';

/** ======= CONFIG ======= */
const DB_FILE = 'kds_vt.db';
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 5000;

/** ======= ANALYSIS CACHE (in-memory, 24h TTL) ======= */
const analysisCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 saat

function getCacheKey(tip, secim, yil) {
  return `${tip}|${secim}|${yil}`;
}

function getCachedAnalysis(tip, secim, yil) {
  const key = getCacheKey(tip, secim, yil);
  const cached = analysisCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    analysisCache.delete(key);
    return null;
  }
  return cached.analiz;
}

function setCachedAnalysis(tip, secim, yil, analiz) {
  const key = getCacheKey(tip, secim, yil);
  analysisCache.set(key, { analiz, timestamp: Date.now() });
}

/** ======= RATE LIMITING ======= */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;

function getClientIP(req) {
  // x-forwarded-for bazen "ip1, ip2" gelir — ilkini al
  const xf = req.headers['x-forwarded-for'];
  return (Array.isArray(xf) ? xf[0] : (xf || '')).split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

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
    // Önce lokal WASM'ı dene, yoksa CDN fallback
    const localWasm = path.join(process.cwd(), 'public', 'sql-wasm.wasm');
    let wasmBinary;
    try {
      wasmBinary = fs.readFileSync(localWasm);
    } catch {
      const wasmResponse = await fetch('https://sql.js.org/dist/sql-wasm.wasm');
      wasmBinary = await wasmResponse.arrayBuffer();
    }
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

/** ======= SAFE JSON (token tasarrufu) ======= */
function safeJson(obj, maxLen = 4000) {
  const s = JSON.stringify(obj);
  return s.length > maxLen ? s.slice(0, maxLen) + '...(kırpıldı)' : s;
}

/** ======= DYNAMIC QUERIES ======= */
function getIlSorulari(Y) {
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
      soru: `${Y} yılında ürün grubu bazlı üretim, Türkiye toplamı, pay ve Türkiye sıralaması`, 
      sql: `SELECT g."Ürün Grubu", g.il_uretim, g.tr_uretim, g.turkiye_payi, g.sira FROM (
            SELECT sub."Ürün Grubu", sub.il_uretim, sub.tr_uretim, sub.turkiye_payi,
              (SELECT COUNT(*) + 1 FROM (
                SELECT "İl", SUM("Üretim") as t FROM kds 
                WHERE "Ürün Grubu" = sub."Ürün Grubu" AND "Yıl" = ? 
                GROUP BY "İl" HAVING t > sub.il_uretim
              )) as sira
            FROM (
              SELECT k."Ürün Grubu",
                SUM(k."Üretim") as il_uretim,
                (SELECT SUM("Üretim") FROM kds WHERE "Ürün Grubu" = k."Ürün Grubu" AND "Yıl" = ?) as tr_uretim,
                ROUND(SUM(k."Üretim") * 100.0 / (SELECT SUM("Üretim") FROM kds WHERE "Ürün Grubu" = k."Ürün Grubu" AND "Yıl" = ?), 1) as turkiye_payi
              FROM kds k WHERE k."İl" = ? AND k."Yıl" = ? 
              GROUP BY k."Ürün Grubu"
            ) sub
          ) g ORDER BY g.il_uretim DESC`,
      params: (secim) => [Y, Y, Y, secim, Y]
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
      soru: `${Y} yılında bu il toplam üretimde Türkiye'de kaçıncı sırada?`, 
      sql: `SELECT sira, il, toplam FROM (
            SELECT "İl" as il, SUM("Üretim") as toplam, ROW_NUMBER() OVER (ORDER BY SUM("Üretim") DESC) as sira
            FROM kds WHERE "Yıl" = ? GROUP BY "İl") t
            WHERE il = ? OR sira <= 5 ORDER BY sira`,
      params: (secim) => [Y, secim]
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
      soru: `${Y} yılında bu ürünün üretim yoğunlaşması nasıl? (ilk 5 ilin toplam payı)`, 
      sql: `SELECT ROUND(SUM(toplam) * 100.0 / (SELECT SUM("Üretim") FROM kds WHERE "Ürün" = ? AND "Yıl" = ?), 1) as ilk5_pay
            FROM (SELECT SUM("Üretim") as toplam FROM kds WHERE "Ürün" = ? AND "Yıl" = ? GROUP BY "İl" ORDER BY toplam DESC LIMIT 5)`,
      params: (secim) => [secim, Y, secim, Y]
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
      soru: `${Y} yılında en çok üreten 5 ilin Türkiye üretimindeki payı`, 
      sql: `SELECT "İl", SUM("Üretim") as uretim, 
            ROUND(SUM("Üretim") * 100.0 / (SELECT SUM("Üretim") FROM kds WHERE "Ürün" = ? AND "Yıl" = ?), 1) as pay_yuzde
            FROM kds WHERE "Ürün" = ? AND "Yıl" = ? GROUP BY "İl" ORDER BY uretim DESC LIMIT 5`,
      params: (secim) => [secim, Y, secim, Y]
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
    ? `${secim} ili için ${maxYil} yılı tarımsal analiz.`
    : `${secim} ürünü için ${maxYil} yılı Türkiye geneli analiz.`;

  // safeJson ile token tasarrufu
  const dataContext = sorular.map((s, i) => {
    const sonuc = sonuclar[i];
    return `**${s.soru}**\nVeri: ${safeJson(sonuc.data || sonuc.error)}`;
  }).join('\n\n');

  // SYSTEM: Kimlik + kurallar (değişmez anayasa)
  const systemMessage = `Sen bir tarım ekonomisti ve karar destek uzmanısın.
Yanıtını Türkçe ver. Bu bir chatbot yazısı değil, bir karar belgesidir. Kurumsal ve profesyonel dil kullan.

GENEL KURALLAR:
- Sayısal verileri kullan, genel konuşma yapma
- Üretim miktarlarını ton olarak belirt, büyük sayılarda "milyon ton" veya "bin ton" kullan
- Yüzde değerlerini tutarlı formatta yaz: %1, %2, %12,8 (ondalıklı ise virgül kullan)
- Veride olmayan yeni üretim/alan değerleri icat etme. Gerekli oranları yalnızca verilen seriden türet.
- Türetilen oranları "yaklaşık" ve "hesaplanan" olarak belirt; ham veri gibi sunma.
- Yüzde ve sıralama bilgilerini veride nasıl geçiyorsa öyle yaz

AKSİYON YAZIM KURALLARI (kesindir, her çalıştırmada aynı mantık):
📉 Üretimi AZALAN ürünler → yalnızca: neden analizi, yapısal sorun tespiti, önleyici tedbirler, alternatif ürüne geçiş. ❌ Asla: kapasite artırımı, yatırım çağrısı.
📈 Üretimi ARTAN ürünler → yalnızca: kapasite artışı, yatırım fırsatı, ihracat/pazar geliştirme, değer zinciri. ❌ Asla: sorun odaklı dil, risk büyütme.
👑 Lider/doygun ürünler → yalnızca: korumaya dönük politika, verimlilik artışı, katma değer, ihracat/markalaşma. ❌ Asla: alan genişletme, agresif yatırım dili.
Aynı ürün için çelişkili aksiyon türleri kullanma.

SENARYO YAZIM KURALLARI:
- Kesinlik iddiası KULLANMA. Tüm senaryolar koşullu ifadelerle yazılmalı.
- Senaryolar mevcut veriden türetilmeli, dış varsayım eklenmemeli.
- "yaklaşık", "bandında", "devam ederse" gibi koşullu ifadeler kullan.`;

  // USER: Bağlam + veri + format talebi
  const userMessage = `${context}

Aşağıdaki verilere dayanarak KARAR KARTI formatında analiz yap:

${dataContext}

KARAR KARTI FORMATI:

1. **Genel Değerlendirme**
${tip === 'il' ? `Her ürün grubu (Meyve, Sebze, Tahıl) için şu formatta bir cümle yaz:
   "Türkiye'de ${maxYil} yılında [ürün grubu] üretimi [TR toplam] ton iken ${secim} üretimi [il toplam] ton olup Türkiye üretimine katkısı %[pay] ile [sıra]. sıradadır."
   Sıralama bilgisini karıştırma: ürün grubu sıralaması ile toplam üretim sıralamasını ayrı ayrı belirt.
   Son olarak ilin stratejik konumunu özetleyen tek bir sentez cümlesi yaz.` 
: `Bu ürünün Türkiye genelindeki durumu, üretim trendi ve yoğunlaşma analizi ile 2-3 cümle özet yaz.`}

2. **Güçlü Yönler** (3 madde, somut rakam. Ürün çeşitliliği yüksekse dayanıklılık avantajını belirt.)

3. **Zayıf Yönler / Riskler** (3 madde, her birini tipine göre etiketle: 🔴 Yapısal / 🟡 Sektörel / 🟠 Konjonktürel)

4. **Trend Analizi** (Yön + geçici mi yapısal mı + alan-üretim ilişkisi yorumu)

5. **Önerilen Aksiyonlar** - Rol bazlı:
   - 🏛️ Bakanlık / Politika yapıcı: (1-2 öneri)
   - 🏢 İl Müdürlüğü / Kalkınma Ajansı: (1-2 öneri)
   - 🌾 Üretici / Yatırımcı: (1-2 öneri)

6. **Risk Seviyesi** (Düşük/Orta/Yüksek + bir satır gerekçe)

7. **Karar Sinyalleri** (🟢 koru 🟡 izle 🔴 müdahale — her ürün grubu/tema için tek satır)

8. **Güven Düzeyi** (%70-%95 + 2-3 madde gerekçe: veri kalitesi, seri uzunluğu, dahil edilmeyen değişkenler)

9. **Senaryo Analizi**
   Trend projeksiyonu: Son 5 yılın değişim hızıyla ${maxYil + 3} projeksiyonu.
   Sonra 3 senaryo (her biri 2-3 cümle, somut rakam):
   🟢 İyimser: "Bu koşullar altında..."
   🟡 Baz: "Mevcut eğilimlerin korunması halinde..."
   🔴 Kötümser: "Bu risklerin birlikte gerçekleşmesi durumunda..."
   Başına disclaimer ekle: "Senaryolar, mevcut eğilimler ve veriye dayalı varsayımlar üzerinden üretilmiş olup yön gösterici niteliktedir."

10. **Analiz Sınırları**
   "Bu karar kartı; ürün bazında kesin üretim tahmini yapmaz, çiftçi bazlı gelir hesaplaması içermez, iklim senaryolarını modellemez. Analiz; TÜİK verileri üzerinden ${maxYil - 4}–${maxYil} yılları gerçekleşmiş verilere dayalı olup yön gösterici niteliktedir."`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemMessage,
    messages: [{ role: 'user', content: userMessage }]
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

  const ip = getClientIP(req);
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

      // Whitelist kontrolü — prompt injection koruması
      const validList = tip === 'il' ? getIller(db) : getUrunler(db);
      if (!validList.includes(secim)) {
        return res.status(400).json({ error: 'Geçersiz seçim' });
      }

      const maxYil = getMaxYil(db);

      // Cache kontrolü — aynı analiz 24 saat içinde tekrar üretilmez
      const cachedAnaliz = getCachedAnalysis(tip, secim, maxYil);
      if (cachedAnaliz) {
        return res.status(200).json({
          success: true,
          secim,
          tip,
          yil: maxYil,
          analiz: cachedAnaliz,
          cached: true
        });
      }

      const sorular = tip === 'il' ? getIlSorulari(maxYil) : getUrunSorulari(maxYil);
      
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

      // Cache'e kaydet
      setCachedAnalysis(tip, secim, maxYil, analiz);

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
