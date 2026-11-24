# AI HUD: contrato da API

Usada pelos aparelhos e pelos outros PCs (peers). Autenticação: `?t=<token>` ou cookie `hud`.
**Regra:** só acrescentar campos. Renomear ou remover quebra aparelhos com a página antiga em cache e PCs
com versão anterior do HUD.

## GET /api/snapshot

| Parâmetro | Efeito |
|---|---|
| `desde=<versão>` | segura a resposta até a versão mudar (long-polling) |
| `espera=<s>` | prazo da espera, máx. 25 s (padrão 25) |

Sem `desde`, responde na hora. Uma versão de outro processo do servidor também responde na hora.

```
{
  now, tz,                 hora do PC (ms) e fuso (min): os aparelhos mostram horários pelo relógio do PC
  version,                 muda quando o conteúdo muda (desde 2026-10)
  appVersion,              versão do app web: diferente da do aparelho = mostrar "Atualizar app"
  remoteMode,
  quotas: { claude, codex, gemini: { plan, at, error, windows: { five_hour, seven_day, pro, flash, daily: { used, resetsAt, pace } } } },
  hours[24], days[7]:      { t, 'Claude Code', Codex, Gemini }   tokens novos por hora/dia
  today:                   { 'Claude Code'|Codex|Gemini: { fresh, cacheRead } }
  sessionsToday:           { 'Claude Code', Codex, Gemini, Antigravity, Ollama }
  burn:                    { claude, codex, gemini: { start, end, used, window, points, projected, runsOutIn } }
  active[], recent[]:      cartões (abaixo); active ordenado com permissões primeiro
  machines[]:              { name, ok, error }          (hub)
  ollamas[]:               estado do Ollama de cada PC  (hub; o PC sozinho manda "ollama")
}
```

Cartão: `tool, id, project, title, start, end, state (working|waiting|idle|closed|permission), lastTool,
completedAt, tokens, prompts, lastPrompt, lastReply, lastReplyAt, context, contextWindow, key, listening,
queued, permission, machine, pinned?, alias?, group?`. Ids de sessões de outro PC: `m<n>:<id>`.

## GET /api/session?id=

Detalhe da sessão: os campos do cartão mais `cwd, models, input, output, cacheRead, cacheWrite, toolCalls,
tools, subagents, subTokens, where, turns, history (Ollama), ollamaGeneration`.

## Ações (POST, corpo JSON)

| Rota | Corpo | Resposta |
|---|---|---|
| `/api/reply` | `{ id, key, tool, text }` | `{ queued, listening }` (Claude), `{ sent }` (Codex/Ollama) |
| `/api/permission` | `{ id, decision: allow\|deny, session }` | `{}`; 410 se já respondido |
| `/api/focus` | `{ id }` | `{ ok, message }` |
| `/api/remote` | `{ on }` | `{ remoteMode }` (repassado a todos os PCs) |
| `/api/refresh` | — | snapshot; 429 se pedido há menos de 30 s |
| `/api/close` | `{ id }` | `{ ok, message }` (encerra/arquiva a sessão) |
| `/api/stop` | `{ id }` | `{ ok, message }` (interrompe só o turno em execução sem encerrar a sessão) |
| `/api/new` | `{ machine?, tool, model?, cwd?, prompt }` | `{ ok, id, tool, machine }` (403 se `strictRemoteCwd` bloquear pasta remota) |
| `/api/projects/pin` | `{ machine?, cwd, pinned }` | `{ ok, pinned[] }` (fixa/desfixa pasta favorita) |
| `/api/handoff` | `{ id, targetTool?, targetModel?, note? }` | `{ ok, id, tool, machine, handoffFile, fromId, fromTool }` |
| `/api/session-meta` | `{ id, pinned?, alias?, group? }` | `{ ok, id, meta: { pinned, alias, group } }` (fixa, renomeia ou agrupa sessão no Hub) |
| `/api/upload` | `{ id?, fileName, base64Data }` | `{ ok, path, relPath, name, size }` (anexa PNG/JPG/WEBP/GIF ≤ 10 MB em `inbox/attachments/`; repassa ao peer se `id` for `m<n>:...`) |

## Outras consultas (GET)

