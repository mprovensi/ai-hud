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

Abrir e fechar os detalhes de uma sessão com **sua vez** marca a resposta como **vista** neste aparelho.
Uma nova resposta volta a destacar o card e pedir sua atenção.
A ordem dos cards é a mesma no navegador e no atalho: permissões pendentes primeiro,
depois a última atividade. Marcar como visto limpa o alerta e mantém a posição do card.

Para iniciar junto com o Windows, copie `start-hidden.vbs` para a pasta Inicializar
(`Win+R` → `shell:startup`).

## Linux

Funciona igual (servidor, sessões, tokens, cotas, respostas, permissões, hub), exceto
**Abrir no PC**, que por enquanto só existe no Windows. O `claude` e o `codex` são
procurados em `~/.local/bin` e no `PATH` (ou defina `AI_HUD_CLAUDE` / `AI_HUD_CODEX`).

```
git clone https://mprovensi@github.com/mprovensi/ai-hud.git ~/ai-hud
cd ~/ai-hud && node server.js            # teste; Ctrl+C para parar
```

Para rodar sempre (e reiniciar se cair), use o serviço do systemd em `ai-hud.service`
(instruções no próprio arquivo). Se houver firewall: `sudo ufw allow 8787/tcp`.
Nos hooks do Claude Code, use os caminhos do Linux, ex.: `node ~/ai-hud/hook-stop.js claude`.

## Vários PCs (hub)

Um PC pode juntar as sessões de outros. Instale o AI HUD também no PC secundário e,
no `config.json` do PC **principal**, acrescente:

```json
"name": "MateusPC",
"peers": [
  { "name": "PC-Trabalho", "url": "http://<ip-do-secundario>:8787", "token": "<token do config.json do secundário>" }
]
```

Reinicie o servidor principal. O principal consulta o secundário a cada 10 s e mostra
tudo junto (com o nome da máquina em cada sessão); responder, permissões, Abrir no PC e
detalhes são repassados ao PC dono da sessão. Os aparelhos acessam só o principal.

## Arquivos

| Arquivo | Função |
| --- | --- |
| `server.js` | Servidor HTTP: snapshot, detalhe da sessão, PIN, respostas, permissões, Abrir no PC |
| `lib.js` | Lê os logs do Claude Code, Codex e Antigravity (tokens, sessões, pedidos, respostas) |
| `codex-history.js` | Recupera conversas do histórico paginado do Codex nos bancos SQLite locais, somente para leitura |
| `http-utils.js` | Autenticação, validação de JSON e tratamento de erros das requisições HTTP |
| `quotas.js` | Cotas ao vivo: Claude via `get_usage`, Codex via `app-server` |
| `peers.js` | Hub: junta os dados de outros PCs e repassa as ações a eles |
| `ollama-chats.js` | Conversas do app do Ollama (Windows) como sessões: lê o db.sqlite do app (só leitura) e responde pelo Ollama local, guardando a continuação no HUD |
| `ollama.js` | Estado do Ollama local (modelos carregados, versão) e da GPU NVIDIA; aparece no HUD só se houver Ollama |
| `ollama-metrics.js` | Converte os tempos medidos pelo Ollama em duração da resposta e tokens por segundo |
| `hook-stop.js` | Hook `Stop` do Claude Code: entrega respostas enviadas pelo HUD |
| `hook-permission.js` | Hook `PermissionRequest`: Permitir/Negar pelo HUD no modo remoto |
| `focus.ps1` | Traz para frente a janela da sessão (VS Code, terminal, app do Claude); só Windows |
| `terminal-focus.js` / `terminal-focus.ps1` | Identificam o processo do CLI e selecionam a aba no VS Code ou Windows Terminal |
| `vscode-terminal/` | Integração local do VS Code para selecionar terminais pelo processo, inclusive abas com nomes iguais |
| `install-terminal-focus.ps1` | Empacota e instala a integração do VS Code sem dependências de npm |
| `ai-hud.service` | Serviço do systemd para rodar no Linux |
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

O leitor respeita `CODEX_HOME` (padrão: `~/.codex`). Quando o Node oferece `node:sqlite`,
também lê as conversas migradas para os bancos `state_*.sqlite` e `thread_history_*.sqlite`,
sem alterá-los. Sem SQLite, continua lendo os JSONL. As métricas de tokens dependem dos
logs JSONL; o HUD não estima tokens ausentes no histórico paginado.

No Ollama, **Mais detalhes** mostra os dados disponíveis da conversa, do modelo e do PC.
Respostas geradas pelo HUD registram tokens de saída, tempo total e a média de tokens/s,
calculada com `eval_count / eval_duration * 1e9` ([métricas da API](https://docs.ollama.com/api/usage)).
O histórico do terminal não salva respostas nem essas métricas; conversas antigas não ganham medições retroativas.
Em instalações com vários PCs, o HUD da máquina que gera a resposta também precisa estar atualizado.

## Selecionar a aba do CLI ao abrir no PC

No Windows, **Abrir no PC** seleciona o terminal da sessão antes de trazer a janela para frente.
No **VS Code**, instale a integração local uma vez em cada PC que hospeda os CLIs:

```powershell
powershell -NoProfile -File install-terminal-focus.ps1
```

A integração identifica o processo de cada terminal; abas com nomes iguais continuam distintas.
Ela só aceita pedidos locais autenticados e não escreve comandos no terminal. Se o VS Code pedir
para recarregar após a instalação, recarregue a janela para ativar a integração.

No **Windows Terminal**, não há extensão para instalar. O HUD procura uma aba com título único
compatível com a sessão, projeto ou modelo. Se duas abas forem indistinguíveis, dê nomes diferentes
a elas: o HUD informa a ambiguidade em vez de selecionar uma ao acaso. Uma sessão já encerrada
precisa estar aberta no CLI para que a aba possa ser selecionada.

## Testes

Execute `node --test` para rodar os testes de regressão, sem dependências externas.
Eles usam dados simulados e um servidor HTTP temporário; não acionam os CLIs nem alteram as conversas locais.
O teste nativo opcional `node scripts/windows-terminal-smoke.js` abre abas próprias no Windows Terminal,
verifica a troca e a recusa de títulos duplicados, e encerra apenas seus processos de teste ao terminar.
