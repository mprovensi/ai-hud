// Rotas de Voz local (Whisper STT + TTS): /api/voice/*
// No Hub (ex.: VPS Linux sem áudio local), repassa automaticamente para o primeiro peer online com voz disponível!
module.exports = ({ voice, peers, send, json, text }) => {
  async function findVoicePeer(need = 'tts') {
    if (!peers || !Array.isArray(peers.list) || !peers.list.length) return null;
    for (const p of peers.list) {
      if (p.error) continue;
      try {
        const r = await peers.forward(p, 'GET', '/api/voice/status?local=1');
        if (r.status === 200 && r.json && r.json[need]) return { peer: p, status: r.json };
      } catch {}
    }
    return null;
  }

  return [
    { method: 'GET', path: '/api/voice/status', handler: async ({ res, url }) => {
      const st = await voice.status();
      if (url.searchParams.get('local') === '1' || (st.stt && st.tts)) return json(res, st);
      if (peers && Array.isArray(peers.list) && peers.list.length) {
        for (const p of peers.list) {
          if (p.error) continue;
          try {
            const r = await peers.forward(p, 'GET', '/api/voice/status?local=1');
            if (r.status === 200 && r.json) {
              if (!st.stt && r.json.stt) { st.stt = true; st.engine.stt = `${r.json.engine.stt} (${p.name})`; }
              if (!st.tts && r.json.tts) { st.tts = true; st.engine.tts = `${r.json.engine.tts} (${p.name})`; }
            }
          } catch {}
        }
      }
      json(res, st);
    } },

    { method: 'POST', path: '/api/voice/transcribe', json: true, maxBytes: 18 * 1024 * 1024, handler: async ({ res, url, body }) => {
      const st = await voice.status();
      if (!st.stt && url.searchParams.get('local') !== '1') {
        const remote = await findVoicePeer('stt');
        if (remote) {
          const r = await peers.forward(remote.peer, 'POST', '/api/voice/transcribe?local=1', body);
          return send(res, r.status, r.status === 200 ? 'application/json' : 'text/plain; charset=utf-8', r.text);
        }
      }
      const r = await voice.transcribe(body);
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/voice/speak', json: true, maxBytes: 64 * 1024, handler: async ({ res, url, body }) => {
      const wantJson = url.searchParams.get('format') === 'json';
      const st = await voice.status();
      if (!st.tts && url.searchParams.get('local') !== '1') {
        const remote = await findVoicePeer('tts');
        if (remote) {
          const r = await peers.forward(remote.peer, 'POST', '/api/voice/speak?local=1&format=json', body);
          if (r.status === 200 && r.json && r.json.audioBase64) {
            if (wantJson) return json(res, r.json);
            return send(res, 200, r.json.contentType || 'audio/wav', Buffer.from(r.json.audioBase64, 'base64'));
          }
          return text(res, r.status || 502, r.text || 'Falha no TTS remoto.');
        }
      }
      const r = await voice.speak(body);
      if (r.status !== 200) return text(res, r.status, r.body);
      if (wantJson) {
        return json(res, { ok: true, contentType: r.contentType, engine: r.engine, audioBase64: r.buffer.toString('base64') });
      }
      return send(res, 200, r.contentType, r.buffer);
    } },
  ];
};
