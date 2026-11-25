# Review do AI HUD / AI Workspace

Data: 25/11/2026. Base: commit `29213f7`. [Spec da revisão](specs/review-do-ai-hud-ai-workspace.md).

Revisão documental, sem alterações de produção. Foram identificados **18 achados: 8 de gravidade alta e 10 média**. A prioridade é corrigir as fronteiras de acesso a arquivos, o tratamento do WebSocket e o isolamento entre relatórios executáveis e credenciais. Os testes existentes passaram, mas não cobrem os cenários abaixo.

## Contexto e método

O servidor Node monta coleta de sessões/cotas, ações locais, persistência, federação e API em `src/main.js`. Os clientes são o HUD ES5 em `web/`, o Workspace React/TypeScript em `workspace-app/` e o shell Tauri em `workspace-desktop/`. Há integrações com hooks dos CLIs, terminal/PTY, VS Code, MCP, proxy Ollama e voz.

Foram lidos os documentos de arquitetura/API, a composição do servidor, os controles de acesso, as rotas e ações relevantes, os componentes envolvidos nos fluxos e seus testes. A leitura do shell nativo, das fontes de coleta e das integrações foi amostral; não equivale a uma auditoria linha a linha de todo o repositório.

Fronteiras e invariantes usados na revisão:

1. IP permitido não substitui autenticação; autenticação não deve desabilitar a política de pastas autorizadas.
2. Parâmetros do cliente, documentos de projeto e HTML gerado por agentes não são contexto privilegiado.
3. Caminhos precisam continuar dentro da raiz autorizada após normalização e resolução de links, inclusive em criação de arquivos.
4. WebSocket precisa preservar autorização e isolamento de origem durante sua vida útil; entrada inválida não pode derrubar o servidor.
5. Um save confirmado deve corresponder ao conteúdo persistido; conflitos devem preservar edições e a recuperação prometida.
6. Todo processo iniciado precisa permanecer registrado e poder ser encerrado; toda sessão marcada como consolidada precisa ter sido enviada ao modelo.
7. Estado de interface, respostas assíncronas e avanço do board devem corresponder à sessão e à entrega vigentes.

**Classificação:** alta indica quebra de uma fronteira de segurança, execução/ação no contexto errado ou indisponibilidade de todo o serviço; média indica perda de edição/contexto, recuperação frágil ou inconsistência funcional relevante. Gravidade considera os pré-requisitos indicados; o produto é um controlador local/remoto de alta confiança, não um serviço multiusuário com isolamento entre contas.

**Tipos de evidência:** “reproduzido” significa execução isolada com funções, mocks ou recursos temporários; “análise estática” significa fluxo rastreado no código, sem afirmar homologação em navegador/dispositivo. As referências de linha correspondem ao commit acima. As recomendações e testes sugeridos não foram implementados.

## Visão de prioridades

| ID | Gravidade | Problema | Evidência |
| --- | --- | --- | --- |
| R01 | Alta | Allowlist aceita caminho com `..` | Função pura |
| R02 | Alta | Query `local=1` ignora autorização de pasta | Handler isolado |
| R03 | Alta | Rotas de memória não autorizam o `cwd` recebido | Análise estática |
| R04 | Alta | Criação de documento por junction escreve fora da raiz | Fixture temporária |
| R05 | Alta | Relatório HTML recebe token global na própria URL | Análise estática |
| R06 | Alta | Upgrade malformado encerra o servidor antes do login | HTTP real em subprocesso |
| R07 | Alta | WebSocket autenticado aceita origem de outra porta | Mock de socket/PTY |
| R08 | Alta | Resposta antiga pode direcionar ações à sessão errada | Análise estática |
| R09 | Média | Bloqueio biométrico não revoga WebSocket aberto | Mock de autorização/PTY |
| R10 | Média | Falha parcial no Play deixa processo sem gerenciamento | Mock de processos |
| R11 | Média | Dreaming descarta sessões além do lote de 12 | Função pura e fluxo de gravação |
| R12 | Média | Dreaming pode sobrescrever edição concorrente | Análise estática |
| R13 | Média | Save antigo limpa dirty/rascunho de edição mais nova | Análise estática |
| R14 | Média | Falha de persistência de pendências fica silenciosa | Fixture temporária |
| R15 | Média | Gravação prossegue mesmo se o backup falhar | Fixture temporária |
| R16 | Média | Sync trunca branch que contém ponto | Função pura |
| R17 | Média | MCP recomendado pelo EGM não grava `docRef` | Análise estática |
| R18 | Média | Fim de turno é tratado como conclusão de etapa | Análise estática |

