// api/chat.js — Basit tarım chatbot (temelden yazıldı)
export const config = { runtime: 'nodejs' };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ======= Ayarlar ======= **/
const TABLE = 'urunler';
const MODEL = 'gpt-4o-mini';
const DEBUG = true;

// Cache
const cache = new Map();
const MAX_CACHE = 200;

/** ======= Yardımcılar ======= **/
const clean = (s) => String(s || '').trim();
const escape = (s) => clean(s).replace(/'/g, "''");

// Debug log
const log = (...args) => DEBUG && console.log('🔧', ...args);

/** ======= Kolon Tespiti ======= **/
function getSchema(db) {
  try {
    const stmt = db.prepare(`PRAGMA table_info("${TABLE}");`);
    const cols = [];
    while (stmt.step()) cols.push(stmt.getAsObject().name);
    stmt.free();
    
    // Varsayılan mapping
    const schema = {
      il: 'il',
      ilce: 'ilce', 
      urun: 'urun_adi',
      kategori: 'urun_cesidi',
      yil: 'yil',
      uretim: 'uretim_miktari',
      alan: 'uretim_alani'
    };
    
    log('Kolonlar:', cols.join(', '));
    return { cols, schema };
  } catch (e) {
    log('Schema hatası:', e);
    return { 
      cols: ['il','ilce','urun_adi','urun_cesidi','yil','uretim_miktari','uretim_alani'],
      schema: { il:'il', ilce:'ilce', urun:'urun_adi', kategori:'urun_cesidi', yil:'yil', uretim:'uretim_miktari', alan:'uretim_alani' }
    };
  }
}

/** ======= Basit Pattern Matching ======= **/
function parseQuery(text) {
  const t = clean(text).toLowerCase();
  
  // İl tespit - sadece büyük harfle başlayan kelimeler
  let il = '';
  const ilMatch = text.match(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:'?[dt][ea]|'?[dt][aı]|\s+ili|\s+ilinde|\s|$)/);
  if (ilMatch) il = ilMatch[1];
  
  // Ürün tespit - bilinen ürünler
  const urunler = [
    'domates','biber','patlıcan','kabak','hıyar','lahana','marul','soğan','patates',
    'elma','portakal','üzüm','muz','çilek','kayısı','şeftali','armut','kiraz',
    'buğday','arpa','mısır','çeltik','yulaf','ayçiçeği','pamuk',
    'fasulye','mercimek','nohut','bezelye'
  ];
  let urun = '';
  for (const u of urunler) {
    if (t.includes(u)) { urun = u; break; }
  }
  
  // Kategori tespit
  let kategori = '';
  if (t.includes('sebze')) kategori = 'Sebze';
  else if (t.includes('meyve')) kategori = 'Meyve'; 
  else if (t.includes('tahıl')) kategori = 'Tahıl';
  
  // Yıl tespit
  const yilMatch = t.match(/\b(20\d{2})\b/);
  const yil = yilMatch ? yilMatch[1] : '2024';
  
  // Sorgu tipi tespit
  let tip = 'toplam';
  if (t.includes('ilçe') || t.includes('nerede')) tip = 'ilce_detay';
  else if (t.includes('en çok') || t.includes('hangi')) tip = 'ranking';
  else if (t.includes('alan') || t.includes('ekim')) tip = 'alan';
  
  log('Parse sonucu:', { il, urun, kategori, yil, tip });
  return { il, urun, kategori, yil, tip };
}

/** ======= Ürün Eşleştirme ======= **/
function buildUrunFilter(urun, schema) {
  if (!urun) return '';
  
  // Çok çeşitli ürünler için geniş arama
  const multiVariety = ['mısır','domates','biber','üzüm','elma','fasulye'];
  const cap = urun.charAt(0).toUpperCase() + urun.slice(1);
  
  if (multiVariety.includes(urun)) {
    return `("${schema.urun}" LIKE '${escape(cap)} %' OR "${schema.urun}" LIKE '%${escape(cap)}%')`;
  } else {
    return `("${schema.urun}" LIKE '${escape(cap)} %' OR "${schema.urun}" = '${escape(cap)}')`;
  }
}

/** ======= SQL Builder ======= **/
function buildSQL(parsed, schema) {
  const { il, urun, kategori, yil, tip } = parsed;
  const { schema: s } = schema;
  
  // WHERE koşulları
  const wheres = [`"${s.yil}" = ${yil}`];
  
  if (il) wheres.push(`"${s.il}" = '${escape(il)}'`);
  if (kategori) wheres.push(`"${s.kategori}" = '${escape(kategori)}'`);
  if (urun) wheres.push(buildUrunFilter(urun, s));
  
  const whereStr = wheres.join(' AND ');
  
  // SQL templates
  switch (tip) {
    case 'alan':
      return `SELECT SUM("${s.alan}") AS toplam_alan FROM ${TABLE} WHERE ${whereStr}`;
      
    case 'ilce_detay':
      return `SELECT "${s.ilce}", SUM("${s.uretim}") AS uretim 
              FROM ${TABLE} WHERE ${whereStr} 
              GROUP BY "${s.ilce}" ORDER BY uretim DESC LIMIT 10`;
              
    case 'ranking':
      if (il && !urun && !kategori) {
        return `SELECT "${s.urun}", SUM("${s.uretim}") AS uretim 
                FROM ${TABLE} WHERE ${whereStr} 
                GROUP BY "${s.urun}" ORDER BY uretim DESC LIMIT 10`;
      } else if (!il && urun) {
        return `SELECT "${s.il}", SUM("${s.uretim}") AS uretim 
                FROM ${TABLE} WHERE ${whereStr} 
                GROUP BY "${s.il}" ORDER BY uretim DESC LIMIT 10`;
      }
      // fallthrough
      
    default: // toplam
      return `SELECT SUM("${s.uretim}") AS toplam_uretim, SUM("${s.alan}") AS toplam_alan 
              FROM ${TABLE} WHERE ${whereStr}`;
  }
}

