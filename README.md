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

Na primeira execução é criado `data/config.json` com o token e o PIN de 8 dígitos (não versionado).
Tudo o que o HUD gera ao rodar (filas, históricos, logs) fica em `data/`. Instalações antigas,
com esses arquivos na raiz, são migradas automaticamente na primeira execução.
O servidor mostra o endereço na rede local; no aparelho, abra `http://<ip-do-pc>:8787` e digite o PIN.

Abrir e fechar os detalhes de uma sessão com **sua vez** marca a resposta como **vista** neste aparelho.
Uma nova resposta volta a destacar o card e pedir sua atenção.
A ordem dos cards é a mesma no navegador e no atalho: permissões pendentes primeiro,
depois a última atividade. Marcar como visto limpa o alerta e mantém a posição do card.

Para iniciar junto com o Windows, copie `windows/tray/start-tray.vbs` (ícone na bandeja, sem janela)
para a pasta Inicializar (`Win+R` → `shell:startup`).

## Instalar como app no Android (PWA)

O acesso HTTP acima serve para usar o painel no navegador. Para instalar como app no Chrome
do Android, abra o HUD por **HTTPS com certificado válido e confiável no celular**. Endereços
como `http://192.168.x.x:8787`, `http://100.x.x.x:8787` (IP do Tailscale) ou `http://pc.local:8787`
não atendem esse requisito: o ícone adicionado pode ser apenas um atalho que abre o Chrome.
O manifest já pede `display: fullscreen`; JavaScript de tela cheia não transforma esse atalho em PWA.

Se você usa Tailscale no PC e no celular, a **bandeja do AI HUD ativa o
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) automaticamente** ao iniciar
o servidor. Faça login e conecte o Tailscale uma vez. A janela **Status e log** mostra o endereço
**HTTPS (Android / PWA)**. No menu da bandeja, use **Copiar endereço HTTPS** para enviá-lo ao celular
ou **Abrir HTTPS (Android / PWA)** para abrir no PC.

O primeiro uso pode exigir habilitar HTTPS na rede Tailscale: use **Autorizar Tailscale / HTTPS**
na bandeja, conclua no navegador e clique em **Atualizar HTTPS**. A bandeja também verifica o estado
a cada minuto e recupera a rota se ela desaparecer. As consultas rodam em segundo plano.
Se faltar instalação/login ou houver um problema, o estado aparece na janela e o HTTP local continua
funcionando. Uma porta 443 ocupada por outro serviço, Serve em foreground ou Funnel é informada
como conflito e preservada. A integração usa a porta configurada do HUD (`AI_HUD_PORT`, padrão 8787).
Ao parar ou fechar o HUD, a configuração do Serve permanece registrada no Tailscale; a página fica
indisponível até o servidor iniciar novamente.

Se preferir rodar o servidor sem a bandeja, configure o Serve manualmente no PC:

```
tailscale serve --bg http://127.0.0.1:8787
```

Se solicitado, siga o link exibido pelo Tailscale para habilitar HTTPS na sua rede.
No Android, conecte o Tailscale e abra no Chrome a URL **`https://…ts.net`** exibida pelo comando.
Digite o PIN, remova o atalho HTTP antigo e use o menu do Chrome para **Instalar app**
(em algumas versões, **Adicionar à tela inicial → Instalar**). Depois, abra pelo novo ícone.
O Serve mantém o acesso na sua rede Tailscale. Se já houver outro serviço no Serve,
confira `tailscale serve status` antes de mudar a configuração da raiz.

