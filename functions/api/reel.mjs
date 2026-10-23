// Noa reels: her daily deal photo becomes a short vertical video (720x1280, 30 fps).
// Motion comes from the free Wan 2.2 image-to-video Space on Hugging Face (needs HF_TOKEN);
// if it is down or out of quota, a slow push-in on the photo is used instead.
// ffmpeg, the fonts and the music are too big for the function bundle, so they live in
// storage under data/reel/ and are copied to /tmp on first use.
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'eu-central-1' });
const run = promisify(execFile);
const W = 720, H = 1280, FPS = 30, CLIP = 5, END = 2.5;
export const REEL_LEN = CLIP + END;
const WAN_SPACE = 'zerogpu-aoti/wan2-2-fp8da-aoti-faster';
const DIR = process.env.REEL_DIR || '/tmp/reel';
const ASSETS = 'data/reel/';
const FONTS = ['rubik-800.ttf', 'rubik-500.ttf', 'josefin.ttf'];

async function fetchAsset(key, file, gunzip) {
    if (existsSync(file) && statSync(file).size) return;
    const r = await s3.send(new GetObjectCommand({ Bucket: process.env.STORAGE_BUCKET, Key: ASSETS + key }));
    await pipeline(r.Body, ...(gunzip ? [createGunzip()] : []), createWriteStream(`${file}.part`));
    await import('node:fs/promises').then(fs => fs.rename(`${file}.part`, file));
}

// ffmpeg + fonts + music in /tmp (kept between runs while the function stays warm)
export async function tools() {
    mkdirSync(`${DIR}/fonts`, { recursive: true });
    const ff = process.env.FFMPEG_PATH || `${DIR}/ffmpeg`;
    await Promise.all([
        process.env.FFMPEG_PATH ? null : fetchAsset(`ffmpeg-${process.arch}.gz`, ff, true).then(() => chmodSync(ff, 0o755)),
        fetchAsset('music.m4a', `${DIR}/music.m4a`),
        ...FONTS.map(f => fetchAsset(f, `${DIR}/fonts/${f}`)),
    ]);
    // libass finds fonts through fontconfig, which has no config on Lambda
    writeFileSync(`${DIR}/fonts.conf`, `<?xml version="1.0"?><fontconfig><dir>${DIR}/fonts</dir><cachedir>${DIR}/fc-cache</cachedir></fontconfig>`);
    return ff;
}

