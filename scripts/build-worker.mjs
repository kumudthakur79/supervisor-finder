import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const assets = ['index.html','styles.css','app.js'];
const entries = assets.map(name => [`/${name}`, fs.readFileSync(path.join(root,name),'utf8')]);
const staticSource = `
const STATIC_ASSETS = new Map(${JSON.stringify(entries)});
function serveStatic(request) {
  const url = new URL(request.url);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const body = STATIC_ASSETS.get(pathname);
  if (body === undefined) return new Response('Not found', { status: 404 });
  const type = pathname.endsWith('.html') ? 'text/html' : pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
  return new Response(body, {
    headers: {
      'Content-Type': type + '; charset=utf-8',
      'Cache-Control': pathname.endsWith('.html') ? 'no-store' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self' https://chatgpt.com https://*.chatgpt.com https://chat.openai.com https://kumudthakur.com.np",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }
  });
}
`;
const worker = fs.readFileSync(path.join(root,'worker.js'),'utf8');
const marker = 'return env.ASSETS.fetch(request);';
if (!worker.includes(marker)) throw new Error('Expected asset fallback was not found');
const output = staticSource + worker.replace(marker, 'return serveStatic(request);');
const outputDir = path.join(root,'dist');
fs.rmSync(outputDir, { recursive:true, force:true });
fs.mkdirSync(outputDir, { recursive:true });
fs.writeFileSync(path.join(outputDir,'index.js'), output);
console.log('Built Worker with HTML, CSS, JS, and API routes.');