## Achados de segurança e isolamento

### R01 — Allowlist aceita traversal no caminho de trabalho

**Alta · reproduzido.** Fontes: `src/core/path-guard.js:25–52,99–109`; consumidores em `src/api/routes/fs.js` e `src/api/routes/workspace.js`.

- **Cenário:** cliente autenticado envia um `cwd` que começa pela raiz autorizada, mas contém `..`. `normalizePath` ajusta separadores e barras finais; `isWithinRoot` compara prefixos sem eliminar esses segmentos.
- **Evidência:** `isCwdAllowed('C:\\safe\\..\\outside', {allowedRoots:['C:\\safe'], strict:true, platform:'win32'})` retornou `{ok:true}`. As barras estão escapadas para que o exemplo seja copiável como JavaScript.
- **Impacto:** caminhos fora da allowlist podem passar pelo guard usado antes de leitura, escrita ou execução. A prova confirma o bypass lexical; o efeito final depende do consumidor. Links também exigem validação física, tratada em R04.
- **Recomendação:** manter a regra pura de comparação em `core`, mas entregar a ela caminhos absolutos normalizados; a camada que acessa o disco deve verificar caminhos reais e limites de diretório. Consolidar a autorização utilizada pelos consumidores.
- **Teste sugerido:** rejeitar `..`, prefixos irmãos e escapes por links; cobrir separadores mistos, UNC, Windows e Linux, preservando caminhos válidos dentro da raiz.

### R02 — `?local=1` funciona como privilégio controlado pelo cliente

**Alta · reproduzido.** Fonte: `src/api/routes/workspace.js:26–45` e handlers de documentos/board que propagam a query.

- **Cenário:** cliente autenticado usa `local=1` com uma pasta desconhecida e `strictRemoteCwd` desabilitado, inclusive na configuração padrão. `checkAuthorizedCwd` retorna sucesso antes de consultar raízes e projetos conhecidos.
- **Evidência:** no mesmo handler de leitura de documento, com coletor sem sessões/pins e `config:{}`, `local=0` retornou 403 e `local=1` retornou 200. A verificação apenas leu um README; não alterou dados reais.
- **Impacto:** o cliente consegue contornar a autorização normalmente aplicada a documentos e boards portáteis. A convenção de encaminhamento de peers não comprova a procedência da chamada.
- **Recomendação:** aplicar autorização também em encaminhamentos; se houver diferença de privilégio necessária, derivá-la de identidade autenticada e contexto de servidor, nunca apenas da query.
- **Teste sugerido:** uma pasta proibida deve continuar proibida com `local=0`, `local=1` e chamada federada sem a autorização correspondente.

### R03 — Memória aceita pastas sem consultar a política de acesso

**Alta · análise estática.** Fontes: `src/api/routes/memory.js:10–62`, `src/collect/memory/index.js:7–15`, `src/actions/memory/index.js:157–213`.

- **Cenário:** cliente autenticado informa `cwd` arbitrário e `mode:'in-repo'`. As rotas de leitura, edição, Dreaming, undo e bridges repassam esses valores sem o guard de pastas usado em outras rotas.
- **Impacto:** `strictRemoteCwd:true` não impede essas operações fora da área autorizada. Além de `.ai-memory`, a instalação de bridges pode modificar `CLAUDE.md`, `AGENTS.md` e `GEMINI.md` na pasta escolhida, alterando o contexto de agentes.
- **Recomendação:** fazer todas as operações por projeto passarem pela mesma autorização de pasta, incluindo memória e bridges, antes de resolver ou modificar seus arquivos. A regra deve valer independentemente do cliente e do modo de armazenamento.
- **Teste sugerido:** com política estrita, leitura, save, dream, undo e bridges em pasta proibida devem responder 403 e não criar nem alterar arquivos; cobrir pasta permitida e raiz com link.

### R04 — Arquivo novo pode atravessar uma junction e sair do projeto

**Alta · reproduzido.** Fontes: `src/actions/workspace/project-storage.js:104–130`; escrita em `src/infra/workspace-paths.js:15–19`.

