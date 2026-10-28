"""Consulta as conversas gravadas pelo proxy.

    python sessoes.py                 lista as últimas sessões
    python sessoes.py <session_id>    mostra a conversa completa
    python sessoes.py --busca texto   procura em perguntas e respostas
"""
import sqlite3
import sys
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "ollama-conversas.sqlite"


def main():
    db = sqlite3.connect(DB)
    args = sys.argv[1:]
    if not args:
        rows = db.execute("SELECT session_id, last_call, calls, models, clients, first_question "
                          "FROM sessions ORDER BY last_call DESC LIMIT 30").fetchall()
        for sid, last, calls, models, clients, q in rows:
            q = (q or "").replace("\n", " ")[:70]
            print(f"{sid}  {last[:19]}  {calls:>3}x  {models}  [{(clients or '')[:25]}]  {q}")
    elif args[0] == "--busca":
        term = f"%{' '.join(args[1:])}%"
        for sid, ts, q in db.execute("SELECT session_id, ts, last_user FROM calls "
                                     "WHERE last_user LIKE ? OR response_text LIKE ? ORDER BY id",
                                     (term, term)):
            print(f"{sid}  {ts[:19]}  {(q or '').replace(chr(10), ' ')[:90]}")
    else:
        for ts, model, q, a, tools in db.execute("SELECT ts, model, last_user, response_text, tool_calls "
                                                 "FROM calls WHERE session_id = ? ORDER BY id", (args[0],)):
            print(f"\n--- {ts[:19]}  {model}\n> {q}\n\n{a}")
            if tools:
                print(f"[tool_calls] {tools}")


if __name__ == "__main__":
    main()
