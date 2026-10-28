"""Proxy de registro para o Ollama.

Escuta na porta pública do Ollama (11434), repassa tudo para o servidor real
(127.0.0.1:11435) e grava requisição + resposta das chamadas de inferência
num SQLite, independente do cliente (app, `ollama run`, CLIs, SDKs, curl...).

Uso:
    python proxy.py --spawn-ollama
    python proxy.py --listen 0.0.0.0:11434 --upstream 127.0.0.1:11435
"""
import argparse
import atexit
import datetime
import hashlib
import http.client
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BASE_DIR = Path(__file__).resolve().parent
DATA = BASE_DIR.parent / "data"  # mesma pasta de dados do AI HUD, fora do git

# Endpoints de inferência que são gravados (POST). O resto só é repassado.
LOGGED_PATHS = {
    "/api/chat",
    "/api/generate",
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/responses",
    "/v1/messages",
}

# Cabeçalhos que não devem ser repassados entre conexões.
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "trailers", "transfer-encoding", "upgrade",
    "content-length", "expect", "host", "accept-encoding",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    client_ip         TEXT,
    user_agent        TEXT,
    endpoint          TEXT,
    model             TEXT,
    session_id        TEXT,
    stream            INTEGER,
    status            INTEGER,
    duration_ms       INTEGER,
    client_aborted    INTEGER DEFAULT 0,
    message_count     INTEGER,
    last_user         TEXT,
    response_text     TEXT,
    thinking          TEXT,
    tool_calls        TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    request_json      TEXT,
    response_raw      TEXT
);
CREATE INDEX IF NOT EXISTS calls_session ON calls(session_id);
CREATE INDEX IF NOT EXISTS calls_ts ON calls(ts);
CREATE VIEW IF NOT EXISTS sessions AS
    SELECT session_id,
           MIN(ts)               AS started,
           MAX(ts)               AS last_call,
           COUNT(*)              AS calls,
           client_ip,
           GROUP_CONCAT(DISTINCT user_agent) AS clients,
           GROUP_CONCAT(DISTINCT model)      AS models,
           SUM(prompt_tokens)    AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           (SELECT last_user FROM calls c2 WHERE c2.session_id = c.session_id
             ORDER BY id LIMIT 1) AS first_question
      FROM calls c
     GROUP BY session_id;