- **Cenário:** um projeto autorizado contém `docs/linked` como junction/symlink para outra pasta. Ao criar `docs/linked/new.md`, o arquivo final ainda não existe e a verificação de `realpath` não é executada.
- **Evidência:** duas pastas temporárias e uma junction foram usadas. `saveProjectDoc` retornou 200 e o arquivo apareceu na pasta externa ao projeto. A fixture foi removida após a validação.
- **Impacto:** um link já presente no projeto transforma a criação de documento em escrita fora da raiz. A gravação atômica segue os diretórios ancestrais; a validação lexical não os contém.
- **Recomendação:** verificar os ancestrais existentes e a raiz física antes de criar o destino, com regra compartilhada entre escritas portáteis e de documentos. Considerar substituição concorrente de links na definição da proteção suportada.
- **Teste sugerido:** criação e atualização através de links internos/externos, destino ausente, `.ai-workspace` ligado a outra pasta e caso permitido sem links.

### R05 — HTML executável recebe a credencial global no próprio endereço

**Alta · análise estática; sem prova em navegador.** Fontes: `workspace-app/src/api.ts:20–28,235`, `workspace-app/src/components/NotesAndReports.tsx:96–99`, `src/api/routes/workspace.js:22,128–138`.

- **Cenário:** o usuário entra com `?t=...` e abre um relatório HTML contendo script. `entityAssetUrl` usa `withToken`, e o iframe tem `sandbox="allow-scripts"`.
- **Impacto:** o script consegue ler a própria `location.search`, que contém o token do controlador. O sandbox sem `allow-same-origin` isola a origem, mas não esconde o endereço do próprio documento. A CSP permite scripts e não impede a navegação do próprio frame para um endereço externo levando esse valor.
- **Limite da conclusão:** `connect-src 'none'` bloqueia `fetch` e não deve ser descrito como bypassado. O risco identificado é entrega da credencial ao HTML e sua saída por navegação; o comportamento final precisa de teste em navegador. O uso posterior do token continua sujeito às restrições de rede do HUD.
- **Recomendação:** não fornecer token global a documento executável. Preferir leitura do asset com sessão inacessível ao script e isolamento de origem, ou autorização temporária restrita ao recurso quando necessária; remover scripts se não forem requisito.
- **Teste sugerido:** relatório hostil em ambiente temporário, confirmando que sua URL/conteúdo não expõe credencial reutilizável e que navegação não permite exportar acesso ao controlador.

### R06 — Upgrade inválido derruba o servidor sem autenticação

**Alta · reproduzido em transporte real.** Fonte: `src/api/ws-pty.js:91–96`, especialmente a linha 94.

- **Cenário:** uma conexão de IP permitido envia Upgrade com request-target `//%`. O parser HTTP aceita a entrada, mas `new URL(req.url, 'http://x')` lança antes da autenticação e fora de `try/catch`.
- **Evidência:** servidor HTTP real em subprocesso temporário, escutando apenas em loopback e sem dados operacionais ou PTY. A requisição sem token encerrou o subprocesso com código 1 e `ERR_INVALID_URL`, com stack na linha 94.
- **Impacto:** negação de serviço de HUD, Workspace e terminais por uma entrada não autenticada de origem de rede permitida.
- **Recomendação:** tratar parsing e erros de Upgrade na fronteira do socket; rejeitar a requisição e fechar somente a conexão afetada. Aplicar a mesma disciplina de contenção de exceções do handler HTTP normal.
- **Teste sugerido:** enviar request-target inválido em subprocesso e depois consultar uma rota válida, verificando que o processo permanece vivo e não inicia PTY.

### R07 — Falta validação de Origin no WebSocket autenticado por cookie

**Alta · handshake/entrada reproduzidos com mocks; cookies de navegador não homologados.** Fontes: `src/api/ws-pty.js:22–26,91–99`; cookie em `src/api/handler.js:141`.

