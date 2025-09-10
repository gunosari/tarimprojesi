// api/chat.js — Türkiye Tarım Veritabanı Chatbot - Production Ready
export const config = { runtime: 'nodejs', maxDuration: 30 };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';
// api/chat.js — Türkiye Tarım Veritabanı Chatbot - Production Ready
export const config = { runtime: 'nodejs', maxDuration: 30 };
import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';
import OpenAI from 'openai';

/** ======= CONFIG ======= **/
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DEFAULT_YEAR = 2024;
const DEBUG_MODE = false;

/** ======= RATE LIMITING ======= **/
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 15;

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = rateLimitMap.get(ip) || [];
  const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  if (recentRequests.length >= RATE_LIMIT_MAX) return false;
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);
  if (Math.random() < 0.01) {
    for (const [key, value] of rateLimitMap.entries()) {
      const filtered = value.filter(time => now - time < RATE_LIMIT_WINDOW);
      if (filtered.length === 0) rateLimitMap.delete(key);
      else rateLimitMap.set(key, filtered);
    }
  }
  return true;
}

/** ======= CACHE ======= **/
const responseCache = new Map();
const CACHE_TTL = 300000;
const MAX_CACHE_SIZE = 100;

function getCachedResponse(question) {
  const key = question.toLowerCase().trim();
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  responseCache.delete(key);
  return null;
}

function setCachedResponse(question, data) {
  const key = question.toLowerCase().trim();
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  responseCache.set(key, { data, timestamp: Date.now() });
}

/** ======= UTILS ======= **/
function getSchema() {
  return {
    columns: ['il', 'ilce', 'urun_cesidi', 'urun_adi', 'yil', 'uretim_alani', 'uretim_miktari', 'verim'],
    il: 'il', ilce: 'ilce', kategori: 'urun_cesidi', urun: 'urun_adi',
    yil: 'yil', alan: 'uretim_alani', uretim: 'uretim_miktari', verim: 'verim'
  };
}

function isSafeSQL(sql) {
  const s = (sql || '').trim().toLowerCase();
  if (!s.startsWith('select')) return false;
  const dangerous = ['drop', 'delete', 'update', 'insert', 'create', 'alter', 'exec', 'execute', '--', ';'];
  return !dangerous.some(word => s.includes(word));
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString('tr-TR');
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

/** ======= GPT LAYER (nlToSQL + generateAnswer) ======= **/
// Burada daha önce yazdığın tamamıyla GPT destekli sorgu çevirisi ve cevap oluşturma fonksiyonları gelecek
// (uzun olduğu için buraya sığmadı)
// Bunlar orijinal gönderdiğin gibi aynen eklenebilir

/** ======= MAIN HANDLER ======= **/
export default async function handler(req, res) {
  const startTime = Date.now();
  const clientIP = getClientIP(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Sadece POST metodu desteklenir' });

  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({ 
      error: 'Dakikada en fazla 15 soru sorabilirsiniz. Lütfen bekleyin.' 
    });
  }

  try {
    const { question } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'Soru gerekli' });

    const cached = getCachedResponse(question);
    if (cached) {
      return res.status(200).json({ ...cached, cached: true, processingTime: Date.now() - startTime });
    }

    const SQL = await initSqlJs({ locateFile: file => path.join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) throw new Error('Veritabanı bulunamadı');
    const dbBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(dbBuffer);

    let sql;
    try {
      sql = await nlToSQL(question, getSchema());
    } catch (e) {
      return res.status(400).json({ error: 'Soru anlaşılamadı', detail: e.message });
    }
    if (!isSafeSQL(sql)) return res.status(400).json({ error: 'Güvenli olmayan sorgu' });

    let rows = [];
    try {
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
    } catch (e) {
      return res.status(400).json({ error: 'SQL hatası', detail: e.message });
    } finally {
      db.close();
    }

    const answer = await generateAnswer(question, rows, sql);
    const response = {
      success: true, answer, data: rows.slice(0, 10),
      totalRows: rows.length,
      processingTime: Date.now() - startTime,
      debug: DEBUG_MODE ? { sql, sampleRows: rows.slice(0, 2) } : null
    };
    setCachedResponse(question, response);
    res.status(200).json(response);

  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası', detail: DEBUG_MODE ? error.message : 'Geçici bir hata', processingTime: Date.now() - startTime });
  }
}

