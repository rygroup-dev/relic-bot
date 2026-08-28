#!/usr/bin/env bash
#
# relic-bot one-line installer
#
#   curl -fsSL https://raw.githubusercontent.com/rygroup-dev/relic-bot/main/scripts/install.sh | bash
#
# Installs to /root/relic-bot, creates a 0700 key directory, writes a .env from
# an interactive wizard, and registers a systemd unit (not started by default).
set -euo pipefail

REPO="${RELIC_REPO:-https://github.com/rygroup-dev/relic-bot.git}"
DIR="${RELIC_DIR:-/root/relic-bot}"
KEYS="${RELIC_KEYS_DIR:-/root/.relic-bot/keys}"
SERVICE="relic-bot"

c()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m  ok\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m  !!\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

c "relic-bot installer"
echo

# ---- prerequisites --------------------------------------------------------
command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node >= 22 is required (https://nodejs.org)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 required, found $(node -v)"
ok "node $(node -v)"

# ---- source ---------------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  c "updating $DIR"
  git -C "$DIR" pull --ff-only
else
  c "cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

c "installing dependencies"
npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
npm install --no-audit --no-fund --include=dev >/dev/null
npm run build
ok "built"

# ---- key directory --------------------------------------------------------
mkdir -p "$KEYS"
chmod 700 "$KEYS"
ok "key directory $KEYS (0700)"

if [ -z "$(ls -A "$KEYS" 2>/dev/null)" ]; then
  warn "no keys yet. Add one file per account, chmod 600:"
  echo "      echo '<base58-secret-key>' > $KEYS/wallet-01.key && chmod 600 $KEYS/wallet-01.key"
  echo "      (a solana-keygen JSON array of 64 ints also works)"
fi

# ---- .env wizard ----------------------------------------------------------
if [ -f .env ]; then
  ok ".env already exists, leaving it alone"
else
  c "configuring .env"
  cp .env.example .env
  chmod 600 .env

  if [ -t 0 ]; then
    read -rp "  Telegram bot token (blank to skip): " TG || true
    read -rp "  Your Telegram user id (blank to skip): " TGID || true
    if [ -n "${TG:-}" ]; then
      sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TG|" .env
    fi
    if [ -n "${TGID:-}" ]; then
      sed -i "s|^TELEGRAM_OWNER_IDS=.*|TELEGRAM_OWNER_IDS=$TGID|" .env
    fi
  else
    warn "non-interactive install: edit $DIR/.env before starting"
  fi

  sed -i "s|^RELIC_KEYS_DIR=.*|RELIC_KEYS_DIR=$KEYS|" .env
  ok ".env written (0600)"
fi

# ---- systemd --------------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  cat > "/etc/systemd/system/${SERVICE}.service" <<UNIT
[Unit]
Description=relic-bot — playrelic.gg automation fleet
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=/usr/bin/env node --enable-source-maps $DIR/dist/index.js
Restart=on-failure
RestartSec=15
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

# hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  ok "systemd unit ${SERVICE}.service installed (not started)"
else
  warn "systemd not found — run manually: node $DIR/dist/index.js"
fi

echo
c "next steps"
cat <<NEXT
  1. Put one secret key per account in $KEYS (chmod 600 each)
  2. Review $DIR/.env
  3. Check everything:      cd $DIR && npm run ctl -- doctor
  4. List wallets:          npm run ctl -- wallets
  5. Check the token gate:  npm run ctl -- gate
  6. Start:                 systemctl enable --now $SERVICE
  7. Logs:                  journalctl -u $SERVICE -f

  This bot can SELL but cannot BUY: no transaction-signing code exists.
  Automating playrelic.gg is against its Terms of Service (§4) and the game
  bans for it. Operating it is your decision.
NEXT
