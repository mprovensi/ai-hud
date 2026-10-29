// Antigravity (Gemini): não registra tokens; só o histórico de prompts por conversa
const path = require('path');
const os = require('os');
const { readLines, parse, emptySession, prompt, touch } = require('./common');

const day = (ts) => new Date(ts).toLocaleDateString('sv-SE'); // YYYY-MM-DD no fuso local

function antigravitySessions(home = os.homedir()) {
  const byConv = new Map();
  for (const line of readLines(path.join(home, '.gemini', 'antigravity-cli', 'history.jsonl'))) {
    const r = parse(line);
    if (!r || !r.timestamp) continue;
    const id = r.conversationId || `sem-id-${day(r.timestamp)}`;
    const ts = new Date(r.timestamp).toISOString();
    const s = byConv.get(id) || Object.assign(emptySession('Antigravity', id, ''), { cwd: r.workspace || '' });
    touch(s, ts);
    prompt(s, r.display || '');
    s.mtime = new Date(s.end).getTime();
    byConv.set(id, s);
  }
  return [...byConv.values()];
}

module.exports = { antigravitySessions };
