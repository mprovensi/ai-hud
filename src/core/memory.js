// Regras puras da Base de Memória Compartilhada entre IAs por projeto e do Dreaming (camada core: sem I/O).
const { normalizePath, samePath } = require('./path-guard');
const { redactSecrets } = require('./redact');

const MEMORY_MAX_LINES = 150;
const MEMORY_FILES = Object.freeze(['MEMORY.md', 'current-state.md', 'pinned.md', 'decisions.md', 'pitfalls.md', 'dream-log.md']);
const EDITABLE_MEMORY_FILES = Object.freeze(['MEMORY.md', 'current-state.md', 'pinned.md', 'decisions.md', 'pitfalls.md']);
const DEFAULT_DREAM_ENGINES = Object.freeze(['Ollama', 'Gemini', 'Codex', 'Claude Code']);

function projectSlug(projectOrCwd) {
  const raw = String(projectOrCwd || '').trim().replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
  const base = raw.includes('/') || raw.includes('\\') ? raw.split(/[\\/]/).filter(Boolean).pop() : raw;
  return String(base || 'geral')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'geral';
}

function enforceLineCap(markdown, maxLines = MEMORY_MAX_LINES) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (lines.length <= maxLines) return lines.join('\n') + '\n';
  const kept = lines.slice(0, Math.max(10, maxLines - 2));
  kept.push('');
  kept.push(`*(resumido ao limite de ${maxLines} linhas — detalhes em decisions.md, pitfalls.md e sessions/)*`);
  return kept.join('\n') + '\n';
}

function sessionMatchesProject(s, { project = '', cwd = '' } = {}) {
  if (!s || s.subagent) return false;
  if (cwd && s.cwd && samePath(s.cwd, cwd)) return true;
  if (project) {
    const targetSlug = projectSlug(project);
    if (s.project && projectSlug(s.project) === targetSlug) return true;
    if (s.cwd && projectSlug(s.cwd) === targetSlug) return true;
  }
  return false;
}

function selectDeltaSessions(sessions, dreamState, { project = '', cwd = '', force = false } = {}) {
  const prevMap = (dreamState && dreamState.sessions) || {};
  const out = [];
  for (const s of sessions || []) {
    if (!sessionMatchesProject(s, { project, cwd })) continue;
    const endMs = Date.parse(s.end) || 0;
    const turns = Array.isArray(s.history) ? s.history.length : (s.prompts || 0);
    const hasContent = !!(turns || s.lastPrompt || s.lastReply || (s.files && Object.keys(s.files).length));
    if (!hasContent) continue;
    const prev = prevMap[s.id];
    if (force || !prev || endMs > (prev.endMs || 0) || turns > (prev.turns || 0)) {
      out.push(s);
    }
  }
  out.sort((a, b) => (Date.parse(a.end) || 0) - (Date.parse(b.end) || 0));
  return out;
}

function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

const DREAM_BATCH_SIZE = 12;

function selectDreamBatch(sessions, maxSessions = DREAM_BATCH_SIZE) {
  const list = Array.isArray(sessions) ? sessions : [];
  const limit = Math.max(1, Number(maxSessions) || DREAM_BATCH_SIZE);
  // Processa em ordem cronológica (mais antigas primeiro) para nunca descartar sessões acima do lote (R11)
  return list.slice(0, limit);
}

function buildSessionDigest(sessions, { maxSessions = DREAM_BATCH_SIZE, maxTurnsPerSession = 8 } = {}) {
  const picked = selectDreamBatch(sessions, maxSessions);
  const blocks = [];
  for (const s of picked) {
    const day = (s.end || s.start || '').slice(0, 10) || 'sem-data';
    const header = `### [${s.tool} · ${day}] id=${s.id}${s.machine ? ` (${s.machine})` : ''}`;
    const parts = [header];
    if (s.title || s.firstPrompt) parts.push(`Objetivo: ${clip(s.title || s.firstPrompt, 240)}`);
    const files = Object.keys(s.files || {}).slice(-15);
    if (files.length) parts.push(`Arquivos modificados: ${files.join(', ')}`);
    if (s.testRun) parts.push(`Testes: ${s.testRun.ok ? 'PASSOU' : 'FALHOU'} (${clip(s.testRun.command || '', 120)})`);
    const hist = Array.isArray(s.history) && s.history.length
      ? s.history.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).slice(-maxTurnsPerSession)
      : [];
    if (hist.length) {
      for (const m of hist) {
        parts.push(`${m.role === 'user' ? 'User' : s.tool}: ${clip(m.content, m.role === 'user' ? 350 : 650)}`);
      }
    } else {
      if (s.lastPrompt) parts.push(`User: ${clip(s.lastPrompt, 350)}`);
      if (s.lastReply) parts.push(`${s.tool}: ${clip(s.lastReply, 650)}`);
    }
    blocks.push(parts.join('\n'));
  }
  return redactSecrets(blocks.join('\n\n')).text;
}

