// Ações da Base de Memória Compartilhada por projeto e Motor de Dreaming (manual e agendado, cota-aware).
// Camada actions/.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const {
  EDITABLE_MEMORY_FILES,
  MEMORY_FILES,
  DEFAULT_DREAM_ENGINES,
  DREAM_BATCH_SIZE,
  selectDeltaSessions,
  selectDreamBatch,
  buildSessionDigest,
  buildDreamPrompt,
  parseDreamResponse,
  extractDreamUsage,
  formatDreamUsageCompact,
  selectDreamEngine,
  buildBridgeSnippet,
} = require('../../core/memory');
const { redactSecrets } = require('../../core/redact');
const { resolveWorkspaceRoot, hashContent, writeAtomic, writeAtomicWithBackup, resolveSafeContainedTarget } = require('../../infra/workspace-paths');
const { readWorkspaceJson } = require('../../collect/workspace');
const { resolveProjectMemoryDir, readDreamState, readProjectMemory, listAllProjectMemories, collectMemorySessions } = require('../../collect/memory');
const { readProjectGit } = require('../../collect/file-preview');
const { hasExe } = require('../../collect/capabilities');

const BRIDGE_START = '<!-- ai-hud-memory-bridge:start -->';
const BRIDGE_END = '<!-- ai-hud-memory-bridge:end -->';

function postJsonHttp(urlStr, payload, timeoutMs = 120e3) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        resolve(body);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Tempo esgotado no modelo de Dreaming.')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function runCliCapture(exe, args, cwd, exec = execFile, timeout = 120e3, stdinText = null) {
  return new Promise((resolve, reject) => {
    const child = exec(exe, args, { cwd, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim().split(/\r?\n/)[0];
        return reject(new Error(msg || 'Falha ao executar CLI para Dreaming.'));
      }
      resolve(String(stdout || ''));
    });
    if (stdinText !== null && child && child.stdin) {
      try { child.stdin.end(stdinText); } catch {}
    }
  });
}