- **Cenário:** uma página maliciosa servida em outra porta do mesmo host/site abre um WebSocket para o HUD já autenticado por cookie. Cookies não são separados por porta, e `SameSite=Lax` não isola origens de portas distintas do mesmo site.
- **Evidência:** socket e PTY inertes receberam handshake 101 e encaminhamento de entrada com `Origin` de outra porta, sem rejeição. Isso comprova a ausência do controle no servidor; não foi uma exploração em navegador real.
- **Impacto:** um servidor de desenvolvimento ou conteúdo local de outra origem pode usar a autenticação ambiente para acessar o terminal. Não implica exploração automática a partir de qualquer site externo.
- **Recomendação:** validar esquema, host e porta de origens de navegador contra os endereços autorizados do HUD. Definir tratamento explícito para clientes nativos e proxy de peers, mantendo autenticação própria.
- **Teste sugerido:** rejeitar outra porta/origem, aceitar origem legítima e cobrir ausência de Origin em clientes nativos autorizados; complementar com teste de navegador autenticado.

### R08 — Respostas atrasadas podem trocar a sessão alvo de uma ação

**Alta · análise estática.** Fontes: `workspace-app/src/components/LiveHudPane.tsx:287–296,385–432,575–580,664–666`.

- **Cenário:** uma consulta da sessão A fica pendente; o usuário seleciona B; a resposta de A termina depois. O polling e os refreshes após envio usam `then(setDetail)` sem verificar a seleção vigente. Limpar o intervalo não cancela a requisição já iniciada, e há também um refresh agendado de 750 ms.
- **Impacto:** `detail` pode voltar a A enquanto a seleção é B. Envio de mensagens, Parar e decisões de permissão usam dados de `detail`, podendo atingir a sessão anterior.
- **Recomendação:** invalidar respostas por geração/identidade da seleção, cancelar requisições quando possível e permitir ações somente quando `detail.id` corresponder à sessão vigente. Centralizar a atualização de detalhes para cobrir todos os caminhos assíncronos.
- **Teste sugerido:** controlar respostas A/B e resolver A por último; confirmar que visualização, resposta, parada e permissão continuam vinculadas a B.

## Achados de confiabilidade, dados e fluxo

### R09 — Bloqueio biométrico deixa terminal previamente aberto autorizado

**Média · reproduzido com mocks.** Fontes: `src/api/handler.js:40–42`, `src/api/webauthn.js:234–235`, `src/api/ws-pty.js:22–26,150–181`.

- **Cenário:** abrir um terminal autenticado por sessão biométrica e depois bloquear/revogar essa sessão. O canal valida autorização apenas no handshake.
- **Evidência:** após invalidar a sessão, o mock ainda recebeu entrada; houve uma única checagem de autorização e uma entrada entregue após revogação.
- **Impacto:** o bloqueio protege novas requisições HTTP, mas não interrompe o controle pelo socket existente. É diferente do acesso convencional por token de outros clientes, que o produto mantém por desenho.
- **Recomendação:** vincular sockets à sessão/dispositivo e fechar ou desautorizar os correspondentes na revogação e expiração, sem afetar outros dispositivos.
- **Teste sugerido:** revogar e expirar uma sessão com socket aberto; recusar entrada/resize/kill posteriores e preservar conexões de outras sessões válidas.

### R10 — Play parcialmente iniciado deixa processo órfão do gerenciador

**Média · reproduzido com processos simulados.** Fonte: `src/actions/project-runner.js:293–300,335–336,364–367`.

- **Cenário:** perfil composto com primeiro processo válido e segundo `cwd` inexistente. O laço inicia o primeiro antes de validar o segundo, mas só registra a execução em `runs` no final.
- **Evidência:** retorno 400, um processo iniciado e nenhum encerrado. `status` mostrou zero processos, e `stopAll()` não alcançou o processo lançado. Não foi necessário iniciar processo real na prova.
- **Impacto:** serviços podem continuar consumindo recursos/portas sem aparecer na interface nem serem encerrados pelo gerenciador.
- **Recomendação:** validar o perfil inteiro antes do lançamento, registrar a execução antes de iniciar filhos e desfazer lançamentos parciais diante de erro.
- **Teste sugerido:** falha no segundo/terceiro processo, subpasta inexistente e falha de spawn; nenhum filho deve ficar fora de `status` e de `stopAll`.

### R11 — Dreaming considera processadas sessões que não entraram no prompt

**Média · limite reproduzido por função pura; gravação rastreada.** Fontes: `src/core/memory.js:65–66`, `src/actions/memory/index.js:334–347`.

