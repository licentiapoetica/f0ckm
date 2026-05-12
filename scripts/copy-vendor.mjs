import fs from 'fs';
import path from 'path';

// Copies vendor browser bundles from node_modules into public/s/js/
const vendors = [
  { src: 'jszip/dist/jszip.min.js', dest: 'public/s/js/jszip.min.js' },
];

for (const { src, dest } of vendors) {
  const srcPath = path.join(process.cwd(), 'node_modules', src);
  const destPath = path.join(process.cwd(), dest);
  fs.copyFileSync(srcPath, destPath);
  const size = fs.statSync(destPath).size;
  console.log(`Copied: ${src} -> ${dest} (${size} bytes)`);
}
