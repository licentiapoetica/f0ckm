#!/usr/bin/env node
// One-time conversion of an old config.json into config.yaml (f0ckm now reads config.yaml only).
//
//   npm run config:migrate                      # ./config.json -> ./config.yaml
//   node scripts/config-migrate.mjs <in> <out>  # explicit paths, e.g. from inside the Docker image
//
// Refuses to overwrite an existing config.yaml. Delete config.json afterwards.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [inArg, outArg] = process.argv.slice(2);
const input = path.resolve(inArg || path.join(root, 'config.json'));
const output = path.resolve(outArg || path.join(root, 'config.yaml'));

if (!fs.existsSync(input)) {
  console.error(`No ${input} to convert.`);
  process.exit(1);
}
if (fs.existsSync(output)) {
  console.error(`${output} already exists, not overwriting it. Remove or rename it first.`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(fs.readFileSync(input, 'utf8'));
} catch (err) {
  console.error(`Cannot parse ${input}: ${err.message}`);
  process.exit(1);
}

fs.writeFileSync(output, String(new YAML.Document(parsed)), 'utf8');
console.log(`Wrote ${output} from ${input}.`);
console.log('Compare it with config_example.yaml for new options and comments, then delete the old config.json.');
