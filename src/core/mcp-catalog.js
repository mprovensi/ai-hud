// Camada core/ (100% pura, sem I/O): catálogo unificado de servidores MCP compartilhados
// entre Claude Code (~/.claude.json / .mcp.json), Codex CLI (~/.codex/config.toml) e Antigravity (~/.gemini/antigravity/mcp_config.json).

const MCP_TARGETS = ['claude', 'codex', 'antigravity'];
const SECRET_KEY_RE = /(?:token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|auth|credential|cookie|bearer)/i;
const PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function isSecretEnvKey(key) {
  return SECRET_KEY_RE.test(String(key || ''));
}

function slugifyMcpId(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function defaultCatalog() {
  return {
    format: 'ai-mcp-catalog',
    version: 1,
    managedIds: [],
    servers: [],
  };
}

function normalizeTargets(t) {
  if (Array.isArray(t)) {
    const set = new Set(t.map((x) => String(x || '').toLowerCase()));
    return {
      claude: set.has('claude'),
      codex: set.has('codex'),
      antigravity: set.has('antigravity'),
    };
  }
  const obj = t && typeof t === 'object' ? t : {};
  return {
    claude: obj.claude !== false,
    codex: obj.codex !== false,
    antigravity: obj.antigravity !== false,
  };
}

function normalizeServer(raw) {
  if (!raw || typeof raw !== 'object') throw Object.assign(new Error('Servidor MCP inválido.'), { status: 400 });
  const id = slugifyMcpId(raw.id || raw.name);
  if (!id) throw Object.assign(new Error('Informe um identificador válido para o MCP (ex.: github, figma).'), { status: 400 });

  const transport = raw.transport === 'http' || raw.type === 'http' || raw.type === 'sse' || (!raw.command && (raw.url || raw.serverUrl))
    ? 'http'
    : 'stdio';

  const command = String(raw.command || '').trim();
  const args = Array.isArray(raw.args)
    ? raw.args.map((a) => String(a)).filter((a) => a.length > 0)
    : [];
  const url = String(raw.url || raw.serverUrl || '').trim();

  if (transport === 'stdio' && !command) {
    throw Object.assign(new Error(`MCP "${id}" (stdio) precisa de um comando (ex.: npx, node, uvx).`), { status: 400 });
  }
  if (transport === 'http' && !/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error(`MCP "${id}" (http) precisa de uma URL http:// ou https:// válida.`), { status: 400 });
  }

  const env = {};
  if (raw.env && typeof raw.env === 'object') {
    for (const [k, v] of Object.entries(raw.env)) {
      const ck = String(k || '').trim();
      if (!ck || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ck)) continue;
      env[ck] = String(v == null ? '' : v);
    }
  }

  const headers = {};
  if (raw.headers && typeof raw.headers === 'object') {
    for (const [k, v] of Object.entries(raw.headers)) {
      const ck = String(k || '').trim();
      if (!ck) continue;
      headers[ck] = String(v == null ? '' : v);
    }
  }

  const machines = Array.isArray(raw.machines)
    ? [...new Set(raw.machines.map((m) => String(m || '').trim()).filter(Boolean))]
    : [];

  return {
    id,
    name: String(raw.name || id).trim().slice(0, 120),
    description: String(raw.description || '').trim().slice(0, 400),
    transport,
    ...(transport === 'stdio' ? { command, args } : { url }),
    ...(Object.keys(env).length ? { env } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    enabled: raw.enabled !== false,
    targets: normalizeTargets(raw.targets),
    machines,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function validateCatalog(raw) {
  if (!raw || typeof raw !== 'object') return defaultCatalog();
  const seen = new Set();
  const servers = [];
  for (const s of Array.isArray(raw.servers) ? raw.servers : []) {
    try {
      const norm = normalizeServer(s);
      if (seen.has(norm.id)) continue;
      seen.add(norm.id);
      servers.push(norm);
    } catch {}
  }
  const managed = new Set(Array.isArray(raw.managedIds) ? raw.managedIds.map(slugifyMcpId).filter(Boolean) : []);
  for (const s of servers) managed.add(s.id);
  return {
    format: 'ai-mcp-catalog',
    version: 1,
    managedIds: [...managed],
    servers,
  };
}

// Separa segredos de `env`/`headers` em referências `${VAR}` para manter `mcp-servers.json` seguro no Git.
function extractSecretRefs(map = {}, serverId = '') {
  const clean = {};
  const secrets = {};
  for (const [k, rawVal] of Object.entries(map || {})) {
    const val = String(rawVal == null ? '' : rawVal);
    const ph = PLACEHOLDER_RE.exec(val);
    if (ph) {
      clean[k] = val;
      continue;
    }
    if (isSecretEnvKey(k) && val) {
      const refName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)
        ? k
        : `${slugifyMcpId(serverId).replace(/-/g, '_').toUpperCase()}_${k.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
      clean[k] = `\${${refName}}`;
      secrets[refName] = val;
    } else {
      clean[k] = val;
    }
  }
  return { clean, secrets };
}

function expandTemplateString(str, { secrets = {}, env = {}, aiHudRoot = '' } = {}) {
  let out = String(str == null ? '' : str);
  if (aiHudRoot) {
    const cleanRoot = String(aiHudRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    out = out.replace(/\{\{AI_HUD_ROOT\}\}/g, cleanRoot);
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
    if (Object.prototype.hasOwnProperty.call(secrets, name) && secrets[name] !== '') return String(secrets[name]);
    if (Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined) return String(env[name]);
    return full;
  });
  return out;
}

function listServerSecretKeys(server) {
  const refs = new Set();
  for (const map of [server.env || {}, server.headers || {}]) {
    for (const [k, v] of Object.entries(map)) {
      const m = PLACEHOLDER_RE.exec(String(v || ''));
      if (m) refs.add(m[1]);
      else if (isSecretEnvKey(k)) refs.add(k);
    }
  }
  return [...refs];
}

function isServerActiveFor(server, target, machineName = '') {
  if (!server || server.enabled === false) return false;
  if (!server.targets || !server.targets[target]) return false;
  if (Array.isArray(server.machines) && server.machines.length > 0 && machineName) {
    return server.machines.includes(machineName);
  }
  return true;
}

function expandServerForSync(server, ctx = {}) {
  const expand = (s) => expandTemplateString(s, ctx);
  const env = {};
  for (const [k, v] of Object.entries(server.env || {})) env[k] = expand(v);
  const headers = {};
  for (const [k, v] of Object.entries(server.headers || {})) headers[k] = expand(v);
  if (server.transport === 'http') {
    return {
      id: server.id,
      transport: 'http',
      url: expand(server.url),
      headers,
      env,
    };
  }
  return {
    id: server.id,
    transport: 'stdio',
    command: expand(server.command),
    args: (server.args || []).map(expand),
    env,
    headers: {},
  };
}

// ---- Claude Code (~/.claude.json e .mcp.json) ----

function toClaudeEntry(exp) {
  if (exp.transport === 'http') {
    return {
      type: 'http',
      url: exp.url,
      ...(Object.keys(exp.headers).length ? { headers: exp.headers } : {}),
    };
  }
  return {
    type: 'stdio',
    command: exp.command,
    args: exp.args,
    ...(Object.keys(exp.env).length ? { env: exp.env } : {}),
  };
}

function parseClaudeMcp(jsonObj) {
  const map = jsonObj && typeof jsonObj.mcpServers === 'object' && jsonObj.mcpServers ? jsonObj.mcpServers : {};
  const out = {};
  for (const [id, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const isHttp = cfg.type === 'http' || cfg.type === 'sse' || (!cfg.command && (cfg.url || cfg.serverUrl));
    out[id] = {
      id,
      transport: isHttp ? 'http' : 'stdio',
      command: isHttp ? '' : String(cfg.command || ''),
      args: isHttp ? [] : (Array.isArray(cfg.args) ? cfg.args.map(String) : []),
      url: isHttp ? String(cfg.url || cfg.serverUrl || '') : '',
      env: cfg.env && typeof cfg.env === 'object' ? { ...cfg.env } : {},
      headers: cfg.headers && typeof cfg.headers === 'object' ? { ...cfg.headers } : {},
    };
  }
  return out;
}

function applyClaudeMcp(jsonObj, activeExpanded, managedIds = []) {
  const base = jsonObj && typeof jsonObj === 'object' ? { ...jsonObj } : {};
  const prev = base.mcpServers && typeof base.mcpServers === 'object' ? { ...base.mcpServers } : {};
  const managedSet = new Set(managedIds);
  for (const id of managedSet) delete prev[id];
  for (const exp of activeExpanded) {
    prev[exp.id] = toClaudeEntry(exp);
  }
  base.mcpServers = prev;
  return base;
}

// ---- Antigravity / Gemini (~/.gemini/antigravity/mcp_config.json) ----

function toAntigravityEntry(exp) {
  if (exp.transport === 'http') {
    return {
      serverUrl: exp.url,
      ...(Object.keys(exp.headers).length ? { headers: exp.headers } : {}),
    };
  }
  return {
    command: exp.command,
    args: exp.args,
    ...(Object.keys(exp.env).length ? { env: exp.env } : {}),
  };
}

function parseAntigravityMcp(jsonObj) {
  return parseClaudeMcp(jsonObj);
}

function applyAntigravityMcp(jsonObj, activeExpanded, managedIds = []) {
  const base = jsonObj && typeof jsonObj === 'object' ? { ...jsonObj } : {};
  const prev = base.mcpServers && typeof base.mcpServers === 'object' ? { ...base.mcpServers } : {};
  const managedSet = new Set(managedIds);
  for (const id of managedSet) delete prev[id];
  for (const exp of activeExpanded) {
    prev[exp.id] = toAntigravityEntry(exp);
  }
  base.mcpServers = prev;
  return base;
}

// ---- Codex CLI (~/.codex/config.toml) ----

function tomlEscapeString(s) {
  return '"' + String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t') + '"';
}

function tomlFormatKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlEscapeString(k);
}

function parseTomlValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    const items = [];
    let cur = '';
    let quote = '';
    let esc = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (esc) { cur += ch; esc = false; continue; }
      if (quote === '"' && ch === '\\') { cur += ch; esc = true; continue; }
      if (quote) {
        cur += ch;
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === ',') {
        if (cur.trim()) items.push(parseTomlValue(cur.trim()));
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) items.push(parseTomlValue(cur.trim()));
    return items;
  }
  return s;
}

function stripTomlComment(line) {
  let quote = '';
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (esc) { esc = false; continue; }
    if (quote === '"' && ch === '\\') { esc = true; continue; }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function parseCodexSectionHeader(line) {
  const m = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
  if (!m) return null;
  const raw = m[1].trim();
  const mcp = /^mcp_servers\.("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)(?:\.(env|http_headers))?$/.exec(raw);
  if (!mcp) return { other: raw };
  let id = mcp[1];
  if ((id.startsWith('"') && id.endsWith('"')) || (id.startsWith("'") && id.endsWith("'"))) {
    id = id.slice(1, -1);
  }
  return { mcpId: id, sub: mcp[2] || '' };
}

function parseCodexTomlMcp(tomlStr) {
  const lines = String(tomlStr || '').split(/\r?\n/);
  const out = {};
  let cur = null;
  for (const line of lines) {
    const hdr = parseCodexSectionHeader(line);
    if (hdr) {
      cur = hdr.mcpId ? hdr : null;
      if (cur && !out[cur.mcpId]) {
        out[cur.mcpId] = { id: cur.mcpId, transport: 'stdio', command: '', args: [], url: '', env: {}, headers: {}, enabled: true };
      }
      continue;
    }
    if (!cur) continue;
    const clean = stripTomlComment(line).trim();
    if (!clean) continue;
    const eq = clean.indexOf('=');
    if (eq < 1) continue;
    let key = clean.slice(0, eq).trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) key = key.slice(1, -1);
    const val = parseTomlValue(clean.slice(eq + 1).trim());
    const entry = out[cur.mcpId];
    if (cur.sub === 'env') {
      entry.env[key] = String(val);
    } else if (cur.sub === 'http_headers') {
      entry.headers[key] = String(val);
    } else if (key === 'command') {
      entry.command = String(val);
      entry.transport = 'stdio';
    } else if (key === 'args' && Array.isArray(val)) {
      entry.args = val.map(String);
    } else if (key === 'url') {
      entry.url = String(val);
      entry.transport = 'http';
    } else if (key === 'enabled') {
      entry.enabled = val !== false;
    }
  }
  return out;
}

function serializeCodexMcpBlock(exp) {
  const idKey = tomlFormatKey(exp.id);
  const lines = [`[mcp_servers.${idKey}]`];
  if (exp.transport === 'http') {
    lines.push(`url = ${tomlEscapeString(exp.url)}`);
  } else {
    lines.push(`command = ${tomlEscapeString(exp.command)}`);
    lines.push(`args = [${(exp.args || []).map(tomlEscapeString).join(', ')}]`);
  }
  lines.push('enabled = true');

  const envKeys = Object.keys(exp.env || {});
  if (envKeys.length) {
    lines.push('');
    lines.push(`[mcp_servers.${idKey}.env]`);
    for (const k of envKeys) {
      lines.push(`${tomlFormatKey(k)} = ${tomlEscapeString(exp.env[k])}`);
    }
  }

  const hdrKeys = Object.keys(exp.headers || {});
  if (hdrKeys.length) {
    lines.push('');
    lines.push(`[mcp_servers.${idKey}.http_headers]`);
    for (const k of hdrKeys) {
      lines.push(`${tomlFormatKey(k)} = ${tomlEscapeString(exp.headers[k])}`);
    }
  }
  return lines.join('\n');
}

// Preserva 100% das outras seções/comentários do config.toml e atualiza apenas os IDs gerenciados.
function applyCodexTomlMcp(tomlStr, activeExpanded, managedIds = []) {
  const managedSet = new Set([...managedIds, ...activeExpanded.map((x) => x.id)]);
  const lines = String(tomlStr || '').split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    const hdr = parseCodexSectionHeader(line);
    if (hdr) {
      skipping = !!(hdr.mcpId && managedSet.has(hdr.mcpId));
    }
    if (!skipping) kept.push(line);
  }
  // Remove excesso de linhas em branco no final
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();

  const blocks = activeExpanded.map(serializeCodexMcpBlock);
  if (!blocks.length) return kept.length ? kept.join('\n') + '\n' : '';
  const prefix = kept.length ? kept.join('\n') + '\n\n' : '';
  return prefix + blocks.join('\n\n') + '\n';
}

function sameExpanded(a, b) {
  if (!a || !b) return false;
  if (a.transport !== b.transport) return false;
  if (a.transport === 'http') {
    return a.url === b.url && JSON.stringify(a.headers || {}) === JSON.stringify(b.headers || {});
  }
  if (a.command !== b.command) return false;
  if (JSON.stringify(a.args || []) !== JSON.stringify(b.args || [])) return false;
  const aEnv = a.env || {};
  const bEnv = b.env || {};
  const keys = [...new Set([...Object.keys(aEnv), ...Object.keys(bEnv)])];
  for (const k of keys) {
    if (String(aEnv[k] || '') !== String(bEnv[k] || '')) return false;
  }
  return true;
}

function computeSyncStatus(catalog, detectedByTarget = {}, { machineName = '', secrets = {}, env = {}, aiHudRoot = '' } = {}) {
  const servers = (catalog.servers || []).map((srv) => {
    const expanded = expandServerForSync(srv, { secrets, env, aiHudRoot });
    const secretKeys = listServerSecretKeys(srv);
    const missingSecrets = secretKeys.filter((k) => !secrets[k] && !env[k]);
    const targetStatus = {};
    for (const t of MCP_TARGETS) {
      const shouldBeOn = isServerActiveFor(srv, t, machineName);
      const found = detectedByTarget[t] && detectedByTarget[t][srv.id];
      if (!shouldBeOn) {
        targetStatus[t] = found ? 'stale' : 'disabled';
      } else if (!found) {
        targetStatus[t] = 'missing';
      } else if (sameExpanded(expanded, found)) {
        targetStatus[t] = 'synced';
      } else {
        targetStatus[t] = 'outdated';
      }
    }
    return {
      ...srv,
      secretKeys,
      missingSecrets,
      targetStatus,
    };
  });

  const catalogIds = new Set(servers.map((s) => s.id));
  const unmanaged = [];
  for (const t of MCP_TARGETS) {
    for (const [id, entry] of Object.entries(detectedByTarget[t] || {})) {
      if (catalogIds.has(id)) continue;
      let existing = unmanaged.find((u) => u.id === id);
      if (!existing) {
        existing = { id, transport: entry.transport, command: entry.command, url: entry.url, foundIn: [] };
        unmanaged.push(existing);
      }
      if (!existing.foundIn.includes(t)) existing.foundIn.push(t);
    }
  }

  return { servers, unmanaged };
}

module.exports = {
  MCP_TARGETS,
  isSecretEnvKey,
  slugifyMcpId,
  defaultCatalog,
  normalizeServer,
  validateCatalog,
  extractSecretRefs,
  expandTemplateString,
  listServerSecretKeys,
  isServerActiveFor,
  expandServerForSync,
  parseClaudeMcp,
  applyClaudeMcp,
  parseAntigravityMcp,
  applyAntigravityMcp,
  parseCodexTomlMcp,
  applyCodexTomlMcp,
  computeSyncStatus,
};
