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
queued, permission, machine`. Ids de sessões de outro PC: `m<n>:<id>`.

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

## Outras consultas (GET)

| Rota | Resposta |
|---|---|
| `GET /api/capabilities` | `{ machines: [{ name, online, platform, home, pinned[], strictRemoteCwd, cwds[], tools }] }` |
| `GET /api/fs/preview?id=&path=&mode=diff\|content` | `{ ok, path, mode, content, truncated, binary, redacted, fallback? }` (restrito ao `cwd` da sessão ou autorizado) |
| `GET /api/fs/list?cwd=&path=&machine=` | `{ ok, dir, entries: [{ name, path, type, size }], truncated }` (pastas autorizadas) |
| `GET /api/fs/git?cwd=&machine=` | `{ ok, isRepo, branch, modified[], commits[] }` (pastas autorizadas) |

## AI Workspace & Memória Compartilhada (`/api/workspace/*`, `/api/memory/*`)

| Rota | Efeito |
|---|---|
| `GET /api/workspace/index` | Índice `workspace.json` + arquivos em `context/`, `knowledge/`, `skills/`, `inbox/handoffs/` |
| `POST /api/workspace/entity` | Cria entidade/projeto (`overview.card.json` + `notes.md` + pasta `media/`) |
| `GET / PUT /api/workspace/entity/file` | Lê ou grava card (`.card.json`) / Markdown com verificação `baseHash` (`409 Conflict` em edição concorrente) + backup |
| `GET /api/workspace/entity/asset?id=&path=` | Serve `media/*` e `report.html` isolados (CSP restrita em HTML) |
| `POST /api/workspace/entity/media` | Upload seguro de imagem (PNG/JPG/WEBP/GIF, até 10 MB) para `media/` da entidade |
| `GET / PUT /api/workspace/doc` | Lê ou grava documento em `context/`, `knowledge/` ou `skills/` (com proteção `409`) |
| `GET /api/memory?project=&cwd=` | Sem filtro: lista todos os projetos e pendências de Dreaming; com projeto: lê `MEMORY.md`, `current-state.md`, `pinned.md`, `decisions.md`, `pitfalls.md`, `dream-log.md` e `episodic[]` |
| `PUT /api/memory/file` | Edita arquivo de memória (ex.: `pinned.md`) com proteção `409` + backup |
| `POST /api/memory/dream` | Dispara consolidação (Dreaming) manual cota-aware (`{ project, cwd?, engine?, dryRun?, force?, ignoreQuota? }`) |
| `POST /api/memory/undo` | Restaura o backup imediatamente anterior ao último Dreaming do projeto |
| `POST /api/memory/bridges` | Instala/atualiza pontes finas (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) preservando conteúdo existente |

## Hooks (mesmo PC)

| Rota | Quem chama |
|---|---|
| `POST /hook/listen`, `POST /hook/unlisten`, `GET /hook/next?session=` | `integrations/claude/hook-stop.js` |
| `POST /hook/permission`, `GET /hook/permission?id=`, `POST /hook/permission-expire` | `integrations/claude/hook-permission.js` |
