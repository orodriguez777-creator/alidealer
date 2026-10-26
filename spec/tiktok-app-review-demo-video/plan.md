# TikTok app review demo video

## Context
TikTok's app review asks for a demo video of how alidealer.com uses Login Kit + Content Posting API. The user asked me to make it using their admin password (shared in chat). TikTok's own login/authorize step needs the user's TikTok account, so (user's choice) the video is made in two clips with the user doing the TikTok login themselves.

## Approach (agent-browser `record start <path>.mp4`, 1280x720)
Password is typed into the login form only; never written to any file, commit, or log.

**Clip 1 — `demo/tiktok-demo-1-connect.mp4`** (before the user connects)
1. Open https://alidealer.com/admin → sign in → Agency tab.
2. Scroll to the channels list: TikTok row "App keys saved" + Connect TikTok.
3. Open Settings: show "Who sees TikTok posts" and "Allow comments on TikTok posts".
4. Press Connect TikTok → TikTok's authorize/login page loads showing the app name and requested permissions. Stop recording there; nothing is logged in on TikTok; close the browser (`agent-browser close --all`). The OAuth state from this press just expires harmlessly.

**User step:** in their own browser, press Connect TikTok and Authorize (optionally phone-record it). I verify the TikTok row now shows "Connected as @…".

**Clip 2 — `demo/tiktok-demo-2-connected.mp4`**
1. Admin → Agency tab: TikTok "Connected as @…".
2. Press Test → shows the account and allowed privacy options.
3. Show a draft with its TikTok caption tab; press "Post now" on one approved/waiting deal only if the user OKs a real (private) post — otherwise show the schedule and the activity log.
4. Optional short clip from the user's phone: the private photo post on their TikTok profile.

## Output
- Files in `/home/user/project/demo/` (not deployed; add `demo/` to .gitignore so videos aren't committed). User downloads them from the studio file browser and uploads to TikTok (mp4, under TikTok's size limit).
- Take screenshots of a few frames to check the clips are readable before handing over.

## Afterwards
- Recommend the user change the admin password, since it was typed in chat.
- `agent-browser close --all` after each clip.

## Verification
- Both mp4 files exist, play (check duration with agent-browser contact sheet/screenshots), show the steps above.
- Admin Agency tab shows TikTok connected after the user's step.