function createMemoryActions({
  dataDir,
  config,
  collector,
  quotas,
  ollama,
  claudeExe = '',
  codexExe = '',
  agyExe = '',
  exec = execFile,
  runModel = null,
  onDreamDone = null,
  now = () => Date.now(),
  log = console.log,
}) {
  const root = () => resolveWorkspaceRoot(dataDir, config);
  const inFlight = new Set();

  function buildAvailableTools() {
    const ollamaOnline = !!(ollama && ollama.state && ollama.state.online);
    const ollamaModels = ollamaOnline
      ? (Array.isArray(ollama.installedModels) && ollama.installedModels.length
        ? ollama.installedModels
        : (ollama.state.models || []).map((m) => m.name).filter(Boolean))
      : [];
    return {
      Ollama: { available: ollamaOnline && ollamaModels.length > 0, defaultModel: ollamaModels[0] || '' },
      Gemini: { available: hasExe(agyExe), defaultModel: '' },
      Codex: { available: hasExe(codexExe), defaultModel: '' },
      'Claude Code': { available: hasExe(claudeExe), defaultModel: 'haiku' },
    };
  }

  async function executeModel({ engine, model, prompt, cwd }) {
    if (typeof runModel === 'function') return runModel({ engine, model, prompt, cwd });
    const runCwd = cwd && fs.existsSync(cwd) ? cwd : root();
    fs.mkdirSync(runCwd, { recursive: true });

    if (engine === 'Ollama') {
      const base = String((ollama && ollama.url) || config.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
      const raw = await postJsonHttp(`${base}/api/chat`, {
        model,
        stream: false,
        format: 'json',
        messages: [{ role: 'user', content: prompt }],
      });
      const parsed = JSON.parse(raw);
      return { raw, text: (parsed && parsed.message && parsed.message.content) || raw };
    }
    if (engine === 'Gemini') {
      const args = ['--output-format', 'json', '--disable-slash-commands'];
      if (model) args.push('--model', model);
      args.push(`--print=${prompt}`);
      return runCliCapture(agyExe, args, runCwd, exec);
    }
    if (engine === 'Codex') {
      const args = ['exec', '--skip-git-repo-check', '--json', '-C', runCwd];
      if (model) args.push('-m', model);
      args.push('-');
      return runCliCapture(codexExe, args, runCwd, exec, 120e3, prompt);
    }
    if (engine === 'Claude Code') {
      const args = ['-p', '--output-format', 'json'];
      if (model) args.push('--model', model);
      return runCliCapture(claudeExe, args, runCwd, exec, 120e3, prompt);
    }
    throw new Error(`Motor de Dreaming não suportado: ${engine}`);
  }

  function snapshotBackup(memDir, slug) {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const dir = path.join(root(), '.ai-workspace', 'backups', 'memory', slug, stamp);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [...MEMORY_FILES, 'dream-state.json']) {
      const src = path.join(memDir, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
    }
    return dir;
  }

  function saveMemoryFile({ project = '', cwd = '', mode = '', file = '', content = '', baseHash = '' }) {
    if (!EDITABLE_MEMORY_FILES.includes(file)) {
      return { status: 400, body: `Arquivo inválido. Permitidos: ${EDITABLE_MEMORY_FILES.join(', ')}` };
    }
    const resolved = resolveProjectMemoryDir({ workspaceRoot: root(), project, cwd, mode });
    const target = path.join(resolved.dir, file);
    if (fs.existsSync(target)) {
      const currentRaw = fs.readFileSync(target, 'utf8');
      const currentHash = hashContent(currentRaw);
      if (baseHash && baseHash !== currentHash) {
        return {
          status: 409,
          body: {
            error: 'Arquivo de memória foi atualizado (ex.: por um Dreaming) enquanto você editava.',
            currentContent: currentRaw,
            currentHash,
          },
        };
      }
    }
    const clean = file === 'pinned.md' ? String(content || '') : redactSecrets(String(content || '')).text;
    const containmentRoot = resolved.mode === 'in-repo' && cwd ? cwd : root();
    if (containmentRoot && fs.existsSync(containmentRoot)) {
      const check = resolveSafeContainedTarget(containmentRoot, target);
      if (!check.ok) return { status: 403, body: check.error || 'Destino de memória fora da raiz autorizada.' };
    }
    try {
      writeAtomicWithBackup({
        filePath: target,
        content: clean,
        backupDir: path.join(root(), '.ai-workspace', 'backups', 'memory-edits', resolved.slug),
        tag: file,
        rootDir: containmentRoot && fs.existsSync(containmentRoot) ? containmentRoot : '',
      });
    } catch (e) {
      return { status: e.status || 500, body: e.message || 'Falha ao salvar arquivo de memória.' };
    }
    return { status: 200, body: { ok: true, file, mode: resolved.mode, hash: hashContent(clean) } };
  }

  function installBridges({ project = '', cwd = '', mode = 'in-repo' }) {
    if (!cwd || !fs.existsSync(cwd)) return { status: 400, body: 'Pasta do projeto não encontrada neste PC.' };
    const resolved = resolveProjectMemoryDir({ workspaceRoot: root(), project, cwd, mode });
    if (resolved.mode === 'in-repo') {
      const dirCheck = resolveSafeContainedTarget(cwd, '.ai-memory');
      if (!dirCheck.ok) return { status: 403, body: dirCheck.error || 'Pasta .ai-memory fora do projeto.' };
    }
    fs.mkdirSync(resolved.dir, { recursive: true });
    const rel = resolved.mode === 'in-repo' ? '.ai-memory' : resolved.dir.replace(/\\/g, '/');
    const snippet = buildBridgeSnippet(rel);
    const updated = [];
    for (const fname of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      const check = resolveSafeContainedTarget(cwd, fname);
      if (!check.ok) return { status: 403, body: check.error || `Arquivo ${fname} atravessa link fora do projeto.` };
      const fp = check.target;
      let prev = '';
      try { prev = fs.readFileSync(fp, 'utf8'); } catch {}
      let next;
      const sIdx = prev.indexOf(BRIDGE_START);
      const eIdx = prev.indexOf(BRIDGE_END);
      if (sIdx >= 0 && eIdx > sIdx) {
        next = prev.slice(0, sIdx) + snippet + prev.slice(eIdx + BRIDGE_END.length);
      } else {
        next = (prev.trimEnd() ? prev.trimEnd() + '\n\n' : '') + snippet + '\n';
      }
      writeAtomic(fp, next);
      updated.push(fname);
    }
    return { status: 200, body: { ok: true, updated, memoryDir: resolved.dir } };
  }

  function appendUsageLog(entry) {
    try {
      const wsRoot = root();
      fs.mkdirSync(wsRoot, { recursive: true });
      fs.appendFileSync(path.join(wsRoot, 'dream-usage.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
  }

  async function dream({ project = '', cwd = '', mode = '', engine = '', model = '', dryRun = false, force = false, ignoreQuota = false, trigger = 'manual' } = {}) {
    const resolved = resolveProjectMemoryDir({ workspaceRoot: root(), project, cwd, mode });
    if (inFlight.has(resolved.slug)) {
      return { status: 409, body: 'Já existe um Dreaming em andamento para este projeto.' };
    }
    inFlight.add(resolved.slug);
    try {
      const sessions = collectMemorySessions(collector);
      const currentMem = readProjectMemory({ workspaceRoot: root(), project: project || resolved.slug, cwd, mode: resolved.mode, sessions });
      const dreamState = readDreamState(resolved.dir);
      const delta = selectDeltaSessions(sessions, dreamState, { project: project || resolved.slug, cwd, force });
      if (!delta.length) {
        return {
          status: 200,
          body: { ok: true, skipped: true, project: currentMem.project, reason: 'Nenhuma sessão nova desde o último Dreaming.' },
        };
      }

      const dreamCfg = (config && config.dream) || {};
      const availableTools = buildAvailableTools();
      const enginesList = engine ? [engine] : (Array.isArray(dreamCfg.engines) && dreamCfg.engines.length ? dreamCfg.engines : DEFAULT_DREAM_ENGINES);
      const picked = selectDreamEngine({
        engines: enginesList,
        quotas: quotas && quotas.snapshot ? quotas.snapshot() : null,
        availableTools,
        preferredModels: { ...(dreamCfg.models || {}), ...(engine && model ? { [engine]: model } : {}) },
        maxQuotaPct: typeof dreamCfg.maxQuotaPct === 'number' ? dreamCfg.maxQuotaPct : 60,
        ignoreQuota: !!ignoreQuota,
      });
      if (!picked.engine) {
        return {
          status: 200,
          body: { ok: true, skipped: true, project: currentMem.project, reason: `Dreaming adiado: ${picked.reason}` },
        };
      }

      let gitLog = '';
      if (cwd) {
        const g = await readProjectGit(cwd, exec).catch(() => null);
        if (g && g.status === 200 && g.body.commits && g.body.commits.length) {
          gitLog = g.body.commits.map((c) => `${c.hash} (${c.date.slice(0, 10)}) ${c.message}`).join('\n');
        }
      }

      // Lote explícito reutilizado no digest, no estado e nas métricas (R11)
      const batch = selectDreamBatch(delta, DREAM_BATCH_SIZE);
      const remainingCount = Math.max(0, delta.length - batch.length);
      const digest = buildSessionDigest(batch, { maxSessions: batch.length });
      const startedAt = now();
      const prompt = buildDreamPrompt({
        project: currentMem.project,
        existing: {
          pinnedMd: currentMem.files['pinned.md'],
          memoryMd: currentMem.files['MEMORY.md'],
          currentStateMd: currentMem.files['current-state.md'],
          decisionsMd: currentMem.files['decisions.md'],
          pitfallsMd: currentMem.files['pitfalls.md'],
        },
        digest,
        gitLog,
        now: startedAt,
      });

      const modelResult = await executeModel({ engine: picked.engine, model: picked.model, prompt, cwd });
      const rawOutput = typeof modelResult === 'object' && modelResult !== null ? String(modelResult.raw || modelResult.text || '') : String(modelResult || '');
      const textOutput = typeof modelResult === 'object' && modelResult !== null ? String(modelResult.text || modelResult.raw || '') : String(modelResult || '');
      const consolidated = parseDreamResponse(textOutput);
      const ts = now();
      const durationMs = Math.max(0, ts - startedAt);
      const usage = extractDreamUsage(rawOutput, { prompt, outputText: textOutput });
      const usageCompact = formatDreamUsageCompact(usage);
      const durSec = (durationMs / 1000).toFixed(1);
      const engineLabel = `${picked.engine}${picked.model ? '/' + picked.model : ''}`;

      if (dryRun) {
        return {
          status: 200,
          body: {
            ok: true,
            dryRun: true,
            project: currentMem.project,
            engine: picked.engine,
            model: picked.model,
            sessionsProcessed: batch.length,
            remainingCount,
            durationMs,
            usage,
            proposed: consolidated,
          },
        };
      }

      // Confere versões atuais em disco antes de publicar para não sobrescrever edição concorrente (R12)
      const latestMem = readProjectMemory({ workspaceRoot: root(), project: project || resolved.slug, cwd, mode: resolved.mode, sessions });
      const changedFiles = EDITABLE_MEMORY_FILES.filter(
        (fname) => (latestMem.hashes && latestMem.hashes[fname]) !== (currentMem.hashes && currentMem.hashes[fname]),
      );
      if (changedFiles.length) {
        return {
          status: 409,
          body: {
            ok: false,
            conflict: true,
            error: `Memória alterada durante o Dreaming (${changedFiles.join(', ')}). Nenhuma edição foi sobrescrita; rode novamente para consolidar sobre a versão atual.`,
            changedFiles,
            proposed: consolidated,
          },
        };
      }

      fs.mkdirSync(path.join(resolved.dir, 'sessions'), { recursive: true });
      snapshotBackup(resolved.dir, resolved.slug);

      // Nunca toca em pinned.md!
      writeAtomic(path.join(resolved.dir, 'MEMORY.md'), consolidated.memoryMd);
      writeAtomic(path.join(resolved.dir, 'current-state.md'), consolidated.currentStateMd);

      if (consolidated.decisionsAppend) {
        const prev = latestMem.files['decisions.md'].trimEnd();
        const header = prev ? `${prev}\n\n` : '# Decisões Arquiteturais\n\n';
        writeAtomic(path.join(resolved.dir, 'decisions.md'), `${header}${consolidated.decisionsAppend}\n`);
      }
      if (consolidated.pitfallsAppend) {
        const prev = latestMem.files['pitfalls.md'].trimEnd();
        const header = prev ? `${prev}\n\n` : '# Armadilhas e Peculiaridades\n\n';
        writeAtomic(path.join(resolved.dir, 'pitfalls.md'), `${header}${consolidated.pitfallsAppend}\n`);
      }

      const day = new Date(ts).toISOString().slice(0, 10);
      if (consolidated.sessionNoteMd) {
        const epPath = path.join(resolved.dir, 'sessions', `${day}.md`);
        const prevEp = fs.existsSync(epPath) ? fs.readFileSync(epPath, 'utf8').trimEnd() + '\n\n' : `# Sessões — ${day}\n\n`;
        writeAtomic(epPath, `${prevEp}${consolidated.sessionNoteMd}\n`);
      }

      const logLine = `- **${new Date(ts).toISOString()}** · \`${engineLabel}\` · ${batch.length} sessões · ${usageCompact} · ${durSec}s · ${consolidated.summary}`;
      const prevLog = latestMem.files['dream-log.md'].trimEnd();
      const nextLog = (prevLog ? `${prevLog}\n` : '# Histórico de Dreaming\n\n') + logLine + '\n';
      writeAtomic(path.join(resolved.dir, 'dream-log.md'), nextLog);

      const nextSessions = { ...(dreamState.sessions || {}) };
      for (const s of batch) {
        nextSessions[s.id] = {
          endMs: Date.parse(s.end) || ts,
          turns: Array.isArray(s.history) ? s.history.length : (s.prompts || 0),
          tool: s.tool,
        };
      }
      writeAtomic(path.join(resolved.dir, 'dream-state.json'), JSON.stringify({
        lastDreamAt: ts,
        lastEngine: engineLabel,
        lastSummary: consolidated.summary,
        lastUsage: usage,
        sessions: nextSessions,
      }, null, 2) + '\n');

      appendUsageLog({
        at: new Date(ts).toISOString(),
        trigger,
        project: currentMem.project,
        slug: resolved.slug,
        engine: picked.engine,
        model: picked.model || '',
        sessionsProcessed: batch.length,
        remainingCount,
        durationMs,
        ...usage,
        summary: consolidated.summary,
      });

      log(`[dream${trigger === 'auto' ? '-auto' : ''}] ${currentMem.project} · ${engineLabel} · ${batch.length} sessões${remainingCount ? ` (+${remainingCount} restantes)` : ''} · ${usageCompact} · ${durSec}s · ${consolidated.summary}`);

      const body = {
        ok: true,
        project: currentMem.project,
        slug: resolved.slug,
        mode: resolved.mode,
        engine: picked.engine,
        model: picked.model,
        reason: picked.reason,
        sessionsProcessed: batch.length,
        remainingCount,
        durationMs,
        usage,
        summary: consolidated.summary,
      };
      if (typeof onDreamDone === 'function') {
        try { onDreamDone(body); } catch {}
      }
      return { status: 200, body };
    } catch (e) {
      return { status: e.status || 502, body: e.message || 'Falha durante o Dreaming.' };
    } finally {
      inFlight.delete(resolved.slug);
    }
  }

  function undoDream({ project = '', cwd = '', mode = '' }) {
    const resolved = resolveProjectMemoryDir({ workspaceRoot: root(), project, cwd, mode });
    const base = path.join(root(), '.ai-workspace', 'backups', 'memory', resolved.slug);
    let dirs = [];
    try {
      dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    } catch {}
    if (!dirs.length) return { status: 404, body: 'Nenhum backup de Dreaming disponível para restaurar.' };
    const latest = path.join(base, dirs[0]);
    fs.mkdirSync(resolved.dir, { recursive: true });
    let restored = 0;
    for (const f of [...MEMORY_FILES, 'dream-state.json']) {
      if (f === 'pinned.md') continue;
      const src = path.join(latest, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(resolved.dir, f));
        restored++;
      }
    }
    return { status: 200, body: { ok: true, backup: dirs[0], restored } };
  }

  // Executa 1 ciclo do agendador: por padrão (workspaceOnly !== false) consolida apenas projetos cadastrados no AI Workspace.
  async function runScheduledCycle() {
    const sched = (config && config.dream && config.dream.schedule) || {};
    const workspaceOnly = sched.workspaceOnly !== false;
    const wsRoot = root();
    const sessions = collectMemorySessions(collector);
    const ws = readWorkspaceJson(wsRoot);
    const groupMeta = (ws && ws.groupMeta) || {};
    const entities = Array.isArray(ws && ws.entities) ? ws.entities : [];
    const isEntityHidden = (e) => !!(e && (e.hidden || (e.group && groupMeta[e.group] && groupMeta[e.group].hidden)));
    const visibleEntities = entities.filter((e) => !isEntityHidden(e));
    const hiddenNames = new Set(
      entities.filter(isEntityHidden).flatMap((e) => [e.id, e.title].filter(Boolean).map((s) => String(s).toLowerCase())),
    );
    const hiddenCwds = new Set(
      entities.filter(isEntityHidden).flatMap((e) => (e.projectBindings || []).map((b) => String(b.cwd || '').replace(/[\\/]+$/, '').toLowerCase())).filter(Boolean),
    );

    let targets;
    if (workspaceOnly) {
      targets = visibleEntities.map((e) => {
        const firstBinding = Array.isArray(e.projectBindings) && e.projectBindings[0];
        const cwd = firstBinding ? firstBinding.cwd : '';
        const mem = readProjectMemory({ workspaceRoot: wsRoot, project: e.title || e.id, cwd, sessions });
        return { project: e.title || e.id, cwd, pendingCount: mem.pendingCount };
      }).filter((p) => p.pendingCount > 0);
    } else {
      targets = listAllProjectMemories({ workspaceRoot: wsRoot, sessions, workspaceEntities: visibleEntities })
        .filter((p) => {
          if (p.pendingCount <= 0) return false;
          const pName = String(p.project || '').toLowerCase();
          const pCwd = String(p.cwd || '').replace(/[\\/]+$/, '').toLowerCase();
          if (hiddenNames.has(pName) || (pCwd && hiddenCwds.has(pCwd))) return false;
          return true;
        });
    }

    if (!targets.length) {
      log(`[dream-auto] ciclo sem pendências (${workspaceOnly ? `${entities.length} projetos no workspace` : 'todos os projetos'}).`);
      return { processed: 0, totalTokens: 0, results: [] };
    }

    const results = [];
    let totalIn = 0;
    let totalOut = 0;
    let totalCache = 0;
    for (const p of targets) {
      const r = await dream({ project: p.project, cwd: p.cwd, ignoreQuota: false, trigger: 'auto' });
      results.push({ project: p.project, status: r.status, body: r.body });
      if (r.status === 200 && r.body && r.body.usage) {
        totalIn += r.body.usage.inputTokens || 0;
        totalOut += r.body.usage.outputTokens || 0;
        totalCache += r.body.usage.cacheReadTokens || 0;
      } else if (r.status !== 200 || (r.body && r.body.skipped)) {
        log(`[dream-auto] ${p.project}: ${(r.body && r.body.reason) || r.body}`);
      }
    }
    const batchUsage = formatDreamUsageCompact({
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadTokens: totalCache,
      totalTokens: totalIn + totalOut,
      estimated: results.some((x) => x.body && x.body.usage && x.body.usage.estimated),
    });
    log(`[dream-auto] resumo do ciclo: ${results.length} projeto(s) · total ${batchUsage}`);
    return { processed: results.length, totalTokens: totalIn + totalOut, results };
  }

  // Agendador leve fora do horário de trabalho (config.dream.schedule = { enabled: true, hour: 3, workspaceOnly: true })
  let lastAutoDay = '';
  function startScheduler() {
    const sched0 = config && config.dream && config.dream.schedule;
    if (sched0 && sched0.enabled) {
      const h = Number.isInteger(sched0.hour) ? sched0.hour : 3;
      const pct = typeof config.dream.maxQuotaPct === 'number' ? config.dream.maxQuotaPct : 60;
      const scope = sched0.workspaceOnly === false ? 'todos os projetos' : 'somente projetos do AI Workspace';
      log(`[dream-auto] agendado diariamente às ${String(h).padStart(2, '0')}:00 (${scope}, teto cota ${pct}%)`);
    }
    const t = setInterval(async () => {
      const sched = config && config.dream && config.dream.schedule;
      if (!sched || !sched.enabled) return;
      const d = new Date(now());
      const targetHour = Number.isInteger(sched.hour) ? sched.hour : 3;
      const dayKey = d.toISOString().slice(0, 10);
      if (d.getHours() !== targetHour || lastAutoDay === dayKey) return;
      lastAutoDay = dayKey;
      try {
        await runScheduledCycle();
      } catch (e) {
        log(`[dream-auto] erro: ${e.message}`);
      }
    }, 15 * 60e3);
    if (t.unref) t.unref();
    return t;
  }

  return { saveMemoryFile, installBridges, dream, undoDream, runScheduledCycle, startScheduler };
}

module.exports = { createMemoryActions };
