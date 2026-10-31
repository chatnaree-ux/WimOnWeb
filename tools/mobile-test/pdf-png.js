// แปลง PDF → PNG ความละเอียดสูง (pdf.js ใน Chrome) เพื่อตรวจเส้นตาราง/ท้ายกระดาษ
//   ใช้: node pdf-png.js <ไฟล์.pdf> [หน้า=1] [scale=3]   → <ไฟล์>-p<หน้า>.png
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const [file, pageNo = '1', scale = '3'] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ channel: 'chrome' });
  const pg = await b.newPage();
  await pg.setContent('<canvas id="c"></canvas>');
  await pg.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' });
  const data = fs.readFileSync(file).toString('base64');
  const png = await pg.evaluate(async ([data, n, s]) => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({ data: atob(data) }).promise;
    const p = await doc.getPage(n), vp = p.getViewport({ scale: s }), c = document.getElementById('c');
    c.width = vp.width; c.height = vp.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c.toDataURL('image/png').split(',')[1];
  }, [data, +pageNo, +scale]);
  const out = file.replace(/\.pdf$/i, `-p${pageNo}.png`);
  fs.writeFileSync(out, Buffer.from(png, 'base64'));
  console.log(out);
  await b.close();
})();
