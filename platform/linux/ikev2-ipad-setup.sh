#!/usr/bin/env bash
# Configura VPN IKEv2 (strongSwan) na VPS Oracle (Ubuntu/Debian) compatível com iPad mini 1 (iOS 9.3.5).
# - Usa IKEv2 + PSK (SharedSecret) de 32 caracteres + AES-256 / SHA-256 / MODP-2048: 100% nativo no iOS 9.3.5
#   sem exigir instalação de certificado CA nem pedir segredo/senha manualmente.
# - Split-tunnel: o iPad envia pela VPN SOMENTE o tráfego para 10.10.10.1 (AI HUD na VPS); a internet normal
#   do iPad continua direta pela Wi-Fi, sem NAT nem ip_forward na VPS.
# - Gera o arquivo ai-hud-ipad.mobileconfig pronto para instalar em 1 toque no iPad.
#
# Uso (na VPS Oracle, como root):
#   sudo bash platform/linux/ikev2-ipad-setup.sh --host <IP_PUBLICO_OU_DOMINIO_DA_VPS>
#
# Libere na Security List da Oracle Cloud (Ingress):
#   UDP 500  e  UDP 4500  (NÃO abra a porta TCP 8787 para a internet!)

set -euo pipefail

HOST=""
CLIENT_ID="ipad"
PSK=""
VPN_IP="10.10.10.1"
VPN_POOL="10.10.10.2-10.10.10.254"
OUT_FILE="./ai-hud-ipad.mobileconfig"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user|--client-id) CLIENT_ID="$2"; shift 2 ;;
    --psk|--pass) PSK="$2"; shift 2 ;;
    --vpn-ip) VPN_IP="$2"; shift 2 ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Uso: sudo bash $0 --host <IP_OU_DOMINIO_VPS> [--client-id ipad] [--psk <chave>] [--out ./ai-hud-ipad.mobileconfig]"
      exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Execute como root (sudo bash $0 --host ...)." >&2
  exit 1
fi

if [[ -z "$HOST" ]]; then
  echo "Informe --host <IP_PUBLICO_OU_DOMINIO_DA_VPS>." >&2
  exit 1
fi

if [[ -z "$PSK" ]]; then
  PSK="$(dd if=/dev/urandom bs=64 count=1 2>/dev/null | base64 | tr -dc 'A-Za-z0-9' | cut -c1-32)"
fi

echo "==> Instalando strongSwan (Ubuntu/Debian)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq strongswan libcharon-extra-plugins uuid-runtime

echo "==> Configurando IP interno fixo da VPN (${VPN_IP}/32) na loopback..."
cat >/etc/systemd/system/ai-hud-vpn-ip.service <<EOF
[Unit]
Description=IP interno da VPN IKEv2 do AI HUD (${VPN_IP}/32)
Before=strongswan-starter.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/ip addr replace ${VPN_IP}/32 dev lo

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ai-hud-vpn-ip.service

echo "==> Escrevendo /etc/ipsec.conf (IKEv2 PSK + AES-256 / SHA-256 / MODP-2048 para iOS 9.3.5)..."
cat >/etc/ipsec.conf <<EOF
config setup
  charondebug="ike 1, knl 1, cfg 0"
  uniqueids=replace

conn ai-hud-ipad
  auto=add
  compress=no
  type=tunnel
  keyexchange=ikev2
  fragmentation=yes
  forceencaps=yes
  mobike=no
  dpdaction=clear
  dpddelay=60s
  rekey=no
  ike=aes256-sha256-modp2048,aes256-sha1-modp2048!
  esp=aes256-sha256,aes256-sha1!
  left=%any
  leftid=${HOST}
  leftauth=psk
  leftsubnet=${VPN_IP}/32
  right=%any
  rightid=${CLIENT_ID}
  rightauth=psk
  rightsourceip=${VPN_POOL}
EOF

cat >/etc/ipsec.secrets <<EOF
${HOST} ${CLIENT_ID} : PSK "${PSK}"
: PSK "${PSK}"
EOF
chmod 600 /etc/ipsec.secrets

