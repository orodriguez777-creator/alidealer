// Builds the Alidealer ad (1080x1920, 30fps) in English and Hebrew.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const FF = '/tmp/vid/node_modules/ffmpeg-static/ffmpeg';
const W = 1080, H = 1920, FPS = 30, XF = 0.5;

const TXT = {
  en: {
    a: ['Thousands of products on AliExpress...', 'which ones are actually good?'],
    b: ['Then I found', 'Alidealer!'],
    c: ['Only the top-selling', 'AliExpress deals, handpicked'],
    d: ['Great finds,', 'straight to your door'],
    e: ['Find your next deal'],
  },
  he: {
    a: ['אינסוף מוצרים ב-AliExpress...', 'איך יודעים מה באמת שווה?'],
    b: ['ואז גיליתי את', 'Alidealer!'],
    c: ['רק המוצרים הנמכרים ביותר', 'ב-AliExpress, בבחירה קפדנית'],
    d: ['מציאות שוות,', 'ישר עד הבית'],
    e: ['המציאה הבאה שלך מחכה'],
  },
};

const esc = s => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/,/g, '\\,');

// Caption lines as ASS subtitle events (libass handles Hebrew RTL), fading in at `start`.
let assN = 0;
function caption(lines, { y, size = 66, start = 0.3, font = 'Rubik ExtraBold', color = 'FFFFFF', box = 0.55 }) {
  const a = Math.round((1 - box) * 255).toString(16).padStart(2, '0').toUpperCase();
  const bgr = color.match(/../g).reverse().join('');
  const ts = t => `0:00:${t.toFixed(2).padStart(5, '0')}`;
  const ev = lines.map((l, i) => `Dialogue: 0,${ts(start + i * 0.25)},0:00:30.00,C,,0,0,0,,{\\an8\\pos(540,${y + i * Math.round(size * 1.55)})\\fad(350,0)}${/[\u0590-\u05FF]/.test(l) ? '\u202B' + l + '\u202C' : l}`);
  const f = `/tmp/vid/cap${assN++}.ass`;
  writeFileSync(f, `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\n\n[V4+ Styles]\n` +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: C,${font},${size},&H00${bgr},&H00FFFFFF,&H${a}000000,&H${a}000000,0,0,0,0,100,100,0,0,3,18,0,8,40,40,0,1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev.join('\n')}\n`);
  return `ass=${f}:fontsdir=/tmp/vid`;
}

// Still image with a slow Ken Burns zoom, cropped to 9:16.
function still(img, dur, z0, z1, overlays) {
  const z = `(${z0}+(${z1}-${z0})*t/${dur})`;
  return {
    inputs: ['-loop', '1', '-t', String(dur), '-i', img],
    filter: `[0:v]scale=2160:-2,scale=w='trunc(1280*${z}/2)*2':h=-2:eval=frame:flags=lanczos,crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2,setsar=1,fps=${FPS},${overlays}[v]`,
    dur,
  };
}

// Phone mockup scrolling the real homepage.
function phone(tall, dur, lines) {
  const sw = 780, sh = 1380, x = (W - sw) / 2, y = 380;
  return {
    inputs: ['-f', 'lavfi', '-t', String(dur), '-i', `color=c=0xf76b1c:s=${W}x${H}:r=${FPS}`, '-loop', '1', '-t', String(dur), '-i', tall],
    filter:
      `[0:v]drawbox=x=${x - 26}:y=${y - 26}:w=${sw + 52}:h=${sh + 52}:color=0x1b120c:t=fill,` +
      `drawbox=x=${W / 2 - 70}:y=${y - 16}:w=140:h=8:color=0x3a2a20:t=fill[bg];` +
      `[1:v]fps=${FPS},crop=${sw}:${sh}:0:'min(ih-${sh},max(0,(t-0.6)*(ih-${sh})/${dur - 1.4}))'[scr];` +
      `[bg][scr]overlay=${x}:${y},${caption(lines, { y: 110, size: 68, box: 0 })},setsar=1[v]`,
    dur,
  };
}

function render(scene, out) {
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...scene.inputs, '-filter_complex', scene.filter,
    '-map', '[v]', '-t', String(scene.dur), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', out]);
}

for (const L of ['en', 'he']) {
  const T = TXT[L];
  const scenes = [
    still('/tmp/vid/s1.png', 4.5, 1.0, 1.08, caption(T.a, { y: 150, size: 62 })),
    still('/tmp/vid/s2.png', 3.5, 1.12, 1.0, caption(T.b, { y: 1480, size: 84 })),
    phone(`/tmp/vid/tall_${L}.png`, 5.5, T.c),
    still('/tmp/vid/s3.png', 3.8, 1.0, 1.07, caption(T.d, { y: 1540, size: 70 })),
    still('/tmp/vid/s4.png', 5.5, 1.06, 1.0,
      `drawbox=x=0:y=1440:w=${W}:h=480:color=0x1b120c@0.55:t=fill,` +
      caption(['alidealer.com'], { y: 1500, size: 120, start: 0.4, font: 'Josefin Sans', box: 0 }) + ',' +
      caption(T.e, { y: 1700, size: 58, start: 0.9, font: 'Rubik Medium', color: 'FFD7A8', box: 0 })),
  ];
  const parts = scenes.map((s, i) => { const f = `/tmp/vid/${L}_${i}.mp4`; render(s, f); return f; });

  // Crossfade the scenes together.
  let filt = '', prev = '[0:v]', off = 0;
  for (let i = 1; i < parts.length; i++) {
    off += scenes[i - 1].dur - XF;
    const out = i === parts.length - 1 ? '[v]' : `[x${i}]`;
    filt += `${prev}[${i}:v]xfade=transition=${i === 2 ? 'slideleft' : 'fade'}:duration=${XF}:offset=${off.toFixed(2)}${out};`;
    prev = out;
  }
  const total = scenes.reduce((a, s) => a + s.dur, 0) - XF * (scenes.length - 1);
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...parts.flatMap(p => ['-i', p]),
    '-f', 'lavfi', '-t', String(total), '-i', 'anullsrc=r=44100:cl=stereo',
    '-filter_complex', filt.slice(0, -1), '-map', '[v]', '-map', `${parts.length}:a`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    `/tmp/vid/alidealer-ad-${L}.mp4`]);
  console.log(L, total.toFixed(1) + 's');
}
