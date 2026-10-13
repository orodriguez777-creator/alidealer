// Builds the Alidealer ad (1080x1920, 30fps) in English and Hebrew.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const FF = '/tmp/vid/node_modules/ffmpeg-static/ffmpeg';
const W = 1920, H = 1080, FPS = 30, XF = 0.5;

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
function caption(lines, { y, x = W / 2, size = 66, start = 0.3, font = 'Rubik ExtraBold', color = 'FFFFFF', box = 0.55 }) {
  const a = Math.round((1 - box) * 255).toString(16).padStart(2, '0').toUpperCase();
  const bgr = color.match(/../g).reverse().join('');
  const ts = t => `0:00:${t.toFixed(2).padStart(5, '0')}`;
  const ev = lines.map((l, i) => `Dialogue: 0,${ts(start + i * 0.25)},0:00:30.00,C,,0,0,0,,{\\an8\\pos(${x},${y + i * Math.round(size * 1.55)})\\fad(350,0)}${/[\u0590-\u05FF]/.test(l) ? '\u202B' + l + '\u202C' : l}`);
  const f = `/tmp/vid/wcap${assN++}.ass`;
  writeFileSync(f, `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\n\n[V4+ Styles]\n` +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: C,${font},${size},&H00${bgr},&H00FFFFFF,&H${a}000000,&H${a}000000,0,0,0,0,100,100,0,0,3,18,0,8,40,40,0,1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev.join('\n')}\n`);
  return `ass=${f}:fontsdir=/tmp/vid`;
}

// Still image with a slow Ken Burns zoom, cropped to 16:9.
function still(img, dur, z0, z1, overlays) {
  const z = `(${z0}+(${z1}-${z0})*t/${dur})`;
  return {
    inputs: ['-loop', '1', '-t', String(dur), '-i', img],
    filter: `[0:v]scale=3840:-2,scale=w='trunc(1920*${z}/2)*2':h=-2:eval=frame:flags=lanczos,crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2,setsar=1,fps=${FPS},${overlays}[v]`,
    dur,
  };
}

// Phone mockup on the right scrolling the real homepage, caption on the left.
function phone(tall, dur, lines) {
  const sw = 480, sh = 880, x = 1200, y = 100;
  return {
    inputs: ['-f', 'lavfi', '-t', String(dur), '-i', `color=c=0xf76b1c:s=${W}x${H}:r=${FPS}`, '-loop', '1', '-t', String(dur), '-i', tall],
    filter:
      `[0:v]drawbox=x=${x - 18}:y=${y - 18}:w=${sw + 36}:h=${sh + 36}:color=0x1b120c:t=fill,` +
      `drawbox=x=${x + sw / 2 - 50}:y=${y - 11}:w=100:h=6:color=0x3a2a20:t=fill[bg];` +
      `[1:v]scale=${sw}:-2:flags=lanczos,fps=${FPS},crop=${sw}:${sh}:0:'min(ih-${sh},max(0,(t-0.6)*(ih-${sh})/${dur - 1.4}))'[scr];` +
      `[bg][scr]overlay=${x}:${y},${caption(lines, { x: 600, y: 420, size: 64, box: 0 })},setsar=1[v]`,
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
    still('/tmp/vid/w1.png', 4.5, 1.0, 1.06, caption(T.a, { x: 520, y: 400, size: 54 })),
    still('/tmp/vid/w2.png', 3.5, 1.08, 1.0, caption(T.b, { x: 520, y: 420, size: 80 })),
    phone(`/tmp/vid/tall_${L}.png`, 5.5, T.c),
    still('/tmp/vid/w3.png', 3.8, 1.0, 1.05, caption(T.d, { x: 460, y: 420, size: 66 })),
    still('/tmp/vid/w4.png', 5.5, 1.05, 1.0,
      caption(['alidealer.com'], { x: 600, y: 440, size: 120, start: 0.4, font: 'Josefin Sans', box: 0 }) + ',' +
      caption(T.e, { x: 600, y: 600, size: 56, start: 0.9, font: 'Rubik Medium', color: 'FFE7CC', box: 0 })),
  ];
  const parts = scenes.map((s, i) => { const f = `/tmp/vid/w_${L}_${i}.mp4`; render(s, f); return f; });

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
    `/tmp/vid/alidealer-ad-${L}-16x9.mp4`]);
  console.log(L, total.toFixed(1) + 's');
}