- **Cenário:** há mais de 12 sessões novas. O digest usa apenas as últimas 12, enquanto o estado e a contagem de sessões processadas usam todo o `delta`.
- **Evidência:** 13 sessões elegíveis produziram um digest de 12, sem a primeira. A gravação seguinte percorre todas as 13 e registra seus marcadores de processamento.
- **Impacto:** sessões omitidas deixam de ser elegíveis na próxima execução, mesmo sem terem sido consolidadas, até nova atividade ou execução forçada. Há perda silenciosa de contexto e métrica superestimada.
- **Recomendação:** criar um lote explícito e reutilizá-lo no prompt, estado e métricas; manter o restante pendente ou processá-lo em lotes seguintes.
- **Teste sugerido:** 13 e 25 sessões, verificando que todas entram em algum lote e nenhuma é marcada antes de ser enviada ao modelo.

### R12 — Resultado de Dreaming pode sobrescrever edição feita durante a execução

**Média · análise estática.** Fonte: `src/actions/memory/index.js:157–190,224,276,305–319`.

- **Cenário:** Dreaming lê a memória, espera o modelo e, nesse intervalo, o usuário salva uma alteração. A conclusão escreve arquivos e monta apêndices com o snapshot anterior, sem conferir os hashes novamente.
- **Impacto:** a edição aceita durante a espera desaparece da versão corrente. O backup antes da publicação ajuda na recuperação manual, mas não evita a sobrescrita. O controle `inFlight` entre execuções de Dreaming não coordena saves comuns.
- **Recomendação:** conferir versões no momento de publicar o resultado e coordenar edição, Dreaming e undo; em conflito, preservar ambos os conteúdos e pedir nova consolidação ou realizar apenas mesclagem comprovadamente segura.
- **Teste sugerido:** manter `runModel` pendente, salvar nova memória e depois resolver o modelo; a edição deve permanecer ou gerar conflito explícito, sem perda silenciosa.

### R13 — Confirmação de save antigo pode apagar o estado de edição mais nova

**Média · análise estática.** Fontes: `workspace-app/src/components/NotesAndReports.tsx:55–65,157–159`, `ProjectDocsPane.tsx:124–133,485–487`, `CardEditor.tsx:590–612,631–638`.

- **Cenário:** o usuário salva A e continua editando B enquanto a requisição está em andamento. O retorno de A executa `setDirty(false)` sem associá-lo à versão enviada. No board, também remove o rascunho do `sessionStorage`.
- **Impacto:** a interface pode indicar salvo mesmo com B somente em memória; o autosave pode deixar de enviá-lo e a recuperação do rascunho pode desaparecer.
- **Recomendação:** associar save à revisão/conteúdo enviado e limpar dirty/rascunho apenas se ainda corresponder à versão corrente. Preservar e reagendar alterações posteriores.
- **Teste sugerido:** atrasar o save, editar novamente e liberar a resposta; verificar dirty, rascunho recuperável e persistência subsequente de B.

### R14 — Pendência é aceita em memória mesmo quando não foi persistida

**Média · reproduzido.** Fontes: `src/infra/store.js:12–19`, `src/actions/pending.js:20–23,35–36`; consumidores semelhantes em config, metadados e WebAuthn.

- **Cenário:** erro de escrita/rename, por bloqueio, permissão ou falta de espaço. `writeJson` retorna `false`, mas o armazenamento de pendências ignora o resultado e mantém a alteração apenas em memória.
- **Evidência:** numa fixture, o caminho temporário foi ocupado por um diretório para provocar falha de escrita. A operação `set` retornou sem erro, a entrada existiu em memória, nenhum JSON foi criado e a releitura perdeu a entrada.
- **Impacto:** respostas e decisões aparentam estar registradas, mas não sobrevivem ao reinício; a garantia documentada de persistência deixa de ser observável pelo usuário. Outros consumidores também ignoram a falha e merecem a mesma revisão.
- **Recomendação:** propagar falha de persistência ao dono da operação e à API; distinguir alteração durável de estado pendente de retry. Evitar confirmação de sucesso quando a gravação necessária falha.
- **Teste sugerido:** falha controlada de escrita/rename em pendências e configuração; verificar erro explícito e estado coerente após reinício, sem depender de disco cheio real.

### R15 — Backup obrigatório pode falhar e a gravação continuar

**Média · reproduzido.** Fonte: `src/infra/workspace-paths.js:22–31`.

