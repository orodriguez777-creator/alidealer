# Generates the photorealistic scenes (run in /tmp/vidh; refs = char.jpg + JPEG copies of the animated frames). Same pipeline as ../ad-video, audio = ../ad-video mix.
P="Same woman as the FIRST reference photo (same face, wavy dark brown hair, mustard-orange knit sweater). Photorealistic live-action commercial photograph, real human, natural skin, cinematic lighting, shallow depth of field, shot on a full-frame camera. Not a cartoon, not 3D, not illustration. No text, no logos, no brand names."
V="$P Vertical 9:16 frame, keep the top 20% and bottom 25% of the frame calm and uncluttered for captions. Match the composition of the second reference image."
Wd="$P Wide 16:9 cinematic frame. Place her in the RIGHT half of the frame; keep the LEFT 40% calmer and less detailed so captions can sit there. Match the composition of the second reference image."
S1="Scene: at night on a sofa in a living room, she scrolls her phone looking overwhelmed and confused; many translucent floating product cards (gadgets, shoes, bags, lamps, toys) swirl around her like a visual effect. Cool bluish light from the phone."
S2="Scene: close-up, she looks at her phone with an amazed, delighted 'aha!' expression, eyes wide, warm orange glow from the screen lighting her face, cozy living room softly blurred behind."
S3="Scene: daytime at her apartment front door, she happily hugs a stack of plain brown delivery parcels, beaming, a few small gadgets peeking out of the top box, warm sunlight."
S4="Scene: she stands against a solid warm orange (#d9480f) seamless studio background, smiling at the camera, giving a thumbs up with one hand and holding her phone in the other. Clean, simple composition, waist-up."
i=0; for s in "$S1" "$S2" "$S3" "$S4"; do i=$((i+1)); [ $i = 1 ] && continue
  for try in 1 2 3; do [ $i = 2 ] || openkbs image "$V $s" --ref char.jpg --ref ref_s$i.jpg --aspect-ratio 9:16 -o s$i.png >/dev/null 2>&1 && break; done; echo "s$i $(test -f s$i.png && echo ok)"
  for try in 1 2 3; do openkbs image "$Wd $s" --ref char.jpg --ref ref_w$i.jpg --aspect-ratio 16:9 -o w$i.png >/dev/null 2>&1 && break; done; echo "w$i $(test -f w$i.png && echo ok)"
done; echo DONE
