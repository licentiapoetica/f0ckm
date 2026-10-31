import sql from "../src/inc/sql.mjs";
import fs from "fs";
import { exec as _exec } from "child_process";

const exec = cmd => new Promise((resolve, reject) => {
  _exec(cmd, { maxBuffer: 5e3 * 1024 }, (err, stdout, stderr) => {
    if(err)
      return reject(err);
    if(stderr)
      console.error(stderr);
    resolve({ stdout: stdout });
  });
});

const _args = process.argv.slice(2);
const _itemid = +_args[0] || 0;

// Thumb size: 512px for high-quality dynamic thumbnails
const THUMB_SIZE = 512;
const THUMB_SPEC = `${THUMB_SIZE}x${THUMB_SIZE}`;

// Ensure temp and output directories exist
if (!fs.existsSync('./tmp')) fs.mkdirSync('./tmp', { recursive: true });
if (!fs.existsSync('./public/t')) fs.mkdirSync('./public/t', { recursive: true });

let items;
if(_itemid > 0)
  items = await sql`select id, dest, mime, src from "items" where id = ${_itemid}`;
else
  items = await sql`select id, dest, mime, src from "items"`;
let count = 1;
let total = items.length;

for(let item of items) {
  const itemid = item.id;
  const filename = item.dest;
  const mime = item.mime;
  const link = item.src;
  try {
    if(mime.startsWith('video/') || mime == 'image/gif') {
      const seeks = ['20%', '40%', '60%', '80%'];
      for (const seek of seeks) {
        await exec(`ffmpegthumbnailer -i./public/b/${filename} -s${THUMB_SIZE} -t ${seek} -o./tmp/${itemid}.png`);
        try {
          const { stdout } = await exec(`magick "./tmp/${itemid}.png" -colorspace Gray -format "%[fx:mean]" info:`);
          if (parseFloat(stdout.trim()) > 0.05) break; 
        } catch (e) { break; }
      }
    }
    else if(mime.startsWith('image/') && mime != 'image/gif')
      await exec(`magick ./public/b/${filename}[0] ./tmp/${itemid}.png`);
    else if(mime.startsWith('audio/')) {
      if(link.match(/soundcloud/)) {
        let cover = (await exec(`yt-dlp --get-thumbnail "${link}"`)).stdout.trim();
        if(!cover.match(/default_avatar/)) {
          cover = cover.replace(/-(large|original)\./, '-t500x500.');
          try {
            await exec(`wget "${cover}" -O ./tmp/${itemid}.jpg`);
            const size = (await fs.promises.stat(`./tmp/${itemid}.jpg`)).size;
            if(size >= 0) {
              await exec(`magick ./tmp/${itemid}.jpg ./tmp/${itemid}.png`);
              await exec(`magick ./tmp/${itemid}.jpg ./public/ca/${itemid}.webp`);
            }
          } catch(err) {
            //console.log(err);
          }
        }
        else {
          await exec(`ffmpeg -i ./public/b/${filename} -update 1 -map 0:v -map 0:1 -c copy ./tmp/${itemid}.png`);
          await exec(`magick ./tmp/${itemid}.png ./public/ca/${itemid}.webp`);
        }
      }
      else {
        await exec(`ffmpeg -i ./public/b/${filename} -update 1 -map 0:v -map 0:1 -c copy ./tmp/${itemid}.png`);
        await exec(`magick ./tmp/${itemid}.png ./public/ca/${itemid}.webp`);
      }
    }

    await exec(`magick "./tmp/${itemid}.png" -resize "${THUMB_SPEC}^" -gravity center -crop ${THUMB_SPEC}+0+0 +repage ./public/t/${itemid}.webp`);
    await fs.promises.unlink(`./tmp/${itemid}.png`).catch(err => {});
    await fs.promises.unlink(`./tmp/${itemid}.jpg`).catch(err => {});
  } catch(err) {
    console.error(`Failed to generate thumbnail for ${itemid}:`, err.message);
  }
  console.log(`current: ${itemid} (${count} / ${total})`);
  count++;
}

console.log('Thumbnail generation complete.');
process.exit(0);