function buildDreamPrompt({ project, existing = {}, digest = '', gitLog = '', now = Date.now() }) {
  const day = new Date(now).toISOString().slice(0, 10);
  return [
    `Você é o consolidador de memória ("Dreaming") do projeto "${project}" (${day}).`,
    'Sua tarefa é consolidar o que várias IAs (Claude, Codex, Gemini/Antigravity, Ollama) fizeram nas sessões recentes em uma base de memória compartilhada, limpa, objetiva e sem segredos.',
    '',
    'REGRAS OBRIGATÓRIAS:',
    `1. Responda APENAS com um objeto JSON válido (sem texto antes ou depois).`,
    `2. "memoryMd": resumo vivo COMPACTO do projeto em Markdown, NO MÁXIMO ${MEMORY_MAX_LINES} linhas. Deve conter arquitetura essencial, convenções críticas, comandos úteis e pontos ativos.`,
    '3. "currentStateMd": estado atual enxuto (branch, o que está em andamento, pendências abertas). REMOVA itens já concluídos/commitados no git log abaixo (esquecimento ativo!).',
    '4. "decisionsAppend": apenas NOVAS decisões arquiteturais relevantes (Markdown com bullet points e origem ex. `[Claude 2026-11-23]`), ou "" se não houver novidade.',
    '5. "pitfallsAppend": apenas NOVAS armadilhas/bugs/peculiaridades do ambiente com causa e solução, ou "" se não houver novidade.',
    '6. "sessionNoteMd": resumo episódico curto do que foi feito neste ciclo para arquivo histórico.',
    '7. "summary": resumo de 1 linha das mudanças desta consolidação (ex.: "+2 decisões, -3 pendências concluídas").',
    '8. NUNCA inclua senhas, API keys, tokens ou segredos. Respeite as regras fixadas em pinned.md (que são imutáveis).',
    '',
    'Esquema JSON exato:',
    '{"memoryMd":"...","currentStateMd":"...","decisionsAppend":"...","pitfallsAppend":"...","sessionNoteMd":"...","summary":"..."}',
    '',
    '--- PINNED (IMUTÁVEL) ---',
    clip(existing.pinnedMd || '(vazio)', 2500),
    '--- MEMORY.md ATUAL ---',
    clip(existing.memoryMd || '(vazio)', 4500),
    '--- current-state.md ATUAL ---',
    clip(existing.currentStateMd || '(vazio)', 2500),
    '--- decisions.md ATUAL (trecho recente) ---',
    clip(existing.decisionsMd || '(vazio)', 2500),
    '--- pitfalls.md ATUAL (trecho recente) ---',
    clip(existing.pitfallsMd || '(vazio)', 2500),
    '--- GIT LOG RECENTE ---',
    clip(gitLog || '(indisponível)', 1500),
    '--- SESSÕES NOVAS (DELTA) ---',
    clip(digest || '(sem sessões)', 12000),
  ].join('\n');
}

function tryJson(str) {
  try {
    const obj = JSON.parse(str);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch { return null; }
}

function extractTextFromCliStream(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const whole = tryJson(s);
  if (whole) {
    if (whole.memoryMd !== undefined) return s;
    if (typeof whole.response === 'string') return whole.response;
    if (typeof whole.result === 'string') return whole.result;
  }
  // Tenta extrair de JSONL (Codex `--json`, Antigravity `--output-format json|stream-json` ou Claude `--output-format json`)
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const chunks = [];
  let jsonLines = 0;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    const obj = tryJson(line);
    if (!obj) continue;
    jsonLines++;
    if (obj.memoryMd !== undefined) return line;
    if (typeof obj.response === 'string') chunks.push(obj.response);
    else if (typeof obj.result === 'string') chunks.push(obj.result);
    else if (typeof obj.text === 'string') chunks.push(obj.text);
    else if (obj.item && typeof obj.item.text === 'string') chunks.push(obj.item.text);
    else if (obj.message && typeof obj.message.content === 'string') chunks.push(obj.message.content);
  }
  return jsonLines > 0 && chunks.length ? chunks.join('\n') : s;
}

