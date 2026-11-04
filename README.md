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

Para iniciar junto com o Windows, copie `platform/windows/tray/start-tray.vbs` (ícone na bandeja, sem janela)
para a pasta Inicializar (`Win+R` → `shell:startup`).

## Atualizações, conexão e leitura

O iPad mini 1 (iOS 9.3.5 / Safari 9) continua sendo a referência mínima. A interface usa ES5,
flexbox com prefixos e consultas HTTP com long-polling (o servidor responde quando algo muda). Não depende de service worker, Push ou APIs modernas.

O servidor gera uma versão por conteúdo e entrega HTML, JavaScript, CSS e cache do PWA com a mesma
identificação. Não é necessário alterar `?v=N` manualmente. **Reinicie o servidor depois de alterar
os arquivos em `web/`**: cada execução mantém uma cópia consistente da interface em memória.
Se um app aberto detectar outra versão no servidor, mostra **Atualizar app**; a atualização é manual
e pede confirmação quando há uma resposta em edição. No iPad, os URLs versionados funcionam mesmo
sem service worker. Nos aparelhos com PWA, a casca da interface pode abrir offline, mas dados,
respostas e permissões continuam exigindo conexão.

O indicador **ao vivo** só aparece após uma consulta válida. Falhas de rede e do servidor ficam
visíveis até a recuperação, acompanhadas do horário dos últimos dados. Uma sessão inválida mostra
**Entrar novamente**, sem ficar repetindo consultas. Isso não altera a regra de alertar desconexão
em tela inteira apenas depois de duas falhas de rede consecutivas.

Use **Aa → Normal / Grande / Maior** para ajustar a leitura. A escolha fica salva neste aparelho.
Os botões têm área mínima de toque de 44 px, o zoom está liberado e os painéis de cotas também
podem ser abertos pelo teclado. Os tamanhos maiores deixam os cards crescerem para acomodar o texto.

Na bandeja, **Status e log → Diagnóstico e ocorrências** separa o processo do servidor, a resposta
HTTP local, a conexão Tailscale e o teste real do HTTPS com certificado confiável. As verificações
de rede rodam em segundo plano. **Copiar diagnóstico** gera um relatório sem PIN nem token.
As últimas 20 ocorrências ficam em `data/tray-events.json`, com credenciais ocultas, e sobrevivem
ao reinício da bandeja. O log bruto do servidor continua em uma aba separada.

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
Nos hooks do Claude Code, use os caminhos do Linux, ex.: `node ~/ai-hud/integrations/claude/hook-stop.js claude`.

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

O cartão do Ollama permanece visível, inclusive quando o PC está desconectado. PCs já identificados
continuam na lista após reiniciar o HUD ou receber temporariamente uma resposta sem dados de Ollama.
Use `"ollama": true` no objeto de um peer para fixá-lo desde a primeira abertura, mesmo sem histórico;
`"ollama": false` nesse objeto o omite explicitamente. Versão e quantidade de modelos ficam como
últimos dados conhecidos; modelos carregados e GPU não são apresentados como atuais sem conexão.
Se o Ollama fica só em outro PC, `"ollama": false` na raiz de `data/config.json` omite o Ollama local.

## Conversas do Ollama de qualquer cliente (ollama-proxy)

O Ollama não grava as conversas feitas pela API; só o app dele guarda as próprias. O `integrations/ollama-proxy/`
fica na porta pública do Ollama (11434), repassa tudo ao servidor real numa porta interna (11435) e
grava pergunta, resposta, raciocínio, tokens, IP e cliente de cada chamada em
`data/ollama-conversas.sqlite`. Vale para qualquer cliente: `ollama run`, CLIs (Hermes, Aider…),
SDKs, curl e outros PCs da rede, nas APIs nativa (`/api/chat`, `/api/generate`), OpenAI
(`/v1/chat/completions`, `/v1/completions`, `/v1/responses`) e Anthropic (`/v1/messages`).
Só Node 22.5+ (o mesmo do HUD), sem dependências.

No HUD, cada conversa vira uma sessão do Ollama com modelo, IP e cliente. Conversas do app não
duplicam, e chamadas de um `ollama run` aberto aparecem no cartão do terminal.

```
powershell -ExecutionPolicy Bypass -File integrations\ollama-proxy\instalar.ps1           # instala e inicia
powershell -ExecutionPolicy Bypass -File integrations\ollama-proxy\instalar.ps1 -Remover  # volta ao normal
node integrations\ollama-proxy\sessoes.js [session_id | --busca texto]       # consulta no terminal
```

O instalador cria a tarefa agendada **Ollama Log Proxy**, que inicia no login, sobe o `ollama serve`
em `127.0.0.1:11435` e o reinicia se cair. Ele também tira o app do Ollama da inicialização, porque o
app sobe o próprio servidor na 11434. Como o servidor não é mais iniciado pelo app, as configurações
do app (tamanho de contexto, expor na rede) não se aplicam: use variáveis como
`OLLAMA_CONTEXT_LENGTH`. Para outros PCs acessarem, libere a porta 11434 no firewall para o
`node.exe`. `node integrations\ollama-proxy\proxy.js --help` lista as opções (`--allow` restringe por IP).
Quem instalou a versão anterior, em Python, precisa rodar o `instalar.ps1` de novo: a tarefa passa a usar o Node.

## Arquivos

O desenho do sistema (camadas, fluxos e compatibilidade) está em [docs/system-design.md](docs/system-design.md)
e o contrato da API em [docs/api.md](docs/api.md).

