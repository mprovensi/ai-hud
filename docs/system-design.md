# AI HUD & AI Workspace: desenho do sistema

## Visão geral

Um único servidor Node (`src/`, zero dependências npm, porta `:8787`) atua como **Control Plane Multi-Máquina** (Notebook + PC Desktop + VPS Oracle 24/7) atendendo **três clientes**:

```text
  [1. iPad mini 1 / Safari 9 / Celular]   [2. Navegador / PWA]        [3. Desktop Windows]
    GET /  (web/ — ES5 sem build)          GET /workspace              workspace-desktop/ (Tauri 2)
    • Monitoramento, cotas, respostas,     • React 19 + TS + Vite      • Casca WebView2 nativa
      permissões, áudio TTS, Workspace       (code-splitting em dist/)   apontando para :8787
      leve (somente leitura + Dream)       • Board, Docs, Memória,
                                             PTY xterm.js, Play, MCPs
              │                                    │                           │
              └───────────────────┬────────────────┴───────────────────────────┘
                                  │ REST + Long-Polling + WebSocket /ws/pty
                                  │ Auth: rede permitida → PIN/token/cookie/WebAuthn
                                  ▼
  Servidor AI HUD (src/, Node 22.5+, ZERO deps npm, :8787)
    api/         handler HTTP, WebAuthn biométrico, WebSocket PTY (/ws/pty), cwd-auth unificado e rotas
    views/       projeções estáveis (snapshot, session-detail) — contrato estritamente aditivo
    actions/     reply, spawn, handoff, upload, workspace/project-storage, memory/dreaming,
                 project-runner (Play), pty, terminal, mcp, voice, push, pending, sync Git
    federation/  long-polling com peers (?local=1&desde=), merge de snapshots/cotas e proxy de ações
    collect/     coleta somente leitura: sessões (Claude, Codex, Gemini/agy, Ollama), cotas sequenciais,
                 FX USD/BRL, workspace/docs, memória, MCPs instalados nas CLIs, file-preview e Git
    core/        regras puras (zero I/O): path-guard, redact, session, quotas, pricing, egm, memory,
                 workspace-schema, doc-parser, mcp-catalog, websocket
    infra/       config, store JSON atômico, workspace-paths (contenção física + backups obrigatórios),
                 empacotamento de web/ e estáticos de workspace-app/dist/
         │                            │                               │
         ▼                            ▼                               ▼
  ~/.claude, ~/.codex,       CLIs & Processos locais         Integrações desacopladas
  ~/.gemini, Ollama,         claude / codex / agy,           • integrations/claude/ (hooks)
  <projeto>/.ai-workspace/   PTY (ConPTY/Unix),              • integrations/mcp/memory-server.js
  <projeto>/.ai-memory/      ProjectRunner (Play),           • integrations/ollama-proxy/
  data/workspace/            sync MCP (JSON + TOML)          • integrations/voice-server/
```

---

## Camadas e invariantes de dependência

```text
api ──► views ─────────┐
  ├───► actions ──► collect ──► core
  └───► federation ────┘         ▲
              (infra serve a todas as camadas)
```

| Camada | Papel | Regra |
|---|---|---|
| `core/` | regras e transformações puras | zero arquivo, rede ou processo (`fs`, `http`, `net`, `child_process` proibidos) |
| `collect/` | leitura de estado | somente leitura; nunca altera arquivos nem inicia ações do usuário |
| `views/` | projeções da API | contrato aditivo (`docs/api.md`) para convivência entre versões |
| `actions/` | escrita e execução | único lugar que altera disco, lança CLIs/processos ou sincroniza configs |
| `federation/` | multi-máquina | conversa com peers apenas via API HTTP pública (`?local=1`) |
| `api/` | fronteira HTTP/WS | valida rede, autenticação, `Origin`, autorização de `cwd` e delega |
| `infra/` | infraestrutura local | `config.json`, JSON atômico, contenção física (`realpath`) e backups |

`test/architecture.test.js` valida automaticamente a direção dessas dependências, a pureza de `core/` e o isolamento de `web/` e `integrations/`.

---

## Subsistemas principais

### 1. Coleta, Cotas e Federação
- **Coletor (`collect/collector.js`):** lê sessões de Claude Code, Codex, Antigravity/Gemini (`agy`) e Ollama a cada 2 s enquanto há clientes observando; fora de uso, entra em repouso.
- **Cotas sequenciais (`collect/quotas/tracker.js`):** lê Claude, Codex e Gemini sequencialmente com trava de concorrência (`refreshing`) para evitar disputa de RAM/swap em VPS de 1 GB.
- **Custos estimados (`core/pricing.js` + `collect/fx.js`):** estima valor equivalente em API (USD/BRL) com cotação atualizada a cada 12 h e fallback offline.
- **Federação (`federation/peers.js` + `merge.js`):** cada máquina roda o mesmo servidor; o Hub consulta peers via `?local=1&desde=`, prefixa IDs remotos com `m<n>:` e prioriza cotas saudáveis de peers sobre erros locais.

