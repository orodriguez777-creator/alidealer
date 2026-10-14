// Free image-to-video via the Wan 2.2 Hugging Face Space. Usage: node wan.mjs <name...> (s1..s4, w1..w4)
import { Client, handle_file } from '@gradio/client';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const SPACE = process.env.SPACE || 'zerogpu-aoti/wan2-2-fp8da-aoti-faster';
const STYLE = 'Photorealistic live-action commercial footage, natural realistic human motion, the same woman, consistent face, smooth subtle camera movement. No text.';
const SCENE = {
  1: { dur: 4.5, p: 'At night on the sofa she scrolls her phone, frowning and overwhelmed, lifts her hand to her head and sighs. The floating product cards drift and slowly swirl around her. Blue phone light flickers on her face.' },
  2: { dur: 3.5, p: 'She looks at her phone, her eyes widen and her face lights up in a delighted surprised smile, she leans toward the screen, thrilled.' },
  3: { dur: 3.8, p: 'At her front door in warm sunlight, she hugs the stack of delivery boxes, laughs happily and sways a little, glancing down at the boxes and back up, beaming.' },
  4: { dur: 5, p: 'She smiles at the camera, raises her thumb up confidently while holding her phone in the other hand, and gives a small friendly nod. Steady camera, slight push in.' },
};
const c = await Client.connect(SPACE, process.env.HF_TOKEN ? { hf_token: process.env.HF_TOKEN } : {});
for (const name of process.argv.slice(2)) {
  const out = `/tmp/vidh/clip_${name}.mp4`;
  if (existsSync(out)) { console.log(name, 'exists'); continue; }
  const sc = SCENE[name[1]], t0 = Date.now();
  try {
    const r = await c.predict('/generate_video', { input_image: handle_file(new Blob([readFileSync(`/tmp/vidh/src_${name}.jpg`)], { type: 'image/jpeg' })), prompt: `${sc.p} ${STYLE}`, steps: 6, duration_seconds: sc.dur, guidance_scale: 1, guidance_scale_2: 1, seed: 42, randomize_seed: false });
    const v = r.data[0]?.video?.url || r.data[0]?.url;
    writeFileSync(out, Buffer.from(await (await fetch(v)).arrayBuffer()));
    console.log(name, 'ok', ((Date.now() - t0) / 1000).toFixed(0) + 's');
  } catch (e) { console.log(name, 'FAILED', (e?.message || JSON.stringify(e)).slice(0, 400)); }
}
process.exit(0);