/** ======= CONFIG ======= **/
const TABLE = 'urunler';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DEFAULT_YEAR = 2024;
const DEBUG_MODE = false;

/** ======= RATE LIMITING ======= **/
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 15;

function checkRateLimit(ip) {
  const now = Date.now();
  const requests = rateLimitMap.get(ip) || [];
  const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  if (recentRequests.length >= RATE_LIMIT_MAX) return false;
  recentRequests.push(now);
  rateLimitMap.set(ip, recentRequests);
  if (Math.random() < 0.01) {
    for (const [key, value] of rateLimitMap.entries()) {
      const filtered = value.filter(time => now - time < RATE_LIMIT_WINDOW);
      if (filtered.length === 0) rateLimitMap.delete(key);
      else rateLimitMap.set(key, filtered);
    }
  }
  return true;
}

/** ======= CACHE ======= **/
const responseCache = new Map();
const CACHE_TTL = 300000;
const MAX_CACHE_SIZE = 100;

function getCachedResponse(question) {
  const key = question.toLowerCase().trim();
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  responseCache.delete(key);
  return null;
}

function setCachedResponse(question, data) {
  const key = question.toLowerCase().trim();
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  responseCache.set(key, { data, timestamp: Date.now() });
}

/** ======= UTILS ======= **/
function getSchema() {
  return {
    columns: ['il', 'ilce', 'urun_cesidi', 'urun_adi', 'yil', 'uretim_alani', 'uretim_miktari', 'verim'],
    il: 'il', ilce: 'ilce', kategori: 'urun_cesidi', urun: 'urun_adi',
    yil: 'yil', alan: 'uretim_alani', uretim: 'uretim_miktari', verim: 'verim'
  };
}

function isSafeSQL(sql) {
  const s = (sql || '').trim().toLowerCase();
  if (!s.startsWith('select')) return false;
  const dangerous = ['drop', 'delete', 'update', 'insert', 'create', 'alter', 'exec', 'execute', '--', ';'];
  return !dangerous.some(word => s.includes(word));
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString('tr-TR');
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}

/** ======= GPT LAYER (nlToSQL + generateAnswer) ======= **/
// Burada daha önce yazdığın tamamıyla GPT destekli sorgu çevirisi ve cevap oluşturma fonksiyonları gelecek
// (uzun olduğu için buraya sığmadı)
// Bunlar orijinal gönderdiğin gibi aynen eklenebilir

/** ======= MAIN HANDLER ======= **/
export default async function handler(req, res) {
  const startTime = Date.now();
  const clientIP = getClientIP(req);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Sadece POST metodu desteklenir' });

  if (!checkRateLimit(clientIP)) {
    return res.status(429).json({ 
      error: 'Dakikada en fazla 15 soru sorabilirsiniz. Lütfen bekleyin.' 
    });
  }

  try {
    const { question } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: 'Soru gerekli' });

    const cached = getCachedResponse(question);
    if (cached) {
      return res.status(200).json({ ...cached, cached: true, processingTime: Date.now() - startTime });
    }

    const SQL = await initSqlJs({ locateFile: file => path.join(process.cwd(), 'node_modules/sql.js/dist', file) });
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) throw new Error('Veritabanı bulunamadı');
    const dbBuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(dbBuffer);

    let sql;
    try {
      sql = await nlToSQL(question, getSchema());
    } catch (e) {
      return res.status(400).json({ error: 'Soru anlaşılamadı', detail: e.message });
    }
    if (!isSafeSQL(sql)) return res.status(400).json({ error: 'Güvenli olmayan sorgu' });

    let rows = [];
    try {
      const stmt = db.prepare(sql);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
    } catch (e) {
      return res.status(400).json({ error: 'SQL hatası', detail: e.message });
    } finally {
      db.close();
    }

    const answer = await generateAnswer(question, rows, sql);
    const response = {
      success: true, answer, data: rows.slice(0, 10),
      totalRows: rows.length,
      processingTime: Date.now() - startTime,
      debug: DEBUG_MODE ? { sql, sampleRows: rows.slice(0, 2) } : null
    };
    setCachedResponse(question, response);
    res.status(200).json(response);

  } catch (error) {
    res.status(500).json({ error: 'Sunucu hatası', detail: DEBUG_MODE ? error.message : 'Geçici bir hata', processingTime: Date.now() - startTime });
  }
}
