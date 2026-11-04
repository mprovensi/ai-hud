// Ponte: a tarefa agendada "Ollama Log Proxy" de instalações anteriores aponta para este caminho.
// O código fica em integrations/ollama-proxy/.
if (require.main === module) require('../integrations/ollama-proxy/proxy.js').main();
