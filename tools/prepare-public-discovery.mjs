import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SITE = 'https://roadmap2u.com/';
const privateRobotsTag = '<meta name="robots" content="noindex, nofollow">';
const privateRobotsFile = 'User-agent: *\nDisallow:\n';

export function publicDiscovery(index, stage) {
  if (!['local', 'dev', 'test', 'prod'].includes(stage)) throw new Error('Unknown discovery stage');
  if (index.split(privateRobotsTag).length !== 2) throw new Error('Expected a single private robots tag');
  if (stage !== 'prod') return { index, robots: privateRobotsFile, sitemap: null };

  const title = index.match(/<title>([^<]+)<\/title>/)?.[1]?.replaceAll('"', '&quot;');
  const description = index.match(/<meta name="description" content="([^"]+)"\s*\/?\s*>/)?.[1];
  if (!title || !description) throw new Error('Public title and description are required');

  const metadata = [
    `<link rel="canonical" href="${SITE}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="RoadMap2U">',
    '<meta property="og:locale" content="es_MX">',
    '<meta property="og:locale:alternate" content="en_US">',
    `<meta property="og:url" content="${SITE}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:image" content="${SITE}icons/icon-512x512.png">`,
    '<meta property="og:image:width" content="512">',
    '<meta property="og:image:height" content="512">',
    '<meta property="og:image:alt" content="RoadMap2U">',
    '<meta name="twitter:card" content="summary">',
  ].join('\n  ');

  return {
    index: index.replace(privateRobotsTag, () => metadata),
    robots: `User-agent: *\nDisallow: /account\nSitemap: ${SITE}sitemap.xml\n`,
    sitemap: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE}</loc></url>\n</urlset>\n`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const stage = process.argv[2];
  if (stage !== 'prod' || process.argv.length !== 3) throw new Error('Usage: prepare-public-discovery.mjs prod');
  const indexPath = resolve(import.meta.dirname, '../src/index.html');
  const publicPath = resolve(import.meta.dirname, '../public');
  if (!existsSync(resolve(publicPath, 'icons/icon-512x512.png'))) throw new Error('Share image is missing');
  const output = publicDiscovery(readFileSync(indexPath, 'utf8'), stage);
  writeFileSync(indexPath, output.index);
  writeFileSync(resolve(publicPath, 'robots.txt'), output.robots);
  writeFileSync(resolve(publicPath, 'sitemap.xml'), output.sitemap);
}
