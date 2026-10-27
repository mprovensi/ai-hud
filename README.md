# AI HUD

Painel para acompanhar, de um iPad ou celular na rede de casa, as sessões e o uso de tokens do
Claude Code, do Codex e do Antigravity que rodam no PC: cotas do plano com projeção, sessões
ativas, respostas rápidas, permissões e um botão para trazer a sessão para frente no PC.

Tudo roda localmente com Node.js, sem dependências: o servidor lê os logs que os próprios CLIs
gravam e serve uma página leve (ES5, funciona até no Safari 9 do iPad mini 1).

## Rodar

```
node server.js
```

Na primeira execução é criado `config.json` com o token e o PIN de 8 dígitos (não versionado).
O servidor mostra o endereço na rede local; no aparelho, abra `http://<ip-do-pc>:8787` e digite o PIN.

Para iniciar junto com o Windows, copie `start-hidden.vbs` para a pasta Inicializar
(`Win+R` → `shell:startup`).

## Arquivos

| Arquivo | Função |
| --- | --- |
| `server.js` | Servidor HTTP: snapshot, detalhe da sessão, PIN, respostas, permissões, Abrir no PC |
| `lib.js` | Lê os logs do Claude Code, Codex e Antigravity (tokens, sessões, pedidos, respostas) |
| `quotas.js` | Cotas ao vivo: Claude via `get_usage`, Codex via `app-server` |
| `hook-stop.js` | Hook `Stop` do Claude Code: entrega respostas enviadas pelo HUD |
| `hook-permission.js` | Hook `PermissionRequest`: Permitir/Negar pelo HUD no modo remoto |
| `focus.ps1` | Traz para frente a janela da sessão (VS Code, terminal, app do Claude) |
| `statusline.js` | Statusline do Claude Code com contexto, custo e cotas |
| `dashboard.js` | Painel HTML estático (versão inicial) |
| `public/` | Página: `index.html`, `app.css`, `app.js`, PWA (`manifest.json`, `sw.js`) e ícones |

## Integração com o Claude Code

Em `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node D:/Projetos/ai-hud/statusline.js" },
"hooks": {
  "Stop": [{ "hooks": [{ "type": "command", "command": "node D:/Projetos/ai-hud/hook-stop.js claude", "timeout": 1900 }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node D:/Projetos/ai-hud/hook-permission.js", "timeout": 660 }] }]
}
```

O Codex recebe respostas pela fila nativa (`codex queue`), sem hook.
