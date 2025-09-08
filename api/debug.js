// api/debug.js - Sistem kontrolü için debug endpoint
export const config = { runtime: 'nodejs' };
import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  try {
    const checks = {};
    
    // 1. Node.js runtime kontrol
    checks.nodejs = {
      version: process.version,
      platform: process.platform,
      status: 'OK'
    };
    
    // 2. Working directory kontrol
    checks.workingDir = {
      path: process.cwd(),
      status: 'OK'
    };
    
    // 3. Database dosyası kontrol
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    checks.database = {
      path: dbPath,
      exists: fs.existsSync(dbPath),
      status: fs.existsSync(dbPath) ? 'OK' : 'ERROR - Dosya bulunamadı'
    };
    
    if (fs.existsSync(dbPath)) {
      const stats = fs.statSync(dbPath);
      checks.database.size = `${(stats.size / 1024 / 1024).toFixed(2)} MB`;
      checks.database.modified = stats.mtime;
    }
    
    // 4. sql.js library kontrol
    try {
      const sqljsPath = path.join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm');
      checks.sqljs = {
        wasmExists: fs.existsSync(sqljsPath),
        status: fs.existsSync(sqljsPath) ? 'OK' : 'ERROR - WASM dosyası bulunamadı'
      };
    } catch (e) {
      checks.sqljs = {
        status: 'ERROR',
        error: e.message
      };
    }
    
    // 5. OpenAI API key kontrol
    checks.openai = {
      keyExists: !!process.env.OPENAI_API_KEY,
      keyLength: process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.length : 0,
      status: process.env.OPENAI_API_KEY ? 'OK' : 'WARNING - API key yok'
    };
    
    // 6. Memory kullanımı
    const memUsage = process.memoryUsage();
    checks.memory = {
      heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
      status: 'OK'
    };
    
    // 7. Environment kontrol
    checks.environment = {
      nodeEnv: process.env.NODE_ENV || 'development',
      platform: process.env.VERCEL ? 'Vercel' : 'Local',
      status: 'OK'
    };
    
    // Genel durum
    const hasErrors = Object.values(checks).some(check => 
      check.status && check.status.includes('ERROR')
    );
    
    res.status(200).json({
      success: true,
      timestamp: new Date().toISOString(),
      status: hasErrors ? 'ERRORS_FOUND' : 'ALL_OK',
      checks
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
}
