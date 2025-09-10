// ... (önceki kodun sabit kısımları aynı kalır)

async function nlToSQL(question, schema) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI API key eksik');
 
  const { il, ilce, urun, yil, uretim, alan, verim, kategori } = schema;
 
  const system = `Sen bir SQL uzmanısın. Türkiye tarım verileri için doğal dil sorgularını SQL'e çevir.
TABLO: ${TABLE}
KOLONLAR:
- "${il}": İl adı (TEXT)
- "${ilce}": İlçe adı (TEXT)
- "${kategori}": Ürün kategorisi (Meyve/Sebze/Tahıl) (TEXT)
- "${urun}": Ürün adı (TEXT)
- "${yil}": Yıl (INTEGER, 2020-2024 arası)
- "${alan}": Üretim alanı, dekar cinsinden (INTEGER)
- "${uretim}": Üretim miktarı, ton cinsinden (INTEGER)
- "${verim}": Verim, ton/dekar (INTEGER)
ÖNEMLİ: YAZIM HATALARINI OTOMATIK DÜZELT!
- "kaysı" → "kayısı", "anakara" → "ankara", "domates" → "domates"
- "adanna" → "adana", "mersinn" → "mersin", "izmirr" → "izmir"
- İl/ürün isimlerindeki typo'ları düzelt
KRİTİK KURALLAR:
1. ÜRÜN EŞLEŞME:
   - Yazım hatalarını düzelt: "kaysı" → "kayısı" olarak işle
   - Tekli: "üzüm" → LOWER("${urun}") LIKE '%üzüm%' OR "${urun}" LIKE '%Üzüm%'
   - Çoklu: "sofralık üzüm çekirdekli" → Her kelimeyi ayrı kontrol:
     LOWER("${urun}") LIKE '%sofralık%' AND LOWER("${urun}") LIKE '%üzüm%' AND LOWER("${urun}") LIKE '%çekirdekli%'
2. İL/İLÇE EŞLEŞME:
   - Yazım hatalarını düzelt: "anakara" → "ankara" olarak işle
   - "Mersin'de" → "${il}"='Mersin'
   - "Tarsus'ta" → "${ilce}"='Tarsus'
   - "Türkiye'de" → İl filtresi koyma
3. YIL KURALI:
   - Yıl yok → Otomatik ${DEFAULT_YEAR} eklenecek
   - "2023'te" → "${yil}"=2023
4. AGGREGATION:
   - SUM() kullan, "en çok" → ORDER BY DESC
5. SIRALAMA SORULARI:
   - Soru "kaçıncı" içeriyorsa:
     - TÜM İLLERİ ilgili ürünün üretim miktarına göre sırala
     - ZORUNLU OLARAK RANK() OVER (ORDER BY SUM(uretim_miktari) DESC) KULLANARAK her ilin sıralama pozisyonunu hesapla
     - İlgili ilin sıralamasını döndürmek için HAVING ile o ili filtrele
     - Sıralama sadece ilgili il için tek bir satır döndürmeli
     - HATALI OLARAK SADECE BİR İLİN ÜRETİMİNİ HESAPLAMA, TÜM İLLERİ KARŞILAŞTIR
ÖRNEKLER:
Soru: "Mersin avokado üretiminde kaçıncı"
SQL: SELECT il, RANK() OVER (ORDER BY SUM(uretim_miktari) DESC) AS siralama FROM ${TABLE} WHERE LOWER(urun_adi) LIKE '%avokado%' AND yil=${DEFAULT_YEAR} GROUP BY il HAVING il='Mersin'
Soru: "mersinn kaysı üretimi" (yazım hatalı)
İşle: "mersin kayısı üretimi" (düzeltilmiş)
SQL: SELECT SUM("${uretim}") AS toplam_uretim FROM ${TABLE} WHERE "${il}"='Mersin' AND LOWER("${urun}") LIKE '%kayısı%'
...
ÇIKTI: Sadece SELECT sorgusu, noktalama yok.`;
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Soru: "${question}"\n\nSQL:` }
      ],
      temperature: 0,
      max_tokens: 200
    });
   
    let sql = (response.choices[0].message.content || '')
      .replace(/```[\s\S]*?```/g, s => s.replace(/```(sql)?/g,'').trim())
      .trim()
      .replace(/;+\s*$/, '');
   
    if (DEBUG_MODE) console.log('Generated SQL:', sql); // Ek hata ayıklama
    
    // Yıl otomatik ekleme
    if (sql && !sql.includes(`"${yil}"`)) {
      if (sql.includes('WHERE')) {
        sql = sql.replace(/WHERE/i, `WHERE "${yil}"=${DEFAULT_YEAR} AND`);
      } else if (sql.includes('GROUP BY') || sql.includes('ORDER BY')) {
        const match = sql.match(/\b(GROUP BY|ORDER BY)/i);
        if (match) {
          sql = sql.slice(0, match.index) + `WHERE "${yil}"=${DEFAULT_YEAR} ` + sql.slice(match.index);
        }
      } else {
        sql += ` WHERE "${yil}"=${DEFAULT_YEAR}`;
      }
    }
   
    return sql;
  } catch (e) {
    console.error('OpenAI hatası:', e.message);
    throw new Error(`GPT servisi geçici olarak kullanılamıyor: ${e.message}`);
  }
}

async function generateAnswer(question, rows, sql) {
  if (!rows || rows.length === 0) {
    return 'Bu sorguya uygun veri bulunamadı.';
  }

  // Sıralama soruları için özel mantık
  if (question.toLowerCase().includes('kaçıncı') && rows.length === 1 && rows[0].siralama) {
    const sira = rows[0].siralama;
    if (DEBUG_MODE) console.log('Ranking result:', rows[0]); // Ek hata ayıklama
    return `${rows[0].il} ${sira}. sırada.`;
  } else if (question.toLowerCase().includes('kaçıncı') && (!rows[0].siralama || rows.length > 1)) {
    if (DEBUG_MODE) console.log('Ranking failed - Rows:', rows); // Ek hata ayıklama
    return 'Sıralama hesaplanamadı. Lütfen verileri kontrol edin.';
  }
 
  // Basit cevaplar için hızlı return
  if (rows.length === 1) {
    const row = rows[0];
    const keys = Object.keys(row);
   
    if (keys.length === 1) {
      const [key, value] = Object.entries(row)[0];
     
      if (value === null || value === undefined || value === 0) {
        return 'Bu sorguya uygun veri bulunamadı.';
      }
     
      if (key.includes('alan')) {
        return `${formatNumber(value)} dekar`;
      } else if (key.includes('verim')) {
        return `${formatNumber(value)} ton/dekar`;
      } else if (key.includes('uretim') || key.includes('toplam')) {
        return `${formatNumber(value)} ton`;
      }
      return formatNumber(value);
    }
  }
 
  // Karmaşık cevaplar için GPT kullan
  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [{
          role: 'system',
          content: 'Tarım verileri uzmanısın. Kısa Türkçe cevap ver. Sayıları binlik ayraçla yaz.'
        }, {
          role: 'user',
          content: `Soru: ${question}\nVeri: ${JSON.stringify(rows.slice(0, 5))}`
        }],
        temperature: 0,
        max_tokens: 100
      });
     
      return response.choices[0].message.content?.trim() || 'Cevap oluşturulamadı.';
    } catch (e) {
      console.error('GPT cevap hatası:', e);
      return `${rows.length} sonuç bulundu: ${JSON.stringify(rows[0])}`;
    }
  }
 
  return `${rows.length} sonuç bulundu.`;
}

// ... (diğer kod kısımları aynı kalır)