echo "==> Reiniciando strongSwan..."
systemctl enable --now strongswan-starter 2>/dev/null || systemctl enable --now strongswan 2>/dev/null || true
ipsec restart

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  echo "==> Liberando UDP 500 e 4500 no UFW..."
  ufw allow 500/udp >/dev/null
  ufw allow 4500/udp >/dev/null
fi

echo "==> Gerando perfil Apple (.mobileconfig) em ${OUT_FILE}..."
UUID_TOP="$(uuidgen)"
UUID_VPN="$(uuidgen)"

cat >"${OUT_FILE}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>IKEv2</key>
      <dict>
        <key>AuthenticationMethod</key>
        <string>SharedSecret</string>
        <key>SharedSecret</key>
        <string>${PSK}</string>
        <key>ExtendedAuthEnabled</key>
        <integer>0</integer>
        <key>AuthName</key>
        <string></string>
        <key>AuthPassword</key>
        <string></string>
        <key>ChildSecurityAssociationParameters</key>
        <dict>
          <key>DiffieHellmanGroup</key>
          <integer>14</integer>
          <key>EncryptionAlgorithm</key>
          <string>AES-256</string>
          <key>IntegrityAlgorithm</key>
          <string>SHA2-256</string>
          <key>LifeTimeInMinutes</key>
          <integer>1440</integer>
        </dict>
        <key>DeadPeerDetectionRate</key>
        <string>Medium</string>
        <key>DisableMOBIKE</key>
        <integer>1</integer>
        <key>DisableRedirect</key>
        <integer>0</integer>
        <key>EnablePFS</key>
        <integer>0</integer>
        <key>IKESecurityAssociationParameters</key>
        <dict>
          <key>DiffieHellmanGroup</key>
          <integer>14</integer>
          <key>EncryptionAlgorithm</key>
          <string>AES-256</string>
          <key>IntegrityAlgorithm</key>
          <string>SHA2-256</string>
          <key>LifeTimeInMinutes</key>
          <integer>1440</integer>
        </dict>
        <key>LocalIdentifier</key>
        <string>${CLIENT_ID}</string>
        <key>OnDemandEnabled</key>
        <integer>0</integer>
        <key>OnDemandRules</key>
        <array>
          <dict>
            <key>Action</key>
            <string>Connect</string>
          </dict>
        </array>
        <key>RemoteAddress</key>
        <string>${HOST}</string>
        <key>RemoteIdentifier</key>
        <string>${HOST}</string>
        <key>UseConfigurationAttributeInternalIPSubnet</key>
        <integer>0</integer>
      </dict>
      <key>PayloadDescription</key>
      <string>VPN IKEv2 privada para acessar o AI HUD na VPS Oracle</string>
      <key>PayloadDisplayName</key>
      <string>AI HUD (VPS Oracle)</string>
      <key>PayloadIdentifier</key>
      <string>local.ai-hud.vpn.ikev2</string>
      <key>PayloadType</key>
      <string>com.apple.vpn.managed</string>
      <key>PayloadUUID</key>
      <string>${UUID_VPN}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>Proxies</key>
      <dict/>
      <key>UserDefinedName</key>
      <string>AI HUD (VPS Oracle)</string>
      <key>VPNType</key>
      <string>IKEv2</string>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>AI HUD VPN (iPad)</string>
  <key>PayloadIdentifier</key>
  <string>local.ai-hud.vpn.profile</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${UUID_TOP}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
EOF
chmod 600 "${OUT_FILE}"

cat <<EOF

====================================================================
VPN IKEv2 (PSK para iOS 9.3.5) configurada!
====================================================================
1. Transfira "${OUT_FILE}" para o iPad mini 1 e instale o perfil.
2. Em Ajustes -> VPN, ative "AI HUD (VPS Oracle)".
3. Abra no Safari: http://${VPN_IP}:8787
   (Local ID: ${CLIENT_ID} | Remote ID: ${HOST})
====================================================================
EOF
