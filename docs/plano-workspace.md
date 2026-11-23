# Plano de Evolução: AI HUD + AI Workspace + Memória Compartilhada (Dreaming)

> **Referência analisada:** [`witnesstodark/mr-mak-workspace`](https://github.com/witnesstodark/mr-mak-workspace) (v0.6.6)  
> **Base atual:** `ai-hud` (Multi-Hub 3 máquinas: Notebook + PC Desktop + VPS Oracle 24/7, 4 IAs: Claude Code, Codex, Gemini/Antigravity e Ollama, servidor Node 22.5+ com zero dependências externas, HUD `/` compatível com iPad mini 1 / Safari 9).  
> **Status:** Decisões arquiteturais consolidadas — pronto para execução faseada.

---

## 0. Decisões Consolidadas

| Decisão | Escolha aprovada | Implicação direta no plano |
|---|---|---|
| **1. Ordem de execução** | **Máxima produtividade** | **Fase 0** (Quick Wins + fundação de segurança no `ai-hud`) → **Fase 1** (Motor File-First: Workspace + Memória Compartilhada & Dreaming) → **Fase 2** (App Desktop/Web `/workspace` em React + TS + Vite) → **Fase 3** (Shell Desktop nativo **Tauri 2** para Windows + recursos avançados) → **Fase 4** (Sync multi-máquina + PWA/Push) → **Fase 5** (*Good-to-have*). |
| **2. Estrutura de repositório** | **Tudo junto no `ai-hud`** (dividir depois se crescer) | Monorepo leve com fronteira rígida de API: `src/` (servidor zero-deps), `web/` (HUD ES5 Safari 9), `workspace-app/` (React + TS + Vite), `workspace-desktop/` (Tauri 2). Dados pessoais do workspace ficam em `data/workspace/` (ignorado no Git do `ai-hud`, opcionalmente como sub-repo Git privado) ou em caminho configurável (`workspaceDir`). |
| **3. Stack do AI Workspace (Windows Desktop)** | **Alta performance no Desktop Windows**, preparado para evoluir interações nativas | **React 19 + TypeScript + Vite** (UI rápida, virtualização, split panes, drag-and-drop, editor rico, atalhos de teclado) + **Tauri 2 (Rust + WebView2 nativo do Windows)** — mesma arquitetura validada pelo `mr-mak-workspace`, mantendo o backend `src/` do `ai-hud` 100% zero-deps e super leve para a VPS Oracle (1 GB RAM). |
| **4. Voz local (Whisper + TTS)** | **Manter no radar (*good-to-have*)** | Planejada na **Fase 5 (segundo momento)** rodando opcionalmente no PC Desktop com GPU, sem bloquear nenhuma entrega principal. |

---

## 1. Visão Geral e Comparativo com o `mr-mak-workspace`

O `mr-mak-workspace` provou um modelo muito eficaz de trabalho com agentes locais: uma casca **Tauri 2** (duas janelas WebView2: *Workspace* em React 19 + TypeScript + Vite e *Chats* em `xterm.js`) conectada a um serviço local Node 22.6+ que gerencia sessões, relatórios HTML, cards editáveis (`*.card.json`) e pastas compartilhadas (`context/`, `knowledge/`, `inbox/`).

### Onde cada sistema já se destaca

| Dimensão | `mr-mak-workspace` | `ai-hud` (hoje) | Papel na arquitetura unificada |
|---|---|---|---|
| **Multi-máquina / 24x7** | 1 computador local | **Multi-Hub federado** (`Notebook` + `PC Desktop` + `VPS Oracle 24/7`, cache offline) | **Núcleo do `ai-hud`** (control plane único) |
| **Cotas, ritmo e telemetria** | Básico (contexto da sessão) | **Completo** (cotas 5h/7d/diária, ritmo, projeção burn-up, tokens/hora/dia, Ollama) | **Exposto no HUD e no Workspace** (e usado pelo Dreaming cota-aware!) |
| **IAs suportadas** | Claude, Codex, Antigravity, OpenCode, Kimi | **Claude, Codex, Gemini/Antigravity (`agy`), Ollama local** | **Unificado** sobre o coletor e launcher do `ai-hud` |
| **Leveza / Hardware antigo** | Tauri + React + `node-pty` | **Zero deps npm** no servidor, VPS **1 GB RAM** e **iPad mini 1 (Safari 9 / ES5)** | **Servidor `src/` e HUD `/` preservados intactos** |
| **Gestão visual de projetos & artefatos** | **Excelente** (`workspace.json`, `*.card.json`, `report.html`, `context/`, `knowledge/`) | Apenas sessões e arquivos modificados | **Implementado no AI Workspace** (`workspace-app/` + `workspace-desktop/`) |
| **Memória compartilhada entre IAs + Dreaming** | Apenas arquivos manuais (`context/`, `knowledge/`) e handoff 1:1 | Ainda não existe | **Diferencial central novo** unindo as 4 IAs nas 3 máquinas |
| **Performance & UX Desktop Windows** | **Excelente** (Tauri 2 + WebView2 + React 19 + TS + Vite + Win32) | Apenas web simples | **Adotado no AI Workspace** (web em `/workspace` + app nativo Tauri 2) |

### Princípio-guia: *Um único cérebro, três clientes*

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENTES                                           │
│                                                                                      │
│  [1. iPad mini 1 / Celular]      [2. Browser / PWA]          [3. Windows Desktop]    │
│   GET /  (HUD clássico ES5)       GET /workspace              Tauri 2 (WebView2)     │
│   • Monitoramento, cotas,         • Mesma UI React+TS+Vite    • Mesma UI React+TS    │
│     respostas rápidas,              servida pelo ai-hud         + múltiplas janelas, │
│     permissões, leitura           • Funciona em qualquer        tray nativa, estado  │
│     de memória/cards                máquina via Tailscale       de janela, rfd/drag, │
│                                                                 atalhos globais      │
└─────────────────┬─────────────────────────┬──────────────────────────────┬───────────┘
                  │  Mesma API REST + Long-Polling + Auth (PIN/token/TS)   │
                  ▼                         ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                   AI HUD SERVER (src/, :8787) — ZERO DEPS NPM                        │
│                                                                                      │
│  • Control Plane Multi-Máquina (Notebook + PC Desktop + VPS Oracle 24/7)             │
│  • Coletor das 4 IAs (Claude, Codex, Gemini/agy, Ollama) + Cotas/Ritmo/Burn-up       │
│  • Ações: spawn headless, reply, stop/close, permissions, handoff, upload, git/fs    │
│  • Motor File-First do Workspace (workspace.json, *.card.json, conflito 409, backup) │
│  • Motor de Memória Compartilhada + Agendador de Dreaming (cota-aware)               │
└─────────────────────────┬──────────────────────────────────┬─────────────────────────┘
                          ▼                                  ▼
┌───────────────────────────────────────────┐  ┌───────────────────────────────────────┐
│  WORKSPACE & MEMÓRIA (File-First / Git)   │  │  PROJETOS DE CÓDIGO (por máquina)     │
│  • workspace.json, entities/*.card.json   │  │  • Notebook, PC Desktop, VPS Oracle   │
│  • context/, knowledge/, skills/, inbox/  │  │  • <projeto>/.ai-memory/ (ou hub)     │
│  • memory/<projeto>/MEMORY.md,            │  │  • Protegidos por allowedRoots        │
│    decisions.md, pitfalls.md, sessions/   │  │    + path-guard + blacklist segredos  │
└───────────────────────────────────────────┘  └───────────────────────────────────────┘
```

---

## 2. O que Aproveitar Diretamente no `ai-hud` (Boas Práticas do `mr-mak-workspace`)

### 2.1 Padrões de engenharia adotados

1. **Modelo File-First & Agent-Readable (`workspace.json` + `*.card.json`):** arquivos simples em disco que tanto humanos (pela UI) quanto agentes (pelas ferramentas normais de arquivo) leem e editam, 100% compatíveis com Git.
2. **Controle otimista de conflito Humano × Agente (`baseHash` → `409 Conflict`) + Backups automáticos:** nunca sobrescrever silenciosamente uma edição feita por uma IA enquanto o usuário estava editando na tela; antes de qualquer gravação, manter cópia de recuperação em pasta ignorada pelo Git (`.ai-workspace/backups/`).
3. **Handoff de conversas longas (`handoff.mjs`):** prompt padronizado `# Handoff` salvo em `inbox/handoffs/` seguido da abertura automática de nova sessão na mesma pasta — estendido no `ai-hud` para **Handoff Cross-IA** (ex.: resumir no Claude perto do limite da cota de 5h e continuar imediatamente no Codex ou Antigravity!).
4. **Projetos pinados + Allowlist remota (`recent-projects.mjs`):** favoritos no topo e regra rígida impedindo que clientes remotos (celular/iPad) iniciem sessões fora de pastas autorizadas.
5. **Isolamento de relatórios HTML (`report.html`):** renderização em `iframe sandbox` com CSP restrita e acesso limitado à própria pasta da entidade.
6. **Anexos de imagem via staging (`inbox/attachments/`):** envio seguro de screenshots/fotos do celular ou desktop direto para o prompt da IA.
7. **Arquitetura Desktop Windows do `mr-mak-workspace` (`React 19 + TS + Vite` + `Tauri 2`):**
   - Usa **WebView2** nativo do Windows (em vez de empacotar Chromium inteiro como Electron) → startup sub-segundo, consumo de RAM drasticamente menor (~40–80 MB vs ~400+ MB) e binário enxuto (`lto = true`, `opt-level = "s"`, `strip = true`).
   - Plugins nativos já validados no `mr-mak-workspace`: `tauri-plugin-single-instance`, `tauri-plugin-window-state`, `tray-icon`, `rfd` (diálogos nativos de pasta/arquivo), `trash` (lixeira do Windows), `drag` (drag-and-drop nativo de arquivos) e suporte a múltiplas janelas independentes (ex.: *Workspace* + *Chats*).

### 2.2 Melhorias diretas no HUD clássico (`/`) — compatíveis com Safari 9 (ES5)

| Onda | Funcionalidade | Camadas no `ai-hud` |
|---|---|---|
| **Fase 0** | **Projetos favoritos (Pin) + Allowlist remota (`strictRemoteCwd`)** no `#nova` e `POST /api/new` | `infra/config.js`, `collect/projects.js`, `actions/spawn/`, `web/js/drawers/new-session.js` |
| **Fase 0** | **Botão rápido `⏹ Parar turno`** direto no topo da conversa quando `working` | `views/session-detail.js`, `api/routes/close.js`, `web/js/drawers/detail.js` |
| **Fase 0** | **Preview seguro de arquivos modificados + `git diff`** ao clicar nos arquivos da aba `Detalhes` | `core/path-guard.js`, `collect/files-preview.js`, `api/routes/file.js`, `federation/`, `web/js/drawers/detail.js` |
| **Fase 0** | **Handoff ("Resumir e continuar" + Cross-IA)** com alerta suave quando contexto ≥ 75% | `core/handoff.js`, `actions/handoff.js`, `api/routes/handoff.js`, `federation/`, `web/js/drawers/detail.js` |
| **Fase 1** | **Botão manual `🌙 Dream` + visualização da memória ativa** do projeto na aba `Detalhes` | `views/memory.js`, `api/routes/memory.js`, `web/js/drawers/detail.js` |
| **Fase 3** | **Pin, Renomear e Grupos de sessões** (`data/session-meta.json`) + **barra de subagentes ativos** | `infra/store.js`, `views/snapshot.js`, `api/routes/session-meta.js`, `web/js/render/` |
| **Fase 3** | **Anexar imagem pelo celular/iPad** (`inbox/attachments/`) + **autocomplete de `/`** + **leitura leve de cards** | `actions/upload.js`, `collect/skills.js`, `web/js/drawers/` |

---

## 3. Pilar Novo: Base de Memória Compartilhada entre IAs por Projeto + Dreaming

### 3.1 Por que funciona excepcionalmente bem aqui

A maioria dos sistemas de memória de agentes falha porque enxerga apenas uma ferramenta. O `ai-hud` já possui tudo que falta a eles:
- **Visão unificada das 4 IAs** (transcripts completos de Claude Code, Codex, Gemini/Antigravity e Ollama) nas **3 máquinas**.
- **Conhecimento de arquivos modificados, falhas de teste e `git log`** por projeto.
- **Monitoramento de cotas em tempo real**, permitindo consolidar memória sem queimar cota cara.
- **VPS Oracle 24/7** para agendamento fora do horário de trabalho + **PC Desktop com GPU/Ollama** para consolidação gratuita quando disponível.

### 3.2 Estrutura File-First de Memória por Projeto (Quente × Fria)

Para evitar **inchaço de contexto** (*context bloat*), a memória é dividida em **camada quente** (sempre carregada no início de uma sessão, com teto rígido de tamanho) e **camada fria** (consultada sob demanda):

```text
<MEMORIA_DO_PROJETO>/
├── MEMORY.md           # [QUENTE] Resumo vivo compacto (TETO RÍGIDO: ≤ 150 linhas / ~2.000 tokens)
├── current-state.md    # [QUENTE] Branch, o que está em andamento, pendências abertas reais
├── pinned.md           # [QUENTE/IMUTÁVEL] Regras fixadas pelo humano — Dreaming NUNCA altera nem apaga
├── decisions.md        # [MORNA] ADRs / Decisões arquiteturais + motivo + sessão de origem
├── pitfalls.md         # [MORNA] Armadilhas do ambiente, comandos peculiares, bugs já resolvidos
├── sessions/           # [FRIA] Resumos episódicos consolidados por dia/semana (arquivo histórico)
│   └── 2026-11-23.md
├── dream-state.json    # Cursor incremental: último timestamp/turnCount processado de cada sessão
└── dream-log.md        # Auditoria legível: data, motor usado, sessões lidas, o que entrou e o que foi podado
```

#### Dois modos configuráveis por projeto
1. **`in-repo` (`.ai-memory/` dentro do projeto):** ideal para projetos próprios; fica acessível diretamente a qualquer CLI aberta manualmente no terminal e pode ser versionado (ou mantido no `.gitignore` local).
2. **`workspace-hub` (`data/workspace/memory/<slug>/`):** ideal para repositórios de terceiros (sem sujar o `git status` do repo) ou projetos compartilhados entre máquinas via VPS.

### 3.3 Como as 4 IAs consomem a mesma base automaticamente (sem duplicar conteúdo)

| IA | Mecanismo de leitura automática |
|---|---|
| **Claude Code** | Ponte de 1–2 linhas em `CLAUDE.md` (`@.ai-memory/MEMORY.md`, `@.ai-memory/pinned.md`, `@.ai-memory/current-state.md`) — ou hook `SessionStart` injetando o resumo no modo `workspace-hub`. |
| **Codex CLI** | Ponte curta em `AGENTS.md` referenciando os mesmos arquivos (e instruindo a consultar `decisions.md`/`pitfalls.md` quando relevante). |
| **Gemini CLI / Antigravity (`agy`)** | Ponte em `GEMINI.md` / `.agents/rules/` + injeção automática do contexto quando iniciada via `POST /api/new` (HUD ou Workspace). |
| **Ollama** | O `ai-hud` monta o `system prompt` no `/api/chat`, injetando `pinned.md` + `MEMORY.md` + `current-state.md` automaticamente. |
| **Consulta sob demanda (Fase 3)** | Micro-servidor MCP local opcional (ou CLI leve do `ai-hud`) com ferramentas `memory_search(project, query)` e `memory_read(project, topic)` para qualquer IA pesquisar `decisions.md`, `pitfalls.md` e `sessions/` sem carregar tudo no prompt inicial. |

> **Handoff × Dreaming:** o **Handoff** é memória de trabalho de *curto prazo* (continua uma tarefa específica imediatamente, inclusive trocando de IA); o **Dreaming** é consolidação de *médio/longo prazo* (reúne tudo que as várias IAs fizeram no projeto, destila aprendizados duráveis e limpa pendências vencidas).

### 3.4 Pipeline do **Dreaming** (Manual ou Agendado Fora do Horário)

O Dreaming roda **por projeto** (ou em lote para todos os projetos ativos), acionado **manualmente** (botão `🌙 Consolidar memória` no HUD ou `/workspace`) ou **automaticamente fora do horário de trabalho** (ex.: diariamente às `03:00` na VPS Oracle via agendador leve integrado ao `ai-hud`, respeitando fuso local).

#### 4 estágios com proteção contra alucinação, vazamento e custo

1. **Estágio 1 — Coleta Incremental Determinística (0 tokens):**
   - Cruza todas as sessões conhecidas do projeto (Claude + Codex + Antigravity + Ollama, nas máquinas disponíveis) com `dream-state.json`.
   - Se não houve novas mensagens nem novos commits desde o último Dreaming, **encerra sem chamar nenhum LLM**.
   - Monta um **digest compacto** de cada sessão delta: prompts do usuário, respostas finais, arquivos modificados, erros/testes falhos e `git log` desde o último Dreaming (descartando logs brutos extensos de chamadas de ferramenta).
2. **Estágio 2 — Redação Determinística de Segredos (`src/core/redact.js`):**
   - Sanitiza o digest **antes** de enviá-lo ao modelo e **antes** de gravar qualquer arquivo de memória: mascara padrões de API keys (`sk-`, `AIza`, `ghp_`, `tskey-`), `Bearer` tokens, blocos `PRIVATE KEY`, URLs com credenciais e atribuições de senha/secret.
3. **Estágio 3 — Consolidação, Verificação e Poda Ativa (LLM):**
   - O modelo recebe: `pinned.md` (somente leitura), `MEMORY.md`, `current-state.md`, `decisions.md`, `pitfalls.md`, o digest das sessões novas e o `git log` recente.
   - Retorna uma saída estruturada (JSON validado em `src/core/memory.js`) contendo:
     - **Novas decisões / armadilhas** (sempre com evidência: `[Claude 2026-11-23]`, `[Codex 2026-11-23]`).
     - **Atualização de `current-state.md`** — cruzando com `git log` para **remover automaticamente pendências já commitadas/concluídas** (*esquecimento ativo*, evitando fatos obsoletos!).
     - **Compilação de `MEMORY.md`** respeitando o **teto rígido de 150 linhas** (se exceder, itens menos urgentes descem para `decisions.md`/`pitfalls.md`/`sessions/`).
     - **Entrada episódica** em `sessions/YYYY-MM-DD.md`.
4. **Estágio 4 — Gravação Atômica, Backup e Modo de Aprovação:**
   - Valida schema e roda `redact.js` novamente na saída do LLM.
   - Grava backups em `.ai-workspace/backups/memory/` e registra o resumo em `dream-log.md`.
   - Suporta 2 políticas configuráveis por projeto:
     - **`auto-apply` (padrão produtivo):** aplica direto com diff auditável + botão **"Desfazer este Dreaming"** em 1 clique no `/workspace`.
     - **`review-first`:** salva em `dream-pending.json` para aprovação visual no `/workspace` antes de atualizar os arquivos.

### 3.5 Motor de Execução Cota-Aware (Zero desperdício de cota)

Configurável por lista de prioridade no `config.json` (`dream.engines`):

1. **Prioridade 1 — Ollama local no PC Desktop (GPU):** se o peer `PC-Desktop` estiver online e com Ollama disponível, consolida com **custo zero** de cota (usando modelo local forte para síntese/JSON).
2. **Prioridade 2 — Modelo leve com guarda de cota (VPS 24/7):** quando o Desktop estiver desligado, dispara via CLI já autenticado na VPS (`agy` com Gemini Flash, Codex mini ou Claude Haiku) **somente se `quotas.<tool>` estiver abaixo do teto configurado** (ex.: `used < 60%`).
3. **Fallback seguro:** se todas as cotas configuradas estiverem acima do teto, **não roda** — marca o projeto como `"aguardando cota / manual"` para o próximo ciclo ou disparo manual.

> **Máquinas desligadas na madrugada:** como o `dream-state.json` rastreia por `sessionId + lastTurnAt`, sessões locais de uma máquina desligada às `03:00` não são perdidas — entram automaticamente no próximo Dreaming assim que a máquina voltar online (ou ao clicar manual).

---

## 4. Arquitetura do App **AI Workspace** (Alta Performance no Desktop Windows)

### 4.1 Stack Tecnológica Escolhida (verificada contra `mr-mak-workspace`)

Para entregar fluidez real de aplicativo desktop no Windows e suportar evoluções futuras ricas (múltiplas janelas, split panes, arrastar cards/arquivos, busca instantânea `Ctrl+K`, diffs lado a lado, terminal opcional):

| Camada | Tecnologia | Por que é a melhor escolha aqui |
|---|---|---|
| **Backend / Control Plane** | **Node 22.5+ (`src/`) — ZERO deps npm** | Preserva a maior força do `ai-hud`: roda com folga na VPS Oracle (1 GB RAM), Notebook e PC Desktop, com testes em `node:test` e arquitetura travada por `test/architecture.test.js`. |
| **HUD Clássico (`/`)** | **HTML/CSS/ES5 (`web/`) — sem build** | Mantém 100% de compatibilidade com **iPad mini 1 (Safari 9)** e carregamento instantâneo no celular. |
| **UI do AI Workspace (`/workspace`)** | **React 19 + TypeScript + Vite (`workspace-app/`)** | Mesma stack de UI do `mr-mak-workspace`: compilação rápida, tipagem forte para schemas de cards/memória/API, virtualização de listas/transcripts, drag-and-drop fluido, `react-markdown` + `remark-gfm`, paleta de comandos (`Ctrl+K`). Na VPS, o servidor apenas serve o bundle estático `workspace-app/dist/` (**zero `node_modules` em produção na VPS!**). |
| **Shell Desktop Windows (Fase 3)** | **Tauri 2 (Rust + WebView2 nativo) (`workspace-desktop/`)** | Mesma casca desktop do `mr-mak-workspace`: usa o **WebView2** já presente no Windows 10/11 (sem empacotar Chromium como Electron), startup < 0.5s, ~5x menos RAM que Electron, múltiplas janelas (ex.: *Workspace* + *Sessões/Chat*), ícone de bandeja, `single-instance`, `window-state`, diálogos nativos (`rfd`), lixeira (`trash`) e drag-and-drop nativo (`drag`). |

### 4.2 Organização do Monorepo (Tudo Junto, Pronto para Separar se Crescer)

```text
ai-hud/
├── src/                        # Servidor Node zero-deps (regras em test/architecture.test.js)
│   ├── core/                   # Funções puras (sem I/O):
│   │   ├── path-guard.js       #   contenção de raiz + blacklist de segredos
│   │   ├── redact.js           #   redação determinística de tokens/chaves/senhas
│   │   ├── workspace-schema.js #   validação de workspace.json e *.card.json
│   │   ├── memory.js           #   teto de linhas, parser/validador de saída do Dreaming
│   │   └── handoff.js          #   prompt e extração de "# Handoff"
│   ├── collect/                # Somente leitura:
│   │   ├── workspace/          #   leitura de workspace.json, cards, context, knowledge, skills, git
│   │   └── memory/             #   leitura de MEMORY.md, dream-state.json, seleção de sessões delta
│   ├── views/                  # Projeções de API (contrato aditivo)
│   ├── actions/                # Escrita/execução:
│   │   ├── workspace/          #   gravar card/md com baseHash (409) + backups + upload mídia
│   │   ├── memory/             #   dream.js (orquestrador cota-aware), undo, agendamento
│   │   └── handoff.js          #   orquestração de handoff mesma IA / Cross-IA
│   ├── federation/             # Proxy transparente multi-máquina (?machine=...)
│   ├── api/routes/             # /api/workspace/*, /api/memory/*, /api/fs/*, /api/handoff, /api/upload
│   └── infra/                  # config, data/, static serving de web/ e workspace-app/dist/
├── web/                        # HUD clássico ES5 (Safari 9 / iPad mini 1) — intocado na filosofia
├── workspace-app/              # Frontend moderno React 19 + TypeScript + Vite (servido em /workspace)
├── workspace-desktop/          # Shell Tauri 2 para Windows (aponta para o daemon ai-hud local/TS)
├── data/                       # Estado local (ignorado no Git do ai-hud)
│   └── workspace/              #   Padrão de WORKSPACE_ROOT (pode ser um sub-repo Git privado próprio!)
└── docs/                       # Documentação e planos
```

> **Isolamento de dependências:** `src/` e `package.json` raiz continuam **sem dependências npm obrigatórias** para rodar o servidor. `workspace-app/` tem seu próprio `package.json` isolado; `workspace-desktop/` tem seu `Cargo.toml` isolado. A VPS Oracle nunca precisa instalar Vite nem Rust — recebe apenas `src/`, `web/` e os estáticos compilados `workspace-app/dist/`.

### 4.3 Modelo File-First do Workspace (`workspace.json` + `*.card.json`)

```text
data/workspace/  (ou caminho em config.json -> workspaceDir)
├── workspace.json                  # Registro de projetos, pins, bindings multi-máquina
├── context/                        # Contexto global (preferências, papel das 3 máquinas, metas)
├── knowledge/                      # Runbooks e conhecimento cross-projeto
├── skills/                         # Catálogo unificado de skills/prompts reutilizáveis
├── memory/                         # Memórias no modo workspace-hub (repos de terceiros / compartilhados)
│   └── <project-slug>/
├── inbox/
│   ├── handoffs/                   # Handoffs gerados entre sessões (incluindo Cross-IA)
│   └── attachments/                # Imagens enviadas do celular/HUD/Workspace
├── entities/                       # Entidades visuais de projetos e pesquisas
│   └── 2026-11-23_ai-hud/
│       ├── board.card.json         # Templates intercambiáveis: board | research | gallery
│       ├── report.html             # Relatórios HTML ricos (sandboxed)
│       ├── notes.md                # Documentos Markdown editáveis
│       └── media/                  # Imagens, mockups, diagramas
└── .ai-workspace/                  # Ignorado no Git: backups de cards e memória
```

- **Templates de `*.card.json`:** `board` (colunas `idea` / `in-progress` / `review` / `done`), `research` (lista rica com notas Markdown e links) e `gallery` (grade visual com imagens e prompts) — todos usando o mesmo JSON, trocáveis sem perda.
- **Vínculo nativo com o `ai-hud`:** cada entidade guarda `projectBindings` (`[{ machine, cwd }]`) e cada item do card pode referenciar uma sessão (`sessionRef`) ou um arquivo de handoff (`handoffPath`).

### 4.4 Contrato de API Aditivo (`/api/*`)

| Método e Rota | Finalidade |
|---|---|
| `GET /api/workspace/index` | Lista entidades, pins, `context/`, `knowledge/`, `skills/`, `inbox/handoffs/`. |
| `POST /api/workspace/entity` | Cria entidade/projeto (pasta + `workspace.json` + card inicial). |
| `GET /api/workspace/entity/:id/file?path=` | Lê card ou Markdown + `hash` (SHA-256) para edição segura. |
| `PUT /api/workspace/entity/:id/file` | Grava com `baseHash` (`409 Conflict` se alterado por IA) + backup atômico. |
| `GET /api/workspace/entity/:id/asset/*` | Serve `media/*` e `report.html` isolados na pasta da entidade + CSP restrita. |
| `POST /api/workspace/entity/:id/media` | Upload seguro de imagem para `media/`. |
| `GET /api/memory?project=` | Lê `MEMORY.md`, `current-state.md`, `pinned.md`, `decisions.md`, `pitfalls.md`, status do último Dreaming e contagem de sessões pendentes. |
| `PUT /api/memory/file` | Edita manualmente qualquer arquivo de memória (especialmente `pinned.md`) com proteção `409 Conflict`. |
| `POST /api/memory/dream` | Dispara Dreaming manual (`{ project?, engine?, dryRun? }`) e retorna job/status + diff. |
| `POST /api/memory/undo` | Restaura o backup imediatamente anterior ao último Dreaming de um projeto. |
| `GET /api/fs/list`, `/api/fs/preview`, `/api/fs/git` | Árvore de arquivos, preview/diff somente leitura e status Git por máquina (`?machine=&cwd=`), protegidos por `path-guard.js`. |
| `POST /api/handoff` | Gera `# Handoff` de sessão longa e abre nova sessão (mesma IA ou Cross-IA). |
| `POST /api/upload`, `POST /api/session-meta` | Upload de anexos para sessão e metadados (`pinned`, `alias`, `group`). |

### 4.5 Segurança (Invariantes)

1. **`path-guard.js` + `fs.realpathSync`:** impede *path traversal* (`..`) e symlinks escapando de `workspaceDir` ou `allowedRoots`.
2. **Blacklist de segredos:** bloqueia leitura/preview de `.env*`, `*.key`, `*.pem`, `*.p12`, `id_rsa*`, `*credentials*`, `config.json` e `data/pending.json`.
3. **Redação pré-LLM (`redact.js`):** limpa tokens/senhas antes do Dreaming enviar dados a qualquer modelo e antes de gravar memória.
4. **Sandbox de `report.html`:** `iframe sandbox` com CSP sem `connect-src`, impedindo relatórios gerados por IA de chamar rotas autenticadas do HUD.
5. **Allowlist remota:** acessos fora do loopback só abrem sessões em pastas conhecidas/autorizadas.

---

## 5. Roadmap Produtivo em Fases

### Fase 0 — Quick Wins & Fundação no `ai-hud`
*Retorno imediato no uso diário (inclusive no iPad mini 1) enquanto constrói os blocos de segurança reutilizados por tudo.*
- [ ] `src/core/path-guard.js` e `src/core/redact.js` (100% puros + testes unitários).
- [ ] **Projetos pinados + Allowlist remota (`strictRemoteCwd`)** no `#nova` e `POST /api/new`.
- [ ] **Botão rápido `⏹ Parar turno`** direto no cabeçalho da conversa quando `working`.
- [ ] **Preview seguro de arquivos modificados + `git diff`** ao clicar nos arquivos listados na aba `Detalhes` (com suporte federado entre as 3 máquinas).
- [ ] **Handoff ("Resumir e continuar" + Cross-IA)** com alerta visual quando contexto ≥ 75%, salvando em `inbox/handoffs/` e abrindo nova sessão via `POST /api/new`.

### Fase 1 — Motor File-First: Workspace + Memória Compartilhada & Dreaming (Backend + API)
*Toda a inteligência de dados, validação, conflito `409`, memória cross-IA e agendamento noturno pronta e testada.*
- [ ] `src/core/workspace-schema.js` e `src/core/memory.js`.
- [ ] `src/collect/workspace/` + `src/actions/workspace/` (entidades, `*.card.json`, `baseHash` → `409`, backups em `.ai-workspace/backups/`, upload de mídia).
- [ ] `src/collect/memory/` + `src/actions/memory/dream.js`:
  - Coleta incremental multi-IA / multi-máquina por `dream-state.json`.
  - Redação de segredos + consolidação com `git log` + poda ativa + teto de `MEMORY.md` + `pinned.md` imutável.
  - Seleção de motor **cota-aware** (Ollama Desktop → modelo leve VPS abaixo do teto de cota).
  - Agendador fora do horário (ex.: `03:00` na VPS) + botão manual `🌙 Dream` e visualização da memória já disponíveis no HUD clássico (`/`).
  - Gerador de pontes finas (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` + injeção no `POST /api/new` e Ollama).
- [ ] Rotas `/api/workspace/*`, `/api/memory/*`, `/api/fs/*` + federação + suíte completa em `node --test` e `test/architecture.test.js`.

### Fase 2 — App **AI Workspace** em React 19 + TypeScript + Vite (`/workspace`)
*Interface desktop/web de alta performance servida pelo próprio `ai-hud`.*
- [ ] Scaffolding limpo em `workspace-app/` (React 19 + TypeScript + Vite) com build estático servido em `/workspace`.
- [ ] **Layout desktop produtivo** (painéis redimensionáveis + atalhos de teclado + paleta de comandos `Ctrl+K`):
  - **Sidebar de Projetos/Entidades:** pins, busca instantânea, indicador de sessões ativas e badge de sessões pendentes de Dreaming.
  - **Área Central (Abas do Projeto):**
    1. **Cards editáveis** (`Board` estilo Kanban, `Research` e `Gallery`, drag-and-drop, Markdown, rascunho resiliente e modal de conflito `409`).
    2. **Memória & Dreaming** (ver/editar `MEMORY.md`, `pinned.md`, `decisions.md`, `pitfalls.md`, histórico `dream-log.md`, diff do último Dreaming, botão `🌙 Consolidar agora` e `Desfazer`).
    3. **Relatórios & Notas** (`report.html` em `iframe sandbox` + editor Markdown).
    4. **Arquivos & Git** (árvore leve, preview com syntax highlight, diff e últimos commits na máquina dona).
  - **Painel Lateral Vivo (AI HUD integrado):** sessões do projeto em todas as máquinas, cotas ao vivo das 4 IAs, conversa estruturada, `+ Nova sessão neste projeto` (com máquina/IA/contexto pré-carregados) e `Handoff Cross-IA`.
- [ ] Pin, renomear, grupos de sessões (`data/session-meta.json`), barra de subagentes, upload de imagens (`inbox/attachments/`) e autocomplete de `/` comandos/skills.

### Fase 3 — App Nativo Windows com **Tauri 2 (WebView2)** + Experiência Multi-Janela
*Evolução natural da mesma UI `workspace-app/` para experiência desktop nativa no Windows.*
- [ ] Casca Rust em `workspace-desktop/` (`Tauri 2`, `WebView2`, `single-instance`, `window-state`, `tray-icon`).
- [ ] Conecta-se ao `ai-hud` local (`127.0.0.1:8787`) ou remoto (VPS/Tailscale), iniciando o serviço local se necessário.
- [ ] Suporte a **múltiplas janelas independentes** (ex.: janela *Workspace/Memória* em um monitor e *Sessões/Chat* em outro — mesmo padrão do `mr-mak-workspace`).
- [ ] Interações nativas de desktop Windows: seletor nativo de pastas (`rfd`), envio seguro para lixeira (`trash`), drag-and-drop nativo de arquivos (`drag`) e atalhos globais opcionais.
- [ ] *(Opcional nesta fase)* Micro-servidor MCP local do `ai-hud` expondo `memory_search` para consultas sob demanda na memória fria (`sessions/`, `decisions.md`).

### Fase 4 — Sync Multi-Máquina 24/7 & Experiência Mobile Aprimorada
*Fechando o ciclo entre Notebook, PC Desktop, VPS Oracle e iPad/Android.*
- [ ] Fluxo de sincronização Git para `data/workspace/` com a VPS Oracle como espelho 24/7 (indicador visual de sync/conflito no topo do `/workspace`).
- [ ] Leitura leve (ES5) de cards, relatórios e `MEMORY.md` diretamente no HUD móvel (`/` — iPad mini 1 e celular).
- [ ] Notificações **Web Push** nativas (`node:crypto` VAPID, zero deps) no Android PWA quando uma sessão termina, falha teste, pede permissão ou conclui um Dreaming noturno.

### Fase 5 — *Good-to-Have* (Segundo Momento, Sob Demanda)
- [ ] **Voz local (Whisper + TTS) no PC Desktop (GPU):** serviço auxiliar opcional apenas no Desktop, permitindo ditado e leitura em voz alta inclusive no **iPad mini 1 (HTTP)** sem custo de API.
- [ ] **Terminal interativo embutido (PTY / `xterm.js`):** apenas se no futuro houver necessidade real de TUI interativa dentro da janela desktop Tauri (mantido fora do núcleo zero-deps e da VPS).
- [ ] **Separação de repositório:** se `workspace-app/` + `workspace-desktop/` crescerem muito, podem ser extraídos para um repositório irmão sem mudar a API do `ai-hud`.