"""


class Store:
    def __init__(self, path):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.db.commit()

    def insert(self, row):
        cols = ", ".join(row)
        marks = ", ".join("?" for _ in row)
        with self.lock:
            self.db.execute(f"INSERT INTO calls ({cols}) VALUES ({marks})", list(row.values()))
            self.db.commit()


# ---------------------------------------------------------------- parsing

def strip_images(obj):
    """Troca imagens em base64 por um marcador, para o banco não explodir."""
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "images" and isinstance(v, list):
                out[k] = [f"<imagem {len(i)} chars>" if isinstance(i, str) else i for i in v]
            else:
                out[k] = strip_images(v)
        return out
    if isinstance(obj, list):
        return [strip_images(v) for v in obj]
    if isinstance(obj, str) and obj.startswith("data:") and ";base64," in obj[:100]:
        return f"<{obj[:obj.index(';')]} {len(obj)} chars>"
    return obj


def as_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                value = p.get("text") or p.get("content") or ""
                parts.append(value if isinstance(value, str) else "")
            elif isinstance(p, str):
                parts.append(p)
        return "\n".join(x for x in parts if x)
    return json.dumps(content, ensure_ascii=False)


def summarize_request(req):
    """Retorna (modelo, stream, mensagens, primeira pergunta, última pergunta)."""
    model = req.get("model")
    stream = req.get("stream")
    messages = req.get("messages")
    if messages is None and isinstance(req.get("input"), list):  # /v1/responses
        messages = req["input"]
    if isinstance(messages, list):
        users = [m for m in messages if isinstance(m, dict) and m.get("role") == "user"]
        first = as_text(users[0].get("content")) if users else ""
        last = as_text(users[-1].get("content")) if users else ""
        return model, stream, len(messages), first, last
    prompt = req.get("prompt")
    if prompt is None and isinstance(req.get("input"), str):
        prompt = req["input"]
    prompt = as_text(prompt)
    return model, stream, None, prompt, prompt


def iter_events(raw):
    """Decodifica JSON único, NDJSON (API nativa) ou SSE (API OpenAI/Anthropic)."""
    text = raw.decode("utf-8", "replace").strip()
    if not text:
        return []
    try:
        return [json.loads(text)]
    except ValueError:
        pass
    events = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("event:") or line.startswith(":"):
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        if line == "[DONE]":
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    return events


def summarize_response(raw):
    content, thinking = [], []
    tools = {}          # índice -> {"name", "arguments"} (streaming OpenAI)
    full_tools = []     # tool calls completas (API nativa / sem streaming)
    usage = {"prompt": None, "completion": None}

    def add_usage(p, c):
        if p is not None:
            usage["prompt"] = p
        if c is not None:
            usage["completion"] = c

    for ev in iter_events(raw):
        if not isinstance(ev, dict):
            continue
        # API nativa: /api/chat e /api/generate
        msg = ev.get("message")
        if isinstance(msg, dict):
            content.append(msg.get("content") or "")
            thinking.append(msg.get("thinking") or "")
            full_tools.extend(msg.get("tool_calls") or [])
        if isinstance(ev.get("response"), str):
            content.append(ev["response"])
            thinking.append(ev.get("thinking") or "")
        add_usage(ev.get("prompt_eval_count"), ev.get("eval_count"))

        # API OpenAI: /v1/chat/completions e /v1/completions
        for ch in ev.get("choices") or []:
            part = ch.get("delta") or ch.get("message") or {}
            if isinstance(ch.get("text"), str):
                content.append(ch["text"])
            content.append(part.get("content") or "")
            thinking.append(part.get("reasoning") or part.get("reasoning_content") or "")
            for tc in part.get("tool_calls") or []:
                fn = tc.get("function") or {}
                slot = tools.setdefault(tc.get("index", len(tools)), {"name": "", "arguments": ""})
                slot["name"] += fn.get("name") or ""
                args = fn.get("arguments")
                slot["arguments"] += args if isinstance(args, str) else json.dumps(args or "")
        u = ev.get("usage")
        if isinstance(u, dict):
            add_usage(u.get("prompt_tokens", u.get("input_tokens")),
                      u.get("completion_tokens", u.get("output_tokens")))

        # API Anthropic (/v1/messages) e Responses (/v1/responses)
        etype = ev.get("type", "")
        delta = ev.get("delta")
        if etype == "content_block_delta" and isinstance(delta, dict):
            content.append(delta.get("text") or "")
            thinking.append(delta.get("thinking") or "")
        elif etype == "response.output_text.delta" and isinstance(delta, str):
            content.append(delta)
        elif etype in ("response.reasoning_text.delta", "response.reasoning_summary_text.delta") and isinstance(delta, str):
            thinking.append(delta)
        elif etype == "message_start" and isinstance(ev.get("message"), dict):
            u = ev["message"].get("usage") or {}
            add_usage(u.get("input_tokens"), None)
        elif etype == "response.completed" and isinstance(ev.get("response"), dict):
            u = ev["response"].get("usage") or {}
            add_usage(u.get("input_tokens"), u.get("output_tokens"))
        if ev.get("object") == "response" or (etype == "message" and "content" in ev):
            blocks = ev.get("output") or ev.get("content") or []
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "thinking":
                    thinking.append(b.get("thinking") or "")
                elif b.get("type") == "text":
                    content.append(b.get("text") or "")
                for c in b.get("content") or []:
                    if isinstance(c, dict) and c.get("type") in ("output_text", "text"):
                        content.append(c.get("text") or "")

    all_tools = full_tools + list(tools.values())
    return {
        "response_text": "".join(content),
        "thinking": "".join(thinking),
        "tool_calls": json.dumps(all_tools, ensure_ascii=False) if all_tools else None,
        "prompt_tokens": usage["prompt"],
        "completion_tokens": usage["completion"],
    }


# ---------------------------------------------------------------- proxy

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ollama-log-proxy"
    cfg = None    # preenchido em main()
    store = None

    def log_message(self, fmt, *args):
        pass

    def read_body(self):
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            parts = []
            while True:
                size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                        pass
                    return b"".join(parts)
                parts.append(self.rfile.read(size))
                self.rfile.readline()
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def handle_any(self):
        cfg = self.cfg
        started = time.time()
        client_ip = self.client_address[0]
        if cfg.allow and client_ip not in cfg.allow:
            self.send_error(403, "IP nao autorizado")
            return
        body = self.read_body()
        path = urlsplit(self.path).path

        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
        headers["Host"] = f"{cfg.up_host}:{cfg.up_port}"
        if body or self.command in ("POST", "PUT", "PATCH"):
            headers["Content-Length"] = str(len(body))

        conn = http.client.HTTPConnection(cfg.up_host, cfg.up_port)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except OSError as e:
            conn.close()
            self.send_error(502, f"Ollama indisponivel em {cfg.up_host}:{cfg.up_port}: {e}")
            return

        logged = self.command == "POST" and path in LOGGED_PATHS
        captured = bytearray()
        aborted = False
        try:
            self.send_response(resp.status, resp.reason)
            for k, v in resp.getheaders():
                if k.lower() not in HOP_HEADERS:
                    self.send_header(k, v)
            length = resp.getheader("Content-Length")
            has_body = self.command != "HEAD" and resp.status not in (204, 304)
            chunked = has_body and length is None
            if chunked:
                self.send_header("Transfer-Encoding", "chunked")
            elif length is not None:
                self.send_header("Content-Length", length)
            self.end_headers()

            while has_body:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                if logged and len(captured) < cfg.max_capture:
                    captured += chunk
                try:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk) if chunked else chunk)
                    self.wfile.flush()
                except OSError:
                    # Cliente desconectou: fecha o upstream para o Ollama parar de gerar.
                    aborted = True
                    self.close_connection = True
                    break
            if chunked and not aborted:
                self.wfile.write(b"0\r\n\r\n")
        except OSError:
            aborted = True
            self.close_connection = True
        finally:
            conn.close()

        if logged:
            try:
                self.record(path, body, bytes(captured), resp.status, started, aborted)
            except Exception as e:  # nunca derrubar o proxy por erro de log
                print(f"[erro ao gravar] {e!r}", file=sys.stderr)

    def record(self, path, body, raw, status, started, aborted):
        try:
            req = json.loads(body or b"{}")
        except ValueError:
            req = {}
        model, stream, n_msgs, first_q, last_q = summarize_request(req)
        key = f"{self.client_address[0]}|{model}|{first_q}"
        row = {
            "ts": datetime.datetime.now().isoformat(timespec="milliseconds"),
            "client_ip": self.client_address[0],
            "user_agent": self.headers.get("User-Agent"),
            "endpoint": path,
            "model": model,
            "session_id": hashlib.sha1(key.encode("utf-8", "replace")).hexdigest()[:16],
            "stream": None if stream is None else int(bool(stream)),
            "status": status,
            "duration_ms": int((time.time() - started) * 1000),
            "client_aborted": int(aborted),
            "message_count": n_msgs,
            "last_user": last_q,
            "request_json": json.dumps(strip_images(req), ensure_ascii=False),
            "response_raw": raw.decode("utf-8", "replace") if self.cfg.keep_raw else None,
        }
        row.update(summarize_response(raw))
        self.store.insert(row)


for _m in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"):
    setattr(Handler, f"do_{_m}", Handler.handle_any)


# ---------------------------------------------------------------- ollama serve

def find_ollama():
    exe = shutil.which("ollama")
    if exe:
        return exe
    default = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
    return str(default) if default.exists() else None


def supervise_ollama(exe, upstream, log_path):
    """Mantém um `ollama serve` rodando só no endereço interno."""
    env = dict(os.environ, OLLAMA_HOST=upstream)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    state = {"proc": None}

    def stop():
        p = state["proc"]
        if p and p.poll() is None:
            p.terminate()

    atexit.register(stop)

    def loop():
        while True:
            with open(log_path, "ab") as log:
                print(f"iniciando ollama serve em {upstream}", file=sys.stderr)
                state["proc"] = subprocess.Popen([exe, "serve"], env=env, stdout=log,
                                                 stderr=subprocess.STDOUT, creationflags=flags)
                state["proc"].wait()
            print("ollama serve saiu; reiniciando em 5s", file=sys.stderr)
            time.sleep(5)

    threading.Thread(target=loop, daemon=True).start()


# ---------------------------------------------------------------- main

def hostport(value, default_host):
    host, _, port = value.rpartition(":")
    return host or default_host, int(port)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--listen", default="0.0.0.0:11434", help="endereço público (padrão 0.0.0.0:11434)")
    ap.add_argument("--upstream", default="127.0.0.1:11435", help="Ollama real (padrão 127.0.0.1:11435)")
    ap.add_argument("--db", default=str(DATA / "ollama-conversas.sqlite"), help="arquivo SQLite")
    ap.add_argument("--spawn-ollama", action="store_true", help="inicia e supervisiona o `ollama serve` no upstream")
    ap.add_argument("--allow", default="", help="IPs permitidos, separados por vírgula (vazio = todos)")
    ap.add_argument("--max-capture-mb", type=int, default=20, help="limite de resposta gravada por chamada")
    ap.add_argument("--no-raw", action="store_true", help="não guardar a resposta bruta (só o texto montado)")
    args = ap.parse_args()

    if sys.stderr is None:  # rodando via pythonw (sem console)
        DATA.mkdir(exist_ok=True)
        sys.stderr = open(DATA / "ollama-proxy.log", "a", buffering=1, encoding="utf-8")

    listen_host, listen_port = hostport(args.listen, "0.0.0.0")
    up_host, up_port = hostport(args.upstream, "127.0.0.1")
    Handler.cfg = argparse.Namespace(
        up_host=up_host, up_port=up_port,
        allow={ip.strip() for ip in args.allow.split(",") if ip.strip()},
        max_capture=args.max_capture_mb * 1024 * 1024,
        keep_raw=not args.no_raw,
    )
    Handler.store = Store(args.db)

    if args.spawn_ollama:
        exe = find_ollama()
        if not exe:
            sys.exit("ollama.exe não encontrado")
        DATA.mkdir(exist_ok=True)
        supervise_ollama(exe, f"{up_host}:{up_port}", DATA / "ollama-server.log")

    server = ThreadingHTTPServer((listen_host, listen_port), Handler)
    server.daemon_threads = True
    print(f"proxy {listen_host}:{listen_port} -> {up_host}:{up_port}  gravando em {args.db}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
