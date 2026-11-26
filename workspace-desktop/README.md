# AI Workspace Desktop (Tauri 2 / WebView2)

Shell desktop nativo leve para Windows (WebView2 já presente no sistema, sem empacotar Chromium/Electron).

## O que entrega
- **Bandeja do sistema (System Tray):** recolhe ao fechar e reabre instantaneamente com clique no ícone.
- **Multi-janela:** janela principal (`AI Workspace` em `/workspace`) + 2ª janela independente (`AI HUD — Sessões` em `/`) pelo menu da bandeja.
- **Instância única + estado da janela:** reabrir o app foca a janela existente e restaura posição/tamanho.
- **VPS Principal + Fallback Local automático:** se um peer em `data/config.json` tiver `"primary": true` (ou `AI_HUD_URL` estiver definido), o app testa a VPS ao abrir e usa ela como fonte principal. Se a VPS estiver fora do ar, cai automaticamente para o servidor local (`127.0.0.1:8787`) e, quando a VPS voltar, dispara o peer-sync bidirecional (`/api/workspace/peer-sync`) e reconecta na VPS.
- **Auto-start do servidor local:** mantém `node server.js` rodando em segundo plano (necessário para federação local, fallback offline e sincronização automática VPS ↔ Local) e encerra ao sair pelo menu da bandeja.

## Como compilar no Windows

Pré-requisitos (apenas 1 vez):
1. **Rustup + Toolchain:**
   ```powershell
   winget install Rustlang.Rustup
   ```
2. **Visual Studio C++ Build Tools** (workload *Desenvolvimento para desktop com C++*):
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools
   ```
3. **Tauri CLI v2:**
   ```powershell
   cargo install tauri-cli --version "^2"
   ```

Build do frontend + instalador NSIS (`.exe`):
```powershell
npm --prefix workspace-app run build
cd workspace-desktop
cargo tauri build
```

O executável leve e o instalador NSIS saem em `workspace-desktop/target/release/bundle/nsis/`.

Para testar em modo desenvolvimento:
```powershell
cd workspace-desktop
cargo tauri dev
```
