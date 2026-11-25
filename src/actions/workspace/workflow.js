// Ações de workflow EGM Lite (revisão Goldfish isolada + estruturação opcional por IA com estimativa prévia e log de tokens — camada actions/).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const {
  DEFAULT_DREAM_ENGINES,
  selectDreamEngine,
  extractDreamUsage,
  formatDreamUsageCompact,
} = require('../../core/memory');
const {
  classifyEgmComplexity,
  defaultModelForEgmTier,
  buildGoldfishReviewPrompt,
  parseGoldfishReview,
  buildStructureFromDocsPrompt,
  parseStructuredItems,
  buildRunConfigPrompt,
  parseRunConfigFromAi,
  estimateTokens,
} = require('../../core/egm');
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { hasExe } = require('../../collect/capabilities');

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
    req.on('timeout', () => { req.destroy(); reject(new Error('Tempo esgotado no motor EGM Lite.')); });
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
        return reject(new Error(msg || 'Falha ao executar CLI para workflow EGM.'));
      }
      resolve(String(stdout || ''));
    });
    if (stdinText !== null && child && child.stdin) {
      try { child.stdin.end(stdinText); } catch {}
    }
  });
}

function createWorkspaceWorkflow({
  dataDir,
  config,
  quotas,
  ollama,
  claudeExe = '',
  codexExe = '',
  agyExe = '',
  exec = execFile,
  runModel = null,
  now = () => Date.now(),
  log = console.log,
}) {
  const root = () => resolveWorkspaceRoot(dataDir, config);

  function buildAvailableTools(tier = 'standard') {
    const ollamaOnline = !!(ollama && ollama.state && ollama.state.online);
    const ollamaModels = ollamaOnline
      ? (Array.isArray(ollama.installedModels) && ollama.installedModels.length
        ? ollama.installedModels
        : (ollama.state.models || []).map((m) => m.name).filter(Boolean))
      : [];
    return {
      Ollama: { available: ollamaOnline && ollamaModels.length > 0, defaultModel: defaultModelForEgmTier('Ollama', tier, { ollamaModels }) },
      Gemini: { available: hasExe(agyExe), defaultModel: defaultModelForEgmTier('Gemini', tier) },
      Codex: { available: hasExe(codexExe), defaultModel: defaultModelForEgmTier('Codex', tier) },
      'Claude Code': { available: hasExe(claudeExe), defaultModel: defaultModelForEgmTier('Claude Code', tier) },
    };
  }

  function pickEngine({ engine = '', model = '', tier = 'standard', ignoreQuota = false } = {}) {
    const dreamCfg = (config && config.dream) || {};
    const tierModels = (dreamCfg.tierModels && dreamCfg.tierModels[tier]) || {};
    // Em tarefas complexas, evita herdar `haiku` do Dreaming noturno caso o usuário não tenha passado modelo explícito
    const baseModels = tier === 'simple' ? { ...(dreamCfg.models || {}) } : {};
    const preferredModels = {
      ...baseModels,
      ...tierModels,
      ...(engine && model ? { [engine]: model } : {}),
    };
    // Para revisões Goldfish complexas, prioriza motores de raciocínio (Claude/Codex/Gemini) antes do Ollama local se não houver override
    const defaultOrder = tier === 'complex'
      ? ['Claude Code', 'Codex', 'Gemini', 'Ollama']
      : DEFAULT_DREAM_ENGINES;
    const enginesList = engine
      ? [engine]
      : (Array.isArray(dreamCfg.engines) && dreamCfg.engines.length && tier === 'simple' ? dreamCfg.engines : defaultOrder);
    return selectDreamEngine({
      engines: enginesList,
      quotas: quotas && quotas.snapshot ? quotas.snapshot() : null,
      availableTools: buildAvailableTools(tier),
      preferredModels,
      maxQuotaPct: typeof dreamCfg.maxQuotaPct === 'number' ? dreamCfg.maxQuotaPct : 75,
      ignoreQuota: !!ignoreQuota,
    });
  }

  async function executeModel({ engine, model, prompt }) {
    if (typeof runModel === 'function') return runModel({ engine, model, prompt });
    const runCwd = root();
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
    throw new Error(`Motor não suportado: ${engine}`);
  }

  function appendUsage(entry) {
    try {
      const wsRoot = root();
      fs.mkdirSync(wsRoot, { recursive: true });
      fs.appendFileSync(path.join(wsRoot, 'workflow-usage.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
  }

  async function reviewSpec({ project = '', docPath = '', docContent = '', pinnedMd = '', memoryMd = '', engine = '', model = '', dryRun = false, ignoreQuota = true } = {}) {
    if (!String(docContent || '').trim()) {
      return { status: 400, body: 'O documento está vazio — escreva ao menos o objetivo antes de pedir revisão Goldfish.' };
    }
    const complexity = classifyEgmComplexity({ kind: 'goldfish-review', docContent });
    const picked = pickEngine({ engine, model, tier: complexity.tier, ignoreQuota });
    const prompt = buildGoldfishReviewPrompt({ project, docPath, docContent, pinnedMd, memoryMd });
    const estIn = estimateTokens(prompt.length);
    const estOut = 500;

    if (dryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          docPath,
          engine: picked.engine || '',
          model: picked.model || '',
          complexity: complexity.tier,
          complexityReason: complexity.reason,
          reason: picked.reason,
          available: !!picked.engine,
          estimatedInputTokens: estIn,
          estimatedOutputTokens: estOut,
          estimatedTotalTokens: estIn + estOut,
          promptChars: prompt.length,
        },
      };
    }

    if (!picked.engine) {
      return { status: 503, body: `Nenhum motor disponível para revisão Goldfish (${picked.reason}).` };
    }

    const startedAt = now();
    try {
      const modelRes = await executeModel({ engine: picked.engine, model: picked.model, prompt });
      const rawOut = typeof modelRes === 'object' && modelRes !== null ? String(modelRes.raw || modelRes.text || '') : String(modelRes || '');
      const textOut = typeof modelRes === 'object' && modelRes !== null ? String(modelRes.text || modelRes.raw || '') : String(modelRes || '');
      const ts = now();
      const durationMs = Math.max(0, ts - startedAt);
      const usage = extractDreamUsage(rawOut, { prompt, outputText: textOut });
      const usageCompact = formatDreamUsageCompact(usage);
      const engineLabel = `${picked.engine}${picked.model ? '/' + picked.model : ''}`;

      const parsed = parseGoldfishReview(textOut, { docPath, engine: engineLabel, usageCompact, at: ts });
      appendUsage({
        at: new Date(ts).toISOString(),
        kind: 'goldfish-review',
        project,
        docPath,
        engine: picked.engine,
        model: picked.model || '',
        complexity: complexity.tier,
        verdict: parsed.verdict,
        durationMs,
        ...usage,
      });
      log(`[egm-goldfish] ${project} (${docPath}) · ${complexity.tier} · ${engineLabel} · ${parsed.verdict} · ${usageCompact} · ${(durationMs / 1000).toFixed(1)}s`);

      return {
        status: 200,
        body: {
          ok: true,
          docPath,
          engine: picked.engine,
          model: picked.model || '',
          complexity: complexity.tier,
          complexityReason: complexity.reason,
          durationMs,
          usage,
          ...parsed,
        },
      };
    } catch (e) {
      log(`[egm-goldfish] erro em ${project} (${docPath}): ${e.message}`);
      return { status: e.status || 502, body: e.message || 'Falha durante a revisão Goldfish.' };
    }
  }

  async function structureDocsWithAi({ project = '', docs = [], engine = '', model = '', dryRun = false, ignoreQuota = true } = {}) {
    if (!Array.isArray(docs) || !docs.length) {
      return { status: 400, body: 'Selecione ao menos um documento para estruturar.' };
    }
    const joinedDocs = docs.map((d) => d.content || '').join('\n');
    const complexity = classifyEgmComplexity({ kind: 'structure-from-docs', docContent: joinedDocs, docCount: docs.length });
    const picked = pickEngine({ engine, model, tier: complexity.tier, ignoreQuota });
    const prompt = buildStructureFromDocsPrompt({ project, docs });
    const estIn = estimateTokens(prompt.length);
    const estOut = 900;

    if (dryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          docCount: docs.length,
          engine: picked.engine || '',
          model: picked.model || '',
          complexity: complexity.tier,
          complexityReason: complexity.reason,
          reason: picked.reason,
          available: !!picked.engine,
          estimatedInputTokens: estIn,
          estimatedOutputTokens: estOut,
          estimatedTotalTokens: estIn + estOut,
          promptChars: prompt.length,
        },
      };
    }

    if (!picked.engine) {
      return { status: 503, body: `Nenhum motor disponível (${picked.reason}).` };
    }

    const startedAt = now();
    try {
      const modelRes = await executeModel({ engine: picked.engine, model: picked.model, prompt });
      const rawOut = typeof modelRes === 'object' && modelRes !== null ? String(modelRes.raw || modelRes.text || '') : String(modelRes || '');
      const textOut = typeof modelRes === 'object' && modelRes !== null ? String(modelRes.text || modelRes.raw || '') : String(modelRes || '');
      const ts = now();
      const durationMs = Math.max(0, ts - startedAt);
      const usage = extractDreamUsage(rawOut, { prompt, outputText: textOut });
      const usageCompact = formatDreamUsageCompact(usage);
      const engineLabel = `${picked.engine}${picked.model ? '/' + picked.model : ''}`;

      const items = parseStructuredItems(textOut);
      appendUsage({
        at: new Date(ts).toISOString(),
        kind: 'structure-from-docs',
        project,
        docCount: docs.length,
        itemsGenerated: items.length,
        engine: picked.engine,
        model: picked.model || '',
        complexity: complexity.tier,
        durationMs,
        ...usage,
      });
      log(`[egm-structure] ${project} (${docs.length} docs) · ${complexity.tier} · ${engineLabel} · ${items.length} itens · ${usageCompact} · ${(durationMs / 1000).toFixed(1)}s`);

      return {
        status: 200,
        body: {
          ok: true,
          engine: picked.engine,
          model: picked.model || '',
          complexity: complexity.tier,
          complexityReason: complexity.reason,
          durationMs,
          usage,
          items,
        },
      };
    } catch (e) {
      log(`[egm-structure] erro em ${project}: ${e.message}`);
      return { status: e.status || 502, body: e.message || 'Falha ao estruturar documentos com IA.' };
    }
  }

  async function configureRunWithAi({ project = '', cwd = '', snapshotText = '', detected = null, engine = '', model = '', ignoreQuota = true } = {}) {
    const complexity = classifyEgmComplexity({ kind: 'run-config', docContent: snapshotText });
    const picked = pickEngine({ engine, model, tier: complexity.tier, ignoreQuota });
    if (!picked.engine) {
      return { status: 503, body: `Nenhum motor disponível para configurar Play (${picked.reason}).` };
    }
    const prompt = buildRunConfigPrompt({ project, cwd, snapshotText, detected });
    const startedAt = now();
    try {
      const modelRes = await executeModel({ engine: picked.engine, model: picked.model, prompt });
      const rawOut = typeof modelRes === 'object' && modelRes !== null ? String(modelRes.raw || modelRes.text || '') : String(modelRes || '');
      const textOut = typeof modelRes === 'object' && modelRes !== null ? String(modelRes.text || modelRes.raw || '') : String(modelRes || '');
      const ts = now();
      const durationMs = Math.max(0, ts - startedAt);
      const usage = extractDreamUsage(rawOut, { prompt, outputText: textOut });
      const usageCompact = formatDreamUsageCompact(usage);
      const engineLabel = `${picked.engine}${picked.model ? '/' + picked.model : ''}`;
      const runConfig = parseRunConfigFromAi(textOut);

      appendUsage({
        at: new Date(ts).toISOString(),
        kind: 'run-config',
        project,
        engine: picked.engine,
        model: picked.model || '',
        complexity: complexity.tier,
        durationMs,
        ...usage,
      });
      log(`[egm-run-config] ${project} · ${complexity.tier} · ${engineLabel} · ${usageCompact} · ${(durationMs / 1000).toFixed(1)}s`);

      return {
        status: 200,
        body: {
          ok: true,
          engine: picked.engine,
          model: picked.model || '',
          complexity: complexity.tier,
          durationMs,
          usage,
          config: runConfig,
        },
      };
    } catch (e) {
      log(`[egm-run-config] erro em ${project}: ${e.message}`);
      return { status: e.status || 502, body: e.message || 'Falha ao gerar configuração Play via IA.' };
    }
  }

  return { reviewSpec, structureDocsWithAi, configureRunWithAi };
}

module.exports = { createWorkspaceWorkflow };