### 2. AI Workspace, EGM Lite e Memória Compartilhada
- **Armazenamento portátil (`<cwd>/.ai-workspace/`):** `board.card.json`, `run.json` e `reviews/*.md` ficam na pasta do projeto (ignorados no Git via `.git/info/exclude`), com espelho de cache no Hub (`data/workspace/`).
- **Conflito otimista e backup obrigatório:** toda edição usa `baseHash` (`409 Conflict`) e `writeAtomicWithBackup` — se o backup falhar, a gravação é abortada preservando o arquivo original.
- **EGM Lite (`core/egm.js` + `actions/workspace/workflow.js`):** classificação de complexidade por etapa (`simple` → Haiku, `standard` → Sonnet, `complex` → Opus), revisão Goldfish isolada e avanço automático do Board condicionado a evidência (`evaluateStageAdvance`).
- **Memória & Dreaming (`core/memory.js` + `actions/memory/index.js`):** camada quente (`MEMORY.md` ≤ 150 linhas, `current-state.md`, `pinned.md` imutável) + morna (`decisions.md`, `pitfalls.md`) + fria (`sessions/`). Processa sessões em lotes cronológicos explícitos de até 12 sessões, verifica hashes antes de publicar (`409` em edição concorrente) e respeita teto de cota.

### 3. Execução, Terminal PTY e MCPs Compartilhados
- **Play multi-stack (`actions/project-runner.js`):** executa perfis simples ou compostos (Front + Back, Godot/GUI, scripts) validando todas as subpastas antes do lançamento, com rollback em falha parcial e `openUrl` liberado somente quando todos os processos e portas sobem (`allReady`).
- **Terminal PTY (`actions/pty.js` + `api/ws-pty.js`):** WebSocket RFC 6455 em `/ws/pty` com suporte a proxy transparente para peers, validação estrita de `Origin`, contenção de erros de Upgrade e encerramento imediato quando uma sessão biométrica WebAuthn é revogada/expirada.
- **MCPs Compartilhados (`core/mcp-catalog.js`, `collect/mcp.js`, `actions/mcp.js`, `api/routes/mcp.js`):** catálogo portátil em `data/workspace/mcp-servers.json` (com segredos isolados localmente em `data/mcp-secrets.json` via `${VAR}` e macro `{{AI_HUD_ROOT}}`), sincronizando automaticamente para Claude Code (`~/.claude.json` / `.mcp.json`), Codex CLI (`~/.codex/config.toml` preservando seções não gerenciadas) e Antigravity (`~/.gemini/antigravity/mcp_config.json`) com backup prévio.
- **Servidor MCP próprio (`integrations/mcp/memory-server.js`):** expõe `memory_search`, `memory_read`, `workspace_list`, `board_read`, `board_update_status` (com `docRef`) e `board_add_item`.

### 4. Ciclo de vida (`src/main.js`)
- `createApp()` expõe `start()` (idempotente) e `stop()` (ponto único de encerramento também ligado a `server.on('close')`), interrompendo timers de cotas/FX/Dreaming/auto-sync, coletor, fontes, peers, PTYs abertos e processos do `ProjectRunner`.

---

## Fronteiras de segurança e invariantes

1. **Rede + Autenticação:** somente loopback, redes privadas e Tailscale (`api/auth.js`); PIN de 8 dígitos trocado por token/cookie `HttpOnly; SameSite=Lax` ou sessão biométrica WebAuthn (`api/webauthn.js`).
2. **Autorização única de `cwd` (`api/cwd-auth.js`):** `path-guard.js` normaliza `.`/`..` e valida raízes autorizadas lexical e fisicamente (`realpath`); `?local=1` nunca concede privilégio extra.
3. **Contenção física de escrita (`infra/workspace-paths.js`):** `resolveSafeContainedTarget` impede criação/gravação através de symlinks ou junctions apontando para fora da raiz.
4. **Isolamento de relatórios HTML:** `/api/workspace/entity/asset` recusa navegação HTML com `?t=` na URL; o Workspace renderiza `report.html` via `srcDoc` em `iframe` `sandbox="allow-scripts"` sem credenciais e com CSP `connect-src 'none'`.
5. **Segredos e durabilidade:** `core/redact.js` mascara segredos antes de LLMs/logs; falhas de persistência em `pending.json`, `session-meta.json`, `config.json` e WebAuthn fazem rollback em memória e propagam erro.

---

## Restrições de cliente e dependências

- **Backend (`src/`):** zero dependências npm em produção; apenas Node 22.5+ (`node:sqlite`, `node:test`).
- **HUD Clássico (`web/`):** ES5 puro, flexbox sem `gap`, XHR, zero build — compatível com **iPad mini 1 (iOS 9.3.5 / Safari 9)**.
- **AI Workspace (`workspace-app/`):** React 19 + TypeScript + Vite com *code-splitting* (`React.lazy` + `manualChunks` separando React, Markdown, ícones e `xterm.js`); a VPS serve apenas `workspace-app/dist/` estático sem `node_modules`.
- **Desktop Windows (`workspace-desktop/`):** Tauri 2 (Rust + WebView2), isolado com `Cargo.toml` próprio.
