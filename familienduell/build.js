// Build: encrypt src/ into site/ (node build.js <password>)
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const pw = process.argv[2]; if (!pw) { console.error('usage: node build.js <password>'); process.exit(1); }
const SRC = path.join(__dirname, 'src'), OUT = path.join(__dirname, 'site');
const rd = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const pages = {}, js = {};
for (const name of ['index', 'host', 'buzzer', 'board']) {
  const html = rd(name + '.html');
  let body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];
  const ext = [], scripts = [];
  body = body.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, inner) => {
    const src = (attrs.match(/src="([^"]+)"/) || [])[1];
    if (src && /^https?:/.test(src)) ext.push(src);
    else if (src) { js[src] = rd(src); scripts.push(src); }
    else { const k = name + '.inline.js'; js[k] = inner; scripts.push(k); }
    return '';
  });
  pages[name] = { body: body.trim(), ext, scripts };
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || 'Familien-Duell';
  const viewport = (html.match(/<meta name="viewport"[^>]*>/) || [''])[0];
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name + '.html'),
`<!doctype html>
<html lang="de" data-page="${name}">
<head>
<meta charset="utf-8">
${viewport}
<meta name="robots" content="noindex,nofollow">
<title>${title.replace(/ –.*/, '')}</title>
<style>html,body{margin:0;background:#06102b;color:#fff;min-height:100%}</style>
</head>
<body>
<script src="gate.js"></script>
</body>
</html>
`);
}
const payload = JSON.stringify({ pages, js, css: rd('style.css'), questions: JSON.parse(rd('questions.json')) });
const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), iter = 300000;
const key = crypto.pbkdf2Sync(pw, salt, iter, 32, 'sha256');
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const data = Buffer.concat([c.update(payload, 'utf8'), c.final(), c.getAuthTag()]);
fs.writeFileSync(path.join(OUT, 'app.enc'), JSON.stringify({ v: 1, iter, salt: salt.toString('base64'), iv: iv.toString('base64'), data: data.toString('base64') }));
fs.copyFileSync(path.join(__dirname, 'gate.js'), path.join(OUT, 'gate.js'));
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log('built site/ :', fs.readdirSync(OUT).join(', '));
