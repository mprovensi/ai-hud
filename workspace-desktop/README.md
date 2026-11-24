# AI Workspace Desktop (Tauri 2 / WebView2)

Shell desktop nativo leve para Windows (WebView2 já presente no sistema, sem empacotar Chromium/Electron).

## O que entrega
- **Bandeja do sistema (System Tray):** recolhe ao fechar e reabre instantaneamente com clique no ícone.
- **Multi-janela:** janela principal (`AI Workspace` em `/workspace`) + 2ª janela independente (`AI HUD — Sessões` em `/`) pelo menu da bandeja.
- **Instância única + estado da janela:** reabrir o app foca a janela existente e restaura posição/tamanho.
- **Auto-start do servidor local:** se `127.0.0.1:8787` não estiver de pé, inicia `node server.js` em segundo plano e encerra ao sair pelo menu da bandeja.
- **Modo VPS direto (opcional):** defina `AI_HUD_URL=https://<seu-hub-tailscale>/?t=<token>` para abrir direto o Hub 24/7 da VPS Oracle sem subir o servidor local.

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
