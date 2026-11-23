#!/usr/bin/env bash
# Configura VPN IKEv2 (strongSwan) na VPS Oracle (Ubuntu/Debian) compatível com iPad mini 1 (iOS 9.3.5).
# - Split-tunnel: o iPad envia pela VPN SOMENTE o tráfego para 10.10.10.1 (AI HUD na VPS); a internet normal
#   do iPad continua direta pela Wi-Fi, sem NAT nem ip_forward na VPS.
# - Gera o arquivo ai-hud-ipad.mobileconfig (CA + VPN IKEv2 em 1 toque no iPad).
#
# Uso (na VPS Oracle, como root):
#   sudo bash platform/linux/ikev2-ipad-setup.sh --host <IP_PUBLICO_OU_DOMINIO_DA_VPS>
#
# Antes/depois, libere na Security List da Oracle Cloud (Ingress):
#   UDP 500  e  UDP 4500  (NÃO abra a porta TCP 8787 para a internet!)

set -euo pipefail

HOST=""
VPN_USER="ipad"
VPN_PASS=""
VPN_IP="10.10.10.1"
VPN_POOL="10.10.10.2-10.10.10.254"
OUT_FILE="./ai-hud-ipad.mobileconfig"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user) VPN_USER="$2"; shift 2 ;;
    --pass) VPN_PASS="$2"; shift 2 ;;
    --vpn-ip) VPN_IP="$2"; shift 2 ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Uso: sudo bash $0 --host <IP_OU_DOMINIO_VPS> [--user ipad] [--pass <senha>] [--out ./ai-hud-ipad.mobileconfig]"
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

if [[ -z "$VPN_PASS" ]]; then
  VPN_PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
fi

echo "==> Instalando strongSwan e plugins EAP (Ubuntu/Debian)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq strongswan strongswan-pki libcharon-extra-plugins openssl uuid-runtime

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

echo "==> Gerando CA e certificado RSA 2048 compatível com iOS 9.3.5..."
mkdir -p /etc/ipsec.d/{cacerts,certs,private}
chmod 700 /etc/ipsec.d/private

if [[ ! -f /etc/ipsec.d/private/ai-hud-ca-key.pem ]]; then
  pki --gen --type rsa --size 2048 --outform pem >/etc/ipsec.d/private/ai-hud-ca-key.pem
  pki --self --ca --lifetime 3650 \
    --in /etc/ipsec.d/private/ai-hud-ca-key.pem --type rsa \
    --dn "CN=AI HUD VPN Root CA" --digest sha256 \
    --outform pem >/etc/ipsec.d/cacerts/ai-hud-ca-cert.pem
fi

SAN_FLAG="--san ${HOST}"
pki --gen --type rsa --size 2048 --outform pem >/etc/ipsec.d/private/ai-hud-server-key.pem
pki --pub --in /etc/ipsec.d/private/ai-hud-server-key.pem --type rsa | \
  pki --issue --lifetime 3650 \
    --cacert /etc/ipsec.d/cacerts/ai-hud-ca-cert.pem \
    --cakey /etc/ipsec.d/private/ai-hud-ca-key.pem \
    --dn "CN=${HOST}" ${SAN_FLAG} \
    --flag serverAuth --flag ikeIntermediate --digest sha256 \
    --outform pem >/etc/ipsec.d/certs/ai-hud-server-cert.pem

chmod 600 /etc/ipsec.d/private/ai-hud-ca-key.pem /etc/ipsec.d/private/ai-hud-server-key.pem

echo "==> Escrevendo /etc/ipsec.conf (AES-256 / SHA-256 / MODP-2048 para iOS 9.3.5)..."
cat >/etc/ipsec.conf <<EOF
config setup
  charondebug="ike 1, knl 1, cfg 0"
  uniqueids=no

conn ai-hud-ipad
  auto=add
  compress=no
  type=tunnel
  keyexchange=ikev2
  fragmentation=yes
  forceencaps=yes
  dpdaction=clear
  dpddelay=300s
  rekey=no
  ike=aes256-sha256-modp2048,aes256-sha1-modp2048!
  esp=aes256-sha256,aes256-sha1!
  left=%any
  leftid=${HOST}
  leftcert=ai-hud-server-cert.pem
  leftsendcert=always
  leftsubnet=${VPN_IP}/32
  right=%any
  rightid=%any
  rightauth=eap-mschapv2
  rightsourceip=${VPN_POOL}
  eap_identity=%identity
EOF

cat >/etc/ipsec.secrets <<EOF
: RSA "ai-hud-server-key.pem"
${VPN_USER} : EAP "${VPN_PASS}"
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
CA_B64="$(openssl x509 -in /etc/ipsec.d/cacerts/ai-hud-ca-cert.pem -outform der | base64 -w 0)"
UUID_TOP="$(uuidgen)"
UUID_CA="$(uuidgen)"
UUID_VPN="$(uuidgen)"

cat >"${OUT_FILE}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>ai-hud-ca.cer</string>
      <key>PayloadContent</key>
      <data>${CA_B64}</data>
      <key>PayloadDescription</key>
      <string>Certificado raiz da VPN privada do AI HUD</string>
      <key>PayloadDisplayName</key>
      <string>AI HUD VPN Root CA</string>
      <key>PayloadIdentifier</key>
      <string>local.ai-hud.vpn.ca</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${UUID_CA}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
    <dict>
      <key>IKEv2</key>
      <dict>
        <key>AuthenticationMethod</key>
        <string>None</string>
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
        <integer>0</integer>
        <key>DisableRedirect</key>
        <integer>0</integer>
        <key>EnableCertificateRevocationCheck</key>
        <integer>0</integer>
        <key>EnablePFS</key>
        <integer>0</integer>
        <key>ExtendedAuthEnabled</key>
        <integer>1</integer>
        <key>AuthName</key>
        <string>${VPN_USER}</string>
        <key>AuthPassword</key>
        <string>${VPN_PASS}</string>
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
        <string>${VPN_USER}</string>
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
VPN IKEv2 configurada!
====================================================================
1. No painel da Oracle Cloud (VCN -> Security List -> Ingress Rules), libere:
     - UDP porta 500  (origem 0.0.0.0/0)
     - UDP porta 4500 (origem 0.0.0.0/0)
   E no firewall da VPS (Oracle Linux / Ubuntu iptables), confirme que UDP 500 e 4500 estão aceitos
   e que a porta TCP 8787 NÃO está aberta para a internet pública.

2. Transfira o arquivo "${OUT_FILE}" para o iPad mini 1 (ex.: e-mail, AirDrop via Mac ou servidor local temporário)
   e instale em: Ajustes -> Geral -> Perfis -> Instalar.

3. No iPad mini 1:
   - Ative a VPN "AI HUD (VPS Oracle)" em Ajustes -> VPN (depois de testar, pode ligar "Conectar Sob Demanda").
   - Abra no Safari: http://${VPN_IP}:8787
   - Digite o PIN do AI HUD da VPS e adicione à Tela de Início.

Usuário EAP: ${VPN_USER}
Senha EAP:   ${VPN_PASS}
====================================================================
EOF
