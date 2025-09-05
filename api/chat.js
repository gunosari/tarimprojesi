// Eğer ranking değilse diğer tipler
  if (tip !== 'ranking') {
    // Hem üretim hem alan isteniyorsa toplam
    const uretimVar = t.includes('üretim') || t.includes('miktar') || t.includes('ton');
    const alanVar = t.includes('alan') || t.includes('ekim') || t.includes('dekar');
    
    if (uretimVar && alanVar) {
      tip = 'toplam'; // Her ikisi de
      log('✅ Tip: toplam (üretim + alan)');
    }
    // Sadece alan isteniyorsa
    else if (alanVar && !uretimVar) {
      tip = 'alan';
      log('✅ Tip: alan');
    }
    // İlçe/lokasyon sorguları
    else if (t.includes('ilçe') || t.includes('nerede') || t.includes('hangi ilçe') || 
             t.includes('bölge') || t.includes('yerde')) {
      tip = 'ilce_detay';
      log('✅ Tip: ilce_detay');
    }
    // Karşılaştırma sorguları
    else if (t.includes('karşılaştır') || t.includes('fark') || t.includes('daha') ||
             t.includes('versus') || t.includes('ile')) {
      tip = 'compare';
      log('✅ Tip: compare');
    }
    else {
      tip = 'toplam';
      log('✅ Tip: toplam (varsayılan)');
    }
  }// api/chat.js — Basit tarım chatbot (temelden yazıldı)
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

// Global cache for schema data
let GLOBAL_SCHEMA_CACHE = null;

/** ======= Kolon Tespiti ======= **/
function getSchema(db) {
  // Eğer cache varsa direkt döndür
  if (GLOBAL_SCHEMA_CACHE) {
    log('✅ Schema cache kullanıldı');
    return GLOBAL_SCHEMA_CACHE;
  }
  
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
    
    // Tüm il ve ilçeleri çek - SADECE İLK SEFERDE
    const iller = new Set();
    const ilceler = new Set();
    
    log('🔄 İl/İlçe listesi veritabanından çekiliyor...');
    const dataStmt = db.prepare(`SELECT DISTINCT "${schema.il}", "${schema.ilce}" FROM ${TABLE}`);
    while (dataStmt.step()) {
      const row = dataStmt.getAsObject();
      if (row.il) iller.add(row.il);
      if (row.ilce) ilceler.add(row.ilce);
    }
    dataStmt.free();
    
    // Cache'e kaydet
    GLOBAL_SCHEMA_CACHE = { 
      cols, 
      schema, 
      iller: Array.from(iller), 
      ilceler: Array.from(ilceler) 
    };
    
    log('✅ Schema cache oluşturuldu - İl:', iller.size, 'İlçe:', ilceler.size);
    return GLOBAL_SCHEMA_CACHE;
    
  } catch (e) {
    log('Schema hatası:', e);
    return { 
      cols: ['il','ilce','urun_adi','urun_cesidi','yil','uretim_miktari','uretim_alani'],
      schema: { il:'il', ilce:'ilce', urun:'urun_adi', kategori:'urun_cesidi', yil:'yil', uretim:'uretim_miktari', alan:'uretim_alani' },
      iller: [],
      ilceler: []
    };
  }
}

