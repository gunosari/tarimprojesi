function ruleBasedSql(nlRaw, cols, catCol) {
  const nl = String(nlRaw || '').trim();
  const mIl = nl.match(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)(?:[’'`´]?[dt]e|[’'`´]?[dt]a|\s|$)/);
  const il = mIl ? mIl[1] : '';
  const year = (nl.match(/\b(19\d{2}|20\d{2})\b/) || [])[1] || '';
  const known = /(domates|biber|patlıcan|kabak|hıyar|salatalık|karpuz|karnabahar|lahana|marul|fasulye|soğan|sarımsak|patates|brokoli|ispanak|maydanoz|enginar|bezelye|bakla|elma|portakal|mandalina|limon|muz|zeytin|üzüm|armut|şeftali|kayısı|nar|incir|vişne|çilek|kiraz|kavun|ayva|fındık|ceviz|antep fıstığı|buğday|arpa|mısır|çeltik|pirinç|yulaf|çavdar|ayçiçeği|kanola)/i;
  let urun = (nl.match(known) || [])[1] || '';
  if (!urun) {
    const mu = nl.match(/([a-zçğıöşü]{3,})\s*(?:ürünü|ürün)?\s*(?:ekim alanı|üretim)/i);
    if (mu) urun = mu[1];
  }
  urun = (urun || '').replace(/["'’`´]+/g,'').trim();
  let kat = '';
  if (/meyve/i.test(nl)) kat = 'Meyve';
  else if (/tah[ıi]l/i.test(nl)) kat = 'Tahıl';
  else if (/sebze/i.test(nl)) kat = 'Sebze';

  // 1) "en çok üretilen" için kategori filtresi
  if (il && /en çok üretilen/i.test(nl)) {
    const likeHead = urun ? headMatchExpr(urun) : '';
    return `
      SELECT "urun_adi" AS urun, SUM("uretim_miktari") AS toplam_uretim
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
      GROUP BY "urun_adi"
      ORDER BY toplam_uretim DESC
      LIMIT 1
    `.trim();
  }
  // 2) "ekim alanı" için
  if (il && /(ekim )?alan/i.test(nl)) {
    const likeHead = urun ? `("urun_adi" LIKE '%${escapeSQL(urun)}%' OR "urun_adi" LIKE '%${escapeSQL(urun.charAt(0).toUpperCase() + urun.slice(1))}%')` : '';
    return `
      SELECT "urun_adi" AS urun, SUM("uretim_alani") AS toplam_alan
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
      GROUP BY "urun_adi"
      ORDER BY toplam_alan DESC
      LIMIT 1
    `.trim();
  }
  // 3) "ne oldu" gibi genel sorgular için varsayılan üretim toplamı
  if (il && /ne oldu/i.test(nl)) {
    const likeHead = urun ? headMatchExpr(urun) : '';
    return `
      SELECT SUM("uretim_miktari") AS toplam_uretim
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        ${likeHead ? `AND ${likeHead}` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
    `.trim();
  }
  // 4) toplam üretim (sebze/meyve/tahıl olabilir)
  if (il && (/kaç\s+ton/i.test(nl) || /toplam.*üretim/i.test(nl)) && !urun) {
    return `
      SELECT SUM("uretim_miktari") AS toplam_uretim
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
    `.trim();
  }
  // 5) belli bir ürün üretimi
  if (il && urun && /üretim/i.test(nl)) {
    const likeHead = headMatchExpr(urun);
    return `
      SELECT SUM("uretim_miktari") AS toplam_uretim
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        AND ${likeHead}
        ${year ? `AND "yil"=${Number(year)}` : ''}
        ${/sebze|meyve|tah[ıi]l/i.test(nl) ? `AND "${catCol}"='${/sebze/i.test(nl) ? 'Sebze' : /meyve/i.test(nl) ? 'Meyve' : 'Tahıl'}'` : ''}
    `.trim();
  }
  // 6) toplam ekim alanı
  if (il && /(toplam)?.*(ekim )?alan/i.test(nl)) {
    return `
      SELECT SUM("uretim_alani") AS toplam_alan
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
    `.trim();
  }
  // 7) ilde en çok üretilen N ürün
  const topN = (nl.match(/en çok üretilen\s+(\d+)/i) || [])[1] || 10;
  if (il && /(en çok üretilen\s+\d+\s+ürün|en çok üretilen ürün)/i.test(nl)) {
    return `
      SELECT "urun_adi" AS urun, SUM("uretim_miktari") AS uretim, SUM("uretim_alani") AS alan
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
      GROUP BY "urun_adi"
      ORDER BY uretim DESC
      LIMIT ${Number(topN)}
    `.trim();
  }
  // 8) ürün en çok hangi ilçelerde?
  if (il && urun && /en çok hangi ilçelerde/i.test(nl)) {
    const likeHead = headMatchExpr(urun);
    return `
      SELECT "ilce" AS ilce, SUM("uretim_miktari") AS uretim, SUM("uretim_alani") AS alan
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        AND ${likeHead}
        ${year ? `AND "yil"=${Number(year)}` : ''}
      GROUP BY "ilce"
      ORDER BY uretim DESC
      LIMIT 10
    `.trim();
  }
  // 9) ortalama verim
  if (il && /verim/i.test(nl)) {
    return `
      SELECT CASE WHEN SUM("uretim_alani")>0 THEN ROUND(SUM("uretim_miktari")/SUM("uretim_alani"), 4) ELSE NULL END AS ort_verim
      FROM ${TABLE}
      WHERE "il"='${escapeSQL(il)}'
        ${kat ? `AND "${catCol}"='${escapeSQL(kat)}'` : ''}
        ${year ? `AND "yil"=${Number(year)}` : ''}
    `.trim();
  }
  return '';
}