| Pasta | Função |
| --- | --- |
| `server.js` | Inicia o servidor (porta, PIN e endereços no log); a montagem fica em `src/main.js` |
| **`src/`** | **Servidor do HUD, por camada** |
| `src/core/` | Regras puras: estado da sessão e formato `Session` (`session.js`), tokens por hora/dia (`usage.js`), ritmo e gráfico das cotas (`quota-pace.js`), métricas do Ollama |
| `src/collect/` | O que está acontecendo: `collector.js` (laço único, snapshot em cache e versão para o long-polling), `sources/` (uma fonte por ferramenta: `claude.js`, `codex/`, `antigravity.js`, `ollama/`), `quotas/` (cotas ao vivo e histórico), `ollama-status.js` (Ollama local e GPU) |
| `src/views/` | O contrato com os aparelhos e os outros PCs: `snapshot.js` e `session-detail.js` |
| `src/actions/` | O que muda algo no PC: `reply/` (Claude, `codex queue`, Ollama), `permissions.js` (modo remoto), `focus/` (Abrir no PC: `plan.js` decide, `index.js` executa), `pending.js` (pendências em `data/pending.json`) |
| `src/federation/` | Outros PCs: `peers.js` (segue cada um por long-polling e repassa ações), `merge.js`, `client.js` |
| `src/api/` | HTTP: `handler.js` (rede permitida → arquivos públicos → PIN → token → rotas), `routes/` (um arquivo por recurso), `auth.js`, `static.js` |
| `src/infra/` | `config.js` (`data/config.json`), `store.js` (JSON seguro), `paths.js`, `web-bundle.js` (junta `web/js` e `web/css` e gera a versão) |
| **`web/`** | **App dos aparelhos (ES5, Safari 9)**: `index.html`, PWA (`manifest.json`, `sw.js`), `icons/` (+ `icon.html`, fonte dos ícones), `js/` (`core/`, `home/`, `drawers/`, `app/`) e `css/` (`home/`, `drawers/`, `screens/`) |
| **`integrations/`** | **Código que roda dentro de outras ferramentas** |
| `integrations/claude/` | `hook-stop.js` (entrega respostas do HUD), `hook-permission.js` (Permitir/Negar no modo remoto), `statusline.js` |
| `integrations/vscode-terminal/` | Extensão local do VS Code que seleciona o terminal pelo processo, inclusive abas com nomes iguais |
| `integrations/ollama-proxy/` | Proxy que grava as conversas de qualquer cliente do Ollama (`proxy.js`), consulta (`sessoes.js`) e instalador |
| **`platform/`** | **Específico do sistema operacional** |
| `platform/windows/` | `focus.ps1` e `terminal-focus.ps1` (Abrir no PC), `install-terminal-focus.ps1`, `tray/` (app de bandeja), `atualizar-caminhos.ps1`, `terminal-smoke.js` (teste nativo opcional) |
| `platform/linux/ai-hud.service` | Serviço do systemd |
| `claude/`, `windows/tray/`, `ollama-proxy/` | Pontes de uma linha para os caminhos antigos, gravados em configurações fora do repositório (veja abaixo) |
| `docs/` | Desenho do sistema e contrato da API |
| `data/` | Gerado ao rodar, fora do git: `config.json` (token e PIN), pendências, históricos e `server.log` |
| `test/` | Testes (`npm test`), nas mesmas pastas de `src/`; `architecture.test.js` garante o sentido das dependências |

### Caminhos antigos

Hooks do Claude/Codex, o atalho da bandeja e a tarefa do ollama-proxy guardam caminhos de antes da
reorganização. As pontes mantêm tudo funcionando. Para passar a usar os caminhos novos em um PC:

```powershell
powershell -ExecutionPolicy Bypass -File platform\windows\atualizar-caminhos.ps1           # mostra o que muda
powershell -ExecutionPolicy Bypass -File platform\windows\atualizar-caminhos.ps1 -Aplicar  # aplica (com .bak)
```

Depois de rodar em todos os PCs, as pontes podem ser apagadas.

## Integração com o Claude Code

Em `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node D:/Projetos/ai-hud/integrations/claude/statusline.js" },
"hooks": {
  "Stop": [{ "hooks": [{ "type": "command", "command": "node D:/Projetos/ai-hud/integrations/claude/hook-stop.js claude", "timeout": 1900 }] }],
  "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node D:/Projetos/ai-hud/integrations/claude/hook-permission.js", "timeout": 660 }] }]
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
powershell -NoProfile -File platform/windows/install-terminal-focus.ps1
```

A integração identifica o processo de cada terminal; abas com nomes iguais continuam distintas.
Ela só aceita pedidos locais autenticados e não escreve comandos no terminal. Se o VS Code pedir
para recarregar após a instalação, recarregue a janela para ativar a integração.

No **Windows Terminal**, não há extensão para instalar. O HUD procura uma aba com título único
compatível com a sessão, projeto ou modelo. Se duas abas forem indistinguíveis, dê nomes diferentes
a elas: o HUD informa a ambiguidade em vez de selecionar uma ao acaso. Uma sessão já encerrada
precisa estar aberta no CLI para que a aba possa ser selecionada.

## Testes

Execute `npm test` para rodar os testes, sem dependências externas.
Eles usam dados simulados e um servidor HTTP temporário; não acionam os CLIs nem alteram as conversas locais.
O teste nativo opcional `node platform/windows/terminal-smoke.js` abre abas próprias no Windows Terminal,
verifica a troca e a recusa de títulos duplicados, e encerra apenas seus processos de teste ao terminar.
