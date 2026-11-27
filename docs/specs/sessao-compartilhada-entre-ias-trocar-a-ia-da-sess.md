# Sessão compartilhada entre IAs (trocar a IA da sessão + compartilhar dados entre sessões)

> **Criado em:** 2026-11-26  
> **Status:** Concluído (revisão Goldfish aprovada em 2026-11-27)

## 1. Objetivo
## Problema
Hoje cada sessão fica presa à IA que a iniciou (Claude, Codex, Gemini etc.). Trocar de IA no meio do trabalho significa perder o contexto, e o que uma sessão descobre não chega às outras.

## Proposta
1. **Sessão neutra (independente da IA):** a sessão vira um registro próprio do AI HUD (id, projeto/cwd, objetivo, histórico resumido, arquivos tocados, decisões, pendências), guardado em `.ai-workspace/sessions/<id>.json`. A IA é só o "motorista" atual da sessão.
2. **Trocar a IA da sessão (handoff):** ao trocar, o HUD gera um *pacote de handoff* (resumo compacto + estado atual + próximos passos + referências a arquivos) e inicia a nova IA com ele como contexto inicial. A troca fica registrada na linha do tempo da sessão (quem fez o quê).
3. **Compartilhar dados entre sessões:** cada sessão publica fatos/decisões/armadilhas na memória compartilhada (pinned/decisions/pitfalls/episodic, já existente no MCP `ai-hud-memory`). Outras sessões do mesmo projeto consultam via `memory_search`, ou uma sessão "importa" o resumo de outra explicitamente.
4. **Exposição via MCP:** novas ferramentas, por exemplo `session_create`, `session_read`, `session_handoff`, `session_link` (vincular sessões) e `session_publish` (enviar fato para a memória), usáveis por qualquer IA que fale MCP.

## Pontos em aberto
- Formato do pacote de handoff: um padrão único ou adaptadores por IA?
- Quanto do histórico guardar (resumo × transcrição completa) e o limite de tokens
- Conflito quando duas IAs escrevem na mesma sessão ao mesmo tempo (lock ou fila)
- Privacidade: o que não deve sair de uma sessão (segredos, .env)
- UI no HUD: seletor "trocar IA" e visualização da linha do tempo da sessão

## Revisão Goldfish (decisões dos pontos em aberto)
- **Reuso:** o handoff Cross-IA já existia (`core/handoff.js`, `actions/handoff.js`, `/api/handoff`, painel no detalhe). Ele foi mantido e passou a registrar a troca na sessão compartilhada.
- **Formato do pacote:** um padrão único em Markdown (`buildSessionPackage`). Qualquer IA lê Markdown, então não há adaptadores por IA.
- **Histórico:** só o resumo estruturado, sem transcrição. Limites: objetivo 600, resumo 4000, itens 500 caracteres; até 50 decisões/pendências, 100 arquivos e 200 eventos na linha do tempo (os mais antigos saem).
- **Concorrência:** lock exclusivo por arquivo (`.lock` com `wx`, órfão expira em 10 s) mais revisão otimista (`expectedRev` → erro `conflict`).
- **Privacidade:** todo texto passa por `redactSecrets` antes de gravar. `pinned.md` não é escrito por IA, preservando o invariante de que é editado só pelo usuário.
- **UI:** fica fora deste corte. O painel de handoff atual já troca a IA; a linha do tempo pode ser vista via `session_read`.

## 2. Escopo (o que entra)
- [x] Registro neutro em `<cwd>/.ai-workspace/sessions/<id>.json` (`core/shared-session.js` + `actions/shared-sessions.js`)
- [x] Ferramentas MCP `session_create`, `session_read`, `session_update`, `session_handoff`, `session_link`, `session_publish` no `ai-hud-memory`
- [x] Handoff do HUD cria ou reutiliza a sessão compartilhada (por id nativo), registra a troca e informa o id à nova IA
- [x] Publicação na memória do projeto: `decision` → `decisions.md`, `pitfall` → `pitfalls.md`, `episodic` → `sessions/`

## 3. Fora de escopo (o que NÃO fazer agora)
- UI própria de linha do tempo e seletor "trocar IA" dedicado
- Escrita automática da sessão pelas IAs sem chamada MCP (por exemplo, hooks)
- Sincronização entre máquinas além do peer-sync já existente do workspace

## 4. Arquivos e impactos previstos
- `src/core/shared-session.js` (novo, puro), `src/actions/shared-sessions.js` (novo, I/O)
- `integrations/mcp/memory-server.js` (6 ferramentas), `src/actions/handoff.js`, `src/main.js`
- `test/actions/shared-sessions.test.js` (novo), `test/actions/phase4-features.test.js` (lista de ferramentas)

## 5. Critérios de aceite
- [x] Testes automatizados: CRUD via MCP, conflito de rev, lock órfão, redação de segredos, `memory_search` acha o fato publicado, handoff do HUD reutiliza a mesma sessão e não trunca a referência da sessão no prompt (`npm test`: 225/225)
- [x] Projeto sobe pelo `.ai-workspace/run.json` (`node server.js` → `/workspace/` HTTP 200) e o MCP lista as 6 ferramentas `session_*`
