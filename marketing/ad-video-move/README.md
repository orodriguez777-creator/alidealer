# Moving real-person ad (in progress)

Scenes are animated with the free Wan 2.2 image-to-video Space on Hugging Face
(`zerogpu-aoti/wan2-2-fp8da-aoti-faster`, anonymous ZeroGPU quota ≈ 2 clips/day).

- Done: `clip_s1.mp4` (sofa, overwhelmed), `clip_s2.mp4` (aha moment)
- To do: `clip_s3.mp4` (boxes at the door), `clip_s4.mp4` (thumbs up)

Steps (scratch dir /tmp/vidh, fonts + site screenshots + audio mix in /tmp/vid — see ../ad-video):
1. `node wan.mjs s3 s4` (sources: src_s*.jpg; skips clips that already exist)
2. `node make-move.mjs && node make-wide-move.mjs` (16:9 reuses the vertical clips)
3. Mux `/tmp/vid/mix_<lang>.wav` onto each video, publish as `site/ad/alidealer-ad-move-*.mp4` and add to /ads.
