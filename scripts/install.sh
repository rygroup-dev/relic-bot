#!/usr/bin/env bash
#
# relic-bot one-line installer
#
#   curl -fsSL https://raw.githubusercontent.com/rygroup-dev/relic-bot/main/scripts/install.sh | bash
#
# Installs Node deps, builds, creates a 0700 key directory, walks you through a
# Telegram token and a wallet (new or imported), and registers a systemd unit.
# Nothing is started automatically.
set -euo pipefail

REPO="${RELIC_REPO:-https://github.com/rygroup-dev/relic-bot.git}"
DIR="${RELIC_DIR:-/root/relic-bot}"
KEYS="${RELIC_KEYS_DIR:-/root/.relic-bot/keys}"
SERVICE="relic-bot"

bold(){ printf '\033[1m%s\033[0m\n' "$*"; }
c()   { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[1;32mok\033[0m %s\n' "$*"; }
warn(){ printf '  \033[1;33m!!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask <prompt> <varname>
  local __p="$1" __v="$2" __r
  read -rp "  $__p" __r </dev/tty || true
  printf -v "$__v" '%s' "$__r"
}

INTERACTIVE=0
[ -t 0 ] && INTERACTIVE=1
[ -e /dev/tty ] && INTERACTIVE=1

echo
bold "relic-bot installer"
echo

# ---------------------------------------------------------------- prereqs --
command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node >= 22 is required — see https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm is required"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >= 22 required, found $(node -v)"
ok "node $(node -v), npm $(npm -v)"

# ----------------------------------------------------------------- source --
if [ -d "$DIR/.git" ]; then
  c "updating $DIR"
  git -C "$DIR" pull --ff-only
else
  c "cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

c "installing dependencies"
npm install --no-audit --no-fund
ok "dependencies installed"

c "building"
npm run build
ok "built to dist/"

# ------------------------------------------------------------------ keys ---
mkdir -p "$KEYS"
chmod 700 "$KEYS"
ok "key directory $KEYS (0700)"

# ------------------------------------------------------------------- env ---
if [ -f .env ]; then
  ok ".env already exists — leaving it untouched"
else
  cp .env.example .env
  chmod 600 .env
  sed -i "s|^RELIC_KEYS_DIR=.*|RELIC_KEYS_DIR=$KEYS|" .env

  if [ "$INTERACTIVE" = "1" ]; then
    echo
    c "Telegram control bot"
    echo "  Create a bot with @BotFather, then paste its token."
    echo "  Get your numeric user id from @userinfobot."
    echo "  Leave blank to skip; you can fill these into .env later."
    echo
    ask "Bot token: " TG
    ask "Your Telegram user id: " TGID
    [ -n "${TG:-}"   ] && sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TG|" .env
    [ -n "${TGID:-}" ] && sed -i "s|^TELEGRAM_OWNER_IDS=.*|TELEGRAM_OWNER_IDS=$TGID|" .env
    [ -n "${TG:-}" ] && ok "telegram configured" || warn "telegram skipped"
  else
    warn "non-interactive install — edit $DIR/.env before starting"
  fi
fi

# ---------------------------------------------------------------- wallet ---
if [ -n "$(ls -A "$KEYS" 2>/dev/null)" ]; then
  ok "wallets already present in $KEYS"
elif [ "$INTERACTIVE" = "1" ]; then
  echo
  c "Wallet setup"
  echo "  1) Create a new wallet"
  echo "  2) Import an existing private key"
  echo "  3) Skip for now"
  echo
  ask "Choose [1/2/3]: " WCHOICE

  case "${WCHOICE:-3}" in
    1)
      npm run --silent ctl -- new wallet-01
      ok "wallet created — back up the key file"
      ;;
    2)
      echo
      echo "  Paste a base58 secret key (Phantom -> Export Private Key)"
      echo "  or a JSON array of 64 numbers (solana-keygen)."
      ask "Secret key: " WKEY
      if [ -n "${WKEY:-}" ]; then
        npm run --silent ctl -- import "$WKEY" wallet-01
        unset WKEY
        ok "wallet imported"
      else
        warn "nothing pasted — skipped"
      fi
      ;;
    *)
      warn "skipped — add a wallet later with: npm run ctl -- new"
      ;;
  esac
else
  warn "no wallets yet. Add one with: cd $DIR && npm run ctl -- new"
fi

# --------------------------------------------------------------- systemd ---
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

# ----------------------------------------------------------------- check ---
echo
c "preflight"
npm run --silent ctl -- doctor || warn "doctor reported problems — see above"

echo
bold "next steps"
cat <<NEXT

  Wallets      npm run ctl -- wallets       list
               npm run ctl -- new           add another
               npm run ctl -- main <id>     choose the main account
  Treasury     npm run ctl -- holdings      balances
               npm run ctl -- sweep         dry run (add --execute to send)
  Game         npm run ctl -- login         verify authentication
               npm run ctl -- gate          token-gate state

  Start        systemctl enable --now $SERVICE
  Logs         journalctl -u $SERVICE -f
  Control      open Telegram and send /menu to your bot

  Gameplay and selling never sign a transaction. The treasury can move funds,
  but only between wallets you control — there is no code that can send to an
  outside address.

  Automating playrelic.gg is against its Terms of Service (section 4), and the
  game does ban for it. Running this is your decision.

NEXT
