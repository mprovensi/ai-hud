# MCP Local — AI HUD Memory Search

Micro-servidor MCP via `stdio` (zero dependências externas) que permite ao **Claude Code**, **Codex** e **Antigravity** consultar sob demanda a memória compartilhada (`MEMORY.md`, `pinned.md`, `decisions.md`, `pitfalls.md`, `episodic/`) e os documentos do **AI Workspace**.

## Ferramentas expostas
- `memory_search(query, project?, limit?)` — busca por palavras-chave na memória e docs do Workspace.
- `memory_read(project, file?)` — lê um arquivo específico da memória de um projeto.
- `workspace_list()` — lista projetos/entidades e memórias disponíveis.

## Como ativar (exemplo `mcpServers`)

```json
{
  "mcpServers": {
    "ai-hud-memory": {
      "command": "node",
      "args": ["D:/Projetos/ai-hud/integrations/mcp/memory-server.js"]
    }
  }
}
```

Por padrão lê `data/config.json` (`workspaceRoot`) ou `<repo>/data/workspace`. Para sobrescrever, defina `AI_WORKSPACE_ROOT` no `env` do servidor MCP.
