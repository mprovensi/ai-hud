// Consulta as conversas gravadas pelo proxy.
//
//   node sessoes.js                 lista as últimas sessões
//   node sessoes.js <session_id>    mostra a conversa completa
//   node sessoes.js --busca texto   procura em perguntas e respostas
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB = path.join(__dirname, '..', 'data', 'ollama-conversas.sqlite');
const oneLine = (t, n) => String(t || '').replace(/\n/g, ' ').slice(0, n);

function main(args) {
  const db = new DatabaseSync(DB, { readOnly: true });
  if (!args.length) {
    const rows = db.prepare('SELECT session_id, last_call, calls, models, clients, first_question FROM sessions ORDER BY last_call DESC LIMIT 30').all();
    for (const r of rows) {
      console.log(`${r.session_id}  ${r.last_call.slice(0, 19)}  ${String(r.calls).padStart(3)}x  ${r.models}  [${String(r.clients || '').slice(0, 25)}]  ${oneLine(r.first_question, 70)}`);
    }
  } else if (args[0] === '--busca') {
    const term = `%${args.slice(1).join(' ')}%`;
    for (const r of db.prepare('SELECT session_id, ts, last_user FROM calls WHERE last_user LIKE ? OR response_text LIKE ? ORDER BY id').all(term, term)) {
      console.log(`${r.session_id}  ${r.ts.slice(0, 19)}  ${oneLine(r.last_user, 90)}`);
    }
  } else {
    for (const r of db.prepare('SELECT ts, model, last_user, response_text, tool_calls FROM calls WHERE session_id = ? ORDER BY id').all(args[0])) {
      console.log(`\n--- ${r.ts.slice(0, 19)}  ${r.model}\n> ${r.last_user}\n\n${r.response_text}`);
      if (r.tool_calls) console.log(`[tool_calls] ${r.tool_calls}`);
    }
  }
  db.close();
}

main(process.argv.slice(2));
