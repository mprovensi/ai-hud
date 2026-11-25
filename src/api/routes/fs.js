// Rotas de sistema de arquivos somente leitura por projeto (/api/fs/preview, /api/fs/list, /api/fs/git).
// Sempre restritas ao `cwd` da sessão ou a pastas conhecidas/autorizadas (path-guard).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isCwdAllowed, isSafeRelativePath, normalizePath, toSafeRelPath, resolveContainedPath, isWithinRoot, isSecretPath } = require('../../core/path-guard');
const { recentCwds } = require('../../collect/capabilities');
const { findProjectIcon } = require('../../collect/file-preview');
const { resolveWorkspaceRoot } = require('../../infra/workspace-paths');
const { readWorkspaceJson } = require('../../collect/workspace');

const IMAGE_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

module.exports = ({ filePreview, fileList, projectGit, projectGitCommit, terminal, ptyManager, pickFolder, openVsCode, peers, collector, dataDir, config, machineName, relay, send, json, text }) => {
  function checkAuthorizedCwd(cwd, { allowHomeSubdirs = false } = {}) {
    const home = os.homedir();
    if (allowHomeSubdirs && !(config && config.strictRemoteCwd) && home && isWithinRoot(home, cwd) && !isSecretPath(cwd)) {
      return { ok: true };
    }
    const knownCwds = recentCwds(collector.current().sessions, (config && config.pinnedProjects) || []);
    const wsRoots = [];
    if (dataDir) {
      try {
        const ws = readWorkspaceJson(resolveWorkspaceRoot(dataDir, config));
        for (const m of Object.values(ws.groupMeta || {})) {
          if (m && m.rootCwd) wsRoots.push(m.rootCwd);
        }
        for (const e of (ws.entities || [])) {
          for (const b of (e.projectBindings || [])) {
            if (b && b.cwd) wsRoots.push(b.cwd);
          }
        }
      } catch {}
    }
    return isCwdAllowed(cwd, {
      allowedRoots: [...((config && config.allowedRoots) || []), ...wsRoots],
      knownCwds,
      home,
      strict: true,
    });
  }

  return [
    { method: 'GET', path: '/api/fs/preview', handler: async ({ res, url }) => {
      const id = url.searchParams.get('id') || '';
      const cwdParam = url.searchParams.get('cwd') || '';
      const machine = url.searchParams.get('machine') || '';
      const relPath = url.searchParams.get('path') || '';
      const mode = url.searchParams.get('mode') === 'content' ? 'content' : 'diff';
      if (!relPath) return text(res, 400, 'informe o caminho do arquivo');

      if (id) {
        const remote = peers.byId(id);
        if (remote) {
          const q = `/api/fs/preview?id=${encodeURIComponent(remote.rid)}&path=${encodeURIComponent(relPath)}&mode=${mode}`;
          return relay(res, peers.forward(remote.peer, 'GET', q));
        }
        const s = collector.find((x) => x.id === id && !x.subagent);
        if (!s) return text(res, 404, 'sessão não encontrada');
        const r = await filePreview({ cwd: s.cwd, relPath, mode });
        return r.status !== 200 ? text(res, r.status || 400, r.error || 'não foi possível ler o arquivo') : json(res, r.body);
      }

      if (!cwdParam) return text(res, 400, 'informe id da sessão ou cwd autorizado');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        const q = `/api/fs/preview?local=1&cwd=${encodeURIComponent(cwdParam)}&path=${encodeURIComponent(relPath)}&mode=${mode}`;
        return relay(res, peers.forward(peer, 'GET', q));
      }
      const check = checkAuthorizedCwd(cwdParam);
      if (!check.ok) return text(res, 403, check.reason);
      const r = await filePreview({ cwd: cwdParam, relPath, mode });
      return r.status !== 200 ? text(res, r.status || 400, r.error || 'não foi possível ler o arquivo') : json(res, r.body);
    } },

    { method: 'GET', path: '/api/fs/list', handler: async ({ res, url }) => {
      const cwd = url.searchParams.get('cwd') || '';
      const relDir = url.searchParams.get('path') || '';
      const machine = url.searchParams.get('machine') || '';
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        const q = `/api/fs/list?local=1&cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relDir)}`;
        return relay(res, peers.forward(peer, 'GET', q));
      }
      const check = checkAuthorizedCwd(cwd, { allowHomeSubdirs: true });
      if (!check.ok) return text(res, 403, check.reason);
      const r = fileList({ cwd, relDir });
      return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
    } },

    { method: 'POST', path: '/api/fs/mkdir', json: true, maxBytes: 4096, handler: async ({ res, url, body }) => {
      const cwd = String((body && body.cwd) || '').trim();
      const name = String((body && body.name) || '').trim();
      const machine = String((body && body.machine) || '').trim();
      if (!cwd) return text(res, 400, 'informe a pasta raiz');
      if (!name) return text(res, 400, 'informe o nome da subpasta');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        return relay(res, peers.forward(peer, 'POST', '/api/fs/mkdir?local=1', { cwd, name }));
      }
      const check = checkAuthorizedCwd(cwd, { allowHomeSubdirs: true });
      if (!check.ok) return text(res, 403, check.reason);
      const baseCwd = normalizePath(cwd);
      if (!baseCwd || !fs.existsSync(baseCwd)) return text(res, 404, 'pasta raiz não encontrada');
      const rel = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!isSafeRelativePath(rel) || isSecretPath(rel) || /[<>:"|?*]/.test(rel)) {
        return text(res, 400, 'nome de subpasta inválido');
      }
      const realRoot = fs.realpathSync(baseCwd);
      const target = resolveContainedPath(realRoot, rel);
      if (!target || !isWithinRoot(realRoot, target) || target.toLowerCase() === realRoot.toLowerCase()) {
        return text(res, 403, 'subpasta fora da pasta raiz autorizada');
      }
      try {
        fs.mkdirSync(target, { recursive: true });
      } catch (e) {
        return text(res, 500, e.message || 'não foi possível criar a subpasta');
      }
      return json(res, { ok: true, path: target, relPath: rel });
    } },

    { method: 'GET', path: '/api/fs/project-icon', handler: async ({ res, url }) => {
      const cwd = url.searchParams.get('cwd') || '';
      const machine = url.searchParams.get('machine') || '';
      if (!cwd) return send(res, 204, 'text/plain', '');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return send(res, 204, 'text/plain', '');
        return peers.forward(peer, 'GET', `/api/fs/project-icon?local=1&cwd=${encodeURIComponent(cwd)}`).then((r) => {
          if (r.status !== 200 || !r.buffer || !r.buffer.length) return send(res, 204, 'text/plain', '');
          return send(res, 200, r.contentType || 'image/png', r.buffer, {
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=300',
            ...((r.contentType || '').includes('svg') ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
          });
        }, () => send(res, 204, 'text/plain', ''));
      }
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return send(res, 204, 'text/plain', '');
      const found = findProjectIcon(cwd);
      if (!found) return send(res, 204, 'text/plain', '');
      try {
        const buf = fs.readFileSync(found.filePath);
        const headers = {
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=300',
          ...(found.ext === '.svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
        };
        return send(res, 200, found.mime, buf, headers);
      } catch {
        return send(res, 204, 'text/plain', '');
      }
    } },

    { method: 'GET', path: '/api/fs/git', handler: async ({ res, url }) => {
      const cwd = url.searchParams.get('cwd') || '';
      const machine = url.searchParams.get('machine') || '';
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        const q = `/api/fs/git?local=1&cwd=${encodeURIComponent(cwd)}`;
        return relay(res, peers.forward(peer, 'GET', q));
      }
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = await projectGit(cwd);
      return r.status !== 200 ? text(res, r.status, r.error) : json(res, r.body);
    } },

    { method: 'POST', path: '/api/fs/git-commit', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!projectGitCommit) return text(res, 501, 'Commit Git indisponível.');
      const cwd = String((body && body.cwd) || '').trim();
      const machine = String((body && body.machine) || '').trim();
      const message = String((body && body.message) || '').trim();
      const push = !!(body && body.push);
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      if (!message) return text(res, 400, 'informe a mensagem do commit');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        return relay(res, peers.forward(peer, 'POST', '/api/fs/git-commit?local=1', { cwd, message, push }, 60000));
      }
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = await projectGitCommit({ cwd, message, push });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/fs/exec', json: true, maxBytes: 16 * 1024, handler: async ({ res, url, body }) => {
      if (!terminal) return text(res, 501, 'Terminal integrado indisponível.');
      const cwd = String(body.cwd || '').trim();
      const machine = String(body.machine || '').trim();
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        return relay(res, peers.forward(peer, 'POST', '/api/fs/exec?local=1', {
          cwd,
          command: body.command,
          timeoutMs: body.timeoutMs,
        }));
      }
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = await terminal({ cwd, command: body.command, timeoutMs: body.timeoutMs });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'GET', path: '/api/pty/status', handler: ({ res }) => {
      json(res, ptyManager ? ptyManager.status() : { ok: true, available: false });
    } },

    { method: 'POST', path: '/api/fs/pick-folder', json: true, maxBytes: 4096, handler: async ({ res, url, body }) => {
      if (!pickFolder) return text(res, 501, 'Seletor nativo indisponível.');
      const machine = String((body && body.machine) || '').trim();
      const initialDir = String((body && body.initialDir) || '').trim();
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        return relay(res, peers.forward(peer, 'POST', '/api/fs/pick-folder?local=1', { initialDir }));
      }
      const r = await pickFolder({ initialDir });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    { method: 'POST', path: '/api/fs/open-vscode', json: true, maxBytes: 4096, handler: async ({ res, url, body }) => {
      if (!openVsCode) return text(res, 501, 'Abertura de VS Code indisponível.');
      const cwd = String((body && body.cwd) || '').trim();
      const machine = String((body && body.machine) || '').trim();
      if (!cwd) return text(res, 400, 'informe cwd do projeto');
      if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
        const peer = peers.list.find((p) => p.name === machine);
        if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
        return relay(res, peers.forward(peer, 'POST', '/api/fs/open-vscode?local=1', { cwd }));
      }
      const check = checkAuthorizedCwd(cwd);
      if (!check.ok) return text(res, 403, check.reason);
      const r = openVsCode({ cwd });
      return typeof r.body === 'string' ? text(res, r.status, r.body) : json(res, r.body, r.status);
    } },

    // GET /api/fs/image?id=&cwd=&machine=&path=&download=1: serve imagem contida na pasta da sessão/projeto (com proxy binário multi-máquina)
    { method: 'GET', path: '/api/fs/image', handler: async ({ res, url }) => {
      const id = url.searchParams.get('id') || '';
      const cwdParam = url.searchParams.get('cwd') || '';
      const machine = url.searchParams.get('machine') || '';
      const rawPath = url.searchParams.get('path') || '';
      const download = url.searchParams.get('download') === '1';
      if (!rawPath) return text(res, 400, 'informe o caminho da imagem');

      const forwardBinary = (peer, routePath) => peers.forward(peer, 'GET', routePath).then((r) => {
        if (r.status !== 200) return text(res, r.status, r.text || 'imagem indisponível');
        const fname = path.basename(rawPath.split(/[?#]/)[0]).replace(/[^\w.-]+/g, '_') || 'imagem.png';
        const headers = {
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=60',
          ...(download ? { 'Content-Disposition': `attachment; filename="${fname}"` } : {}),
        };
        return send(res, 200, r.contentType || 'application/octet-stream', r.buffer, headers);
      }, () => text(res, 502, 'o outro PC não respondeu'));

      let baseCwd = cwdParam;
      if (id) {
        const remote = peers.byId(id);
        if (remote) {
          const q = `/api/fs/image?id=${encodeURIComponent(remote.rid)}&path=${encodeURIComponent(rawPath)}${download ? '&download=1' : ''}`;
          return forwardBinary(remote.peer, q);
        }
        const s = collector.find((x) => x.id === id && !x.subagent);
        if (!s || !s.cwd) return text(res, 404, 'sessão sem pasta de projeto');
        baseCwd = s.cwd;
      } else {
        if (!baseCwd) return text(res, 400, 'informe id da sessão ou cwd autorizado');
        if (url.searchParams.get('local') !== '1' && machine && machine !== machineName) {
          const peer = peers.list.find((p) => p.name === machine);
          if (!peer) return text(res, 404, `máquina "${machine}" não encontrada`);
          const q = `/api/fs/image?local=1&cwd=${encodeURIComponent(baseCwd)}&path=${encodeURIComponent(rawPath)}${download ? '&download=1' : ''}`;
          return forwardBinary(peer, q);
        }
        const check = checkAuthorizedCwd(baseCwd);
        if (!check.ok) return text(res, 403, check.reason);
      }

      baseCwd = normalizePath(baseCwd);
      if (!baseCwd || !fs.existsSync(baseCwd)) return text(res, 404, 'pasta do projeto não encontrada');
      let cleanPath = rawPath.split(/[?#]/)[0].trim();
      try { cleanPath = decodeURIComponent(cleanPath); } catch {}
      if (/^file:\/\//i.test(cleanPath)) {
        cleanPath = cleanPath.replace(/^file:\/\/\//i, '').replace(/^file:\/\//i, '');
        if (!/^[a-zA-Z]:/.test(cleanPath) && !cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;
      }

      let allowedRoot = baseCwd;
      let rel = toSafeRelPath(cleanPath, baseCwd);
      if ((!rel || isSecretPath(rel)) && dataDir) {
        const attachRoot = normalizePath(path.join(resolveWorkspaceRoot(dataDir, config), 'inbox', 'attachments'));
        if (attachRoot && fs.existsSync(attachRoot)) {
          const attRel = toSafeRelPath(cleanPath, attachRoot);
          if (attRel && !isSecretPath(attRel)) {
            allowedRoot = attachRoot;
            rel = attRel;
          }
        }
      }
      if (!rel || isSecretPath(rel)) return text(res, 403, 'caminho de imagem fora da pasta do projeto');
      const ext = path.extname(rel).toLowerCase();
      const mime = IMAGE_MIMES[ext];
      if (!mime) return text(res, 400, 'extensão de imagem não permitida');

      const realRoot = fs.realpathSync(allowedRoot);
      const target = resolveContainedPath(realRoot, rel);
      if (!target || !isWithinRoot(realRoot, target) || !fs.existsSync(target)) {
        return text(res, 404, 'imagem não encontrada');
      }
      const realFile = fs.realpathSync(target);
      if (!isWithinRoot(realRoot, realFile)) return text(res, 403, 'link simbólico fora do projeto');
      const st = fs.statSync(realFile);
      if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return text(res, 413, 'imagem inválida ou excede 15 MB');

      const buf = fs.readFileSync(realFile);
      const fname = path.basename(realFile).replace(/[^\w.-]+/g, '_') || 'imagem.png';
      const headers = {
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=60',
        ...(ext === '.svg' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
        ...(download ? { 'Content-Disposition': `attachment; filename="${fname}"` } : {}),
      };
      return send(res, 200, mime, buf, headers);
    } },
  ];
};