// 5 seconds of AI motion from one photo. Returns the mp4 bytes.
export async function motionClip(jpg, prompt) {
    const { Client, handle_file } = await import('@gradio/client');
    const c = await Client.connect(WAN_SPACE, process.env.HF_TOKEN ? { token: process.env.HF_TOKEN } : {});
    const r = await c.predict('/generate_video', {
        input_image: handle_file(new Blob([jpg], { type: 'image/jpeg' })),
        prompt, steps: 6, duration_seconds: CLIP, guidance_scale: 1, guidance_scale_2: 1,
        seed: Math.floor(Math.random() * 1e6), randomize_seed: false,
    });
    const url = r.data?.[0]?.video?.url || r.data?.[0]?.url;
    if (!url) throw new Error('the video Space returned no video');
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`the video didn't download (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
}

const hebrew = (s) => /[֐-׿]/.test(s);
const assText = (s) => {
    const t = String(s).replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim();
    return hebrew(t) ? `‫${t}‬` : t;
};
const ts = (t) => `0:00:${t.toFixed(2).padStart(5, '0')}`;

// Captions: product name in the top band, price + site in the bottom band, then an end card
function captions(t) {
    const top = Math.round((H - W * 5 / 4) / 2); // the 4:5 video sits in the middle
    const ev = (start, end, style, x, y, text, fade = '\\fad(300,0)') =>
        `Dialogue: 1,${ts(start)},${ts(end)},${style},,0,0,0,,{\\an5\\pos(${x},${y})${fade}}${assText(text)}`;
    const lines = [
        ev(0.3, CLIP, 'Name', W / 2, top / 2, t.name),
        t.price && ev(0.8, CLIP, 'Price', W / 2, H - top / 2 - 22, t.price),
        ev(1.2, CLIP, 'Small', W / 2, H - top / 2 + 42, 'alidealer.com'),
        // end card: a dark veil over the last frame
        `Dialogue: 0,${ts(CLIP)},${ts(REEL_LEN + 1)},Veil,,0,0,0,,{\\an7\\pos(0,0)\\fad(350,0)\\p1}m 0 0 l ${W} 0 ${W} ${H} 0 ${H}{\\p0}`,
        ev(CLIP + 0.2, REEL_LEN + 1, 'Site', W / 2, H / 2 - 40, 'alidealer.com'),
        ev(CLIP + 0.5, REEL_LEN + 1, 'Tag', W / 2, H / 2 + 50, t.tagline),
        ev(CLIP + 0.5, REEL_LEN + 1, 'Note', W / 2, H - 90, t.disclosure),
    ];
    const style = (name, font, size, color, outline = 0, alpha = '00') =>
        `Style: ${name},${font},${size},&H${alpha}${color},&H00FFFFFF,&H64000000,&H00000000,0,0,0,0,100,100,0,0,1,${outline},0,5,30,30,0,1`;
    return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\n\n[V4+ Styles]\n` +
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
        [style('Name', 'Rubik ExtraBold', 52, 'FFFFFF', 2), style('Price', 'Rubik ExtraBold', 72, '6CC8FF', 2), // colours are BGR: warm orange
            style('Small', 'Josefin Sans SemiBold', 34, 'FFFFFF', 1), style('Veil', 'Rubik Medium', 20, '0C121B', 0, '38'),
            style('Site', 'Josefin Sans SemiBold', 84, 'FFFFFF'), style('Tag', 'Rubik Medium', 44, 'A8D7FF'), style('Note', 'Rubik Medium', 26, 'DDDDDD')].join('\n') +
        `\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.filter(Boolean).join('\n')}\n`;
}

// One reel. `clip` is the AI clip file, or null to animate the photo instead.
// text = { name, price, tagline, disclosure }. Returns the mp4 bytes.
export async function render(ff, { clip, photo, text, out }) {
    const ass = `${out}.ass`;
    writeFileSync(ass, captions(text));
    const src = clip
        ? `[0:v]fps=${FPS},tpad=stop_mode=clone:stop_duration=${END + 1},setpts=PTS-STARTPTS`
        : `[0:v]scale=${W * 2}:-2,zoompan=z='1+0.08*on/${(REEL_LEN * FPS) | 0}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${W * 5 / 4}:fps=${FPS}`;
    const filter = `${src},split[a][b];` +
        `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.18[bg];` +
        `[b]scale=${W}:${W * 5 / 4}:force_original_aspect_ratio=increase,crop=${W}:${W * 5 / 4}[fg];` +
        `[bg][fg]overlay=0:(H-h)/2,setsar=1,ass=${ass}:fontsdir=${DIR}/fonts,format=yuv420p[v];` +
        `[1:a]atrim=0:${REEL_LEN},asetpts=PTS-STARTPTS,volume=0.6,afade=t=in:d=0.3,afade=t=out:st=${REEL_LEN - 1.2}:d=1.2[au]`;
    const input = clip ? ['-i', clip] : ['-loop', '1', '-framerate', String(FPS), '-t', String(REEL_LEN + 1), '-i', photo];
    await run(ff, ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-stream_loop', '-1', '-i', `${DIR}/music.m4a`,
        '-filter_complex', filter, '-map', '[v]', '-map', '[au]', '-t', String(REEL_LEN), '-r', String(FPS),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-movflags', '+faststart', out],
    { env: { ...process.env, FONTCONFIG_FILE: `${DIR}/fonts.conf` }, maxBuffer: 1 << 24, timeout: 150000 });
    return (await import('node:fs/promises')).readFile(out);
}
