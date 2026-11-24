#!/usr/bin/env python3
"""
Serviço auxiliar opcional de Voz Local (Whisper STT + TTS) para o AI HUD.
Pensado para rodar no PC Desktop com GPU (CUDA) ou Notebook (CPU).

Rotas:
  GET  /health      -> status dos motores STT (faster-whisper) e TTS (Windows SAPI / pyttsx3)
  POST /transcribe  -> { audioBase64, mimeType?, language? } -> { ok, text, language, engine }
  POST /speak       -> { text, voice? } -> audio/wav
"""

import base64
import json
import os
import platform
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("VOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOICE_PORT", "8790"))
WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "auto")  # auto | cuda | cpu
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE", "auto")

_whisper_model = None
_whisper_error = ""
_whisper_device_used = ""


def load_whisper():
    global _whisper_model, _whisper_error, _whisper_device_used
    if _whisper_model is not None or _whisper_error:
        return _whisper_model
    try:
        from faster_whisper import WhisperModel  # type: ignore

        device = WHISPER_DEVICE
        compute = WHISPER_COMPUTE
        if device == "auto":
            try:
                import ctranslate2  # type: ignore
                device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
            except Exception:
                device = "cpu"
        if compute == "auto":
            compute = "float16" if device == "cuda" else "int8"
        _whisper_model = WhisperModel(WHISPER_MODEL_NAME, device=device, compute_type=compute)
        _whisper_device_used = f"{device}/{compute}"
        print(f"[voice-server] faster-whisper carregado: {WHISPER_MODEL_NAME} ({_whisper_device_used})", flush=True)
    except Exception as exc:
        _whisper_error = str(exc)
        print(f"[voice-server] faster-whisper indisponível: {_whisper_error}", flush=True)
    return _whisper_model


def has_whisper():
    try:
        import importlib.util
        return importlib.util.find_spec("faster_whisper") is not None
    except Exception:
        return False


def has_tts():
    if platform.system() == "Windows":
        return True
    try:
        import importlib.util
        return importlib.util.find_spec("pyttsx3") is not None
    except Exception:
        return False


def synthesize_wav(text: str, voice_hint: str = "") -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = tmp.name
    try:
        if platform.system() == "Windows":
            ps = (
                "Add-Type -AssemblyName System.Speech; "
                "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                "$voices = $s.GetInstalledVoices() | Where-Object { $_.Enabled }; "
                "$hint = $env:AI_HUD_TTS_VOICE; $pick = $null; "
                "if ($hint) { $pick = $voices | Where-Object { $_.VoiceInfo.Name -like \"*$hint*\" } | Select-Object -First 1 }; "
                "if (-not $pick) { $pick = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'pt*' } | Select-Object -First 1 }; "
                "if ($pick) { $s.SelectVoice($pick.VoiceInfo.Name) }; "
                "$s.Rate = 1; $s.SetOutputToWaveFile($env:AI_HUD_TTS_OUT); "
                "$s.Speak($env:AI_HUD_TTS_TEXT); $s.Dispose()"
            )
            env = dict(os.environ, AI_HUD_TTS_TEXT=text[:1800], AI_HUD_TTS_OUT=out_path, AI_HUD_TTS_VOICE=voice_hint)
            subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], check=True, env=env, timeout=25)
        else:
            import pyttsx3  # type: ignore
            engine = pyttsx3.init()
            engine.save_to_file(text[:1800], out_path)
            engine.runAndWait()
        with open(out_path, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass


class VoiceHandler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self, max_bytes: int = 18 * 1024 * 1024):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > max_bytes:
            return None
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            return self._send_json(200, {
                "ok": True,
                "stt": has_whisper(),
                "tts": has_tts(),
                "whisperModel": WHISPER_MODEL_NAME,
                "device": _whisper_device_used or WHISPER_DEVICE,
                "sttEngine": f"faster-whisper:{WHISPER_MODEL_NAME}" if has_whisper() else "",
                "ttsEngine": "windows-sapi" if platform.system() == "Windows" else "pyttsx3",
            })
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        route = self.path.split("?")[0]
        try:
            body = self._read_json()
        except Exception as exc:
            return self._send_json(400, {"error": f"JSON inválido: {exc}"})
        if not isinstance(body, dict):
            return self._send_json(400, {"error": "Corpo JSON ausente ou grande demais."})

        if route == "/transcribe":
            model = load_whisper()
            if model is None:
                return self._send_json(503, {"error": f"faster-whisper indisponível: {_whisper_error}"})
            b64 = str(body.get("audioBase64") or "").strip()
            if not b64:
                return self._send_json(400, {"error": "audioBase64 ausente."})
            mime = str(body.get("mimeType") or "audio/webm").lower()
            ext = ".wav" if "wav" in mime else ".m4a" if "mp4" in mime or "m4a" in mime else ".ogg" if "ogg" in mime else ".webm"
            lang = str(body.get("language") or "pt").strip() or None
            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                tmp.write(base64.b64decode(b64))
                audio_path = tmp.name
            try:
                segments, info = model.transcribe(audio_path, language=lang, vad_filter=True)
                text = " ".join(s.text.strip() for s in segments if s.text).strip()
                return self._send_json(200, {
                    "ok": True,
                    "text": text,
                    "language": getattr(info, "language", lang or "pt"),
                    "engine": f"faster-whisper:{WHISPER_MODEL_NAME}({_whisper_device_used})",
                })
            except Exception as exc:
                return self._send_json(500, {"error": str(exc)})
            finally:
                try:
                    os.remove(audio_path)
                except OSError:
                    pass

        if route == "/speak":
            text = str(body.get("text") or "").strip()
            if not text:
                return self._send_json(400, {"error": "Texto vazio."})
            try:
                wav = synthesize_wav(text, str(body.get("voice") or ""))
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
            except Exception as exc:
                return self._send_json(500, {"error": str(exc)})
            return

        self._send_json(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        sys.stdout.write(f"[voice-server] {self.address_string()} - {fmt % args}\n")
        sys.stdout.flush()


if __name__ == "__main__":
    print(f"[voice-server] ouvindo em http://{HOST}:{PORT} (STT={has_whisper()}, TTS={has_tts()})", flush=True)
    ThreadingHTTPServer((HOST, PORT), VoiceHandler).serve_forever()
