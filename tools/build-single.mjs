// Bundles the game into ONE self-contained HTML file (no import map, no local
// modules) — used to publish it as a Claude Artifact or host it anywhere.
// Run: node tools/build-single.mjs [out.html]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
// Dependency order
const modules = ['config', 'rng', 'pacenotes', 'stage', 'physics', 'input', 'scene', 'effects', 'audio', 'ui', 'main'];

let js = `import * as THREE from '${THREE_URL}';\n`;
for (const m of modules) {
  let src = fs.readFileSync(path.join(root, 'js', m + '.js'), 'utf8');
  src = src.replace(/^import .*;\s*$/gm, '');
  const exported = [];
  src = src.replace(/^export (async function|function|class|const|let) (\w+)/gm, (_, kind, name) => { exported.push(name); return `${kind} ${name}`; });
  // Each module gets its own scope so private helpers (clamp, lerp, ...) can't collide.
  js += `\n// ---- ${m}.js ----\nconst { ${exported.join(', ')} } = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();\n`;
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'style.css'), 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script type="module" src="js\/main.js"><\/script>/, '');
const out = `<title>String Rally</title>\n<style>\n${css}\n</style>\n${body}\n<script type="module">\n${js}\n</script>\n`;
const dest = process.argv[2] || path.join(root, 'dist', 'string-rally.html');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log(`wrote ${dest} (${(out.length / 1024).toFixed(0)} KB)`);
