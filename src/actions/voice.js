// Voz local (Whisper STT + TTS) — zero dependências npm no servidor.
// - Se `config.voiceUrl` estiver configurado (ex.: servidor GPU em integrations/voice-server/server.py),
//   encaminha STT (`/transcribe`) e TTS (`/speak`).
// - No Windows (quando `config.voiceLocalTts !== false`), oferece TTS nativo instantâneo via SAPI
//   (ex.: Microsoft Maria Desktop em PT-BR), funcionando até no Safari 9 do iPad mini 1 via <audio>.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const MAX_TTS_CHARS = 1800;

function sanitizeForSpeech(raw) {
  return String(raw || '')
    .replace(/```[\s\S]*?```/g, ' bloco de código. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_>~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TTS_CHARS);
}

function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch { return resolve({ ok: false, status: 0, error: 'URL inválida' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total <= MAX_AUDIO_BYTES) chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode || 0,
          contentType: res.headers['content-type'] || 'application/octet-stream',
          buffer: buf,
          text: buf.toString('utf8'),
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'Tempo esgotado no serviço de voz.' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    if (body) req.write(body);
    req.end();
  });
}

function synthesizeWindowsSapi(text, voiceHint = '', exec = execFile) {
  return new Promise((resolve) => {
    const tmpWav = path.join(os.tmpdir(), `ai-hud-tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
    const script = [
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$hint = $env:AI_HUD_TTS_VOICE',
      '$voices = $s.GetInstalledVoices() | Where-Object { $_.Enabled }',
      '$pick = $null',
      'if ($hint) { $pick = $voices | Where-Object { $_.VoiceInfo.Name -like "*$hint*" } | Select-Object -First 1 }',
      'if (-not $pick) { $pick = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like "pt*" } | Select-Object -First 1 }',
      'if ($pick) { $s.SelectVoice($pick.VoiceInfo.Name) }',
      '$s.Rate = 1',
      '$s.SetOutputToWaveFile($env:AI_HUD_TTS_OUT)',
      '$s.Speak($env:AI_HUD_TTS_TEXT)',
      '$s.Dispose()',
    ].join('; ');

    exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 25000,
      windowsHide: true,
      env: {
        ...process.env,
        AI_HUD_TTS_TEXT: text,
        AI_HUD_TTS_OUT: tmpWav,
        AI_HUD_TTS_VOICE: String(voiceHint || ''),
      },
    }, (err, _stdout, stderr) => {
      if (err) {
        try { fs.unlinkSync(tmpWav); } catch {}
        return resolve({ ok: false, error: (stderr || err.message || 'Falha no TTS SAPI').trim() });
      }
      try {
        const buffer = fs.readFileSync(tmpWav);
        try { fs.unlinkSync(tmpWav); } catch {}
        if (!buffer.length) return resolve({ ok: false, error: 'Áudio vazio gerado pelo SAPI.' });
        resolve({ ok: true, contentType: 'audio/wav', buffer, engine: 'windows-sapi' });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  });
}

function createVoice({ config = {}, platform = process.platform, exec = execFile, fetchUrl = httpRequest } = {}) {
  let healthCache = { at: 0, data: null };
  const baseUrl = () => String(config.voiceUrl || process.env.AI_VOICE_URL || '').trim().replace(/\/+$/, '');
  const hasLocalSapi = () => platform === 'win32' && config.voiceLocalTts !== false;

  async function status() {
    const url = baseUrl();
    let remote = null;
    if (url) {
      const now = Date.now();
      if (healthCache.data && now - healthCache.at < 15000) {
        remote = healthCache.data;
      } else {
        const r = await fetchUrl(`${url}/health`, { timeoutMs: 3000 });
        if (r.ok) {
          try { remote = JSON.parse(r.text); } catch { remote = { ok: true, stt: true, tts: true }; }
          healthCache = { at: now, data: remote };
        }
      }
    }
    const stt = !!(remote && remote.stt !== false);
    const tts = !!(remote && remote.tts !== false) || hasLocalSapi();
    return {
      ok: true,
      stt,
      tts,
      configured: !!url,
      remoteOnline: !!remote,
      engine: {
        stt: stt ? (remote.sttEngine || remote.whisperModel || 'whisper') : '',
        tts: (remote && remote.tts !== false) ? (remote.ttsEngine || 'voice-server') : hasLocalSapi() ? 'windows-sapi' : '',
      },
    };
  }

  async function transcribe({ audioBase64 = '', mimeType = 'audio/webm', language = 'pt' } = {}) {
    const clean = String(audioBase64 || '').replace(/^data:[^;]+;base64,/, '').trim();
    if (!clean) return { status: 400, body: 'Áudio ausente.' };
    const buf = Buffer.from(clean, 'base64');
    if (!buf.length || buf.length > MAX_AUDIO_BYTES) {
      return { status: 413, body: 'Áudio inválido ou acima de 15 MB.' };
    }
    const url = baseUrl();
    if (!url) {
      return {
        status: 503,
        body: 'Serviço local de transcrição (Whisper) não configurado. Defina "voiceUrl" em data/config.json apontando para integrations/voice-server/server.py.',
      };
    }
    const payload = JSON.stringify({ audioBase64: clean, mimeType, language });
    const r = await fetchUrl(`${url}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload,
      timeoutMs: 60000,
    });
    if (!r.ok) {
      return { status: r.status || 502, body: r.error || r.text.slice(0, 200) || 'Falha na transcrição.' };
    }
    try {
      const data = JSON.parse(r.text);
      return { status: 200, body: { ok: true, text: String(data.text || '').trim(), language: data.language || language, engine: data.engine || 'whisper' } };
    } catch {
      return { status: 200, body: { ok: true, text: r.text.trim(), language, engine: 'whisper' } };
    }
  }

  async function speak({ text = '', voice = '' } = {}) {
    const clean = sanitizeForSpeech(text);
    if (!clean) return { status: 400, body: 'Texto vazio para leitura.' };
    const url = baseUrl();
    if (url) {
      const payload = JSON.stringify({ text: clean, voice });
      const r = await fetchUrl(`${url}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        body: payload,
        timeoutMs: 30000,
      });
      if (r.ok && r.buffer && r.buffer.length) {
        return { status: 200, contentType: r.contentType || 'audio/wav', buffer: r.buffer, engine: 'voice-server' };
      }
    }
    if (hasLocalSapi()) {
      const r = await synthesizeWindowsSapi(clean, voice, exec);
      if (r.ok) return { status: 200, contentType: r.contentType, buffer: r.buffer, engine: r.engine };
      return { status: 500, body: r.error };
    }
    return { status: 503, body: 'Nenhum serviço de voz (TTS) disponível nesta máquina.' };
  }

  return { status, transcribe, speak };
}

module.exports = { createVoice, sanitizeForSpeech };