/** ======= Güzel cevap (opsiyonel GPT) ======= **/
async function prettyAnswer(question, rows) {
  if (!process.env.OPENAI_API_KEY) {
    if (!rows?.length) return 'Veri bulunamadı.';
    if (rows.length === 1) return Object.entries(rows[0]).map(([k,v]) => `${k}: ${v}`).join(' • ');
    return `${rows.length} satır döndü.`;
  }
  const sample = Array.isArray(rows) ? rows.slice(0, 5) : [];
  const year = rows.length > 0 ? rows[0].yil : DEFAULT_YEAR; // SQL'den yılı al
  const r = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Kısa ve net Türkçe cevap ver. Sayıları binlik ayırıcıyla yaz. Sadece verilen verilere ve belirtilen yıla (eğer varsa) dayan, varsayım yapma.' },
      { role: 'user', content: `Soru: ${question}\nÖrnek veri: ${JSON.stringify(sample)}\nToplam satır: ${rows.length}\nYıl: ${year}\n1-2 cümle özet yaz, yılı yalnızca verilen yıl olarak kullan.` }
    ],
  });
  return (r.choices[0].message.content || '').trim();
}

/** ======= Handler ======= **/
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Sadece POST isteklerine izin verilir' }); return;
    }
    const { question } = req.body || {};
    const raw = String(question ?? '').trim();
    if (!raw) { res.status(400).json({ ok: false, error: 'question alanı zorunlu' }); return; }
    // sql.js başlat
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules/sql.js/dist', file),
    });
    // DB
    const dbPath = path.join(process.cwd(), 'public', 'tarimdb.sqlite');
    if (!fs.existsSync(dbPath)) { res.status(500).json({ ok: false, error: 'tarimdb.sqlite bulunamadı' }); return; }
    const db = new SQL.Database(fs.readFileSync(dbPath));
    // Şema ve güvenlik
    const COLS = getColumns(SQL, db);
    const hasUrunCesidi = COLS.includes('urun_cesidi');
    const catCol = hasUrunCesidi ? 'urun_cesidi' : 'urun_cesidi'; // Varsayılan olarak urun_cesidi
    const isSafeSql = makeIsSafeSql([TABLE, ...COLS.map(c => `"${c}"`)]);
    // Debug için sorguyu log'la
    console.log(`Sorgu: ${raw}`);
    // Kısa yol: "İl, Ürün" -> ilçe top10 (başta-eşleşme)
    if (raw.includes(',')) {
      const [ilInput, urunInput] = raw.split(',').map(s => s.trim());
      const stmt = db.prepare(`
        SELECT "ilce" AS ilce, SUM("uretim_miktari") AS uretim, SUM("uretim_alani") AS alan
        FROM ${TABLE}
        WHERE "il" = ? AND ${headMatchExpr(urunInput)}
        GROUP BY "ilce"
        ORDER BY uretim DESC
        LIMIT 10;
      `);
      const rows = [];
      stmt.bind([ilInput]);
      while (stmt.step()) rows.push(st.getAsObject());
      stmt.free();
      const text = qToText(rows, r => `• ${r.ilce}: ${r.uretim} ton, ${r.alan} dekar`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: il_urun_ilce_top\nİl: ${ilInput} | Ürün: ${urunInput}\n\n${text}`);
      return;
    }
    // 1) GPT ile dene
    let used = 'nl2sql-gpt', gptErr = '', sql = '';
    try {
      sql = await nlToSql_gpt(raw, COLS, catCol);
    } catch (e) {
      gptErr = `${e?.status || e?.code || ''} ${e?.message || String(e)}`;
      used = 'fallback-rules';
    }
    // 2) Uygunsuz/boşsa (ve GPT-only mod kapalıysa) kural tabanlı
    if (!sql || !isSafeSql(sql)) {
      if (FORCE_GPT_ONLY) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.status(200).send(`🧭 Mod: gpt-only | GPT SQL geçersiz/boş\nSQL:\n${sql || '(yok)'}`);
        return;
      }
      const rb = ruleBasedSql(raw, COLS, catCol);
      if (rb && isSafeSql(rb)) { sql = rb; used = 'rules'; }
    }
    // 3) Hâlâ SQL yoksa: il adına göre top ürünler (debug dostu)
    if (!sql) {
      const ilInput = raw;
      let tmp = `
        SELECT "urun_adi" AS urun, SUM("uretim_miktari") AS uretim, SUM("uretim_alani") AS alan
        FROM ${TABLE}
        WHERE "il" = ?
        GROUP BY "urun_adi"
        ORDER BY uretim DESC
        LIMIT 10
      `.trim();
      tmp = AUTO_INJECT_DEFAULT_YEAR ? tmp.replace('WHERE "il" = ?', `WHERE "yil"=${DEFAULT_YEAR} AND "il" = ?`) : tmp;
      const rows = [];
      const stmt = db.prepare(tmp);
      stmt.bind([ilInput]);
      while (stmt.step()) rows.push(st.getAsObject());
      stmt.free();
      const text = qToText(rows, r => `• ${r.urun?.trim?.()}: ${r.uretim} ton, ${r.alan} dekar`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: fallback_il_top_urun\nİl: ${ilInput}\n\n${text}`);
      return;
    }
    // 4) SQL'i çalıştır
    let rows = [];
    try {
      const st = db.prepare(sql);
      while (st.step()) rows.push(st.getAsObject());
      st.free();
    } catch (e) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(`🧭 Mod: ${used} (model: ${MODEL})\nSQL derlenemedi.\nSQL:\n${sql}\n\nHata: ${String(e)}`);
      return;
    }
    // 5) Özet + Debug
    const nice = await prettyAnswer(raw, rows);
    const debugText = DEBUG_ROWS
      ? `\n\n-- DEBUG --\nKolonlar: ${COLS.join(', ')}\nSQL:\n${sql}\nİlk 5 Satır:\n${JSON.stringify(rows.slice(0,5), null, 2)}`
      : '';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(
      `🧭 Mod: ${used} (model: ${MODEL})${gptErr ? ` | gptErr: ${gptErr}` : ''}\n` +
      `Soru: ${raw}\n\n${nice}\n\n` +
      (rows.length ? qToText(rows, r => '• ' + JSON.stringify(r)) : 'Veri bulunamadı.') +
      debugText
    );
  } catch (err) {
    console.error('API hata:', err);
    res.status(500).json({ ok: false, error: 'FUNCTION_INVOCATION_FAILED', detail: String(err) });
  }
}
</xaiArtifact>

### Yapman Gerekenler
1. **Kodu Güncelle:** Yukarıdaki `api/chat.js` kodunu kopyalayıp mevcut dosyayla değiştir.
2. **Deploy Et:** 
   ```bash
   git add api/chat.js
   git commit -m "Tüm ürünler için genelleştirilmiş ekim alanı sorgusu"
   git push
