// Temporary: mints a sealed live-voice session for recording the ad voiceover. Delete after use.
export async function handler(event) {
  const body = event.body ? JSON.parse(event.body) : {};
  if (!process.env.VO_KEY || body.key !== process.env.VO_KEY) return { statusCode: 403, body: '{"error":"forbidden"}' };
  const res = await fetch('https://proxy.openkbs.com/v1/live/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENKBS_API_KEY}` },
    body: JSON.stringify({
      systemInstruction: 'You are a professional voice-over artist recording a short, upbeat online ad. ' +
        'Each user message is one line of the script. Read it aloud EXACTLY as written, word for word, in its language, ' +
        'with a warm, friendly, energetic tone at a brisk pace. Never add, skip, translate or comment on anything. Say nothing else.',
      voice: body.voice || 'Kore',
      language: body.language === 'he-IL' ? 'he-IL' : 'en-US',
      maxSessionMs: 180000,
    }),
  });
  return { statusCode: res.status, headers: { 'Content-Type': 'application/json' }, body: await res.text() };
}
