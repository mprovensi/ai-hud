// Antigravity (Gemini): lê transcrições em ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
// (com tokens, cache, contexto, respostas e ferramentas), enriquece com conversation_summaries.db
// (título, workspace e subagentes) e preserva conversas antigas de ~/.gemini/antigravity-cli/history.jsonl.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readLines, parse, cached, emptySession, touchFile, pushHistory, clip, prompt, toolCall, touch, dbSignature, sqlite } = require('../common');
const { readJson } = require('../../../infra/store');
const { isTestCommand, testOutcome } = require('../../../core/tests');
const { normalizeQuestions } = require('../../../core/questions');

const GEMINI_HOME = process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');
const day = (ts) => new Date(ts).toLocaleDateString('sv-SE'); // YYYY-MM-DD no fuso local

function uriToPath(uri) {
  if (!uri || typeof uri !== 'string') return '';
  if (!uri.startsWith('file://')) return uri;
  let decoded;
  try { decoded = decodeURIComponent(uri.slice(7)); } catch { decoded = uri.slice(7); }
  // Windows: file:///d%3A/Projetos -> /d:/Projetos -> d:/Projetos
  if (/^\/[a-zA-Z]:/.test(decoded)) return decoded.slice(1);
  return decoded;
}

function firstWorkspace(raw) {
  if (!raw) return '';
  const list = typeof raw === 'string' ? parse(raw) : raw;
  if (Array.isArray(list)) {
    for (const u of list) {
      const p = uriToPath(u);
      if (p) return p;
    }
  }
  return typeof raw === 'string' && !raw.startsWith('[') ? uriToPath(raw) : '';
}

