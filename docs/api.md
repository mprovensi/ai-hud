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
  quotas: { claude, codex: { plan, at, error, windows: { five_hour, seven_day: { used, resetsAt, pace } } } },
  hours[24], days[7]:      { t, 'Claude Code', Codex }   tokens novos por hora/dia
  today:                   { 'Claude Code'|Codex: { fresh, cacheRead } }
  sessionsToday:           { 'Claude Code', Codex, Antigravity, Ollama }
  burn:                    { claude, codex: { start, end, used, points, projected, runsOutIn } }
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

## Hooks (mesmo PC)

| Rota | Quem chama |
|---|---|
| `POST /hook/listen`, `POST /hook/unlisten`, `GET /hook/next?session=` | `integrations/claude/hook-stop.js` |
| `POST /hook/permission`, `GET /hook/permission?id=`, `POST /hook/permission-expire` | `integrations/claude/hook-permission.js` |