/** ======= Basit Pattern Matching ======= **/
function parseQuery(text) {
  const t = clean(text).toLowerCase();
  
  // İl tespit - çok basit yaklaşım
  let il = '';
  
  // Basit string arama - büyük/küçük harf duyarsız
  const iller = ['Adana','Adıyaman','Afyon','Ağrı','Amasya','Ankara','Antalya','Artvin','Aydın','Balıkesir','Bilecik','Bingöl','Bitlis','Bolu','Burdur','Bursa','Çanakkale','Çankırı','Çorum','Denizli','Diyarbakır','Edirne','Elazığ','Erzincan','Erzurum','Eskişehir','Gaziantep','Giresun','Gümüşhane','Hakkari','Hatay','Isparta','Mersin','İstanbul','İzmir','Kars','Kastamonu','Kayseri','Kırklareli','Kırşehir','Kocaeli','Konya','Kütahya','Malatya','Manisa','Kahramanmaraş','Mardin','Muğla','Muş','Nevşehir','Niğde','Ordu','Rize','Sakarya','Samsun','Siirt','Sinop','Sivas','Tekirdağ','Tokat','Trabzon','Tunceli','Şanlıurfa','Uşak','Van','Yozgat','Zonguldak','Aksaray','Bayburt','Karaman','Kırıkkale','Batman','Şırnak','Bartın','Ardahan','Iğdır','Yalova','Karabük','Kilis','Osmaniye','Düzce'];
  
  for (const ilAdi of iller) {
    if (text.toLowerCase().includes(ilAdi.toLowerCase())) {
      il = ilAdi;
      log('✅ İl bulundu:', il);
      break;
    }
  }
  
  if (!il) log('❌ İl bulunamadı!');
  // İlçe tespit - Mersin ilçeleri dahil
  let ilce = '';
  const temelIlceler = [
    // Mersin ilçeleri
    'Anamur','Aydıncık','Bozyazı','Çamlıyayla','Erdemli','Gülnar','Mezitli','Mut','Silifke','Tarsus','Toroslar','Yenişehir','Akdeniz',
    // Diğer büyük ilçeler
    'Merkez','Seyhan','Sarıçam','Çukurova','Karataş'
  ];
  
  for (const ilceAdi of temelIlceler) {
    if (text.toLowerCase().includes(ilceAdi.toLowerCase())) {
      ilce = ilceAdi;
      log('✅ İlçe bulundu:', ilce);
      break;
    }
  }
  
  if (!ilce) log('❌ İlçe bulunamadı!');
  const urunler = [
    'domates','biber','patlıcan','kabak','hıyar','lahana','marul','soğan','patates',
    'elma','portakal','üzüm','muz','çilek','kayısı','şeftali','armut','kiraz',
    'buğday','arpa','mısır','çeltik','yulaf','ayçiçeği','pamuk',
    'fasulye','mercimek','nohut','bezelye','börülce','bakla'
  ];
  
  let urun = '';
  
  // Direkt ürün arama
  for (const u of urunler) {
    const patterns = [
      new RegExp(`\\b${u}\\b`, 'i'),                    // domates
      new RegExp(`\\b${u}\\s+(üretim|miktarı|ne kadar)`, 'i'), // domates üretimi  
      new RegExp(`\\b${u}\\s+yetiştiriciliği`, 'i'),    // domates yetiştiriciliği
      new RegExp(`\\b${u}\\s+(eken|ekilen)`, 'i')       // domates eken
    ];
    
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        urun = u;
        log('Ürün tespit edildi:', urun);
        break;
      }
    }
    if (urun) break;
  }
  
  // Kategori tespit - doğal dil varyasyonları
  let kategori = '';
  
  const sebzePatterns = [/\bsebze\b/i, /\bsebzeler\b/i, /\bsebze üretimi\b/i, /\bsebze yetiştiriciliği\b/i];
  const meyvePatterns = [/\bmeyve\b/i, /\bmeyveler\b/i, /\bmeyva\b/i, /\bmeyve üretimi\b/i, /\bmeyve yetiştiriciliği\b/i];
  const tahilPatterns = [/\btahıl\b/i, /\btahıllar\b/i, /\btahıl ürünleri\b/i, /\bhububat\b/i, /\btane ürünleri\b/i];
  
  if (sebzePatterns.some(p => p.test(text))) { 
    kategori = 'Sebze'; 
    log('Kategori: Sebze'); 
  }
  else if (meyvePatterns.some(p => p.test(text))) { 
    kategori = 'Meyve'; 
    log('Kategori: Meyve'); 
  }
  else if (tahilPatterns.some(p => p.test(text))) { 
    kategori = 'Tahıl'; 
    log('Kategori: Tahıl'); 
  }
  
  // Yıl tespit - doğal zaman ifadeleri
  let yil = '2024'; // varsayılan
  
  const yilMatch = t.match(/\b(20\d{2})\b/);
  if (yilMatch) {
    yil = yilMatch[1];
  } else {
    // Doğal zaman ifadeleri
    if (t.includes('geçen yıl') || t.includes('geçen sene')) yil = '2023';
    else if (t.includes('bu yıl') || t.includes('bu sene')) yil = '2024';
    else if (t.includes('2 yıl önce') || t.includes('iki yıl önce')) yil = '2022';
    else if (t.includes('3 yıl önce') || t.includes('üç yıl önce')) yil = '2021';
  }
  
  log('Yıl tespit edildi:', yil);
  
  // Sorgu tipi tespit - doğal dil desteği
  let tip = 'toplam';
  
  // Hem üretim hem alan isteniyorsa toplam
  const uretimVar = t.includes('üretim') || t.includes('miktar') || t.includes('ton');
  const alanVar = t.includes('alan') || t.includes('ekim') || t.includes('dekar');
  
  if (uretimVar && alanVar) {
    tip = 'toplam'; // Her ikisi de
    log('✅ Tip: toplam (üretim + alan)');
  }
  // Sadece alan isteniyorsa
  else if (alanVar && !uretimVar) {
    tip = 'alan';
    log('✅ Tip: alan');
  }
  // İlçe/lokasyon sorguları
  else if (t.includes('ilçe') || t.includes('nerede') || t.includes('hangi ilçe') || 
           t.includes('bölge') || t.includes('yerde')) {
    tip = 'ilce_detay';
    log('✅ Tip: ilçe_detay');
  }
  // Ranking sorguları  
  else if (t.includes('en çok') || t.includes('hangi') || t.includes('en fazla') ||
           t.includes('sırala') || t.includes('listele') || t.includes('top') ||
           t.includes('önde gelen') || t.includes('başta') || t.includes('lider')) {
    tip = 'ranking';
    log('✅ Tip: ranking');
  }
  // Karşılaştırma sorguları
  else if (t.includes('karşılaştır') || t.includes('fark') || t.includes('daha') ||
           t.includes('versus') || t.includes('ile')) {
    tip = 'compare';
    log('✅ Tip: compare');
  }
  else {
    log('✅ Tip: toplam (varsayılan)');
  }
  
  log('🔍 Parse sonucu:', { il, ilce, urun, kategori, yil, tip });
  return { il, ilce, urun, kategori, yil, tip, originalText: text };
}