function parseDbTime(v) {
  if (!v) return '';
  const s = String(v).trim();
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

// Cache do banco conversation_summaries.db (somente leitura)
const summaryCache = new Map();
function readSummaries(root) {
  const dbFile = path.join(root, 'antigravity', 'conversation_summaries.db');
  const sig = dbSignature(dbFile);
  if (!sig || !sqlite) return new Map();
  const hit = summaryCache.get(dbFile);
  if (hit && hit.sig === sig) return hit.value;
  const map = new Map();
  let db;
  try {
    db = new sqlite.DatabaseSync(dbFile, { readOnly: true, readBigInts: true });
    const rows = db.prepare(
      'SELECT conversation_id, title, preview, last_modified_time, workspace_uris, status, source, parent_conversation_id, nesting_depth FROM conversation_summaries'
    ).all();
    for (const r of rows) {
      const id = String(r.conversation_id || '');
      if (!id) continue;
      map.set(id, {
        title: String(r.title || r.preview || '').trim(),
        cwd: firstWorkspace(r.workspace_uris),
        where: String(r.source || '') === 'CORTEX_TRAJECTORY_SOURCE_CLI' ? 'antigravity-cli' : 'antigravity',
        status: String(r.status || ''),
        parentId: String(r.parent_conversation_id || ''),
        subagent: Boolean(r.parent_conversation_id) || Number(r.nesting_depth || 0) > 0,
        lastModified: parseDbTime(r.last_modified_time),
      });
    }
  } catch {
    // banco ausente ou esquema incompatível: segue só com os JSONL
  } finally {
    try { if (db) db.close(); } catch {}
  }
  summaryCache.set(dbFile, { sig, value: map });
  return map;
}

// Metadados gravados pelo Antigravity CLI (`~/.gemini/antigravity-cli/cache/conversation_metadata.json`)
function readCliMetadata(root) {
  const doc = readJson(path.join(root, 'antigravity-cli', 'cache', 'conversation_metadata.json'), null);
  const convs = doc && doc.conversations;
  const map = new Map();
  if (!convs || typeof convs !== 'object') return map;
  for (const [id, entry] of Object.entries(convs)) {
    const sum = entry && entry.summary;
    if (!id || !sum) continue;
    map.set(id, {
      title: String(sum.Title || sum.Preview || '').trim(),
      cwd: firstWorkspace(sum.WorkspaceURIs),
      where: 'antigravity-cli',
    });
  }
  return map;
}

function extractUserText(raw) {
  const text = String(raw || '');
  const req = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
  return (req ? req[1] : text).trim();
}

function extractModelSelection(raw) {
  const m = /Model Selection`\s+from\s+[^\n]+?\s+to\s+([^.\n]+)/i.exec(String(raw || ''));
  return m ? m[1].trim() : '';
}

function unquoteArg(v) {
  const s = String(v || '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

function contextWindowFor(models, context) {
  const list = [...models];
  if (list.some((m) => /claude/i.test(m) && !/1m/i.test(m))) return context > 200e3 ? 1e6 : 200e3;
  return 1e6;
}

function parseTranscript(file, convId) {
  const s = emptySession('Gemini', convId, file);
  s.where = 'antigravity';
  let pendingTestCmd = null;
  let turnTools = [];
  for (const line of readLines(file)) {
    const r = parse(line);
    if (!r || typeof r !== 'object') continue;
    const ts = r.created_at || '';
    touch(s, ts);

    if (r.type === 'USER_INPUT') {
      const model = extractModelSelection(r.content);
      if (model) s.models.add(model);
      const text = extractUserText(r.content);
      if (text) {
        prompt(s, text);
        pushHistory(s, 'user', text, ts);
        turnTools = [];
        s.pendingQuestion = null;
        s.lastStop = '';
      }
      continue;
    }

    if (r.type === 'PLANNER_RESPONSE') {
      if (r.model) s.models.add(String(r.model));
      const inTok = Number(r.input_tokens || 0) || 0;
      const cacheRead = Number(r.cache_read_tokens || 0) || 0;
      const outTok = Number(r.output_tokens || 0) || 0;
      s.input += inTok;
      s.cacheRead += cacheRead;
      s.output += outTok;
      const ctx = inTok + cacheRead;
      if (ctx > 0) s.context = ctx;
      const fresh = inTok + outTok;
      if (fresh > 0 || cacheRead > 0) s.events.push({ ts, fresh, cacheRead });

      const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
      s.pendingQuestion = null;
      for (const tc of calls) {
        if (!tc || !tc.name) continue;
        toolCall(s, tc.name);
        turnTools.push(tc.name);
        if (tc.name === 'run_command' && tc.args && tc.args.CommandLine) {
          const cmd = unquoteArg(tc.args.CommandLine);
          if (isTestCommand(cmd)) pendingTestCmd = cmd;
        }
        if (/^(write_file|edit_file|multi_edit_file|replace_file_content|multi_replace_file_content)$/i.test(tc.name) && tc.args && !tc.args.ArtifactMetadata) {
          const target = unquoteArg(tc.args.Path || tc.args.TargetFile || tc.args.file_path || tc.args.path || '');
          if (target && !/[\\/]\.gemini[\\/]antigravity(?:-cli)?[\\/]brain[\\/]/i.test(target)) touchFile(s, target);
        }
        if (tc.name === 'ask_question' && tc.args) {
          const rawQ = typeof tc.args.questions === 'string' ? parse(tc.args.questions) : tc.args.questions;
          const qs = normalizeQuestions({ questions: rawQ });
          if (qs.length) s.pendingQuestion = qs;
        }
      }
      const replyText = typeof r.content === 'string' ? r.content.trim() : '';
      if (replyText) {
        s.lastReply = clip(replyText, 4000);
        s.lastReplyAt = Date.parse(ts) || 0;
        pushHistory(s, 'assistant', replyText, ts, turnTools);
        turnTools = [];
      }
      if (!calls.length && r.status === 'DONE') {
        s.lastStop = 'end_turn';
        s.completedAt = Date.parse(ts) || 0;
      } else if (calls.length) {
        s.lastStop = '';
      }
      continue;
    }

    if (r.type === 'GENERIC') {
      if (r.status && r.status !== 'RUNNING') s.pendingQuestion = null;
      if (pendingTestCmd && r.status && r.status !== 'RUNNING') {
        s.testRun = {
          command: clip(pendingTestCmd, 200),
          at: Date.parse(ts) || 0,
          ...testOutcome(r.content || '', r.status === 'ERROR'),
        };
        pendingTestCmd = null;
      }
    }
  }
  if (s.context > 0) s.contextWindow = contextWindowFor(s.models, s.context);
  return s.events.length || s.prompts > 0 ? s : null;
}

function cloneSession(s) {
  return { ...s, models: new Set(s.models), tools: { ...s.tools }, files: { ...s.files }, events: s.events };
}

function antigravitySessions(rootOrHome = GEMINI_HOME) {
  // Compatibilidade: chamadas antigas passavam `home` (~), novas passam `root` (~/.gemini)
  const root = path.basename(rootOrHome) === '.gemini' || fs.existsSync(path.join(rootOrHome, 'antigravity')) || fs.existsSync(path.join(rootOrHome, 'antigravity-cli'))
    ? rootOrHome
    : path.join(rootOrHome, '.gemini');

  const summaries = readSummaries(root);
  const cliMeta = readCliMetadata(root);
  const byId = new Map();
  const parents = new Map();

  // Lê tanto o app/IDE (`~/.gemini/antigravity/brain`) quanto o CLI `agy` (`~/.gemini/antigravity-cli/brain`)
  const brainRoots = [
    [path.join(root, 'antigravity', 'brain'), 'antigravity'],
    [path.join(root, 'antigravity-cli', 'brain'), 'antigravity-cli'],
  ];
  for (const [brainDir, defaultWhere] of brainRoots) {
    let convDirs = [];
    try { convDirs = fs.readdirSync(brainDir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch {}
    for (const d of convDirs) {
      if (byId.has(d.name)) continue;
      const file = path.join(brainDir, d.name, '.system_generated', 'logs', 'transcript.jsonl');
      const parsed = cached(file, (f) => parseTranscript(f, d.name));
      if (!parsed) continue;
      const s = cloneSession(parsed);
      s.where = defaultWhere;
      const meta = summaries.get(d.name) || cliMeta.get(d.name);
      if (meta) {
        if (meta.cwd && !s.cwd) s.cwd = meta.cwd;
        if (meta.title && !s.title) s.title = clip(meta.title, 160);
        if (meta.where) s.where = meta.where;
        if (meta.subagent) s.subagent = true;
        if (meta.parentId) parents.set(d.name, meta.parentId);
        if (meta.status === 'CASCADE_RUN_STATUS_IDLE' && !s.lastStop) s.lastStop = 'end_turn';
        if (meta.status === 'CASCADE_RUN_STATUS_RUNNING') s.lastStop = '';
      }
      byId.set(d.name, s);
    }
  }

  // Histórico do Antigravity CLI (~/.gemini/antigravity-cli/history.jsonl):
  // completa o workspace das sessões já lidas e mantém conversas sem transcript.jsonl
  for (const line of readLines(path.join(root, 'antigravity-cli', 'history.jsonl'))) {
    const r = parse(line);
    if (!r || !r.timestamp) continue;
    const id = r.conversationId || `sem-id-${day(r.timestamp)}`;
    const existing = byId.get(id);
    if (existing && existing.file) {
      if (r.workspace && !existing.cwd) existing.cwd = r.workspace;
      continue;
    }
    const ts = new Date(r.timestamp).toISOString();
    const s = existing || Object.assign(emptySession('Gemini', id, ''), { cwd: r.workspace || '', where: 'antigravity-cli' });
    touch(s, ts);
    prompt(s, r.display || '');
    s.mtime = new Date(s.end).getTime();
    byId.set(id, s);
  }

  // Soma subagentes na conversa pai, como no Claude Code
  for (const s of byId.values()) {
    if (!s.cwd && !s.project) s.project = 'Antigravity';
    if (!s.subagent) { s.subagents = 0; s.subTokens = 0; }
  }
  for (const [id, parentId] of parents) {
    const child = byId.get(id), parent = byId.get(parentId);
    if (!child || !parent) continue;
    parent.subagents++;
    parent.subTokens += child.input + child.output + child.cacheWrite;
  }

  return [...byId.values()];
}

module.exports = { antigravitySessions, parseTranscript, uriToPath };