| Rota | Resposta |
|---|---|
| `GET /api/capabilities` | `{ machines: [{ name, online, platform, home, pinned[], strictRemoteCwd, cwds[], tools }] }` |
| `GET /api/skills?cwd=` | `{ skills: [{ cmd, name, description, source }] }` (comandos `/` do projeto, AI Workspace, IAs locais e builtins) |
| `GET /api/fs/preview?id=&path=&mode=diff\|content` | `{ ok, path, mode, content, truncated, binary, redacted, fallback? }` (restrito ao `cwd` da sessão ou autorizado) |
| `GET /api/fs/list?cwd=&path=&machine=` | `{ ok, dir, entries: [{ name, path, type, size }], truncated }` (pastas autorizadas) |
| `GET /api/fs/git?cwd=&machine=` | `{ ok, isRepo, branch, modified[], commits[] }` (pastas autorizadas) |
| `POST /api/fs/exec` | `{ cwd, machine?, command, timeoutMs? }` → `{ ok, code, timedOut, truncated, redacted, durationMs, stdout, stderr }` (terminal integrado em pastas autorizadas; desativável via `config.disableTerminal`) |
| `GET /api/pty/status` | `{ ok, available, backend, active }` (status do PTY nativo — `win32-conpty` no Windows ou `unix-pty` no Linux/macOS) |
| `WS /ws/pty` | WebSocket RFC 6455 nativo (`?cwd=&machine=&mode=resume\|cli\|shell&tool=&sessionId=&cols=&rows=&key=`) para terminal `xterm.js` interativo real (com proxy multi-máquina) |
| `POST /api/fs/pick-folder` | `{ machine?, initialDir? }` → `{ ok, path, canceled }` (abre o seletor nativo de pastas do sistema operacional na máquina escolhida) |

## AI Workspace & Memória Compartilhada (`/api/workspace/*`, `/api/memory/*`)

| Rota | Efeito |
|---|---|
| `GET /api/workspace/index` | Índice `workspace.json` + arquivos em `context/`, `knowledge/`, `skills/`, `inbox/handoffs/` |
| `POST /api/workspace/entity` | Cria entidade/projeto (`overview.card.json` + `notes.md` + pasta `media/`, com `group?`) |
| `PUT /api/workspace/entity` | Atualiza metadados de entidade/projeto (`title`, `description`, `group`, `pinned`, `projectBindings`) |
| `POST /api/workspace/group` | Cria, renomeia ou remove englobador de projetos (`{ name, renameFrom?, remove? }`) |
| `GET / PUT /api/workspace/entity/file` | Lê ou grava card (`.card.json`) / Markdown com verificação `baseHash` (`409 Conflict` em edição concorrente) + backup |
| `GET /api/workspace/entity/asset?id=&path=` | Serve `media/*` e `report.html` isolados (CSP restrita em HTML) |
| `POST /api/workspace/entity/media` | Upload seguro de imagem (PNG/JPG/WEBP/GIF, até 10 MB) para `media/` da entidade |
| `GET / PUT /api/workspace/doc` | Lê ou grava documento em `context/`, `knowledge/` ou `skills/` (com proteção `409`) |
| `GET / POST /api/workspace/sync` | Status e sincronização Git segura de `data/workspace/` (`add` → `commit` → `pull --rebase` → `push`, abortando rebase sem perda em caso de conflito `409`) |
| `GET /api/memory?project=&cwd=` | Sem filtro: lista todos os projetos e pendências de Dreaming; com projeto: lê `MEMORY.md`, `current-state.md`, `pinned.md`, `decisions.md`, `pitfalls.md`, `dream-log.md` e `episodic[]` |
| `PUT /api/memory/file` | Edita arquivo de memória (ex.: `pinned.md`) com proteção `409` + backup |
| `POST /api/memory/dream` | Dispara consolidação (Dreaming) manual cota-aware (`{ project, cwd?, engine?, dryRun?, force?, ignoreQuota? }`) |
| `POST /api/memory/undo` | Restaura o backup imediatamente anterior ao último Dreaming do projeto |
| `POST /api/memory/bridges` | Instala/atualiza pontes finas (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) preservando conteúdo existente |

## Web Push nativo (VAPID, `/api/push/*`)

| Rota | Efeito |
|---|---|
| `GET /api/push/public-key` | Retorna `{ enabled, publicKey, count }` para assinar Web Push no navegador/PWA |
| `POST /api/push/subscribe` | Registra assinatura `{ endpoint, keys: { p256dh, auth }, label? }` em `data/push-subscriptions.json` |
| `POST /api/push/unsubscribe` | Remove assinatura `{ endpoint }` |
| `POST /api/push/test` | Envia uma notificação de teste para todas as assinaturas ativas |

## Voz Local (`/api/voice/*`, STT Whisper + TTS)

| Rota | Efeito |
|---|---|
| `GET /api/voice/status` | Retorna `{ ok, stt, tts, configured, remoteOnline, engine: { stt, tts } }` (no Hub consulta peers online se local não tiver voz) |
| `POST /api/voice/transcribe` | Transcreve `{ audioBase64, mimeType?, language? }` via serviço local `voiceUrl` (`integrations/voice-server/server.py`) |
| `POST /api/voice/speak` | Sintetiza `{ text, voice? }` em `audio/wav` (ou JSON base64 com `?format=json`) usando `voiceUrl` ou Windows SAPI PT-BR nativo |

## Hooks (mesmo PC)

| Rota | Quem chama |
|---|---|
| `POST /hook/listen`, `POST /hook/unlisten`, `GET /hook/next?session=` | `integrations/claude/hook-stop.js` |
| `POST /hook/permission`, `GET /hook/permission?id=`, `POST /hook/permission-expire` | `integrations/claude/hook-permission.js` |
