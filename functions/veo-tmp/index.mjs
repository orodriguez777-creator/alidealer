// Temporary: image-to-video for the real-person ad via Google Veo (user's GEMINI_API_KEY). Delete after use.
const G = 'https://generativelanguage.googleapis.com/v1beta';
export async function handler(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
  const body = raw ? JSON.parse(raw) : {};
  if (!process.env.VEO_KEY || body.key !== process.env.VEO_KEY) return { statusCode: 403, body: '{"error":"forbidden"}' };
  if (!process.env.GEMINI_API_KEY) return { statusCode: 500, body: '{"error":"GEMINI_API_KEY not set"}' };
  const h = { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'Content-Type': 'application/json' };
  const json = (r, b) => ({ statusCode: r, headers: { 'Content-Type': 'application/json' }, body: typeof b === 'string' ? b : JSON.stringify(b) });

  if (body.action === 'models') {
    const r = await fetch(`${G}/models?pageSize=1000`, { headers: h }).then(r => r.json());
    return json(200, (r.models || []).map(m => m.name).filter(n => /veo/i.test(n)).concat(r.error ? [JSON.stringify(r.error)] : []));
  }
  if (body.action === 'start') {
    const r = await fetch(`${G}/models/${body.model}:predictLongRunning`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        instances: [{ prompt: body.prompt, image: { bytesBase64Encoded: body.image, mimeType: 'image/jpeg' } }],
        parameters: { aspectRatio: body.aspectRatio, durationSeconds: body.duration, ...(body.params || {}) },
      }),
    });
    return json(r.status, await r.text());
  }
  if (body.action === 'poll') {
    const r = await fetch(`${G}/${body.op}`, { headers: h });
    return json(r.status, await r.text());
  }
  if (body.action === 'fetch') {
    // Download a byte range of the finished video (Lambda responses are capped at 6 MB).
    const r = await fetch(body.uri, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, Range: `bytes=${body.from}-${body.to}` }, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    return json(200, { status: r.status, range: r.headers.get('content-range'), data: buf.toString('base64') });
  }
  return json(400, { error: 'unknown action' });
}