- **Cenário:** existe conteúdo anterior e um `backupDir` foi solicitado, mas a cópia de recuperação falha. O helper captura qualquer erro e segue para `writeAtomic`.
- **Evidência:** numa fixture, `backupDir` apontou para um arquivo comum. A criação do diretório falhou, mas o documento foi substituído por `after` sem backup e sem erro para o chamador.
- **Impacto:** edição de documentos/boards pode substituir conteúdo sem a recuperação prometida. Isto é independente de R14: aqui a nova escrita pode funcionar e o conteúdo anterior é que fica sem proteção.
- **Recomendação:** quando o contrato exige backup, abortar a substituição se ele não puder ser criado e reportar a causa. Definir retenção e identificação suficiente para evitar colisões de backups em gravações próximas.
- **Teste sugerido:** erro de cópia/diretório deve preservar o arquivo anterior; sucesso deve produzir backup íntegro antes da substituição.

### R16 — Branch com ponto é truncada durante a sincronização

**Média · reproduzido.** Fonte: `src/actions/workspace/sync.js:35–36,169–189`.

- **Cenário:** a branch contém ponto, como `release/1.2`. A regex que extrai seu nome para no primeiro `.`.
- **Evidência:** `parsePorcelain('## release/1.2...origin/release/1.2 [ahead 1]')` retornou `branch:'release/1'`.
- **Impacto:** verificação de referência, pull e push usam nome diferente da branch atual; a sincronização pode falhar ou operar uma referência existente diferente.
- **Recomendação:** obter o nome com comando Git próprio ou separar somente pelo delimitador de upstream `...`, preservando pontos válidos.
- **Teste sugerido:** `release/1.2`, `feature/foo.bar`, branch sem upstream, detached HEAD e nomes comuns, verificando os argumentos reais enviados ao Git com mock.

### R17 — Prompt EGM oferece atualização de `docRef` que o MCP não suporta

**Média · análise estática.** Fontes: `workspace-app/src/components/CardEditor.tsx:1117–1118`, `integrations/mcp/memory-server.js:231–265,349–369`.

- **Cenário:** o agente segue o prompt Ideia → Spec e usa `board_update_status` para vincular a spec. O schema da ferramenta não declara `docRef`; a atualização só aplica status, timestamp e nota no corpo.
- **Impacto:** a operação pode ser reportada como sucesso sem gravar o vínculo exigido pelo próprio fluxo. `board_add_item` aceitar esse campo não resolve a atualização de um item existente.
- **Recomendação:** alinhar o contrato e a aplicação da ferramenta para aceitar e validar `docRef`, ou remover essa alternativa do prompt até que seja suportada.
- **Teste sugerido:** atualizar um item existente com status e `docRef`, validar arquivo/retorno e preservação dos demais campos; rejeitar referência inválida. Nesta entrega, foi usada edição direta autorizada do board.

### R18 — Fim de turno não comprova entrega, mas avança o board

**Média · análise estática.** Fontes: `workspace-app/src/App.tsx:198–236`, `src/core/session.js:48–57`, prompts de fase em `workspace-app/src/components/CardEditor.tsx:1106–1164`.

- **Cenário:** após observar execução, o cliente recebe `waiting`/`idle`. Basta não haver resposta começando por `⚠` nem teste explicitamente falho para avançar a etapa. Erro ao consultar detalhes vira `null` e também permite continuar.
- **Impacto:** uma pergunta, bloqueio descrito em texto normal ou spec ausente pode ser tratado como conclusão. Dependendo da etapa, o fluxo marca `done` e sincroniza checklist sem comprovar os critérios de aceite.
- **Recomendação:** condicionar avanço a resultado explícito e evidência própria da etapa; consulta falha deve preservar o estado. Usar a semântica já existente de artefatos, testes e revisão em vez de inferir conclusão apenas do estado da sessão.
- **Teste sugerido:** respostas com pergunta/bloqueio, detalhe indisponível, spec ausente e teste falho não avançam; uma entrega válida avança uma vez e preserva alterações concorrentes.

## Melhorias adicionais e pontos positivos

Estas observações não entram na contagem de falhas confirmadas:

