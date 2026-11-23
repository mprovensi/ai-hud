// Peças comuns aos leitores de sessões. Toda fonte devolve sessões no formato Session (core/session.js).
const fs = require('fs');
const path = require('path');

function walk(dir, ext, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// Reprocessa um arquivo só quando muda (o servidor relê tudo a cada poucos segundos)
const cache = new Map();
function cached(file, parser) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = parser(file);
  if (value) value.mtime = st.mtimeMs;
  cache.set(file, { mtime: st.mtimeMs, size: st.size, value });
  return value;
}

/** @returns {import('../../core/session').Session} */
function emptySession(tool, id, file) {
  return { tool, id, file, cwd: '', start: null, end: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    models: new Set(), subagent: false, context: 0, contextWindow: 0, lastStop: '', events: [],
    title: '', prompts: 0, firstPrompt: '', lastPrompt: '', lastReply: '', toolCalls: 0, lastTool: '', tools: {},
    files: {}, history: [], pendingQuestion: null };
}

// Registra arquivo modificado na sessão (relativo ao cwd quando possível; mais recente por último)
function touchFile(s, rawPath) {
  let p = String(rawPath || '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (!p) return;
  const cwd = String(s.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (cwd && p.toLowerCase().startsWith(cwd.toLowerCase() + '/')) p = p.slice(cwd.length + 1);
  p = p.replace(/^\.\//, '');
  if (!p) return;
  const count = (s.files[p] || 0) + 1;
  delete s.files[p]; // mantém ordem de modificação mais recente
  s.files[p] = count;
}

// Registra uma mensagem na linha do tempo da sessão (mantém as últimas 24 para o detalhe)
function pushHistory(s, role, content, ts, tools) {
  const text = String(content || '').trim();
  if (!text) return;
  const at = typeof ts === 'number' ? ts : Date.parse(ts) || 0;
  const msg = { role, content: cut(text, 4000), at };
  if (Array.isArray(tools) && tools.length) msg.tools = tools.slice(0, 6);
  s.history.push(msg);
  if (s.history.length > 24) s.history.splice(0, s.history.length - 24);
}

// Corta textos longos com reticências; clip também tira espaços das pontas
const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const clip = (t, n) => cut(t, n).trim();

function prompt(s, text) {
  s.prompts++;
  s.lastPrompt = clip(text, 400);
  if (!s.firstPrompt) s.firstPrompt = clip(text, 120);
}

function toolCall(s, name) {
  s.toolCalls++;
  s.lastTool = name;
  s.tools[name] = (s.tools[name] || 0) + 1;
}

function touch(s, ts) {
  if (!ts) return;
  if (!s.start || ts < s.start) s.start = ts;
  if (!s.end || ts > s.end) s.end = ts;
}

// Datas que podem vir como texto ISO ou número (segundos/ms)
function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (!Number.isNaN(n) && /^\d+(\.\d+)?$/.test(String(v))) return n < 1e12 ? n * 1000 : n;
  return Date.parse(v) || 0;
}

// Assinatura de um banco SQLite (data + tamanho do arquivo e do WAL). No Windows a data de um arquivo
// mantido aberto não atualiza; o tamanho sim. '' se o banco não existe.
function dbSignature(file) {
  let sig = '';
  for (const f of [file, `${file}-wal`]) { try { const st = fs.statSync(f); sig += `${st.mtimeMs}:${st.size};`; } catch {} }
  return sig;
}

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {} // Node 22.5+; sem ele, as fontes em SQLite ficam vazias

module.exports = { walk, readLines, parse, cached, emptySession, touchFile, pushHistory, clip, cut, prompt, toolCall, touch, toMs, dbSignature, sqlite };
