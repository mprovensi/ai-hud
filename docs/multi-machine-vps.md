# AI HUD em 3 máquinas: Notebook + PC Desktop + VPS Oracle

Esta arquitetura permite consolidar **3 fontes** (Notebook Windows, PC Desktop Windows e VPS Oracle Linux) em modo **Multi-Hub seguro (`?local=1`)**, com a VPS rodando **24/7** e o **iPad mini 1 (iOS 9.3.5)** acessando direto pela VPN IKEv2 nativa do iOS (sem precisar do app Tailscale no iPad).

## Topologia

```text
  Celular / Navegador externo ──(Tailscale Serve HTTPS)──┐
  iPad mini 1 (iOS 9.3.5)     ──(VPN IKEv2 10.10.10.1)──┼──► VPS Oracle (Hub 24/7 · Linux)
                                                         │      ├── Peer m0: Notebook  (Tailscale ?local=1)
                                                         │      └── Peer m1: Desktop   (Tailscale ?local=1)
                                                         │
  iPad mini 1 (fallback Wi-Fi local, sem VPN) ───────────┴──► Notebook ou Desktop (LAN :8787)
                                                                ├── Peer m0: Outro PC  (LAN/Tailscale ?local=1)
                                                                └── Peer m1: VPS Oracle (Tailscale ?local=1)
```

- **Sem loop de federação:** cada hub consulta os peers com `GET /api/snapshot?local=1&desde=...` (e repassa `POST /api/remote?local=1` / `/api/refresh?local=1`), recebendo **apenas os dados locais** de cada peer.
- **Resiliência offline (`data/peer-cache.json`):** quando o Notebook ou o Desktop hiberna, a VPS continua exibindo o acumulado de hoje, os gráficos de 24h/7d, o histórico recente e a última cota ainda válida (ocultando apenas sessões `working` da máquina offline).
- **Fuso horário alinhado:** `mergeSeries` casa os últimos 7 dias pela data local mesmo entre fusos distintos, e o `systemd` da VPS define `TZ=America/Sao_Paulo`.
- **Linux headless:** sessões rodando na VPS ocultam automaticamente o botão `Abrir no PC` (`canFocus: false`).

---

## 1. Preparar a VPS Oracle (Linux + Node 22.5+ + Tailscale)

1. Instale **Node 22.5+** (necessário para `node:sqlite`) e **Tailscale** na VPS:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Clone o repositório em `~/ai-hud` e rode uma primeira vez para gerar `data/config.json` (token + PIN):
   ```bash
   git clone <URL-DO-REPO> ~/ai-hud
   cd ~/ai-hud && node server.js   # Ctrl+C após gerar data/config.json
   ```
3. Instale o serviço 24/7 com `systemd`:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp platform/linux/ai-hud.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now ai-hud
   sudo loginctl enable-linger "$USER"
   ```
4. Exponha com HTTPS no Tailscale para o celular / navegador:
   ```bash
   sudo tailscale serve --bg 8787
   ```
   *(Nenhuma porta TCP pública precisa ser aberta na VCN da Oracle.)*

---

## 2. Configurar `data/config.json` nas 3 máquinas

Anote o IP Tailscale (`tailscale ip -4`) e o `"token"` de `data/config.json` de cada máquina.

### Na VPS Oracle (`~/ai-hud/data/config.json`)
```json
{
  "name": "VPS-Oracle",
  "ollama": false,
  "peers": [
    { "name": "Notebook", "url": "http://100.x.x.1:8787", "token": "<token-do-notebook>" },
    { "name": "Desktop",  "url": "http://100.x.x.2:8787", "token": "<token-do-desktop>" }
  ]
}
```
*(Mantenha `"token"` e `"pin"` gerados na própria VPS.)*

### No Notebook (`d:\Projetos\ai-hud\data\config.json`) — opcional para Multi-Hub local
```json
{
  "name": "Notebook",
  "peers": [
    { "name": "Desktop",    "url": "http://100.x.x.2:8787", "token": "<token-do-desktop>" },
    { "name": "VPS-Oracle", "url": "http://100.x.x.3:8787", "token": "<token-da-vps>" }
  ]
}
```

### No PC Desktop (`data/config.json`) — opcional para Multi-Hub local
```json
{
  "name": "Desktop",
  "peers": [
    { "name": "Notebook",   "url": "http://100.x.x.1:8787", "token": "<token-do-notebook>" },
    { "name": "VPS-Oracle", "url": "http://100.x.x.3:8787", "token": "<token-da-vps>" }
  ]
}
```

> **Dica:** Na VPS Oracle, se usar Claude Code lá também, configure os hooks em `~/.claude/settings.json` apontando para `http://127.0.0.1:8787/hook/...` (o mesmo PC).

---

## 3. Acesso do iPad mini 1 (iOS 9.3.5) direto na VPS via VPN IKEv2

Na VPS Oracle (Ubuntu/Debian), execute:

```bash
sudo bash platform/linux/ikev2-ipad-setup.sh --host <IP_PUBLICO_OU_DOMINIO_DA_VPS>
```