function parseDreamResponse(raw) {
  const text = extractTextFromCliStream(raw);
  let obj = tryJson(text);
  if (!obj) {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
    if (fenced) obj = tryJson(fenced[1].trim());
  }
  if (!obj) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) obj = tryJson(text.slice(start, end + 1));
  }
  if (!obj || typeof obj.memoryMd !== 'string' || !obj.memoryMd.trim()) {
    throw Object.assign(new Error('O modelo de Dreaming não retornou um JSON estruturado válido.'), { status: 502 });
  }
  const clean = (v) => redactSecrets(String(v || '').trim()).text;
  return {
    memoryMd: enforceLineCap(clean(obj.memoryMd), MEMORY_MAX_LINES),
    currentStateMd: clean(obj.currentStateMd || '# Estado atual\n\n(sem pendências abertas)') + '\n',
    decisionsAppend: clean(obj.decisionsAppend || ''),
    pitfallsAppend: clean(obj.pitfallsAppend || ''),
    sessionNoteMd: clean(obj.sessionNoteMd || ''),
    summary: clip(clean(obj.summary || 'Memória consolidada.'), 200),
  };
}

function numOrZero(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

// Extrai contagem real de tokens retornada por Ollama, Claude (--output-format json), Codex (--json) ou Gemini (stream-json).
// Quando a CLI não expõe telemetria de uso, estima por caracteres (~4 chars/token) e marca estimated: true.
function extractDreamUsage(raw, { prompt = '', outputText = '' } = {}) {
  const promptChars = String(prompt || '').length;
  const outputChars = String(outputText || '').length;
  const text = String(raw || '').trim();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = null;
  let found = false;

  const inspectObj = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    // Ollama /api/chat
    if (typeof obj.prompt_eval_count === 'number' || typeof obj.eval_count === 'number') {
      inputTokens = numOrZero(obj.prompt_eval_count);
      outputTokens = numOrZero(obj.eval_count);
      found = true;
    }
    // Claude Code (--output-format json) ou Codex (turn.completed -> usage) ou stream-json genérico
    const u = obj.usage || obj.usageMetadata || (obj.response && obj.response.usageMetadata) || (obj.message && obj.message.usage);
    if (u && typeof u === 'object') {
      const inp = numOrZero(u.input_tokens ?? u.promptTokenCount ?? u.prompt_tokens);
      const out = numOrZero(u.output_tokens ?? u.candidatesTokenCount ?? u.completion_tokens);
      const cache = numOrZero(u.cache_read_input_tokens ?? u.cache_read_tokens ?? u.cached_input_tokens ?? u.cachedContentTokenCount ?? u.cache_creation_input_tokens);
      if (inp > 0 || out > 0 || cache > 0) {
        inputTokens = inp;
        outputTokens = out;
        cacheReadTokens = cache;
        found = true;
      }
    }
    if (typeof obj.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd)) {
      costUsd = Math.round(obj.total_cost_usd * 1e6) / 1e6;
    }
  };

  if (text) {
    const whole = tryJson(text);
    if (whole) inspectObj(whole);
    else {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        inspectObj(tryJson(t));
      }
    }
  }

  const estimated = !found;
  if (estimated) {
    inputTokens = promptChars ? Math.ceil(promptChars / 4) : 0;
    outputTokens = outputChars ? Math.ceil(outputChars / 4) : 0;
  }
  const totalTokens = inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
    costUsd,
    estimated,
    promptChars,
    outputChars,
  };
}

