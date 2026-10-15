# Moving real-person ad

Scenes are animated with the free Wan 2.2 image-to-video Space on Hugging Face
(`zerogpu-aoti/wan2-2-fp8da-aoti-faster`, anonymous ZeroGPU quota ≈ 2 clips/day).

- Done: all four clips (sofa, aha moment, boxes at the door, thumbs up); published as site/ad/alidealer-ad-move-*.mp4 on /ads

Steps (scratch dir /tmp/vidh, fonts + site screenshots + audio mix in /tmp/vid — see ../ad-video):
1. `node wan.mjs s3 s4` (sources: src_s*.jpg; skips clips that already exist)
2. `node make-move.mjs && node make-wide-move.mjs` (16:9 reuses the vertical clips)
3. Mux `/tmp/vid/mix_<lang>.wav` onto each video, publish as `site/ad/alidealer-ad-move-*.mp4` and add to /ads.