- **Limites de recursos:** `src/api/ws-pty.js:150–154` e `src/core/websocket.js:43–82` acumulam dados de frames sem um teto explícito da aplicação. Definir limites por mensagem/conexão e tratar frames parciais é melhoria de robustez; não foi executado teste de exaustão de memória.
- **Escala de coleta:** `src/collect/sources/common.js:6–37` usa varredura/leitura síncrona e cache por arquivo. O cache reduz parsing repetido, mas históricos grandes merecem medição de latência do event loop e memória antes de decidir por leitura incremental, expiração de cache ou outro desenho. Não houve benchmark que demonstre gargalo no ambiente atual.
- **Ciclo de vida:** `src/main.js:199–224` encerra PTYs/runner no fechamento do servidor, mas inicializa outros timers/schedulers sem um ponto único de parada. Consolidar start/stop pode facilitar reinício controlado e testes; não foi comprovado vazamento em execução real prolongada.
- **Cobertura:** a suíte protege bastante o HUD legado e regras do servidor. Os cenários de respostas fora de ordem e versões de draft no React precisam de testes comportamentais; a compilação TypeScript não comprova essas invariantes.
- **Bundle do Workspace:** o build desta etapa gerou um chunk JavaScript de 972,21 kB minificado (273,86 kB gzip), acima do aviso padrão de 500 kB do Vite. Avaliar carregamento sob demanda de áreas pesadas e medir o tempo de abertura antes de decidir a divisão do bundle; o aviso não impediu a compilação e não demonstra, sozinho, lentidão em uso real.
- **Arquitetura e documentação:** as camadas existentes, `path-guard`, escrita atômica e testes de arquitetura oferecem donos naturais para as correções. Preferir estender esses responsáveis e unificar a autorização de projeto a acrescentar verificações divergentes em cada endpoint. `docs/system-design.md` ainda descreve sobretudo o HUD original; atualizar o mapa com Workspace, PTY, memória, EGM e dependências de frontend ajudará futuras revisões.
- **Controles úteis já presentes:** comparação constante de token; limite e validação de JSON no HTTP; autenticação antes das rotas privadas; verificação de caminhos reais em parte dos leitores/assets; conflitos por `baseHash`; backups e escrita atômica em várias ações; Markdown React sem execução de HTML bruto; iframe sem `allow-same-origin`; bridge VS Code em loopback com token próprio; testes de Safari legado e federação. Preservar esses controles durante as correções.

## Sequência de correção recomendada

1. **Fronteiras de acesso:** R01–R04, com autorização única de projeto e testes dos caminhos diretos/federados. Incluir memória e criação de destinos novos.
2. **Canal remoto e documentos:** R05–R07 e R09, isolando credenciais e origens, contendo entradas inválidas e propagando revogação.
3. **Ações e durabilidade:** R08, R10, R13–R15, mantendo identidade da sessão, gerenciamento de processos e confirmação de gravação coerentes.
4. **Contexto e EGM:** R11–R12 e R16–R18, com lotes consistentes, conflitos visíveis, contrato MCP e avanço por evidência.

Cada grupo deve virar uma tarefa com escopo e testes próprios. As remediações não integram a entrega documental aprovada e não foram aplicadas nesta etapa.

## Verificações executadas

| Verificação | Resultado | Limite |
| --- | --- | --- |
| `npm test` | **202 passaram; 0 falhas, 0 ignorados** | Suíte existente, incluindo arquitetura, API, coleta, ações, integrações, federação e HUD. Não prova ausência dos achados. |
| `workspace-app/node_modules/.bin/tsc.cmd --project workspace-app/tsconfig.json --noEmit` | **Passou, sem diagnósticos** | Checagem de tipos; não executa React nem substitui build/homologação de navegador. |
| `vite build --outDir <saída isolada em test-output/>`, após TypeScript | **Passou; 1901 módulos transformados** | Build de produção do Workspace, preservando `workspace-app/dist`. Aviso de chunk JavaScript de 972,21 kB, sem erro de compilação. Não homologa Tauri ou navegador. |
| Play salvo e inicialização via `createProjectRunner` com `node server.js` | **Passou; `allReady:true`, nenhum erro de inicialização, processo encerrado** | Cópia temporária do código/build, porta efêmera, dados e usuário isolados; CLIs de IA indisponíveis e agendamentos desativados. HUD, Workspace e 2 assets com HTTP 200; snapshot 401 sem autenticação e 200 com autenticação. Aviso de SQLite experimental do Node. |
| `npm --prefix workspace-app audit --registry=https://registry.npmjs.org --package-lock-only --ignore-scripts --json` | **0 vulnerabilidades conhecidas reportadas** | Consulta pontual do lockfile npm; não cobre Rust, Python, binários externos ou falhas de lógica. Nenhuma dependência instalada/atualizada. |
| Provas isoladas descritas em R01, R02, R04, R06, R07, R09–R11, R14–R16 | Comportamentos observados conforme cada achado | Mocks não homologam navegador nem serviço de produção; R11 combina prova pura do limite com leitura da gravação. |

