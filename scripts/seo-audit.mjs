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

function meta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const tag = tags.find((x) => x.includes('name="' + key + '"') || x.includes('property="' + key + '"'));
  return tag?.match(/\bcontent="([^"]*)"/i)?.[1] || null;
}

function countMeta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  return tags.filter((x) => x.includes('name="' + key + '"') || x.includes('property="' + key + '"')).length;
}

function normalizeRoute(pathname) {
  if (!pathname || pathname === '/') return '/';
  if (path.extname(pathname)) return null;
  return pathname.endsWith('/') ? pathname : pathname + '/';
}

function distTarget(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  const result = path.resolve(DIST, '.' + decoded);
  if (result !== DIST && !result.startsWith(DIST + path.sep)) return null;
  return result;
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
const descriptions = new Map();
const canonicals = new Map();
const canonicalUrls = [];
const pageRoutes = new Set();
const linkedRoutes = new Set();
let previews = 0;

for (const file of pages) {
  const relative = path.relative(DIST, file).split(path.sep).join('/');
  const html = await readFile(file, 'utf8');
  const route = routeOf(file);
  const expected = ORIGIN + route;
  pageRoutes.add(route);

  const titleMatches = [...html.matchAll(/<title>([\s\S]*?)<\/title>/gi)];
  const title = titleMatches[0]?.[1]?.replace(/\s+/g, ' ').trim() || '';
  const desc = meta(html, 'description');
  const canonical = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1] || '';

  if (titleMatches.length !== 1 || !title) issues.push(relative + ': expected exactly one non-empty title.');
  if (title.length > 75) issues.push(relative + ': title is longer than 75 characters.');
  if (/[{}]|undefined|null/i.test(title)) issues.push(relative + ': title contains a likely unresolved placeholder.');
  if (title) {
    if (titles.has(title)) issues.push(relative + ': duplicate title with ' + titles.get(title) + '.');
    else titles.set(title, relative);
  }

  if (!desc || desc.length < 60 || desc.length > 200) issues.push(relative + ': meta description missing or outside 60–200 characters.');
  if (desc) {
    if (descriptions.has(desc)) issues.push(relative + ': duplicate meta description with ' + descriptions.get(desc) + '.');
    else descriptions.set(desc, relative);
  }
  for (const name of ['description', 'robots']) {
    if (countMeta(html, name) !== 1) issues.push(relative + ': expected exactly one meta ' + name + ' tag.');
  }

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
  if (!/<meta\s+name="viewport"/i.test(html)) issues.push(relative + ': viewport meta tag is missing.');
  if (!/<link\s+rel="icon"\s+type="image\/png"\s+href="\/favicon\.png"/i.test(html)) issues.push(relative + ': supported PNG favicon reference is missing.');
  if (/href="\/favicon\.(?:bmp|svg)"/i.test(html)) issues.push(relative + ': use the single supported PNG favicon instead of BMP/SVG favicon references.');
  const h1 = (html.match(/<h1\b/gi) || []).length;
  if (h1 !== 1) issues.push(relative + ': expected one H1, found ' + h1 + '.');
  if (!/<h2\b/i.test(html)) issues.push(relative + ': no H2 headings found; check content structure.');

  const ogImage = meta(html, 'og:image');
  const twImage = meta(html, 'twitter:image');
  const card = meta(html, 'twitter:card');
  const ogTitle = meta(html, 'og:title');
  const ogDescription = meta(html, 'og:description');
  const ogUrl = meta(html, 'og:url');
  const twTitle = meta(html, 'twitter:title');
  const twDescription = meta(html, 'twitter:description');

  if (!ogImage || ogImage !== ORIGIN + '/og-cover.png' || twImage !== ogImage || card !== 'summary_large_image') {
    issues.push(relative + ': social preview image/card metadata incomplete.');
  } else if (!await exists(path.join(DIST, 'og-cover.png'))) {
    issues.push('Social preview file dist/og-cover.png missing.');
  } else previews++;

  if (!ogTitle || ogTitle !== title || !ogDescription || ogDescription !== desc || ogUrl !== canonical) {
    issues.push(relative + ': Open Graph title/description/URL do not match the page metadata and canonical URL.');
  }
  if (twTitle !== title || twDescription !== desc) issues.push(relative + ': Twitter title/description do not match page metadata.');
  if (!meta(html, 'og:site_name') || !meta(html, 'og:locale')) issues.push(relative + ': Open Graph site name or locale missing.');
  if (!meta(html, 'og:image:alt')) issues.push(relative + ': Open Graph image alt text is missing.');
  if (!meta(html, 'twitter:image:alt')) issues.push(relative + ': Twitter image alt text is missing.');

  const jsonLdScripts = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  const schemaObjects = [];
  if (!jsonLdScripts.length) issues.push(relative + ': no JSON-LD structured data found.');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script[1]);
      if (!data['@context'] || (!data['@type'] && !data['@graph'])) issues.push(relative + ': JSON-LD missing context/type.');
      schemaObjects.push(data);
    } catch { issues.push(relative + ': JSON-LD is not valid JSON.'); }
  }

  const schemaTypes = new Set();
  const collectSchema = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value['@type'] === 'string') schemaTypes.add(value['@type']);
    if (Array.isArray(value)) value.forEach(collectSchema);
    else Object.values(value).forEach(collectSchema);
  };
  schemaObjects.forEach(collectSchema);
  if (route !== '/' && !schemaTypes.has('BreadcrumbList')) issues.push(relative + ': BreadcrumbList structured data is missing.');
  if (route === '/') {
    if (!schemaTypes.has('WebSite')) issues.push('Homepage: WebSite structured data is missing.');
    if (!schemaTypes.has('Organization')) issues.push('Homepage: Organization structured data is missing.');
    const org = schemaObjects.flatMap((obj) => Array.isArray(obj['@graph']) ? obj['@graph'] : [obj]).find((obj) => obj['@type'] === 'Organization');
    const logo = typeof org?.logo === 'string' ? org.logo : org?.logo?.url;
    if (!logo) issues.push('Homepage: Organization logo is missing from structured data.');
    else {
      try {
        const parsedLogo = new URL(logo, ORIGIN);
        if (parsedLogo.origin !== ORIGIN || !await exists(distTarget(parsedLogo.pathname))) {
          issues.push('Homepage: Organization logo URL does not point to an existing local asset.');
        }
      } catch { issues.push('Homepage: Organization logo URL is invalid.'); }
    }
  }

  for (const image of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt\s*=/.test(image[0])) issues.push(relative + ': image is missing an alt attribute: ' + image[0].slice(0, 120));
  }

  for (const anchor of html.matchAll(/<a\\b[^>]*>/gi)) {
    const href = anchor[0].match(/\\bhref="([^"]+)"/i)?.[1] || '';
    const hasReferralParameter = /^https?:\\/\\//i.test(href) && /[?&](?:ref|referral|referralcode|r)=/i.test(href);
    if (hasReferralParameter && !/\\brel="[^"]*\\bsponsored\\b/i.test(anchor[0])) {
      issues.push(relative + ': commercial referral link must include rel="sponsored": ' + href);
    }
  }


  const refs = [
    ...[...html.matchAll(/\bhref="([^"]+)"/gi)].map((m) => ({ value: m[1], isAnchor: m.index > -1 && html.slice(Math.max(0, m.index - 3), m.index).includes('<a') })),
    ...[...html.matchAll(/\bsrc="([^"]+)"/gi)].map((m) => ({ value: m[1], isAnchor: false }))
  ];
  for (const refItem of refs) {
    const ref = refItem.value;
    if (!ref || ref.startsWith('#') || /^(?:https?:)?\/\//i.test(ref) || /^(?:mailto:|tel:|data:|javascript:)/i.test(ref)) continue;
    let url;
    try { url = new URL(ref, ORIGIN); } catch { continue; }
    if (url.origin !== ORIGIN) continue;
    const target = distTarget(url.pathname);
    if (!target) { issues.push(relative + ': unsafe local reference ' + ref); continue; }
    if (!await exists(target) && !(await exists(path.join(target, 'index.html'))) && !(await exists(target + '/index.html'))) {
      issues.push(relative + ': broken local reference ' + url.pathname);
      continue;
    }
    if (refItem.isAnchor) {
      const normalized = normalizeRoute(url.pathname);
      if (normalized) linkedRoutes.add(normalized);
    }
  }
}

