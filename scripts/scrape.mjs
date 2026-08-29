// scrape.mjs — 블로그 회차 페이지 수집 → data/raw/{round}/ 에 page.html, page.txt, imgNN.<ext> 저장
// 1회성 실행. 이미지 서명 URL 만료 대비, 수집 즉시 로컬 저장.
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const ROUNDS = {
  '2020-1': 196, '2020-2': 195, '2020-3': 194, '2020-4': 192,
  '2021-1': 191, '2021-2': 210, '2021-3': 217,
  '2022-1': 271, '2022-2': 423, '2022-3': 424,
  '2023-1': 372, '2023-2': 420, '2023-3': 453,
  '2024-1': 476, '2024-2': 483, '2024-3': 495,
  '2025-1': 540, '2025-2': 554, '2025-3': 558,
  '2026-1': 561, '2026-2': 562,
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fetchBuf(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://chobopark.tistory.com/' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchBuf(new URL(res.headers.location, url).href, depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout: ' + url)));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 티스토리 본문 영역 추출
function extractArticle(html) {
  const start = html.search(/<div class="(?:tt_article_useless_p_margin|entry-content|contents_style)[^"]*"/);
  if (start === -1) return html;
  // 균형 잡힌 div 스캔
  let i = html.indexOf('>', start) + 1;
  let depth = 1;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = i;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0][1] === '/') { depth--; if (depth === 0) return html.slice(i, m.index); }
    else depth++;
  }
  return html.slice(i);
}

function htmlToText(h) {
  return h
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, (_, s) => `\n[IMG ${s}]\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|pre|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&emsp;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function imgExt(url, contentType) {
  const u = url.split('?')[0].toLowerCase();
  for (const e of ['.png', '.jpg', '.jpeg', '.gif', '.webp']) if (u.endsWith(e)) return e === '.jpeg' ? '.jpg' : e;
  if (/png/.test(contentType)) return '.png';
  if (/gif/.test(contentType)) return '.gif';
  if (/webp/.test(contentType)) return '.webp';
  return '.jpg';
}

async function scrapeRound(round, postId, rawRoot) {
  const url = `https://chobopark.tistory.com/${postId}`;
  const dir = path.join(rawRoot, round);
  fs.mkdirSync(dir, { recursive: true });
  const { buf } = await fetchBuf(url);
  const html = buf.toString('utf8');
  fs.writeFileSync(path.join(dir, 'page.html'), html, 'utf8');

  const article = extractArticle(html);
  fs.writeFileSync(path.join(dir, 'article.html'), article, 'utf8');
  fs.writeFileSync(path.join(dir, 'page.txt'), htmlToText(article), 'utf8');

  // 이미지 수집
  const srcs = [];
  const re = /<img[^>]+src="([^"]+)"/gi;
  let m;
  while ((m = re.exec(article))) {
    let s = m[1];
    if (s.startsWith('//')) s = 'https:' + s;
    if (!/^https?:/.test(s)) continue;
    if (!srcs.includes(s)) srcs.push(s);
  }
  const manifest = [];
  for (let i = 0; i < srcs.length; i++) {
    const src = srcs[i];
    try {
      const { buf: ib, type } = await fetchBuf(src);
      const name = `img${String(i).padStart(2, '0')}${imgExt(src, type)}`;
      fs.writeFileSync(path.join(dir, name), ib);
      manifest.push({ index: i, file: name, url: src, bytes: ib.length });
      await sleep(250);
    } catch (e) {
      manifest.push({ index: i, file: null, url: src, error: String(e.message) });
    }
  }
  fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify({ round, url, images: manifest }, null, 2), 'utf8');
  return { round, url, htmlBytes: html.length, textBytes: fs.statSync(path.join(dir, 'page.txt')).size, images: manifest.length, failed: manifest.filter(x => !x.file).length };
}

if (process.argv[1] && process.argv[1].endsWith('scrape.mjs')) {
  const rawRoot = path.resolve('data/raw');
  const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const targets = only.length ? only : Object.keys(ROUNDS);
  const results = [];
  for (const r of targets) {
    if (!ROUNDS[r]) { console.error(`unknown round: ${r}`); process.exitCode = 1; continue; }
    try {
      const res = await scrapeRound(r, ROUNDS[r], rawRoot);
      results.push(res);
      console.log(`[ok] ${r}  html=${res.htmlBytes}B text=${res.textBytes}B img=${res.images} failed=${res.failed}`);
    } catch (e) {
      results.push({ round: r, error: String(e.message) });
      console.error(`[FAIL] ${r}: ${e.message}`);
    }
    await sleep(1200);
  }
  fs.writeFileSync(path.join(rawRoot, 'scrape-report.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('\nreport -> data/raw/scrape-report.json');
}