Ambiente: Windows/PowerShell, Node `v22.23.2`, npm `11.16.0`. A primeira tentativa de audit usou o registry HTTP configurado no ambiente e recebeu 426; foi repetida com HTTPS explícito, sem mudar configuração. Logs locais, ignorados pelo Git: `test-output/review-system-tests.log`, `test-output/review-system-audit.json` e `test-output/review-system-audit.stderr.log`. As provas temporárias não acrescentaram testes nem scripts permanentes ao projeto.

Na transição Spec → Em andamento, em 25/11/2026, a suíte e o TypeScript foram executados novamente e passaram; o build Vite foi acrescentado como validação. Logs: `test-output/review-goldfish-tests.log`, `test-output/review-goldfish-typescript.log`, `test-output/review-goldfish-build.log` e `test-output/review-goldfish-build.stderr.log`. Saída isolada: `test-output/review-workspace-build-20261125T114256996/`. A auditoria npm registrada acima foi preservada, pois não houve alteração de dependências.

Na entrega Em andamento → Revisão, a suíte passou novamente (202/202), o TypeScript passou e o build Vite foi gerado em `test-output/review-handoff-build-20261125T114741492/`. Evidências: `test-output/review-handoff-tests.log`, `test-output/review-handoff-typescript.log`, `test-output/review-handoff-build.log`, `test-output/review-handoff-build.stderr.log` e `test-output/review-handoff-play.json`. O perfil `.ai-workspace/run.json`, antes ausente, foi criado com um único processo `node server.js`, reconhecido pelo loader como configuração salva e validado pelo gerenciador de execução em cópia temporária. O build recém-gerado foi servido nessa cópia, e o processo foi encerrado após as verificações.

O Play abre `http://127.0.0.1:8787/workspace/` e usa o `workspace-app/dist` existente; não requer Vite dev. Após alterações no frontend, o pré-requisito é recompilar com `npm --prefix workspace-app run build`. Se `AI_HUD_PORT` mudar, ajustar `openUrl` para a mesma porta. A validação preservou o `dist` e os dados operacionais do projeto real.

## Parecer da revisão da entrega

Revisão executada em 25/11/2026: **entrega documental aprovada, sem bloqueios de aceite**. Foram conferidos os 18 achados, sua estrutura e pré-requisitos, referências aos arquivos, separação entre provas executadas e análise estática, schema do board/Play e evidências de testes, tipos, build e inicialização. Foi corrigido o limite de linha da referência de R03; o conteúdo e a gravidade do achado foram preservados.

Os resultados de 202 testes, TypeScript, build e Play foram conferidos nos registros existentes. Como o código de produção e as dependências permanecem iguais, esses processos não foram repetidos nesta revisão. As verificações documentais, schemas e exemplos puros de R01/R16 foram executados novamente. Registro objetivo: `test-output/review-acceptance.json`.

O parecer aprova o artefato solicitado, mantendo o card em `review`. Os 18 problemas do sistema continuam registrados para remediação em tarefas próprias; a aprovação documental não significa que foram corrigidos nem que o sistema foi certificado como seguro.

## Limites e próximos passos

Não foram iniciados o servidor com `data/` real, modelos/CLIs pagos, dispositivos móveis, Tauri, voz/GPU ou peers reais. O servidor efêmero usado na prova de Upgrade e os servidores de fixture da suíte ficaram isolados de dados operacionais. Não foram executados pentest externo, fuzzing amplo, teste de carga, build/auditoria Rust/Python ou validação visual/acessibilidade completa.

Os achados estáticos precisam de testes direcionados ao corrigir, especialmente HTML/CSP, cookies em navegador, concorrência React e publicação de Dreaming. O relatório registra riscos e evidências da versão analisada, sem certificar segurança integral. O portão Goldfish desta entrega documental foi revisado: os ajustes de fase/status e do exemplo Windows foram aplicados, sem bloqueios de escopo remanescentes. O card acompanha a transição autorizada para `review`; as correções dos 18 achados dependem de tarefas posteriores.
