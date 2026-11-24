# Serviço Auxiliar de Voz Local (Whisper GPU + TTS)

Permite **ditado (STT)** e **leitura em voz alta (TTS)** sem custo de API — inclusive no **iPad mini 1 (HTTP / Safari 9)**, onde `SpeechRecognition` do navegador não existe.

> **Dica:** para **TTS (ler respostas em voz alta)** no Windows, o próprio `ai-hud` já usa a voz nativa **Microsoft Maria (PT-BR)** via SAPI sem precisar instalar nada! Este servidor Python só é necessário quando você quiser **STT (Whisper local na GPU do PC Desktop)**.

## Instalação no PC Desktop (GPU NVIDIA / CPU)

```powershell
pip install faster-whisper
```

## Como rodar

```powershell
# Na rede Tailscale (escutando no IP Tailscale do Desktop ou 127.0.0.1 local)
$env:VOICE_HOST = "0.0.0.0"
$env:VOICE_PORT = "8790"
$env:WHISPER_MODEL = "small"   # tiny | base | small | medium | large-v3-turbo
python integrations/voice-server/server.py
```

Depois, adicione no `data/config.json` do `ai-hud` (no Desktop ou na VPS):
```json
{
  "voiceUrl": "http://127.0.0.1:8790"
}
```
(Na VPS, use o IP Tailscale do PC Desktop, ex.: `"http://100.x.y.z:8790"` — ou deixe vazio na VPS que o Hub encaminha automaticamente para o peer Windows conectado!)
