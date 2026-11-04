# AI HUD: desenho do sistema

## Visão geral

```
 Aparelhos (iPad mini/Safari 9, Android PWA, navegador)
   │  GET /api/snapshot?desde=<versão>   (long-polling: o servidor responde quando algo muda, máx. 25 s)
   │  POST /api/reply, /api/focus, /api/permission, /api/remote, /api/refresh
   ▼
 PC principal (hub) ── servidor do HUD (Node, :8787) ──────────────────────────────────────────────
   api/         rede permitida → arquivos públicos → PIN/token → tabela de rotas
   views/       snapshot e detalhe: o contrato com aparelhos e outros PCs
   actions/     respostas (Claude, Codex, Ollama), permissões do modo remoto, Abrir no PC, pendências
   federation/  segue os outros PCs (long-polling) e junta os snapshots; repassa ações ao PC dono
   collect/     coletor: lê as fontes, guarda as sessões e o snapshot pronto, muda a versão quando muda
   core/        regras puras: estado da sessão, ritmo das cotas, tokens por hora/dia
   infra/       config, JSON seguro em data/, pastas, empacotamento do app (web/)
        │ lê                         │ pergunta                │ executa
        ▼                            ▼                         ▼
   ~/.claude/projects, ~/.codex,   claude -p get_usage,      codex queue, platform/windows/*.ps1,
   ~/.gemini, Ollama (app, proxy)  codex app-server          vscode://, codex://, claude://
        ▲
   integrations/claude (hooks Stop e PermissionRequest, statusline) ──► /hook/* (mesmo PC)
   integrations/ollama-proxy: clientes → :11434 (proxy, grava em data/) → ollama serve :11435

 PC secundário (peer): o mesmo servidor; o hub o segue com ?desde= e prefixa os ids com "m<n>:"
```

## Camadas e dependências

```
api ──► views ─────────┐
  ├───► actions ──► collect ──► core
  └───► federation ────┘         ▲
              (infra serve a todas as camadas)
```

| Camada | Responde | Regra |
|---|---|---|
| `core/` | o que significa | sem arquivo, rede ou processo; só funções |
| `collect/` | o que está acontecendo | só lê; nunca muda nada no PC |
| `views/` | o que o aparelho recebe | contrato: só acrescentar campos (docs/api.md) |
| `actions/` | o que o usuário mandou fazer | único lugar que executa comandos no PC |
| `federation/` | e os outros PCs | só usa a API pública dos outros PCs |
| `api/` | como se chega aqui | fino: valida, chama as outras camadas e responde |
| `infra/` | onde guardar | config, `data/`, empacotamento do `web/` |

`test/architecture.test.js` falha se uma camada usar outra fora dessa ordem, se `core/` fizer E/S ou se
`web/` e `integrations/` importarem o servidor.

## Fluxos

**Leitura.** O coletor (`collect/collector.js`) roda a cada 2 s enquanto alguém está olhando (ou há uma
consulta esperando): lê as fontes (só os arquivos que mudaram, pelo cache de data e tamanho), monta o
snapshot do PC e junta o dos secundários. Se o conteúdo mudou (ignorando campos de relógio como `now`,
`at`, ritmo e gráfico das cotas), a versão muda e as consultas em espera respondem. Sem ninguém olhando,
o laço para; a próxima consulta lê na hora.

**Ações.** O aparelho pede ao hub; o PC dono da sessão executa. Depois de cada ação o coletor relê na hora
(`poke`), e o cartão muda nos aparelhos sem esperar o próximo ciclo.

| Ação | Caminho |
|---|---|
| Responder ao Claude | fila em `data/pending.json` → `hook-stop` da sessão busca a cada 2 s |
| Responder ao Codex | `codex queue` (fila nativa) |
| Responder ao Ollama | `/api/chat` do Ollama local → continuação guardada no HUD |
| Permitir/Negar | `hook-permission` segura o pedido (modo remoto) → decisão no HUD → hook |
| Abrir no PC | `actions/focus/plan.js` decide janela/link; `platform/windows/*.ps1` executa |
| Sessão de outro PC | o hub repassa a mesma rota ao peer, sem o prefixo `m<n>:` |

**Pendências.** Respostas na fila, hooks escutando e pedidos de permissão ficam juntos em
`data/pending.json` (`actions/pending.js`). Um reinício do servidor não perde nada: o hook continua
consultando e encontra o que deixou.

**Federação.** Todo PC roda o mesmo servidor; o hub é só o que tem `peers` no `config.json`. O hub segue
cada secundário com `?desde=<versão>`; secundários com versão antiga (sem `version` no snapshot) são
consultados a cada 10 s. Versões diferentes convivem porque o contrato só cresce.

## Compatibilidade com o que está fora do repositório

Alguns caminhos estão gravados em outros programas. Os antigos viraram pontes de uma linha:

| Caminho antigo (ponte) | Quem usa | Código |
|---|---|---|
| `claude/*.js` | `~/.claude/settings.json`, hooks do Codex | `integrations/claude/` |
| `windows/tray/ai-hud-tray.ps1` | atalho `AI HUD.vbs` na pasta Inicializar | `platform/windows/tray/` |
| `ollama-proxy/proxy.js` | tarefa agendada "Ollama Log Proxy" | `integrations/ollama-proxy/` |

`platform/windows/atualizar-caminhos.ps1` mostra (e com `-Aplicar`, troca) esses caminhos em cada PC.
Depois de rodar em todos, as pontes podem sair.

## Restrições que moldam o desenho

- **Safari 9 (iPad mini 1):** `web/` em ES5, flexbox sem `gap`, XHR; sem etapa de build.
- **Sem dependências:** só Node 22.5+ (`node:sqlite`, `node:test`).
- **Rede:** só loopback, redes privadas e Tailscale; PIN troca por token; HTTPS pelo Tailscale Serve.
