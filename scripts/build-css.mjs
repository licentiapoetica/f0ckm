import fs from 'fs';
import path from 'path';

const cssDir = path.join(process.cwd(), 'public/s/css');
const files = ['f0ckm.css', 'v0ck.css'];
const outputFile = path.join(cssDir, 'bundle.css');

let combined = '';

files.forEach(file => {
  const content = fs.readFileSync(path.join(cssDir, file), 'utf8');
  combined += content + '\n';
});

// Simple minification
const minified = combined
  .replace(/\/\*[\s\S]*?\*\//g, '') // Remove comments
  .replace(/\s*([\{\}:;,])\s*/g, '$1') // Remove whitespace around selectors/properties
  .replace(/\s+/g, ' ') // Collapse multiple whitespaces
  .trim();

fs.writeFileSync(outputFile, minified);
console.log(`Bundle created: ${outputFile} (${combined.length} -> ${minified.length} bytes)`);
