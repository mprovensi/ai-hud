// Testes rodados dentro de uma sessão: reconhece o comando de teste e decide, pela saída, se passou.
// Regras puras: o coletor de cada IA entrega o comando, a saída e se a ferramenta acusou erro.

// Executores de teste comuns (o comando pode vir com cd, pipes e filtros em volta)
const TEST_COMMAND = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b`, String.raw`\bnode\s+--test\b`, String.raw`\bpytest\b`,
  String.raw`\bpython3?\s+-m\s+(pytest|unittest)\b`, String.raw`\b(jest|vitest|mocha|phpunit|rspec)\b`,
  String.raw`\b(go|cargo|dotnet)\s+test\b`, String.raw`\bmvnw?\b[^|&;]*\b(test|verify)\b`, String.raw`\bgradlew?\b[^|&;]*\btest\b`,
].join('|'), 'i');

// Sinais de falha nos resumos dos executores (node:test/TAP, jest, vitest, pytest, mocha, go, maven, cargo)
const FAILED = /^# fail [1-9]|^not ok \d|\b[1-9]\d* (failed|failing|failures?)\b|^FAIL\b|^--- FAIL|BUILD FAILURE|test result: FAILED|Tests? failed/im;
// Resumo explícito sem falhas: vale mais que o código de saída (o comando pode terminar num grep que não achou nada)
const PASSED = /^# fail 0\b|\b0 (failed|failing|failures?)\b|\b\d+ passed\b(?![^\n]*\bfailed\b)|^ok\s+\S+|test result: ok|BUILD SUCCESS/im;
// Linhas que explicam a falha, para mostrar na gaveta
const DETAIL = /not ok|fail|error|assert|expected|✗|×|✕/i;

const isTestCommand = (command) => typeof command === 'string' && TEST_COMMAND.test(command);

// { ok, summary } do teste a partir da saída; summary = até 6 linhas que mostram o que falhou
function testOutcome(output, isError) {
  const text = String(output || '');
  const ok = FAILED.test(text) ? false : PASSED.test(text) ? true : !isError;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const picked = ok ? lines.slice(-3) : lines.filter((l) => DETAIL.test(l)).slice(0, 6);
  return { ok, summary: (picked.length ? picked : lines.slice(-6)).map((l) => (l.length > 200 ? l.slice(0, 199) + '…' : l)).join('\n') };
}

module.exports = { isTestCommand, testOutcome };
