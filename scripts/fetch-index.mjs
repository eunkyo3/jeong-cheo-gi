import https from 'node:https';
import fs from 'node:fs';

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return resolve(get(new URL(res.headers.location, url).href));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('timeout')); });
  });
}

const { status, body } = await get('https://chobopark.tistory.com/561');
console.error('status', status, 'len', body.length);
fs.mkdirSync('data/raw/_index', { recursive: true });
fs.writeFileSync('data/raw/_index/page.html', body, 'utf8');
console.error('saved data/raw/_index/page.html');
