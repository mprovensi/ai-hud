// Gemini CLI: sessões em ~/.gemini/tmp/<projeto>/chats/session-*.jsonl (e .json legado).
// O caminho do projeto vem de <projeto>/.project_root ou ~/.gemini/projects.json.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readLines, parse, cached, emptySession, clip, prompt, toolCall, touch } = require('../common');
const { readJson } = require('../../../infra/store');
const { isTestCommand, testOutcome } = require('../../../core/tests');

const GEMINI_HOME = process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');
const SYSTEM_PREFIX = /^<(session_context|environment_context|system_instruction|turn_aborted)\b/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function projectMap(root) {
  const map = new Map();
  const projects = readJson(path.join(root, 'projects.json'), {}).projects || {};
  for (const [cwd, slug] of Object.entries(projects)) {
    if (slug && cwd) map.set(String(slug), String(cwd));
  }
  return map;
}

function projectRoot(dir, slug, projects) {
  try {
    const raw = fs.readFileSync(path.join(dir, '.project_root'), 'utf8').trim();
    if (raw) return raw;
  } catch {}
  return projects.get(slug) || '';
}

function upsertMessage(messages, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id) {
    const i = messages.findIndex((m) => m.id === msg.id);
    if (i >= 0) { messages[i] = msg; return; }
  }
  messages.push(msg);
}

function loadSessionRecords(file) {
  const meta = { startTime: '', lastUpdated: '', summary: '', kind: '' };
  let messages = [];
  if (file.endsWith('.json')) {
    const doc = parse(readLines(file).join('\n'));
    if (!doc || typeof doc !== 'object') return { meta, messages };
    meta.startTime = doc.startTime || '';
    meta.lastUpdated = doc.lastUpdated || '';
    meta.summary = doc.summary || '';
    meta.kind = doc.kind || '';
    if (Array.isArray(doc.messages)) messages = doc.messages;
    return { meta, messages };
  }
  for (const line of readLines(file)) {
    const r = parse(line);
    if (!r || typeof r !== 'object') continue;
    if (r.startTime && !meta.startTime) meta.startTime = r.startTime;
    if (r.lastUpdated) meta.lastUpdated = r.lastUpdated;
    if (r.summary) meta.summary = r.summary;
    if (r.kind) meta.kind = r.kind;
    if (r.$set && typeof r.$set === 'object') {
      if (r.$set.lastUpdated) meta.lastUpdated = r.$set.lastUpdated;
      if (r.$set.summary) meta.summary = r.$set.summary;
      if (Array.isArray(r.$set.messages)) messages = r.$set.messages.slice();
      continue;
    }
    if (r.type === 'user' || r.type === 'gemini' || r.type === 'model') upsertMessage(messages, r);
  }
  return { meta, messages };
}

function toolResultText(tc) {
  if (typeof tc.resultDisplay === 'string' && tc.resultDisplay) return tc.resultDisplay;
  if (typeof tc.result === 'string') return tc.result;
  if (Array.isArray(tc.result)) {
    return tc.result.map((r) => (typeof r === 'string' ? r : (r && (r.output || r.text || (r.functionResponse && JSON.stringify(r.functionResponse.response)))) || '')).join('\n');
  }
  if (tc.result && typeof tc.result === 'object') return String(tc.result.output || tc.result.text || '');
  return '';
}

function parseGeminiCli(file, cwd, slug = '') {
  const s = emptySession('Gemini', path.basename(file, path.extname(file)), file);
  s.where = 'gemini-cli';
  s.cwd = cwd || '';
  if (!s.cwd && slug && !/^[0-9a-f]{32,}$/i.test(slug)) s.project = slug;
  const { meta, messages } = loadSessionRecords(file);
  touch(s, meta.startTime);
  touch(s, meta.lastUpdated);
  if (meta.summary) s.title = clip(meta.summary, 160);
  if (meta.kind === 'subagent') s.subagent = true;

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const ts = m.timestamp || meta.lastUpdated || meta.startTime || '';
    touch(s, ts);
    if (m.type === 'user') {
      const text = textOf(m.content).trim();
      if (text && !SYSTEM_PREFIX.test(text)) {
        prompt(s, text);
        s.lastStop = '';
      }
      continue;
    }
    if (m.type !== 'gemini' && m.type !== 'model') continue;
    if (m.model) s.models.add(m.model);
    const text = textOf(m.content).trim();
    if (text) {
      s.lastReply = clip(text, 4000);
      s.lastReplyAt = Date.parse(ts) || 0;
    }
    let pendingTools = false;
    for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      const name = tc.name || (tc.functionCall && tc.functionCall.name) || 'tool';
      toolCall(s, name);
      if (tc.status === 'executing' || tc.status === 'scheduled' || tc.status === 'validating' || tc.status === 'awaiting_approval') {
        pendingTools = true;
      }
      const args = tc.args || (tc.functionCall && tc.functionCall.args) || {};
      const cmd = args.command || args.cmd || '';
      if (isTestCommand(cmd) && tc.status !== 'executing' && tc.status !== 'scheduled') {
        s.testRun = { command: clip(cmd, 200), at: Date.parse(ts) || 0, ...testOutcome(toolResultText(tc), tc.status === 'error') };
      }
    }
    if (text && !pendingTools) {
      s.lastStop = 'end_turn';
      s.completedAt = Date.parse(ts) || 0;
    } else if (pendingTools) {
      s.lastStop = '';
    }
    const t = m.tokens || m.usageMetadata;
    if (!t || typeof t !== 'object') continue;
    const rawInput = Number(t.input ?? t.promptTokenCount ?? 0) || 0;
    const cachedTok = Number(t.cached ?? t.cachedContentTokenCount ?? 0) || 0;
    const freshInput = Math.max(0, rawInput - cachedTok);
    const outTok = (Number(t.output ?? t.candidatesTokenCount ?? 0) || 0) + (Number(t.thoughts ?? t.thoughtsTokenCount ?? 0) || 0);
    s.input += freshInput;
    s.cacheRead += cachedTok;
    s.output += outTok;
    if (rawInput > 0) s.context = rawInput;
    s.contextWindow = 1e6;
    const fresh = freshInput + outTok;
    if (fresh > 0 || cachedTok > 0) s.events.push({ ts, fresh, cacheRead: cachedTok });
  }
  return s.events.length || s.prompts > 0 ? s : null;
}

function geminiCliSessions(root = GEMINI_HOME) {
  const tmpDir = path.join(root, 'tmp');
  let dirs;
  try { dirs = fs.readdirSync(tmpDir, { withFileTypes: true }); } catch { return []; }
  const projects = projectMap(root);
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(tmpDir, d.name);
    const chatsDir = path.join(projDir, 'chats');
    let files;
    try { files = fs.readdirSync(chatsDir); } catch { continue; }
    const cwd = projectRoot(projDir, d.name, projects);
    for (const name of files) {
      if (!/^session-.*\.jsonl?$/.test(name)) continue;
      const s = cached(path.join(chatsDir, name), (f) => parseGeminiCli(f, cwd, d.name));
      if (s) out.push(s);
    }
  }
  return out;
}

module.exports = { geminiCliSessions, parseGeminiCli };
