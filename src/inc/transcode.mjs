// Re-encode video that browsers can't play (MPEG-1/2 program streams, .mpg/.mpeg) to web MP4.
// A plain remux (-codec copy) is not enough for these: MPEG-1/2 video has to become H.264.

// file --mime-type results that get converted
export const TRANSCODE_TO_MP4 = new Set(['video/mpeg']);

/**
 * Re-encode src to H.264/AAC MP4 at dest.
 * - yadif only touches frames flagged as interlaced (DVD MPEG-2), progressive video is left alone
 * - even dimensions + yuv420p for broad decoder support, faststart so playback starts before the full download
 * @param {{ spawn: Function }} queue
 * @param {string} src
 * @param {string} dest
 */
export async function transcodeToMp4(queue, src, dest) {
  await queue.spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', 'yadif=deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    dest
  ]);
}