/** ======= Güvenlik Kontrolü ======= **/
function isSafe(sql) {
  const s = sql.toLowerCase();
  
  // Temel kontroller
  if (!s.startsWith('select')) return false;
  if (s.includes('--') || s.includes('/*') || s.includes(';')) return false;
  if (s.includes('drop') || s.includes('delete') || s.includes('update')) return false;
  
  log('SQL güvenlik OK');
  return true;
}

/** ======= GPT Fallback ======= **/
async function gptQuery(question, schema) {
  if (!process.env.OPENAI_API_KEY) return null;
  
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { schema: s } = schema;
  
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{
        role: 'system',
        content: `Sen bir SQL üretici asistansın. 
        
Tablo: ${TABLE}
Kolonlar: ${s.il}, ${s.ilce}, ${s.urun}, ${s.kategori}, ${s.yil}, ${s.uretim}, ${s.alan}

Kurallar:
- Sadece SELECT sorguları
- Yıl belirtilmemişse 2024 kullan  
- Genel ürün isimleri için LIKE '%Ürün%' kullan
- SUM() fonksiyonlarını kullan
- Kolon isimlerini çift tırnak ile yaz`
      }, {
        role: 'user', 
        content: question
      }],
      temperature: 0,
      max_tokens: 300
    });
    
    let sql = response.choices[0].message.content
      .replace(/```[\s\S]*?```/g, m => m.replace(/```(sql)?/g, ''))
      .replace(/```/g, '')
      .trim()
      .replace(/;+$/, '');
      
    return isSafe(sql) ? sql : null;
  } catch (e) {
    log('GPT hatası:', e.message);
    return null;
  }
}

/** ======= Ana Handler ======= **/
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Sadece POST' });
  
  try {
    const { question } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'Soru boş' });
    
    const q = clean(question);
    log('Soru:', q);
    
    // Cache kontrol
    if (cache.has(q)) {
      log('Cache hit');
      return res.status(200).send(`🧭 Cache\n${cache.get(q)}`);
    }
    
    // DB bağlantı
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file)
    });
    
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) {
      return res.status(500).json({ error: 'Database bulunamadı' });
    }
    
    const db = new SQL.Database(fs.readFileSync(dbPath));
    const schema = getSchema(db);
    
    // Query parse ve SQL oluştur
    const parsed = parseQuery(q);
    let sql = buildSQL(parsed, schema);
    let method = 'rules';
    
    // Rules başarısızsa GPT dene
    if (!sql || !isSafe(sql)) {
      log('Rules başarısız, GPT deneniyor...');
      sql = await gptQuery(q, schema);
      method = 'gpt';
    }
    
    if (!sql) {
      return res.status(400).send('SQL oluşturulamadı. Soruyu basitleştirin.');
    }
    
    // SQL çalıştır
    log('SQL:', sql);
    const rows = [];
    
    try {
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      log(`${rows.length} satır bulundu`);
    } catch (e) {
      log('SQL hatası:', e);
      return res.status(500).send(`SQL çalıştırılamadı: ${e.message}`);
    }
    
    // Sonuç formatla
    let result = '';
    if (rows.length === 0) {
      result = 'Veri bulunamadı.';
    } else if (rows.length === 1) {
      const [row] = rows;
      const entries = Object.entries(row);
      if (entries.length === 1) {
        const [key, val] = entries[0];
        result = `${key}: ${Number(val || 0).toLocaleString('tr-TR')}`;
      } else {
        result = entries.map(([k,v]) => `${k}: ${Number(v||0).toLocaleString('tr-TR')}`).join('\n');
      }
    } else {
      result = rows.slice(0,5).map(r => 
        '• ' + Object.entries(r).map(([k,v]) => `${k}: ${v}`).join(', ')
      ).join('\n');
      if (rows.length > 5) result += `\n... (+${rows.length-5} satır daha)`;
    }
    
    // Cache'e ekle
    if (cache.size >= MAX_CACHE) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    cache.set(q, result);
    
    // Debug info
    const debug = DEBUG ? `\n\n-- DEBUG --\nSQL: ${sql}\nSatır: ${rows.length}` : '';
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(`🧭 ${method}\nSoru: ${q}\n\n${result}${debug}`);
    
  } catch (err) {
    log('Ana hata:', err);
    res.status(500).json({ error: 'Server hatası', detail: err.message });
  }
}
