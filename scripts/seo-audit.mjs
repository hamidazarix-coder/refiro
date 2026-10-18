import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const DIST = path.resolve('dist');
const ORIGIN = 'https://refiro.ir';
const issues = [];

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function walk(dir) {
  const items = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

function routeOf(file) {
  const relative = path.relative(DIST, file).split(path.sep).join('/');
  if (relative === 'index.html') return '/';
  if (relative.endsWith('/index.html')) return '/' + relative.slice(0, -'index.html'.length);
  return '/' + relative.replace(/\.html$/, '');
}

function distTarget(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const result = path.resolve(DIST, '.' + decoded);
  if (result !== DIST && !result.startsWith(DIST + path.sep)) return null;
  return result;
}

function meta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const tag = tags.find((x) => x.includes('name="' + key + '"') || x.includes('property="' + key + '"'));
  return tag?.match(/\bcontent="([^"]*)"/i)?.[1] || null;
}

async function sitemapUrls() {
  const indexPath = path.join(DIST, 'sitemap-index.xml');
  if (!await exists(indexPath)) {
    issues.push('Missing sitemap-index.xml in the build output.');
    return [];
  }
  const indexXml = await readFile(indexPath, 'utf8');
  const maps = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const result = [];
  for (const mapUrl of maps) {
    let parsed;
    try { parsed = new URL(mapUrl); } catch { issues.push('Invalid sitemap URL: ' + mapUrl); continue; }
    if (parsed.origin !== ORIGIN) { issues.push('Sitemap index uses a non-canonical host: ' + mapUrl); continue; }
    const file = distTarget(parsed.pathname);
    if (!file || !await exists(file)) { issues.push('Sitemap file missing from output: ' + parsed.pathname); continue; }
    const xml = await readFile(file, 'utf8');
    result.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()));
  }
  return result;
}

if (!await exists(DIST)) {
  console.error('SEO audit: dist/ not found. Run npm run build first.');
  process.exit(1);
}

const all = await walk(DIST);
const pages = all.filter((file) => file.endsWith('.html') && path.basename(file) !== '404.html');
if (!pages.length) issues.push('No HTML pages found.');
const titles = new Map();
const canonicals = new Map();
const canonicalUrls = [];
let previews = 0;

for (const file of pages) {
  const relative = path.relative(DIST, file).split(path.sep).join('/');
  const html = await readFile(file, 'utf8');
  const route = routeOf(file);
  const titleMatches = [...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)];
  const title = titleMatches[0]?.[1]?.replace(/\s+/g, ' ').trim() || '';
  const desc = meta(html, 'description');
  const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1] || '';
  const expected = ORIGIN + route;

  if (titleMatches.length !== 1 || !title) issues.push(relative + ': expected exactly one non-empty title.');
  if (title.length > 75) issues.push(relative + ': title is longer than 75 characters.');
  if (title) {
    if (titles.has(title)) issues.push(relative + ': duplicate title with ' + titles.get(title) + '.');
    else titles.set(title, relative);
  }

  if (!desc || desc.length < 60 || desc.length > 200) issues.push(relative + ': meta description missing or outside 60–200 characters.');
  if (!canonical) issues.push(relative + ': canonical URL is missing.');
  else {
    try {
      const parsed = new URL(canonical);
      if (parsed.origin !== ORIGIN || canonical !== expected) issues.push(relative + ': canonical mismatch; expected ' + expected + '.');
      if (canonicals.has(canonical)) issues.push(relative + ': duplicate canonical with ' + canonicals.get(canonical) + '.');
      else canonicals.set(canonical, relative);
      canonicalUrls.push(canonical);
    } catch { issues.push(relative + ': invalid canonical URL.'); }
  }

  const robots = meta(html, 'robots');
  if (!robots || /noindex/i.test(robots)) issues.push(relative + ': robots metadata missing or noindex is set.');
  if (!/<html\b[^>]*\blang="fa"/i.test(html) || !/<html\b[^>]*\bdir="rtl"/i.test(html)) issues.push(relative + ': expected lang="fa" and dir="rtl".');
  const h1 = (html.match(/<h1\b/gi) || []).length;
  if (h1 !== 1) issues.push(relative + ': expected one H1, found ' + h1 + '.');

  const ogImage = meta(html, 'og:image');
  const twImage = meta(html, 'twitter:image');
  const card = meta(html, 'twitter:card');
  if (!ogImage || ogImage !== ORIGIN + '/og-cover.png' || twImage !== ogImage || card !== 'summary_large_image') {
    issues.push(relative + ': social preview image/card metadata incomplete.');
  } else if (!await exists(path.join(DIST, 'og-cover.png'))) {
    issues.push('Social preview file dist/og-cover.png missing.');
  } else previews++;

  for (const script of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(script[1]);
      if (!data['@context'] || (!data['@type'] && !data['@graph'])) issues.push(relative + ': JSON-LD missing context/type.');
    } catch { issues.push(relative + ': JSON-LD is not valid JSON.'); }
  }

  const refs = [
    ...[...html.matchAll(/\bhref="([^"]+)"/gi)].map((m) => m[1]),
    ...[...html.matchAll(/\bsrc="([^"]+)"/gi)].map((m) => m[1])
  ];
  for (const ref of refs) {
    if (!ref || ref.startsWith('#') || /^(?:https?:)?\/\//i.test(ref) || /^(?:mailto:|tel:|data:|javascript:)/i.test(ref)) continue;
    let url;
    try { url = new URL(ref, ORIGIN); } catch { continue; }
    if (url.origin !== ORIGIN) continue;
    const target = distTarget(url.pathname);
    if (!target) { issues.push(relative + ': unsafe local reference ' + ref); continue; }
    if (await exists(target)) continue;
    if (!path.extname(url.pathname) && await exists(path.join(target, 'index.html'))) continue;
    if (!path.extname(url.pathname) && await exists(target + '/index.html')) continue;
    issues.push(relative + ': broken local reference ' + url.pathname);
  }
}

const robotsFile = path.join(DIST, 'robots.txt');
if (!await exists(robotsFile)) issues.push('robots.txt missing from build output.');
else {
  const robots = await readFile(robotsFile, 'utf8');
  if (!robots.includes(ORIGIN + '/sitemap-index.xml')) issues.push('robots.txt does not point to the sitemap index.');
  if (/^\s*Disallow:\s*\/\s*$/im.test(robots)) issues.push('robots.txt blocks the entire site.');
}

const sitemap = new Set(await sitemapUrls());
for (const url of canonicalUrls) if (!sitemap.has(url)) issues.push('Canonical is missing from sitemap: ' + url);
for (const url of sitemap) {
  try { if (new URL(url).origin !== ORIGIN) issues.push('Non-canonical host in sitemap: ' + url); }
  catch { issues.push('Invalid URL in sitemap: ' + url); }
}

if (issues.length) {
  console.error('SEO audit failed with ' + issues.length + ' issue(s):');
  for (const issue of issues) console.error(' - ' + issue);
  process.exit(1);
}
console.log('SEO audit passed: ' + pages.length + ' HTML pages, unique titles/canonicals, metadata, JSON-LD, local references, sitemap and ' + previews + ' social previews checked.');