1. No painel da **Oracle Cloud** (*Networking → VCN → Security Lists → Ingress Rules*), libere somente:
   - **UDP 500** (`0.0.0.0/0`)
   - **UDP 4500** (`0.0.0.0/0`)
   *(Se a imagem Ubuntu da Oracle tiver regras restritivas no `iptables` local, libere UDP 500 e 4500 no `iptables`/`netfilter-persistent` também; mantenha TCP 8787 fechada para a internet.)*
2. Envie o arquivo `ai-hud-ipad.mobileconfig` gerado para o iPad mini 1 e instale em **Ajustes → Geral → Perfis**.
3. Ative a VPN **AI HUD (VPS Oracle)** em **Ajustes → VPN** (split-tunnel: só `10.10.10.1` passa pela VPN; a internet normal do iPad continua direta pela Wi-Fi).
4. Abra no Safari do iPad: **`http://10.10.10.1:8787`**, informe o PIN da VPS e toque em **Adicionar à Tela de Início**.
5. Depois de validar, ative **Conectar Sob Demanda** na VPN do iPad para reconectar automaticamente.

---

## 4. Troubleshooting (VPS Oracle, VPN IKEv2 no iPad e Cotas)

### iPad conecta na VPN, mas o Safari exibe *"não pode abrir a página porque o servidor parou de responder"*
- **Causa raiz comprovada:**
  1. O kernel Linux (`esp4.c`) envia pacotes **ESP-in-UDP (`UDP 4500`)** não-fragmentados com **checksum UDP `0x0000`** (permitido pela RFC 3948 em IPv4). Roteadores domésticos/CGNAT frequentemente descartam pacotes `UDP 4500` com `csum=0x0000` assim que o fluxo entra no hardware NAT/fastpath — travando todos os handshakes TCP (`SYN-ACK` de 60 bytes) em `SYN-RECV`.
  2. Além disso, a NIC `ens3` da Oracle Cloud tem `mtu 9000`; sem `mtu = 1360` no `kernel-netlink.conf` do strongSwan, pacotes grandes (~1492 bytes) sofrem blackhole em links PPPoE.
- **Correção definitiva aplicada na VPS (e em `platform/linux/ikev2-ipad-setup.sh`):**
  1. Serviço `ai-hud-vpn-csum.service` (`/usr/local/sbin/ai-hud-vpn-csum.sh`) aplica um filtro `tc` nativo no kernel (`flower ip_proto udp src_port 4500 ip_flags nofrag` → `pedit` offset 26 `0x0001` → `action csum udp`), recalculando um checksum UDP válido na saída da `ens3` em velocidade de kernel.
  2. `/etc/strongswan.d/charon/kernel-netlink.conf` define `mtu = 1360` nativamente na tabela 220 do strongSwan.
- **Se precisar diagnosticar/recuperar:**
  1. Confirme que o serviço de checksum está ativo e contando pacotes:
     ```bash
     systemctl is-active ai-hud-vpn-csum.service
     sudo tc -s filter show dev ens3 egress
     ```
  2. Se a sessão do iPad ficar presa após troca de rede, reinicie o strongSwan (`sudo systemctl restart strongswan-starter`) e ligue/desligue a VPN (ou Modo Avião) no iPad.
  3. *(Fallback na Wi-Fi de casa)*: com a VPN desligada, acesse diretamente o IP LAN do notebook/desktop federado (`http://<IP_LAN_DO_PC>:8787`).
- **Atenção — NÃO usar `iptables -t mangle ... -j TCPMSS` nem `mobike=no` na VPS:**
  - Não adicione regras `TCPMSS` nas chains `INPUT`/`OUTPUT` da tabela `mangle` para `10.10.10.0/24`; use `mtu = 1360` nativo em `/etc/strongswan.d/charon/kernel-netlink.conf`.
  - Não adicione `mobike=no` em `/etc/ipsec.conf` enquanto o perfil `.mobileconfig` instalado no iPad estiver com `DisableMOBIKE=0`.

### Timeouts nas cotas do Codex ou Gemini na VPS (1 vCPU / ~1 GB RAM)
- **Causa:** rodar `claude`, `codex app-server` e `agy --print /usage` em paralelo estoura CPU/swap em instâncias pequenas, gerando `tempo esgotado` / falha de comando.
- **Comportamento já corrigido no código:**
  - `src/collect/quotas/tracker.js` executa os coletores de cota **sequencialmente** com trava de concorrência (`refreshing`).
  - `src/collect/quotas/gemini.js` usa timeout estendido (`45s` / `--print-timeout 35s`) e erro transitório (`soft = true`) para preservar a última leitura válida.
  - `src/federation/merge.js` prioriza cota saudável vinda de peers (`MateusNote`/Desktop) sobre uma cota local com erro.

### Comandos rápidos de diagnóstico na VPS
```bash
# 1. Ver estado do túnel IKEv2 e contadores de tráfego (bytes_i e bytes_o devem crescer livremente)
sudo ipsec statusall

# 2. Ver requisições chegando do iPad no AI HUD
journalctl --user -u ai-hud --since "10 min ago" --no-pager | grep 10.10.10.2

# 3. Ver se há handshakes TCP travados em SYN-RECV
ss -tan | grep 10.10.10

# 4. Conferir regras do firewall (INPUT deve liberar UDP 500/4500 e TCP 8787 via ipsec; mangle sem TCPMSS)
sudo iptables -S INPUT | grep -E "8787|4500|500|10\.10\.10"
sudo iptables -t mangle -S
```