function fmtTok(n) {
  const v = numOrZero(n);
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

function formatDreamUsageCompact(u) {
  if (!u || typeof u !== 'object') return '0 tok';
  const cachePart = u.cacheReadTokens > 0 ? ` / cache ${fmtTok(u.cacheReadTokens)}` : '';
  const tag = u.estimated ? 'est.' : 'real';
  const costPart = typeof u.costUsd === 'number' && u.costUsd > 0 ? `, $${u.costUsd.toFixed(4)}` : '';
  return `${fmtTok(u.totalTokens)} tok (in ${fmtTok(u.inputTokens)} / out ${fmtTok(u.outputTokens)}${cachePart}, ${tag}${costPart})`;
}

function maxQuotaUsedPct(tool, quotas) {
  if (!quotas || typeof quotas !== 'object') return null;
  const key = tool === 'Claude Code' ? 'claude' : tool === 'Codex' ? 'codex' : tool === 'Gemini' ? 'gemini' : null;
  if (!key || !quotas[key] || !quotas[key].windows) return null;
  const wins = Object.values(quotas[key].windows).filter((w) => w && typeof w.used === 'number');
  if (!wins.length) return null;
  return Math.max(...wins.map((w) => w.used));
}

function selectDreamEngine({
  engines = DEFAULT_DREAM_ENGINES,
  quotas = null,
  availableTools = {},
  preferredModels = {},
  maxQuotaPct = 60,
  ignoreQuota = false,
} = {}) {
  const skipped = [];
  for (const engine of engines) {
    const info = availableTools[engine];
    if (!info || !info.available) {
      skipped.push(`${engine}: indisponível`);
      continue;
    }
    if (engine === 'Ollama') {
      const model = preferredModels.Ollama || info.defaultModel || '';
      if (!model) { skipped.push('Ollama: sem modelo instalado'); continue; }
      return { engine: 'Ollama', model, reason: 'Ollama local (custo zero de cota)' };
    }
    const used = maxQuotaUsedPct(engine, quotas);
    if (!ignoreQuota && used !== null && used >= maxQuotaPct) {
      skipped.push(`${engine}: cota em ${Math.round(used)}% (teto ${maxQuotaPct}%)`);
      continue;
    }
    const model = preferredModels[engine] || info.defaultModel || '';
    const note = used !== null ? `cota em ${Math.round(used)}%` : 'cota não reportada';
    return { engine, model, reason: `${engine} (${note})` };
  }
  return { engine: null, model: '', reason: skipped.length ? skipped.join('; ') : 'nenhum motor configurado' };
}

function buildBridgeSnippet(memoryRelDir = '.ai-memory') {
  const dir = normalizePath(memoryRelDir, 'linux').replace(/\/+$/, '');
  return [
    '<!-- ai-hud-memory-bridge:start -->',
    '## Memória Compartilhada e Quadro do Projeto (AI HUD)',
    `Antes de iniciar, consulte \`${dir}/pinned.md\`, \`${dir}/MEMORY.md\` e \`${dir}/current-state.md\`.`,
    `Quando relevante, consulte histórico em \`${dir}/decisions.md\`, \`${dir}/pitfalls.md\` e \`${dir}/sessions/\`.`,
    'O Quadro do projeto fica em `.ai-workspace/board.card.json` (`ai-card` v1; status: `idea`, `spec`, `in-progress`, `review`, `done`). Quando solicitado a auditar ou concluir tarefas, prefira as tools MCP `board_read` / `board_update_status` (ou atualize o JSON preservando o schema e os checkboxes `- [x]` em `docRef`).',
    '<!-- ai-hud-memory-bridge:end -->',
  ].join('\n');
}

function formatMemoryContextBlock({ pinnedMd = '', memoryMd = '', currentStateMd = '' }) {
  const parts = [];
  if (pinnedMd.trim()) parts.push(`## Regras Fixadas (pinned)\n${pinnedMd.trim()}`);
  if (memoryMd.trim()) parts.push(`## Memória do Projeto\n${memoryMd.trim()}`);
  if (currentStateMd.trim()) parts.push(`## Estado Atual\n${currentStateMd.trim()}`);
  return parts.join('\n\n');
}

module.exports = {
  MEMORY_MAX_LINES,
  MEMORY_FILES,
  EDITABLE_MEMORY_FILES,
  DEFAULT_DREAM_ENGINES,
  DREAM_BATCH_SIZE,
  projectSlug,
  enforceLineCap,
  sessionMatchesProject,
  selectDeltaSessions,
  selectDreamBatch,
  buildSessionDigest,
  buildDreamPrompt,
  parseDreamResponse,
  extractDreamUsage,
  formatDreamUsageCompact,
  maxQuotaUsedPct,
  selectDreamEngine,
  buildBridgeSnippet,
  formatMemoryContextBlock,
};
