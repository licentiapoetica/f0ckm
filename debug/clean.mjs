import cfg from "../src/inc/config.mjs";
import db from "../src/inc/sql.mjs";
import fs from "node:fs";
import readline from 'node:readline/promises';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// npm run clean -- --dry-run
const dry = !!process.argv.filter(a => a == '--dry-run').length;
console.log(`dry run? ${dry}`);

const dirs = {
  b:   "./public/b",
  t:   "./public/t",
  tmp: "./tmp"
};
const files = {
  b:   (await fs.promises.readdir(dirs.b))  .filter(f => f !== '.empty'),
  t:   (await fs.promises.readdir(dirs.t))  .filter(f => f !== '.empty'),
  tmp: (await fs.promises.readdir(dirs.tmp)).filter(f => f !== '.empty')
};
const extensions = [ ...Object.values(cfg.mimes), 'mov' ];
const count = {
  missing: { b: [], t: [] },
  invalid: { b: [], t: [] },
  spare:   { b: [], t: [] },
  tmp:     files.tmp
};
const rows = await db`select id, dest from items where active = true`;
const f0cks = {
  b: rows.flatMap(f => f.dest),
  t: rows.flatMap(f => `${f.id}.webp`)
};

// missing
for(const row of rows) {
  if(!fs.existsSync(`${dirs.b}/${row.dest}`))
    count.missing.b.push(row.id);
  if(!fs.existsSync(`${dirs.t}/${row.id}.webp`))
    count.missing.t.push(row.id);
}

// invalid
count.invalid.b = files.b.filter(f => !extensions.includes(f.toLowerCase().split('.')[1]));
count.invalid.t = files.t.filter(f => !f.endsWith('.webp'));

// spare
for(const file of files.b)
  if(!f0cks.b.includes(file))
    count.spare.b.push(`${dirs.b}/${file}`);

for(const file of files.t)
  if(!f0cks.t.includes(file))
    count.spare.t.push(`${dirs.t}/${file}`);

// show confusing summary
console.log(count);

// delete spare if --dry-run
if(!dry) {
  let q;
  if(count.spare.b.length > 0) {
    q = (await rl.question(`delete ${count.spare.b.length} unnecessary files in ${dirs.b}? [y/N] `)) == 'y';
    if(q) {
      await Promise.all(count.spare.b.map(f => fs.promises.unlink(f)));
      console.log(`deleted ${count.spare.b.length} files`);
    }
    else
      console.log('abort...');
  }

  if(count.spare.t.length > 0) {
    q = (await rl.question(`delete ${count.spare.t.length} unnecessary files in ${dirs.t}? [y/N] `)) == 'y';
    if(q) {
      await Promise.all(count.spare.t.map(f => fs.promises.unlink(f)));
      console.log(`deleted ${count.spare.t.length} files`);
    }
    else
      console.log('abort...');
  }

  if(files.tmp.length > 0) {
    q = (await rl.question(`delete ${files.tmp.length} files in ${dirs.tmp}? [y/N] `)) == 'y';
    if(q) {
      await Promise.all(files.tmp.map(f => fs.promises.unlink(`${dirs.tmp}/${f}`)));
      console.log(`deleted ${files.tmp.length} files`);
    }
    else
      console.log('abort...');
  }
}

// close connection
await db.end();
process.exit();
