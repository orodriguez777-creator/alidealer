// Noa ad (1080x1920, 30fps) in English and Hebrew: AI clips where we have them, slow camera moves on stills otherwise.
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const FF = '/tmp/vid/node_modules/ffmpeg-static/ffmpeg';
const W = 1080, H = 1920, FPS = 30, XF = 0.4, D = '/tmp/noa';

const TXT = {
  en: [['Hi, I\'m Noa!', 'I find the best AliExpress deals'], ['Chest bag', 'for morning runs'], ['Night light', 'for cozy evenings'], ['Mini garden tools', 'for your balcony'], ['New deals every day'], 'Noa is an AI character'],
  he: [['היי, אני נועה!', 'הדילים הכי שווים ב-AliExpress'], ['תיק חזה', 'לריצות של הבוקר'], ['מנורת לילה', 'לערבים נעימים'], ['כלי גינה קטנים', 'למרפסת'], ['דילים חדשים כל יום'], 'נועה היא דמות AI'],
};

let assN = 0;
function caption(lines, { y, size = 66, start = 0.3, font = 'Rubik ExtraBold', color = 'FFFFFF', box = 0.55 }) {
  const a = Math.round((1 - box) * 255).toString(16).padStart(2, '0').toUpperCase();
  const bgr = color.match(/../g).reverse().join('');
  const ts = t => `0:00:${t.toFixed(2).padStart(5, '0')}`;
  const ev = lines.map((l, i) => `Dialogue: 0,${ts(start + i * 0.25)},0:00:30.00,C,,0,0,0,,{\\an8\\pos(540,${y + i * Math.round(size * 1.55)})\\fad(300,0)}${/[֐-׿]/.test(l) ? '‫' + l + '‬' : l}`);
  const f = `${D}/cap${assN++}.ass`;
  writeFileSync(f, `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 2\n\n[V4+ Styles]\n` +
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    `Style: C,${font},${size},&H00${bgr},&H00FFFFFF,&H${a}000000,&H${a}000000,0,0,0,0,100,100,0,0,3,18,0,8,40,40,0,1\n\n` +
    `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${ev.join('\n')}\n`);
  return `ass=${f}:fontsdir=/tmp/vid`;
}

// AI clip (16 fps, low-res): interpolated to 30 fps, scaled to cover, last frame held if short
const clip = (file, dur, ov) => ({ inputs: ['-i', file], dur,
  filter: `[0:v]minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,tpad=stop_mode=clone:stop_duration=4,scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},unsharp=5:5:0.6,setsar=1,trim=duration=${dur},setpts=PTS-STARTPTS,${ov}[v]` });
// still with a slow push-in
const still = (img, dur, ov) => {
  return { inputs: ['-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', img], dur,
    filter: `[0:v]scale=-2:${H}:flags=lanczos,crop=${W}:${H},scale=${W * 2}:${H * 2}:flags=lanczos,zoompan=z='1+0.08*on/${Math.round(dur * FPS)}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=${FPS},setsar=1,${ov}[v]` };
};
const scene = (n, dur, ov) => existsSync(`${D}/clip_s${n}.mp4`) ? clip(`${D}/clip_s${n}.mp4`, dur, ov) : still(`${D}/s${n}.png`, dur, ov);
const wavDur = f => readFileSync(f).readUInt32LE(40) / 48000;

for (const L of ['en', 'he']) {
  const T = TXT[L];
  const vo = [0, 1, 2, 3, 4].map(i => `/tmp/vid/noa_vo_${L}_${i}.wav`);
  const durs = vo.map((f, i) => Math.max(3.2, wavDur(f) + (i === 4 ? 1.4 : 0.6)));
  const end = `drawbox=x=0:y=1360:w=${W}:h=560:color=0x1b120c@0.6:t=fill,` +
    caption(['alidealer.com'], { y: 1420, size: 120, start: 0.3, font: 'Josefin Sans SemiBold', box: 0 }) + ',' +
    caption(T[4], { y: 1610, size: 60, start: 0.7, font: 'Rubik Medium', color: 'FFD7A8', box: 0 }) + ',' +
    caption([T[5]], { y: 1760, size: 40, start: 0.7, font: 'Rubik Medium', color: 'DDDDDD', box: 0 });
  const scenes = [
    scene(1, durs[0], caption(T[0], { y: 1480, size: 70 })),
    scene(2, durs[1], caption(T[1], { y: 1500, size: 80 })),
    scene(3, durs[2], caption(T[2], { y: 1500, size: 80 })),
    scene(4, durs[3], caption(T[3], { y: 1500, size: 80 })),
    scene(5, durs[4], end),
  ];
  const parts = scenes.map((s, i) => {
    const f = `${D}/${L}_${i}.mp4`;
    execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...s.inputs, '-filter_complex', s.filter, '-map', '[v]', '-t', String(s.dur), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', f]);
    return f;
  });
  // crossfades; each voice line starts 0.25 s into its scene
  let filt = '', prev = '[0:v]', off = 0;
  const starts = [0];
  for (let i = 1; i < parts.length; i++) {
    off += scenes[i - 1].dur - XF;
    starts.push(off);
    const out = i === parts.length - 1 ? '[v]' : `[x${i}]`;
    filt += `${prev}[${i}:v]xfade=transition=${i === 4 ? 'fade' : 'slideleft'}:duration=${XF}:offset=${off.toFixed(2)}${out};`;
    prev = out;
  }
  const total = off + scenes.at(-1).dur;
  const n = parts.length;
  const voIn = vo.map((f, i) => `[${n + 1 + i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${Math.round((starts[i] + 0.25) * 1000)}:all=1,volume=1.6[vo${i}]`).join(';');
  filt += `[${n}:a]atrim=0:${total.toFixed(2)},volume=0.22,afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[mus];${voIn};[mus]${vo.map((_, i) => `[vo${i}]`).join('')}amix=inputs=${vo.length + 1}:normalize=0:duration=first[a]`;
  execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...parts.flatMap(p => ['-i', p]),
    '-stream_loop', '1', '-i', '/home/user/project/marketing/ad-video/music.wav', ...vo.flatMap(f => ['-i', f]),
    '-filter_complex', filt, '-map', '[v]', '-map', '[a]', '-t', total.toFixed(2),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    `${D}/noa-ad-${L}.mp4`]);
  console.log(L, total.toFixed(1) + 's');
}
