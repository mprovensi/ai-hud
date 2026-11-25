# Review do AI HUD / AI Workspace

Data: 25/11/2026. Fase atual: entrega documental / Em andamento → Revisão.

## Objetivo

Revisar o sistema existente para identificar problemas de segurança, confiabilidade e manutenção, produzindo um relatório Markdown com evidências e prioridades. Esta entrega é documental; correções dependem de tarefas posteriores.

## Escopo

- Mapear HUD ES5, Workspace React, servidor Node, federação, persistência, shell Tauri e integrações relevantes.
- Rastrear autenticação, autorização de pastas, documentos executáveis, terminal, processos, gravação concorrente, memória/Dreaming e fluxo EGM.
- Consultar código, contratos e testes relevantes; reproduzir falhas somente com funções isoladas, mocks e recursos temporários.
- Registrar, para cada achado, gravidade, pré-requisitos, evidência com arquivo/linha, impacto, recomendação e verificação futura.
- Executar a suíte existente, a checagem TypeScript e o build do Workspace em saída isolada; registrar a auditoria do lockfile do frontend, sem instalar ou atualizar dependências.
- Criar o perfil Play em `.ai-workspace/run.json`, conforme solicitado nesta etapa, e validar a inicialização pelo gerenciador do projeto com dados temporários e integrações de IA indisponíveis.
- Entregar os achados em [docs/review-do-ai-hud-ai-workspace.md](../review-do-ai-hud-ai-workspace.md) e vincular esta spec ao card `item-mww13anw`.

## Fora de escopo

- Implementar correções, refatorar produção ou acrescentar funcionalidades/testes permanentes.
- Alterar credenciais, bancos ou projetos reais; configurações operacionais além do perfil Play explicitamente solicitado.
- Explorar máquinas da rede, executar agentes pagos ou publicar/deployar alterações.
- Certificar ausência de vulnerabilidades, auditar exaustivamente dependências ou homologar dispositivos e aplicativos nativos.
- Mover automaticamente o item para etapas posteriores à transição solicitada (`review`).

## Arquivos impactados

| Arquivo | Alteração autorizada |
| --- | --- |
| `docs/specs/review-do-ai-hud-ai-workspace.md` | Especificação desta revisão. |
| `docs/review-do-ai-hud-ai-workspace.md` | Relatório com achados, evidências, recomendações e limites. |
| `.ai-workspace/board.card.json` | Somente o item da tarefa: status `review`, `docRef` e `updatedAt`. |
| `.ai-workspace/run.json` | Perfil Play mínimo: um processo `node server.js` na raiz, servindo HUD e Workspace compilado. |

Logs de verificação ficam em `test-output/`, já ignorado pelo Git. Uma cópia de recuperação do board fica em `.ai-workspace/backups/`.

## Critérios de aceite objetivos

- [x] Relatório salvo em `docs`, em português, com arquitetura e fronteiras de confiança consideradas.
- [x] Todo achado possui fonte, cenário/pré-requisito, impacto, gravidade, recomendação e teste sugerido.
- [x] Evidências reproduzidas e conclusões por análise estática são identificadas separadamente.
- [x] Resultado dos testes, TypeScript, build isolado, auditoria de dependências e limitações registrado no relatório.
- [x] Nenhum código de produção alterado e nenhum dado operacional real modificado; perfil Play criado conforme autorização desta etapa.
- [x] Play salvo no schema `ai-run` v1 e reconhecido pelo loader como configuração salva.
- [x] Play validado em cópia temporária: prontidão do processo, HTTP 200 para HUD/Workspace/assets, API 401 sem autenticação e 200 com autenticação; processo encerrado após o teste.
- [x] Item `item-mww13anw` em `review` com `docRef: "docs/specs/review-do-ai-hud-ai-workspace.md"`, preservando os outros campos/itens.

## Portão Goldfish

Em 25/11/2026, a revisão independente solicitou apenas ajustes documentais: atualizar fase/status e declarações de execução à transição autorizada pelo usuário, além de tornar o exemplo Windows de R01 copiável como JavaScript. Esses ajustes foram aplicados. Resultado final: aprovado para a entrega documental, sem bloqueios de escopo.

O relatório existente já satisfaz o produto solicitado; esta etapa o reutiliza, registra a validação por testes/build e atualiza o acompanhamento. As remediações dos achados continuam destinadas a tarefas posteriores.

## Execução

Revisão concluída sobre o commit `29213f7`. Os aliases leves `haiku`/`flash`/`mini` não estavam disponíveis nesta sessão; subagentes no modelo padrão fizeram leitura/verificações isoladas e a revisão Goldfish. O relatório foi atualizado e validado com 202 testes, TypeScript e build Vite em `test-output/`, preservando o `dist` servido pela aplicação. A entrega continua documental; nenhum código de produção foi alterado.

Na entrega para Revisão, a suíte passou novamente (202/202), assim como TypeScript e build Vite. O Play criado usa o servidor existente, sem Vite dev. O teste de inicialização utilizou o mesmo comando em uma cópia temporária do código e do build recém-gerado, com porta efêmera, diretório de usuário/dados isolados, agendamentos desativados e CLIs de IA indisponíveis. Evidência em `test-output/review-handoff-play.json`: `allReady:true`, nenhum erro de inicialização e encerramento confirmado. Foram observados apenas os avisos já documentados de bundle grande e SQLite experimental.

Pré-requisito de uso do Play no projeto real: Node 22.5+ e `workspace-app/dist` compilado. Após mudanças de frontend, executar `npm --prefix workspace-app run build`. O perfil abre `http://127.0.0.1:8787/workspace/`; se usar `AI_HUD_PORT` diferente de 8787, ajustar também `openUrl` no perfil. A validação não iniciou outra instância sobre `data/` real.

## Revisão de aceite

Em 25/11/2026, a revisão da entrega conferiu os critérios acima, a estrutura dos 18 achados, referências, schemas e registros das validações. Uma referência de R03 que excedia a última linha de `src/api/routes/memory.js` foi corrigida no relatório. Parecer final: **aprovado para o escopo documental, sem bloqueios**. As verificações anteriores de testes/build/Play foram reaproveitadas por não haver mudança no código de produção; validações documentais e exemplos puros foram repetidos. Evidência em `test-output/review-acceptance.json`. O card permanece em `review`; a revisão não encerra automaticamente a tarefa nem implementa as remediações.
