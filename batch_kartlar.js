// batch_kartlar.js — 81 ilin karar kartını önceden üretir
// Calistirma:  node batch_kartlar.js
// Cikti:       public/karar_kartlari.json
//
// SQL sorgulari api/apichat2.js'ten import edilir; tek kaynak korunur.

import fs from 'fs';
import path from 'path';
import {
  getDB, executeQuery, getMaxYil,
  getIlSorulari, getUrunSorulari,
  getIller, getUrunler, generateAnalysis
} from './api/apichat2.js';

/** ======= AYARLAR ======= */
const CIKTI     = path.join(process.cwd(), 'public', 'karar_kartlari.json');
const BEKLEME   = 1500;   // istekler arasi ms — API rate limit korumasi
const TIP       = process.argv[2] || 'il';   // 'il' | 'urun' | 'hepsi'
const YENIDEN   = process.argv.includes('--yeniden');  // mevcut kartlari da yeniden uret

/** ======= YARDIMCILAR ======= */
const bekle = ms => new Promise(r => setTimeout(r, ms));
const sure  = ms => ms < 60000 ? `${Math.round(ms/1000)} sn` : `${Math.floor(ms/60000)} dk ${Math.round(ms%60000/1000)} sn`;

function kartlariYukle() {
  try { return JSON.parse(fs.readFileSync(CIKTI, 'utf8')); }
  catch { return { uretim: null, yil: null, kartlar: {} }; }
}

function kartlariKaydet(veri) {
  fs.mkdirSync(path.dirname(CIKTI), { recursive: true });
  fs.writeFileSync(CIKTI, JSON.stringify(veri, null, 2), 'utf8');
}

/** ======= TEK KART URET ======= */
async function kartUret(db, tip, secim, maxYil) {
  const sorular = tip === 'il' ? getIlSorulari(maxYil) : getUrunSorulari(maxYil);
  const sonuclar = sorular.map(s => executeQuery(db, s.sql, s.params(secim)));
  // res parametresi yok -> stream yerine tek seferde doner
  const analiz = await generateAnalysis(secim, tip, sorular, sonuclar, maxYil, null);
  return { analiz, uretim: new Date().toISOString() };
}

/** ======= ANA AKIS ======= */
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('HATA: ANTHROPIC_API_KEY tanimli degil.');
    console.error('  Windows:  set ANTHROPIC_API_KEY=sk-ant-...');
    console.error('  Mac/Linux: export ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const t0 = Date.now();
  const db = await getDB();
  const maxYil = getMaxYil(db);
  const veri = kartlariYukle();

  // Yil degistiyse tum kartlar bayat -> sifirla
  if (veri.yil && veri.yil !== maxYil) {
    console.log(`Veri yili degisti (${veri.yil} -> ${maxYil}). Tum kartlar yeniden uretilecek.`);
    veri.kartlar = {};
  }
  veri.yil = maxYil;

  // Hedef listeyi kur
  const hedefler = [];
  if (TIP === 'il' || TIP === 'hepsi') getIller(db).forEach(x => hedefler.push({ tip: 'il', secim: x }));
  if (TIP === 'urun' || TIP === 'hepsi') getUrunler(db).forEach(x => hedefler.push({ tip: 'urun', secim: x }));

  // Zaten uretilmis olanlari atla (--yeniden verilmediyse)
  const kalan = YENIDEN ? hedefler : hedefler.filter(h => !veri.kartlar[`${h.tip}|${h.secim}`]);

  console.log(`Veri yili   : ${maxYil}`);
  console.log(`Toplam hedef: ${hedefler.length}  |  Uretilecek: ${kalan.length}  |  Mevcut: ${hedefler.length - kalan.length}`);
  if (!kalan.length) { console.log('Tum kartlar guncel, yapilacak is yok.'); return; }
  console.log(`Tahmini sure: ~${sure(kalan.length * (BEKLEME + 12000))}\n`);

  let basarili = 0, hatali = 0;
  const hatalar = [];

  for (let i = 0; i < kalan.length; i++) {
    const { tip, secim } = kalan[i];
    const etiket = `[${String(i + 1).padStart(3)}/${kalan.length}] ${secim}`;
    process.stdout.write(`${etiket.padEnd(34)} ... `);

    try {
      const kart = await kartUret(db, tip, secim, maxYil);
      veri.kartlar[`${tip}|${secim}`] = kart;
      basarili++;
      console.log(`OK  (${kart.analiz.length.toLocaleString('tr-TR')} karakter)`);
      // Her kartta kaydet — kesinti olursa is kaybolmaz
      veri.uretim = new Date().toISOString();
      kartlariKaydet(veri);
    } catch (e) {
      hatali++;
      hatalar.push({ secim, hata: e.message });
      console.log(`HATA: ${e.message.slice(0, 60)}`);
    }

    if (i < kalan.length - 1) await bekle(BEKLEME);
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`Basarili : ${basarili}`);
  console.log(`Hatali   : ${hatali}`);
  console.log(`Sure     : ${sure(Date.now() - t0)}`);
  console.log(`Dosya    : ${CIKTI}`);
  console.log(`Boyut    : ${(fs.statSync(CIKTI).size / 1024 / 1024).toFixed(2)} MB`);
  if (hatalar.length) {
    console.log('\nHatalilar (tekrar calistirinca denenecek):');
    hatalar.forEach(h => console.log(`  - ${h.secim}: ${h.hata.slice(0, 70)}`));
  }
  console.log('='.repeat(52));
}

main().catch(e => { console.error('\nBEKLENMEYEN HATA:', e); process.exit(1); });
