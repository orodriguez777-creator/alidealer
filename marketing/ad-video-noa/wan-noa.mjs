// Free image-to-video via the Wan 2.2 Hugging Face Space. Usage: node wan.mjs s1 s5 ...
import { Client, handle_file } from '@gradio/client';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const STYLE = 'Photorealistic live-action social media footage, natural realistic human motion, the same woman, consistent face, the product keeps its exact shape. Smooth subtle camera movement. No text.';
const SCENE = {
  1: { dur: 5, p: 'She looks into the camera, waves hello with a big warm smile and says hi, tilting her head a little, then lowers her hand, talking cheerfully to the camera.' },
  2: { dur: 3.5, p: 'Standing on the park trail, she adjusts the chest bag strap with one hand, smiles and takes a small step toward the camera, trees swaying gently.' },
  3: { dur: 3.5, p: 'She keeps the glowing night light beside her cheek at the same distance, tilts her head toward it and smiles warmly at the camera, the soft glow lighting her face. The light never covers her face.' },
  4: { dur: 3.5, p: 'She holds the small gardening tools out toward the camera, smiles and gives them a small playful wiggle, leaves moving in a light breeze.' },
  5: { dur: 5, p: 'She smiles at the camera, raises her thumb up confidently while holding her phone in the other hand, and gives a small friendly nod. Steady camera, slight push in.' },
};
const c = await Client.connect('zerogpu-aoti/wan2-2-fp8da-aoti-faster', process.env.HF_TOKEN ? { token: process.env.HF_TOKEN } : {});
for (const name of process.argv.slice(2)) {
  const out = `/tmp/noa/clip_${name}.mp4`;
  if (existsSync(out)) { console.log(name, 'exists'); continue; }
  const sc = SCENE[name[1]], t0 = Date.now();
  try {
    const r = await c.predict('/generate_video', { input_image: handle_file(new Blob([readFileSync(`/tmp/noa/src_${name}.jpg`)], { type: 'image/jpeg' })), prompt: `${sc.p} ${STYLE}`, steps: 6, duration_seconds: sc.dur, guidance_scale: 1, guidance_scale_2: 1, seed: Number(process.env.SEED || 42), randomize_seed: false });
    const v = r.data[0]?.video?.url || r.data[0]?.url;
    writeFileSync(out, Buffer.from(await (await fetch(v)).arrayBuffer()));
    console.log(name, 'ok', ((Date.now() - t0) / 1000).toFixed(0) + 's');
  } catch (e) { console.log(name, 'FAILED', (e?.message || JSON.stringify(e)).slice(0, 300)); }
}
process.exit(0);