Sem Tailscale, use um proxy HTTPS com certificado confiável no Android apontando para a porta 8787.
Use o mesmo endereço HTTPS nas próximas aberturas e instalações. Apenas aceitar o aviso de um
certificado inválido não resolve. A exceção HTTP de `localhost` se refere ao próprio celular,
não ao PC na rede. Veja os [critérios de instalação do Chrome](https://web.dev/articles/install-criteria).

Para diagnosticar pelo Chrome do PC, abra o mesmo endereço e veja **DevTools → Application → Manifest**.
O manifest e os ícones precisam carregar sem autenticação; a tela de PIN também referencia o manifest.
Em **Service Workers**, confirme o registro de `/sw.js`. No console, `window.isSecureContext`
deve ser `true`. Dentro do app aberto pelo ícone, `matchMedia('(display-mode: fullscreen)').matches`
deve ser `true` quando o navegador suportar esse modo; `standalone` também indica uma janela de app
sem a barra de endereço. A confirmação final da instalação deve ser feita no Android.

## Linux

Funciona igual (servidor, sessões, tokens, cotas, respostas, permissões, hub), exceto
**Abrir no PC**, que por enquanto só existe no Windows. O `claude` e o `codex` são
procurados em `~/.local/bin` e no `PATH` (ou defina `AI_HUD_CLAUDE` / `AI_HUD_CODEX`).

```
git clone https://mprovensi@github.com/mprovensi/ai-hud.git ~/ai-hud
cd ~/ai-hud && node server.js            # teste; Ctrl+C para parar
```

Para rodar sempre (e reiniciar se cair), use o serviço do systemd em `linux/ai-hud.service`
(instruções no próprio arquivo). Se houver firewall: `sudo ufw allow 8787/tcp`.
Nos hooks do Claude Code, use os caminhos do Linux, ex.: `node ~/ai-hud/claude/hook-stop.js claude`.

## Vários PCs (hub)

Um PC pode juntar as sessões de outros. Instale o AI HUD também no PC secundário e,
no `data/config.json` do PC **principal**, acrescente:

```json
"name": "MateusPC",
"peers": [
  { "name": "PC-Trabalho", "url": "http://<ip-do-secundario>:8787", "token": "<token do data/config.json do secundário>" }
]
```

Reinicie o servidor principal. O principal consulta o secundário a cada 10 s e mostra
tudo junto (com o nome da máquina em cada sessão); responder, permissões, Abrir no PC e
detalhes são repassados ao PC dono da sessão. Os aparelhos acessam só o principal.

O cartão do Ollama mostra cada PC com Ollama, inclusive fora do ar ou sem conexão. Se o
Ollama fica só em outro PC, `"ollama": false` no `data/config.json` esconde o deste.

## Arquivos

| Arquivo | Função |
| --- | --- |
| `server.js` | Servidor HTTP: snapshot, detalhe da sessão, PIN, respostas, permissões, Abrir no PC |
| **`src/`** | **Módulos do servidor** |
| `src/lib.js` | Lê os logs do Claude Code, Codex e Antigravity (tokens, sessões, pedidos, respostas) |
| `src/codex-history.js` | Recupera conversas do histórico paginado do Codex nos bancos SQLite locais, somente para leitura |
| `src/http-utils.js` | Autenticação, validação de JSON e tratamento de erros das requisições HTTP |
| `src/quotas.js` | Cotas ao vivo: Claude via `get_usage`, Codex via `app-server` |
| `src/peers.js` | Hub: junta os dados de outros PCs e repassa as ações a eles |
| `src/ollama-chats.js` | Conversas do app do Ollama (Windows) como sessões: lê o db.sqlite do app (só leitura) e responde pelo Ollama local, guardando a continuação no HUD |
| `src/ollama.js` | Estado do Ollama local (modelos carregados, versão) e da GPU NVIDIA; aparece no HUD só se houver Ollama |
| `src/ollama-metrics.js` | Converte os tempos medidos pelo Ollama em duração da resposta e tokens por segundo |
| `src/terminal-focus.js` | Identifica o processo do CLI e seleciona a aba no VS Code ou Windows Terminal |
| **`claude/`** | **Integração com o Claude Code** |
| `claude/hook-stop.js` | Hook `Stop`: entrega respostas enviadas pelo HUD |
| `claude/hook-permission.js` | Hook `PermissionRequest`: Permitir/Negar pelo HUD no modo remoto |
| `claude/statusline.js` | Statusline com contexto, custo e cotas |
| **`windows/`** | **Scripts só do Windows** |
| `windows/focus.ps1` | Traz para frente a janela da sessão (VS Code, terminal, app do Claude) |
| `windows/terminal-focus.ps1` | Seleciona a aba do CLI no Windows Terminal (usado por `src/terminal-focus.js`) |
| `windows/install-terminal-focus.ps1` | Empacota e instala a integração do VS Code sem dependências de npm |
| `windows/tray/` | App de bandeja: inicia, reinicia e mostra o status e o log do servidor |
| `linux/ai-hud.service` | Serviço do systemd para rodar no Linux |
| `vscode-terminal/` | Integração local do VS Code para selecionar terminais pelo processo, inclusive abas com nomes iguais |
| `public/` | Página: `index.html`, `app.css`, `app.js`, PWA (`manifest.json`, `sw.js`) e ícones |
| `data/` | Gerado ao rodar, fora do git: `config.json` (token e PIN), filas, históricos e `server.log` |
| `scripts/` | Teste nativo opcional do Windows Terminal |
| `test/` | Testes de regressão (`node --test`) |

## Integração com o Claude Code

Em `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node D:/Projetos/ai-hud/claude/statusline.js" },
"hooks": {
  "Stop": [{ "hooks": [{ "type": "command", "command": "node D:/Projetos/ai-hud/claude/hook-stop.js claude", "timeout": 1900 }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node D:/Projetos/ai-hud/claude/hook-permission.js", "timeout": 660 }] }]
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
powershell -NoProfile -File windows/install-terminal-focus.ps1
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
