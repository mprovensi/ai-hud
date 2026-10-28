// Estado do Ollama local (se houver) e da GPU NVIDIA, para o cartão do HUD.
// Só leitura e só local: consulta a API do Ollama neste PC (padrão 127.0.0.1:11434, ou a URL
// em config.ollamaUrl / OLLAMA_HOST) e o nvidia-smi. Não guarda histórico de tokens.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const POLL_MS = 10e3;
const TAGS_MS = 60e3; // a lista de modelos instalados muda pouco

function get(base, route, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(route, base), { timeout: timeoutMs }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta')));
    req.on('error', reject);
  });
}

// GPU NVIDIA: nome, uso %, VRAM usada/total (MiB) e temperatura; null sem nvidia-smi
function gpu() {
  return new Promise((resolve) => execFile('nvidia-smi',
    ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
    { windowsHide: true, timeout: 4000 }, (err, out) => {
      if (err) return resolve(null);
      const [name, util, used, total, temp] = String(out).split('\n')[0].split(',').map((s) => s.trim());
      resolve(name ? { name, util: +util, memUsed: +used, memTotal: +total, temp: +temp } : null);
    }));
}

// Ollama instalado neste PC? (app do Windows ou executável no PATH) Assim o cartão aparece
// como "fora do ar" mesmo quando o servidor nunca respondeu desde que o HUD subiu.
function installed() {
  const exe = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') dirs.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama'));
  else dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/Applications/Ollama.app/Contents/Resources');
  return dirs.some((d) => { try { return fs.statSync(path.join(d, exe)).isFile(); } catch { return false; } });
}

class Ollama {
  constructor(url) {
    const host = process.env.OLLAMA_HOST && !/^0\.0\.0\.0/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : '';
    this.url = url || (host ? (host.startsWith('http') ? host : `http://${host}`) : 'http://127.0.0.1:11434');
    // Com Ollama instalado (ou URL configurada) o HUD mostra o cartão desde o início, fora do ar
    // até responder; sem Ollama, null e o HUD não mostra nada
    this.state = url || installed() ? { online: false, version: null, models: [], installed: null, gpu: null, at: Date.now() } : null;
    this.installed = null;
    this.tagsAt = 0;
    this.poll();
    setInterval(() => this.poll(), POLL_MS);
  }

  async poll() {
    try {
      const [version, ps] = await Promise.all([get(this.url, '/api/version'), get(this.url, '/api/ps')]);
      if (Date.now() - this.tagsAt > TAGS_MS) {
        get(this.url, '/api/tags').then((t) => { this.installed = (t.models || []).length; this.tagsAt = Date.now(); }, () => {});
      }
      const models = (ps.models || []).map((m) => ({
        name: m.name || m.model, size: m.size || 0, vram: m.size_vram || 0,
        gpuPct: m.size ? Math.round((m.size_vram || 0) / m.size * 100) : 0,
        expiresAt: Date.parse(m.expires_at) || null,
        params: m.details && m.details.parameter_size, quant: m.details && m.details.quantization_level,
      }));
      this.state = { online: true, version: version.version, models, installed: this.installed, gpu: await gpu(), at: Date.now() };
    } catch {
      // Já respondeu antes (ou está instalado): agora está fora do ar. Sem state: este PC não tem Ollama.
      if (this.state) this.state = { ...this.state, online: false, models: [], gpu: await gpu(), at: Date.now() };
    }
  }
}

module.exports = { Ollama, installed };