/** ======= Ürün Eşleştirme ======= **/
function buildUrunFilter(urun, schema) {
  if (!urun) return '';
  
  // Çok çeşitli ürünler için geniş arama
  const multiVariety = ['mısır','domates','biber','üzüm','elma','fasulye','muz','portakal','mandalina'];
  const cap = urun.charAt(0).toUpperCase() + urun.slice(1);
  
  if (multiVariety.includes(urun)) {
    // ÇOK GENİŞ ARAMA - hem başta hem içinde
    return `("${schema.urun}" LIKE '${escape(cap)} %' OR "${schema.urun}" LIKE '%${escape(cap)}%' OR "${schema.urun}" LIKE '% ${escape(cap)} %' OR "${schema.urun}" = '${escape(cap)}')`;
  } else {
    return `("${schema.urun}" LIKE '${escape(cap)} %' OR "${schema.urun}" = '${escape(cap)}')`;
  }
}

/** ======= SQL Builder ======= **/
function buildSQL(parsed, schemaObj) {
  const { il, ilce, urun, kategori, yil, tip, originalText } = parsed;
  const { schema: s } = schemaObj;
  const t = originalText.toLowerCase();
  
  // WHERE koşulları
  const wheres = [`"${s.yil}" = ${yil}`];
  
  if (il) wheres.push(`"${s.il}" = '${escape(il)}'`);
  if (ilce) wheres.push(`"${s.ilce}" = '${escape(ilce)}'`);
  if (kategori) wheres.push(`"${s.kategori}" = '${escape(kategori)}'`);
  if (urun) wheres.push(buildUrunFilter(urun, s));
  
  const whereStr = wheres.join(' AND ');
  log('🔧 Tip:', tip, 'WHERE:', whereStr);
  
  // SQL templates
  switch (tip) {
    case 'alan':
      return `SELECT SUM("${s.alan}") AS toplam_alan FROM ${TABLE} WHERE ${whereStr}`;
      
    case 'ilce_detay':
      return `SELECT "${s.ilce}", SUM("${s.uretim}") AS uretim 
              FROM ${TABLE} WHERE ${whereStr} 
              GROUP BY "${s.ilce}" ORDER BY uretim DESC LIMIT 10`;
              
    case 'ranking':
      if (!il && !urun && !kategori) {
        // Genel ürün ranking
        if (text.includes('alan') || text.includes('ekim')) {
          return `SELECT "${s.urun}", SUM("${s.alan}") AS toplam_alan 
                  FROM ${TABLE} WHERE ${whereStr} 
                  GROUP BY "${s.urun}" ORDER BY toplam_alan DESC LIMIT 10`;
        } else {
          return `SELECT "${s.urun}", SUM("${s.uretim}") AS toplam_uretim 
                  FROM ${TABLE} WHERE ${whereStr} 
                  GROUP BY "${s.urun}" ORDER BY toplam_uretim DESC LIMIT 10`;
        }
      } else if (il && !urun && !kategori) {
        return `SELECT "${s.urun}", SUM("${s.uretim}") AS uretim 
                FROM ${TABLE} WHERE ${whereStr} 
                GROUP BY "${s.urun}" ORDER BY uretim DESC LIMIT 10`;
      } else if (!il && urun) {
        return `SELECT "${s.il}", SUM("${s.uretim}") AS uretim 
                FROM ${TABLE} WHERE ${whereStr} 
                GROUP BY "${s.il}" ORDER BY uretim DESC LIMIT 10`;
      }
      break;
      
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
async function gptQuery(question, schemaObj) {
  if (!process.env.OPENAI_API_KEY) return null;
  
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const { schema: s } = schemaObj;
  
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{
        role: 'system',
        content: `Sen bir tarım SQL üretici asistansın. Türkçe doğal dili anlayıp SQLite sorguları üretirsin.
        
Tablo: ${TABLE}
Kolonlar: ${s.il}, ${s.ilce}, ${s.urun}, ${s.kategori}, ${s.yil}, ${s.uretim}, ${s.alan}

Kurallar:
- Sadece SELECT sorguları üret
- Yıl belirtilmemişse 2024 kullan
- "Geçen yıl" = 2023, "bu yıl" = 2024  
- Genel ürün isimleri için LIKE '%Ürün%' kullan (örn: "mısır" → "urun_adi" LIKE '%Mısır%')
- "Hangi illerde" sorularında GROUP BY il kullan
- "Hangi ilçelerde" sorularında GROUP BY ilce kullan
- "En çok" sorularında ORDER BY DESC LIMIT 10 kullan
- SUM() fonksiyonlarını kullan
- Kolon isimlerini çift tırnak ile yaz
- Türkiye geneli sorularda il filtresi koyma

Örnekler:
"Geçen yıl domates üretimi" → SELECT SUM(uretim_miktari) FROM urunler WHERE urun_adi LIKE '%Domates%' AND yil = 2023
"Hangi illerde en çok meyve?" → SELECT il, SUM(uretim_miktari) FROM urunler WHERE urun_cesidi='Meyve' GROUP BY il ORDER BY SUM(uretim_miktari) DESC`
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
    
    // Cache kontrol - debug modda cache atla
    if (!DEBUG && cache.has(q)) {
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
    const parsed = parseQuery(q, { iller: schema.iller, ilceler: schema.ilceler });
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
