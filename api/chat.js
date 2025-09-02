import { sqliteDb } from '@/lib/db';

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { question } = req.body;

      if (!question || typeof question !== 'string') {
        return res.status(400).json({ error: 'Geçerli bir il adı giriniz.' });
      }

      const result = await sqliteDb.prepare(`
        SELECT il, urun_adi, 
               SUM(uretim_miktari) AS toplam_uretim, 
               SUM(uretim_alani) AS toplam_alani
        FROM sebze
        WHERE il = ?
        GROUP BY urun_adi
        ORDER BY toplam_uretim DESC
        LIMIT 10
      `).all(question.trim());

      if (!result.length) {
        return res.status(200).json({ cevap: `${question} için veri bulunamadı.` });
      }

      const cevap = result.map(r =>
        `🥕 ${r.urun_adi} — ${r.toplam_uretim} ton (${r.toplam_alani} da)`
      ).join('\n');

      return res.status(200).send(cevap);

    } catch (error) {
      console.error('Hata:', error);
      return res.status(500).json({ error: 'Sunucu hatası oluştu.' });
    }

  } else {
    return res.status(405).send('Sadece POST isteklerine izin verilir');
  }
}
