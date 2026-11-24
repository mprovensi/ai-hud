# AI HUD & AI Workspace — Design System ("Obsidian Slate")

Identidade visual unificada para o **AI Workspace** (`workspace-app/`) e o **AI HUD** (`web/`).
Tokens formais vivem em [`workspace-app/src/design-system/tokens.css`](../workspace-app/src/design-system/tokens.css), primitivos React em [`workspace-app/src/ui/index.tsx`](../workspace-app/src/ui/index.tsx) e o showcase visual interativo em [`docs/design-system-preview.html`](./design-system-preview.html).

---

## 1. Princípios Visuais

1. **Densidade operacional sem ruído:** painéis compactos com contraste claro entre canvas, painéis e cards, evitando decorações excessivas.
2. **Cor como sinal semântico (nunca enfeite):** cada provedor de IA, estado de sessão e etapa do Board possui uma cor fixa e consistente em toda a interface.
3. **Economia cognitiva:** listas simples (ex.: sidebar com visual limpo + bolinha discreta de status à direita do nome), ações primárias evidentes e modais de edição protegidos contra fechamento acidental.
4. **Compatibilidade dupla:**
   - **AI Workspace (`workspace-app/`):** React + CSS custom properties (`--ds-*`).
   - **AI HUD (`web/`):** ES5 puro, flexbox **sem `gap`** e cores hexadecimais estáticas espelhadas dos mesmos tokens (compatível com Safari 9 / iPad mini 1).

---

## 2. Paleta e Tokens (`tokens.css`)

### Superfícies e Bordas
| Token | Alias | Hex | Uso |
|---|---|---|---|
| `--ds-bg` | `--bg` | `#0e0f12` | Canvas principal da aplicação |
| `--ds-inset` | — | `#101216` | Inputs, listas internas, blocos de código/console |
| `--ds-panel` | `--panel` | `#15171c` | Topbar, sidebar, colunas do Board, painéis do HUD |
| `--ds-card` | `--card` | `#1b1e25` | Cards, botões padrão, chips de cota |
| `--ds-card-hover` | `--card-hover` | `#21252f` | Estado hover/ativo suave |
| `--ds-border` | `--border` | `#292d38` | Divisores e contornos padrão |
| `--ds-border-hi` | `--border-hi` | `#3a4152` | Foco, hover de borda, contornos de modais |

### Tipografia e Texto
| Token | Alias | Valor | Uso |
|---|---|---|---|
| `--ds-text` | `--text` | `#eceef2` | Texto principal |
| `--ds-text-soft` | — | `#cfd5e2` | Texto secundário legível |
| `--ds-muted` | `--muted` | `#8f96a6` | Metadados, placeholders, rótulos de seção |
| `--ds-sans` | `--sans` | `'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif` | Interface geral (`14px` base) |
| `--ds-mono` | `--mono` | `'Cascadia Code', Consolas, Menlo, monospace` | Caminhos, hashes Git, comandos, logs |

### Marca, Provedores de IA e Semântica
| Grupo | Token | Hex | Significado |
|---|---|---|---|
| Marca | `--ds-accent` | `#5fb8a4` | Ação primária, seleção ativa, foco de drag-and-drop |
| Provedor | `--ds-claude` | `#e08a66` | Claude Code |
| Provedor | `--ds-codex` | `#5fb8a4` | Codex |
| Provedor | `--ds-gemini` | `#7d9bf0` | Gemini / Antigravity |
| Provedor | `--ds-ollama` | `#b39ddb` | Ollama local |
| Estado | `--ds-ok` | `#8ad6a3` | Executando / sucesso / saudável |
| Estado | `--ds-warn` | `#e5c063` | Atenção / aguardando / revisão / pendência Git |
| Estado | `--ds-danger` | `#e87070` | Erro / permissão crítica / ação destrutiva |

### Etapas do Board (Workflow Elephant-Goldfish)
| Etapa | Token | Hex | Aplicação visual |
|---|---|---|---|
| **Ideia** (`idea`) | `--ds-stage-idea` | `#7c8ba6` | Borda esquerda `3px` + gradiente 6% no card + borda topo `3px` no modal |
| **Spec / Plano** (`spec`) | `--ds-stage-spec` | `#b692f6` | Borda esquerda `3px` + gradiente 8% no card + badge violeta |
| **Em andamento** (`in-progress`) | `--ds-stage-progress` | `#6ea3f7` | Borda esquerda `3px` + gradiente 9% no card + badge azul |
| **Revisão** (`review`) | `--ds-stage-review` | `#e5c063` | Borda esquerda `3px` + gradiente 9% no card + badge âmbar |
| **Concluído** (`done`) | `--ds-stage-done` | `#6fd195` | Borda esquerda `3px` + gradiente 7%, opacidade `.82` (`1` no hover) |

---

## 3. Escala de Geometria e Camadas

- **Raios:** `--ds-r-sm: 6px` (chips/itens de lista), `--ds-r-md: 8px` (botões/inputs), `--ds-r-lg: 12px` (cards/colunas), `--ds-r-xl: 14px` (modais/painéis HUD), `--ds-r-pill: 999px` (badges/cotas).
- **Espaçamento:** múltiplos de `4px` (`--ds-sp-1: 4px`, `--ds-sp-2: 8px`, `--ds-sp-3: 12px`, `--ds-sp-4: 16px`, `--ds-sp-5: 20px`).
- **Camadas (`z-index`):** Dropdowns `30`, Side Drawers `60`, Modais `70`, Lightbox de imagem `90`, Toasts `100`.

---

## 4. Regras de Componentes

- **Botões (`Button` em `src/ui/index.tsx`):** `default` (neutro), `primary` (tint `--ds-accent-bg` + borda `--ds-accent-border`), `danger` (tint vermelho), `sm` para toolbars e cards.
- **Modais de formulário (`ModalFrame`):** `closeOnBackdrop={false}` por padrão — nunca descartar dados digitados ao clicar fora; fechar apenas via **Cancelar**, **X** ou **Esc**.
- **Comboboxes:** sempre usar menu customizado `width: 100%` (`.ws-combo` / `.ws-combo-menu`) em vez de `<datalist>` nativo.
- **Sidebar:** visual limpo; projetos ocultos com `.sb-hidden` (`opacity: .52`); indicador de atividade apenas como bolinha `.sb-dot` à direita do nome.
- **Board:** container em altura total sem scroll externo; scroll vertical individual por coluna; auto-save silencioso (`500ms`).