const robotsFile = path.join(DIST, 'robots.txt');
if (!await exists(robotsFile)) issues.push('robots.txt missing from build output.');
else {
  const robots = await readFile(robotsFile, 'utf8');
  if (!robots.includes(ORIGIN + '/sitemap-index.xml')) issues.push('robots.txt does not point to the sitemap index.');
  if (/^\s*Disallow:\s*\/\s*$/im.test(robots)) issues.push('robots.txt blocks the entire site.');
}

const notFoundFile = path.join(DIST, '404.html');
if (!await exists(notFoundFile)) issues.push('Custom 404.html is missing from the build output.');
else {
  const notFound = await readFile(notFoundFile, 'utf8');
  if (!/name="robots"\s+content="noindex,follow"/i.test(notFound)) issues.push('404 page should use noindex,follow.');
  if ((notFound.match(/<h1\b/gi) || []).length !== 1) issues.push('404 page should have exactly one H1.');
  if (!/href="\/"|href="https:\/\/refiro\.ir\//i.test(notFound) || !/href="\/codes\//i.test(notFound)) {
    issues.push('404 page should link to the homepage and code directory.');
  }
}

const sitemap = new Set(await sitemapUrls());
const canonicalSet = new Set(canonicalUrls);
for (const url of canonicalUrls) if (!sitemap.has(url)) issues.push('Canonical is missing from sitemap: ' + url);
for (const url of sitemap) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN) issues.push('Non-canonical host in sitemap: ' + url);
    if (!canonicalSet.has(url)) issues.push('Sitemap contains a URL without a matching indexed page canonical: ' + url);
    if (parsed.search || parsed.hash) issues.push('Sitemap URL should not contain query string or fragment: ' + url);
  } catch { issues.push('Invalid URL in sitemap: ' + url); }
}

for (const route of pageRoutes) {
  if (!linkedRoutes.has(route)) issues.push('Potential orphan page: no internal link points to ' + route);
}

if (issues.length) {
  console.error('SEO audit failed with ' + issues.length + ' issue(s):');
  for (const issue of issues) console.error(' - ' + issue);
  process.exit(1);
}
console.log('SEO audit passed: ' + pages.length + ' indexable HTML pages; unique titles/descriptions/canonicals; Open Graph/Twitter metadata; JSON-LD; image alt attributes; internal links; robots.txt and sitemap checked.');
