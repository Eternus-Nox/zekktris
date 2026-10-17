#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Zekktris installer — run your own Zekktris server.
#
#   ./install.sh                  guided install (asks a few questions)
#   ./install.sh --ip             reachable at this network's public IP
#   ./install.sh --domain chat.example.com
#   ./install.sh --lan            home network only
#   ./install.sh --yes ...        take the recommended answer everywhere
#
# Other options:
#   --admin-email you@example.com   the admin account the installer creates
#   --admin-password-file /path     its password (first line), for scripted
#                                   installs; or set ZEKKTRIS_ADMIN_PASSWORD
#   --data-dir /path                where the database and uploads live
#   --no-upnp                       don't ask the router to open ports
#   --reconfigure                   change how an existing install is reached
#   --no-start                      write the config, don't start anything
#
# What it works out by itself:
#   • Docker (offers to install it on Linux) and whether it can use it
#   • this machine's LAN address and the network's public IP
#   • whether the machine is directly on the internet, behind a router, or
#     behind carrier-grade NAT (where port forwarding can't work)
#   • whether the router supports UPnP — and if so, opens the ports for you
#   • a host firewall (ufw / firewalld) that would block calls
#   • ports already taken by something else
#   • for a domain: whether its DNS points here
#
# Then it writes .env with fresh secrets, starts the stack, waits for HTTPS to
# come up, and tells you exactly what's left to do (if anything).
#
# Run it again any time: with an existing .env it only fills in what's
# missing and restarts — your secrets and data are never replaced.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── Output helpers ──────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
    GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"
    RED="$(printf '\033[31m')"; CYAN="$(printf '\033[36m')"; RESET="$(printf '\033[0m')"
else
    BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi
step() { echo; echo "${BOLD}▶ $*${RESET}"; }
ok()   { echo "  ${GREEN}✓${RESET} $*"; }
info() { echo "  ${DIM}·${RESET} $*"; }
warn() { echo "  ${YELLOW}!${RESET} $*"; }
fail() { echo "  ${RED}✗${RESET} $*" >&2; exit 1; }

# Questions read from the terminal even when the script itself is piped in.
TTY=""
if [[ -r /dev/tty ]] && { : </dev/tty; } 2>/dev/null; then TTY=/dev/tty; fi
ASSUME_YES=0

# ask "Question" "default" → prints the answer
ask() {
    local q="$1" def="${2:-}" a=""
    if [[ $ASSUME_YES -eq 1 || -z "$TTY" ]]; then echo "$def"; return; fi
    if [[ -n "$def" ]]; then printf '  %s %s[%s]%s ' "$q" "$DIM" "$def" "$RESET" >/dev/tty
    else printf '  %s ' "$q" >/dev/tty; fi
    IFS= read -r a </dev/tty || true
    echo "${a:-$def}"
}

# confirm "Question" [Y|N] → 0 for yes
confirm() {
    local q="$1" def="${2:-Y}" a=""
    if [[ $ASSUME_YES -eq 1 || -z "$TTY" ]]; then [[ "$def" == "Y" ]]; return; fi
    local hint="[Y/n]"; [[ "$def" == "N" ]] && hint="[y/N]"
    printf '  %s %s ' "$q" "$hint" >/dev/tty
    IFS= read -r a </dev/tty || true
    a="$(printf '%s' "${a:-$def}" | tr '[:upper:]' '[:lower:]')"
    [[ "$a" == y* ]]
}

# ── Arguments ───────────────────────────────────────────────────────────────
MODE=""; DOMAIN=""; IP_ARG=""; ADMIN_EMAIL=""; DATA_DIR=""
USE_UPNP=1; RECONFIGURE=0; START=1
while [[ $# -gt 0 ]]; do
    case "$1" in
        --ip) MODE="ip"; if [[ "${2:-}" =~ ^[0-9.]+$ ]]; then IP_ARG="$2"; shift; fi; shift ;;
        --domain) MODE="domain"; DOMAIN="${2:-}"; [[ -n "$DOMAIN" ]] || fail "--domain needs a name"; shift 2 ;;
        --lan) MODE="lan"; shift ;;
        --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
        --admin-password-file) ADMIN_PASSWORD_FILE="${2:-}"; shift 2 ;;
        --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
        --no-upnp) USE_UPNP=0; shift ;;
        --reconfigure) RECONFIGURE=1; shift ;;
        --no-start) START=0; shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        -h|--help) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) fail "unknown option: $1 (see --help)" ;;
    esac
done

# ── Small utilities (bash 3 / BSD + GNU safe) ───────────────────────────────
is_ipv4() { [[ "$1" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; }

# Private, loopback, link-local, or carrier-grade-NAT (100.64.0.0/10).
is_nonpublic_ipv4() {
    local a b
    IFS=. read -r a b _ _ <<<"$1"
    [[ $a -eq 10 || $a -eq 127 ]] && return 0
    [[ $a -eq 172 && $b -ge 16 && $b -le 31 ]] && return 0
    [[ $a -eq 192 && $b -eq 168 ]] && return 0
    [[ $a -eq 169 && $b -eq 254 ]] && return 0
    [[ $a -eq 100 && $b -ge 64 && $b -le 127 ]] && return 0
    return 1
}
is_cgnat_ipv4() { local a b; IFS=. read -r a b _ _ <<<"$1"; [[ $a -eq 100 && $b -ge 64 && $b -le 127 ]]; }

# Set KEY=value in .env (replace the line, or append it). Values are written
# verbatim, so keep them free of newlines.
env_set() {
    local key="$1" value="$2" tmp
    tmp="$(mktemp)"
    if grep -qE "^${key}=" .env 2>/dev/null; then
        awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' .env >"$tmp"
    else
        cat .env >"$tmp"; printf '%s=%s\n' "$key" "$value" >>"$tmp"
    fi
    cat "$tmp" >.env; rm -f "$tmp"
}
env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }
# Fill KEY only when it's missing or blank.
env_default() { [[ -n "$(env_get "$1")" ]] || env_set "$1" "$2"; }

rand_hex() { openssl rand -hex "$1"; }

# Root (common on a VPS) needs no sudo — and may not even have it.
SUDO="sudo"; [[ "$(id -u)" -eq 0 ]] && SUDO=""

# ── 1. This machine ─────────────────────────────────────────────────────────
echo
echo "${BOLD}${CYAN}Zekktris installer${RESET}"
echo "${DIM}Sets up your own Zekktris server on this machine.${RESET}"

step "Checking this machine"
OS="$(uname -s)"; ARCH="$(uname -m)"
IS_WSL=0; IS_UNRAID=0
[[ "$OS" == "Linux" ]] && grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1
[[ -f /etc/unraid-version ]] && IS_UNRAID=1
case "$OS" in
    Linux)
        if [[ $IS_UNRAID -eq 1 ]]; then ok "Unraid ($ARCH)"
        elif [[ $IS_WSL -eq 1 ]]; then ok "Linux under WSL ($ARCH)"
        else ok "Linux ($ARCH)"; fi ;;
    Darwin) ok "macOS ($ARCH)" ;;
    *) fail "Unsupported system: $OS. Use Linux (any distro), Unraid, or macOS." ;;
esac
if [[ "$OS" == "Darwin" || $IS_WSL -eq 1 ]]; then
    warn "Voice and video calls need Docker's host networking, which only works"
    warn "fully on Linux. Here, chat works for everyone but calls may only work"
    warn "on this machine. For a real server use Linux (a spare PC, a Raspberry"
    warn "Pi 4/5, a NAS like Unraid, or a cheap VPS)."
    confirm "Continue anyway?" Y || exit 1
fi

for tool in curl openssl awk; do
    command -v "$tool" >/dev/null 2>&1 || fail "'$tool' is required. Install it and run this again."
done

MEM_MB=0
if [[ "$OS" == "Linux" ]]; then MEM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
else MEM_MB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 )); fi
if [[ $MEM_MB -lt 1800 ]]; then warn "Only ${MEM_MB} MB of memory — 2 GB is the practical minimum."
else ok "Memory: $(( MEM_MB / 1024 )) GB"; fi

# ── 2. Docker ───────────────────────────────────────────────────────────────
step "Checking Docker"
DOCKER="docker"
if ! command -v docker >/dev/null 2>&1; then
    if [[ "$OS" == "Linux" && $IS_UNRAID -eq 0 ]]; then
        warn "Docker isn't installed."
        # Running a downloaded script as root is the operator's call, never a
        # default: the answer defaults to No and --yes does not say yes to it.
        info "Docker's convenience script (https://get.docker.com) can install it — it runs as root."
        info "Or install it from your distribution's packages: https://docs.docker.com/engine/install/"
        if [[ $ASSUME_YES -eq 0 && -n "$TTY" ]] && confirm "Download get.docker.com and run it as root now?" N; then
            curl -fsSL https://get.docker.com | $SUDO sh || fail "Docker install failed."
        else
            fail "Docker is required. Install it (see above), then run ./install.sh again."
        fi
    else
        fail "Docker is required. macOS: install Docker Desktop or colima. Unraid: enable Docker in Settings."
    fi
fi
if ! docker info >/dev/null 2>&1; then
    if [[ -n "$SUDO" ]] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
        DOCKER="sudo docker"
    else
        fail "Docker is installed but not usable by $(whoami). Start it, or add yourself to the docker group: sudo usermod -aG docker $(whoami) (then log out and in)."
    fi
    info "Using sudo for Docker."
fi
if $DOCKER compose version >/dev/null 2>&1; then COMPOSE="$DOCKER compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"; [[ "$DOCKER" == "sudo docker" ]] && COMPOSE="sudo docker-compose"
else
    fail "Docker Compose is missing. Install the docker-compose-plugin package."
fi
ok "Docker $($DOCKER version --format '{{.Server.Version}}' 2>/dev/null || echo ready) with $COMPOSE"

# ── 3. Existing install? ────────────────────────────────────────────────────
EXISTING=0
[[ -f .env ]] && EXISTING=1
if [[ $EXISTING -eq 1 && $RECONFIGURE -eq 0 && -z "$MODE" ]]; then
    step "Found an existing .env — keeping its settings"
    info "Only missing values are filled in. Use --reconfigure to change how the server is reached."
fi
NEED_ADDRESSING=1
[[ $EXISTING -eq 1 && $RECONFIGURE -eq 0 && -z "$MODE" ]] && NEED_ADDRESSING=0

# ── 4. Network ──────────────────────────────────────────────────────────────
LAN_IP=""; PUBLIC_IP=""; DIRECT=0; CGNAT=0; UPNP_OK=0; ROUTER_WAN_IP=""
if [[ $NEED_ADDRESSING -eq 1 ]]; then
    step "Looking at the network"

    if command -v ip >/dev/null 2>&1; then
        LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    fi
    if [[ -z "$LAN_IP" && "$OS" == "Darwin" ]]; then
        iface="$(route -n get default 2>/dev/null | awk '/interface:/ {print $2}')"
        [[ -n "$iface" ]] && LAN_IP="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    fi
    [[ -z "$LAN_IP" ]] && LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    if is_ipv4 "${LAN_IP:-}"; then ok "This machine on the network: $LAN_IP"
    else warn "Couldn't work out this machine's network address."; LAN_IP=""; fi

    for url in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
        candidate="$(curl -4 -fsS --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
        if is_ipv4 "$candidate"; then PUBLIC_IP="$candidate"; break; fi
    done
    if [[ -n "$PUBLIC_IP" ]]; then ok "Public IP (what the internet sees): $PUBLIC_IP"
    else warn "Couldn't reach the internet to look up the public IP."; fi

    # Is the public IP on one of this machine's own interfaces? (a VPS)
    if [[ -n "$PUBLIC_IP" ]]; then
        if command -v ip >/dev/null 2>&1; then
            ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$PUBLIC_IP" && DIRECT=1
        else
            ifconfig 2>/dev/null | awk '/inet / {print $2}' | grep -qx "$PUBLIC_IP" && DIRECT=1
        fi
    fi
    if [[ -n "$PUBLIC_IP" ]] && is_cgnat_ipv4 "$PUBLIC_IP"; then CGNAT=1; fi

    if [[ $DIRECT -eq 1 ]]; then
        ok "This machine is directly on the internet — no router to set up."
    elif [[ "$OS" == "Linux" && $USE_UPNP -eq 1 ]]; then
        # Ask the router over UPnP (from a throwaway container on the host
        # network — nothing is installed on this machine).
        info "Asking the router whether it supports automatic port forwarding (UPnP)…"
        upnp_out="$($DOCKER run --rm --network host alpine:3.20 sh -c \
            'apk add --no-cache -q miniupnpc >/dev/null 2>&1 && upnpc -s' 2>/dev/null || true)"
        ROUTER_WAN_IP="$(printf '%s\n' "$upnp_out" | awk -F'= ' '/ExternalIPAddress/ {print $2; exit}' | tr -d '[:space:]')"
        if is_ipv4 "${ROUTER_WAN_IP:-}"; then
            UPNP_OK=1
            ok "Router supports UPnP (its internet address: $ROUTER_WAN_IP)"
            # The router's own WAN address is private/CGNAT while the internet
            # sees something else → the ISP puts us behind carrier-grade NAT.
            if is_nonpublic_ipv4 "$ROUTER_WAN_IP" && [[ "$ROUTER_WAN_IP" != "$PUBLIC_IP" ]]; then CGNAT=1; fi
        else
            info "No UPnP answer — ports will need forwarding by hand (instructions below)."
        fi
    fi

    if [[ $CGNAT -eq 1 ]]; then
        warn "Your internet provider shares one public IP between many customers"
        warn "(carrier-grade NAT), so port forwarding can't reach this machine from"
        warn "outside. Options: ask your ISP for a public IPv4 address (often free or"
        warn "cheap), use a VPS, or put the server behind Cloudflare Tunnel / Tailscale."
        warn "A home-network-only install works fine meanwhile."
    fi
fi

# ── 5. How people will reach it ─────────────────────────────────────────────
if [[ $NEED_ADDRESSING -eq 1 && -z "$MODE" ]]; then
    step "How should people reach your server?"
    echo "    1) Just your public IP ${PUBLIC_IP:+($PUBLIC_IP) }— no domain needed, free HTTPS"
    echo "    2) A domain name you own (e.g. chat.example.com)"
    echo "    3) Home network only (${LAN_IP:-this LAN}) — nobody outside can connect"
    default_choice=1
    [[ -z "$PUBLIC_IP" || $CGNAT -eq 1 ]] && default_choice=3
    choice="$(ask "Choose 1, 2 or 3:" "$default_choice")"
    case "$choice" in
        1) MODE="ip" ;;
        2) MODE="domain" ;;
        3) MODE="lan" ;;
        *) fail "Please choose 1, 2 or 3." ;;
    esac
fi

if [[ "$MODE" == "ip" ]]; then
    [[ -n "$IP_ARG" ]] && PUBLIC_IP="$IP_ARG"
    is_ipv4 "${PUBLIC_IP:-}" || PUBLIC_IP="$(ask "Public IP address:" "")"
    is_ipv4 "$PUBLIC_IP" || fail "That isn't an IPv4 address."
    is_nonpublic_ipv4 "$PUBLIC_IP" && fail "$PUBLIC_IP is a private address — use --lan for a home-network install."
fi
if [[ "$MODE" == "domain" ]]; then
    [[ -n "$DOMAIN" ]] || DOMAIN="$(ask "Domain name (e.g. chat.example.com):" "")"
    DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')"
    [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || fail "\"$DOMAIN\" isn't a valid domain name."
    # DNS over HTTPS so this works the same everywhere (no dig/host needed).
    dns_ips="$(curl -fsS --max-time 6 "https://dns.google/resolve?name=${DOMAIN}&type=A" 2>/dev/null \
        | grep -oE '"data": *"[0-9.]+"' | grep -oE '[0-9.]+' | tr '\n' ' ' || true)"
    if [[ -z "$dns_ips" ]]; then
        warn "$DOMAIN doesn't resolve yet. Add a DNS \"A\" record pointing it to ${PUBLIC_IP:-your public IP}."
        warn "HTTPS starts working a few minutes after the record exists."
    elif [[ -n "$PUBLIC_IP" && " $dns_ips " != *" $PUBLIC_IP "* ]]; then
        warn "$DOMAIN points to $dns_ips, not to this network ($PUBLIC_IP)."
        warn "If it's behind Cloudflare's proxy (orange cloud), switch it to \"DNS only\" for the first setup."
        warn "(To keep Cloudflare's proxy on afterwards, also set EDGE_PROXY=cloudflare in .env.)"
    else
        ok "$DOMAIN points here ($PUBLIC_IP)"
    fi
fi
if [[ "$MODE" == "lan" ]]; then
    is_ipv4 "${LAN_IP:-}" || LAN_IP="$(ask "This machine's LAN address:" "")"
    is_ipv4 "$LAN_IP" || fail "That isn't an IPv4 address."
fi

# ── 6. Ports ────────────────────────────────────────────────────────────────
port_in_use() { # port proto(tcp|udp) → 0 if something already listens
    local port="$1" proto="$2"
    if command -v ss >/dev/null 2>&1; then
        if [[ "$proto" == "tcp" ]]; then ss -Hltn "sport = :$port" 2>/dev/null | grep -q .
        else ss -Hlun "sport = :$port" 2>/dev/null | grep -q .; fi
    elif command -v lsof >/dev/null 2>&1; then
        if [[ "$proto" == "tcp" ]]; then lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
        else lsof -nP -iUDP:"$port" >/dev/null 2>&1; fi
    else
        return 1
    fi
}

# Router-facing ports for each mode.
#   80/443 TCP  web + HTTPS certificate checks   (443 UDP = faster HTTP/3, optional)
#   7881 TCP / 7882 UDP  voice + video media (LiveKit)
PORTS_TCP="80 443 7881"; PORTS_UDP="443 7882"
[[ "$MODE" == "lan" ]] && { PORTS_TCP="5550 7881"; PORTS_UDP="7882"; }
if [[ $NEED_ADDRESSING -eq 1 ]]; then
    step "Checking ports on this machine"
    ours="$($DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -c '^zekktris-' || true)"
    conflicts=""
    for p in $PORTS_TCP 7880; do
        if port_in_use "$p" tcp && [[ "$ours" -eq 0 ]]; then conflicts="$conflicts $p/tcp"; fi
    done
    for p in $PORTS_UDP; do
        if port_in_use "$p" udp && [[ "$ours" -eq 0 ]]; then conflicts="$conflicts $p/udp"; fi
    done
    if [[ -n "$conflicts" ]]; then
        warn "Already in use by another program:$conflicts"
        warn "Stop it (often another web server like nginx/apache), or Zekktris won't start."
        confirm "Continue anyway?" N || exit 1
    else
        ok "Ports are free: TCP ${PORTS_TCP// /, } · UDP ${PORTS_UDP// /, }"
    fi
fi

# ── Admin account ───────────────────────────────────────────────────────────
# The installer creates the admin account itself, inside the api container
# (apps/api/scripts/create-admin.ts), once the stack is healthy: verified, with
# the password asked for here. Nothing is left for a stranger to race for —
# the old way (BOOTSTRAP_ADMIN_EMAIL + "register with this email") made whoever
# registered that address first the admin on an open server without SMTP, so
# fresh installs no longer set it (and if someone registers the address before
# the script runs, the install stops rather than promote them). Password
# sources, in order: the first line of --admin-password-file,
# $ZEKKTRIS_ADMIN_PASSWORD, a hidden prompt (twice).
# It is never put on a command line; it reaches the script on stdin.
ADMIN_PASSWORD_FILE="${ADMIN_PASSWORD_FILE:-}"
ADMIN_PASSWORD="${ZEKKTRIS_ADMIN_PASSWORD:-}"
ADMIN_CREATED=0; ADMIN_PROMOTED=0; ADMIN_MISSING=0
ADMIN_PASSWORD_MIN=8   # PASSWORD_MIN_LENGTH in packages/shared/src/constants.ts

# admin_password_collect [optional] → sets ADMIN_PASSWORD. "optional" (an
# existing install promoting an account that may already exist) allows empty.
admin_password_collect() {
    local optional="${1:-}" a="" b=""
    if [[ -n "$ADMIN_PASSWORD_FILE" ]]; then
        [[ -r "$ADMIN_PASSWORD_FILE" ]] || fail "Can't read $ADMIN_PASSWORD_FILE (--admin-password-file)."
        IFS= read -r ADMIN_PASSWORD <"$ADMIN_PASSWORD_FILE" || true
    fi
    if [[ -z "$ADMIN_PASSWORD" ]]; then
        if [[ $ASSUME_YES -eq 1 || -z "$TTY" ]]; then
            [[ -n "$optional" ]] && return 0
            fail "Set ZEKKTRIS_ADMIN_PASSWORD or pass --admin-password-file when running with --yes or without a terminal."
        fi
        while :; do
            if [[ -n "$optional" ]]; then
                printf '  Admin password (hidden; leave empty if the account already exists): ' >/dev/tty
            else
                printf '  Admin password (at least %s characters, hidden): ' "$ADMIN_PASSWORD_MIN" >/dev/tty
            fi
            IFS= read -rs a </dev/tty || true; echo >/dev/tty
            [[ -z "$a" && -n "$optional" ]] && return 0
            if [[ ${#a} -lt $ADMIN_PASSWORD_MIN ]]; then warn "Use at least $ADMIN_PASSWORD_MIN characters."; continue; fi
            printf '  Repeat it: ' >/dev/tty
            IFS= read -rs b </dev/tty || true; echo >/dev/tty
            if [[ "$a" != "$b" ]]; then warn "The two didn't match — try again."; continue; fi
            ADMIN_PASSWORD="$a"; break
        done
    fi
    if [[ ${#ADMIN_PASSWORD} -lt $ADMIN_PASSWORD_MIN ]]; then
        fail "The admin password must be at least $ADMIN_PASSWORD_MIN characters."
    fi
    ok "Admin password set"
}

# Runs once the api is healthy. On a fresh install the account is created
# with --create-only: registration is already open, so if someone registered
# the address first that's an error, not an admin. With an explicit
# --admin-email on an existing install an existing account is promoted
# instead (password left alone; unverified ones are refused by the script).
# An existing install with no admin at all (an earlier run that died before
# this step) is offered a fresh one again. Stops the install on failure.
admin_account_create() {
    local out rc mode="" existing_ok=0
    if [[ -z "$ADMIN_EMAIL" ]]; then
        rc=0; out="$($COMPOSE exec -T -e LOG_LEVEL=warn -w /app/apps/api api \
            node --import tsx/esm scripts/create-admin.ts --check 2>&1)" || rc=$?
        [[ $rc -eq 3 ]] || return 0   # has an admin (or can't tell: leave it)
        step "This server has no admin account yet"
        if [[ ( $ASSUME_YES -eq 1 || -z "$TTY" ) && -z "$ADMIN_PASSWORD" && -z "$ADMIN_PASSWORD_FILE" ]]; then
            warn "Not creating one without a password (--yes / no terminal): set ZEKKTRIS_ADMIN_PASSWORD."
            ADMIN_MISSING=1; return 0
        fi
        while :; do
            ADMIN_EMAIL="$(ask "Admin email:" "$(env_get ACME_EMAIL)")"
            [[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] && break
            ADMIN_EMAIL=""
            [[ $ASSUME_YES -eq 1 || -z "$TTY" ]] && { ADMIN_MISSING=1; return 0; }
            warn "That doesn't look like an email address."
        done
        admin_password_collect
        mode="--create-only"
    elif [[ $EXISTING -eq 0 ]]; then
        mode="--create-only"
    else
        existing_ok=1
    fi
    if [[ $existing_ok -eq 1 ]]; then step "Making $ADMIN_EMAIL an admin"; else step "Creating your admin account"; fi
    if out="$(printf '%s\n' "$ADMIN_PASSWORD" | $COMPOSE exec -T -e LOG_LEVEL=warn -w /app/apps/api api \
            node --import tsx/esm scripts/create-admin.ts --email "$ADMIN_EMAIL" $mode 2>&1)"; then
        # "Created admin account …" = the password given here is the account's.
        if grep -q '^Created admin account' <<<"$out"; then ADMIN_CREATED=1; else ADMIN_PROMOTED=1; fi
        ok "$(tail -1 <<<"$out")"
    else
        printf '%s\n' "$out" | tail -5 | sed 's/^/      /' >&2
        if [[ $existing_ok -eq 1 ]]; then
            fail "Couldn't make $ADMIN_EMAIL an admin. The server is running; fix the above and run ./install.sh --admin-email $ADMIN_EMAIL again."
        fi
        fail "Couldn't create the admin account. The server is running; fix the above and run ./install.sh again (it asks for the admin while there is none)."
    fi
    ADMIN_PASSWORD=""
}

# ── 7. Admin + data ─────────────────────────────────────────────────────────
if [[ $EXISTING -eq 1 && -n "$ADMIN_EMAIL" ]]; then
    step "Admin account"
    info "$ADMIN_EMAIL becomes an admin: an existing account is promoted, otherwise it is created."
    # Only used once the server is up; --no-start prints the command instead.
    if [[ $START -eq 1 ]]; then admin_password_collect optional; fi
fi
if [[ $EXISTING -eq 0 ]]; then
    step "Your admin account"
    info "The installer creates this account for you and makes it the server's admin."
    while [[ -z "$ADMIN_EMAIL" || ! "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; do
        [[ -n "$ADMIN_EMAIL" ]] && warn "That doesn't look like an email address."
        ADMIN_EMAIL="$(ask "Admin email:" "")"
        [[ -z "$TTY" && -z "$ADMIN_EMAIL" ]] && fail "Pass --admin-email when running without a terminal."
        [[ $ASSUME_YES -eq 1 && -z "$ADMIN_EMAIL" ]] && fail "Pass --admin-email together with --yes."
    done
    ok "Admin: $ADMIN_EMAIL"
    if [[ $START -eq 1 ]]; then admin_password_collect; fi

    if [[ -z "$DATA_DIR" ]]; then
        if [[ $IS_UNRAID -eq 1 ]]; then DATA_DIR="/mnt/user/appdata/zekktris"; else DATA_DIR="$ROOT/data"; fi
        DATA_DIR="$(ask "Where should the database and uploads live?" "$DATA_DIR")"
    fi
fi

# ── 8. Write .env ───────────────────────────────────────────────────────────
step "Writing the configuration"
if [[ $EXISTING -eq 0 ]]; then
    [[ -f .env.example ]] || fail ".env.example is missing — is this the Zekktris folder?"
    cp .env.example .env
    chmod 600 .env
    env_set DB_PASSWORD "$(rand_hex 24)"
    env_set JWT_SECRET "$(rand_hex 32)"
    env_set JWT_REFRESH_SECRET "$(rand_hex 32)"
    env_set FIELD_ENCRYPTION_KEY "$(rand_hex 32)"
    env_set APPDATA_PATH "$DATA_DIR"
    env_set ACME_EMAIL "$ADMIN_EMAIL"
    env_set ALLOW_REGISTRATION open
    ok "Fresh secrets generated (.env, readable only by you)"
else
    cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
    info "Backed up the old .env next to it."
fi

# LiveKit (voice/video) keys — the bundled SFU. The old shared LiveKit Cloud
# credentials that early versions committed are replaced if still present.
# Replacing them here does not revoke them: the pair is in the public git
# history, so its owner must delete key APIAMD7Sj5psuK4 in the LiveKit Cloud
# dashboard (docs/SELF-HOSTING.md, "Security notes").
if [[ "$(env_get LIVEKIT_API_KEY)" == "APIAMD7Sj5psuK4" ]]; then
    env_set LIVEKIT_WS_URL ""; env_set LIVEKIT_API_KEY ""; env_set LIVEKIT_API_SECRET ""
fi
env_default LIVEKIT_API_KEY "lk_$(rand_hex 8)"
env_default LIVEKIT_API_SECRET "$(rand_hex 32)"
env_default LIVEKIT_IMAGE_TAG "v1.9.12"

# Web push (browser notifications): a P-256 VAPID keypair sliced straight out
# of openssl's DER output — no Node needed. Generated once, never rotated
# (rotating breaks every existing subscription).
if [[ -z "$(env_get VAPID_PUBLIC_KEY)" || -z "$(env_get VAPID_PRIVATE_KEY)" ]]; then
    der="$(mktemp)"
    if openssl ecparam -name prime256v1 -genkey -noout -outform DER >"$der" 2>/dev/null \
        && [[ "$(wc -c <"$der")" -ge 121 ]]; then
        b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
        total="$(wc -c <"$der" | tr -d ' ')"
        env_set VAPID_PRIVATE_KEY "$(dd if="$der" bs=1 skip=7 count=32 2>/dev/null | b64url)"
        env_set VAPID_PUBLIC_KEY "$(dd if="$der" bs=1 skip=$((total - 65)) count=65 2>/dev/null | b64url)"
        ok "Browser notification keys generated"
    else
        warn "Couldn't generate browser-notification keys; web push stays off."
    fi
    rm -f "$der"
fi
env_default VAPID_CONTACT_EMAIL "$(env_get ACME_EMAIL)"
[[ -z "$(env_get VAPID_CONTACT_EMAIL)" ]] && env_set VAPID_CONTACT_EMAIL "admin@example.com"

if [[ $NEED_ADDRESSING -eq 1 ]]; then
    case "$MODE" in
        ip)
            URL="https://$PUBLIC_IP"
            env_set PUBLIC_URL "$URL"; env_set SITE_ADDRESS "$URL"
            env_set TLS_MODE ip; env_set PUBLIC_IP "$PUBLIC_IP"
            env_set HTTP_PORT 80; env_set HTTPS_PORT 443; env_set COOKIE_SECURE true
            env_set LIVEKIT_USE_EXTERNAL_IP true; env_set LIVEKIT_HOST "" ;;
        domain)
            URL="https://$DOMAIN"
            env_set PUBLIC_URL "$URL"; env_set SITE_ADDRESS "$URL"
            env_set TLS_MODE none; env_set PUBLIC_IP ""
            env_set HTTP_PORT 80; env_set HTTPS_PORT 443; env_set COOKIE_SECURE true
            env_set LIVEKIT_USE_EXTERNAL_IP true; env_set LIVEKIT_HOST "" ;;
        lan)
            URL="http://$LAN_IP:5550"
            env_set PUBLIC_URL "$URL"; env_set SITE_ADDRESS ":5550"
            env_set TLS_MODE none; env_set PUBLIC_IP ""
            env_set HTTP_PORT 5550; env_set HTTPS_PORT 5551; env_set COOKIE_SECURE false
            # Media on the LAN address only; no STUN lookup of the public IP.
            env_set LIVEKIT_USE_EXTERNAL_IP false; env_set LIVEKIT_HOST "$LAN_IP" ;;
    esac
    ok "Address: $URL"
else
    URL="$(env_get PUBLIC_URL)"
    MODE="existing"
    [[ "$(env_get TLS_MODE)" == "ip" ]] && MODE="ip"
    [[ "$(env_get SITE_ADDRESS)" == https://* && "$(env_get TLS_MODE)" != "ip" ]] && MODE="domain"
    ok "Address: $URL (unchanged)"
fi

DATA_DIR="$(env_get APPDATA_PATH)"
DATA_DIR="${DATA_DIR:-/mnt/user/appdata/zekktris}"
for d in db uploads caddy-data caddy-config desktop-updates backups control; do
    mkdir -p "$DATA_DIR/$d" 2>/dev/null || $SUDO mkdir -p "$DATA_DIR/$d" 2>/dev/null || true
done
mkdir -p secrets
ok "Data folder: $DATA_DIR"

# ── 9. Firewall + router ────────────────────────────────────────────────────
# Docker-published web ports bypass ufw/firewalld, but the voice/video ports
# (LiveKit runs on the host network) do not — so open them all.
if [[ $NEED_ADDRESSING -eq 1 && "$OS" == "Linux" ]]; then
    if command -v ufw >/dev/null 2>&1 && grep -qs '^ENABLED=yes' /etc/ufw/ufw.conf; then
        step "Firewall (ufw)"
        if confirm "Open the Zekktris ports in ufw?" Y; then
            for p in $PORTS_TCP; do $SUDO ufw allow "$p/tcp" >/dev/null; done
            for p in $PORTS_UDP; do $SUDO ufw allow "$p/udp" >/dev/null; done
            ok "ufw: allowed TCP ${PORTS_TCP// /, } and UDP ${PORTS_UDP// /, }"
        else
            warn "Calls from outside won't connect until UDP 7882 and TCP 7881 are allowed."
        fi
    elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld 2>/dev/null; then
        step "Firewall (firewalld)"
        if confirm "Open the Zekktris ports in firewalld?" Y; then
            for p in $PORTS_TCP; do $SUDO firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
            for p in $PORTS_UDP; do $SUDO firewall-cmd --permanent --add-port="$p/udp" >/dev/null; done
            $SUDO firewall-cmd --reload >/dev/null
            ok "firewalld: allowed TCP ${PORTS_TCP// /, } and UDP ${PORTS_UDP// /, }"
        else
            warn "Calls from outside won't connect until UDP 7882 and TCP 7881 are allowed."
        fi
    fi
fi

FORWARDED=0
if [[ $NEED_ADDRESSING -eq 1 && ( "$MODE" == "ip" || "$MODE" == "domain" ) && $DIRECT -eq 0 && $CGNAT -eq 0 ]]; then
    step "Router port forwarding"
    if [[ $UPNP_OK -eq 1 ]] && confirm "Ask the router to forward the ports to this machine (UPnP)?" Y; then
        args=""
        for p in $PORTS_TCP; do args="$args $p TCP"; done
        for p in $PORTS_UDP; do args="$args $p UDP"; done
        if $DOCKER run --rm --network host alpine:3.20 sh -c \
            "apk add --no-cache -q miniupnpc >/dev/null 2>&1 && upnpc -e Zekktris -r $args" >/dev/null 2>&1; then
            FORWARDED=1
            ok "Router is forwarding TCP ${PORTS_TCP// /, } and UDP ${PORTS_UDP// /, } to ${LAN_IP:-this machine}"
            info "Some routers forget UPnP rules when they restart — run ./install.sh again if that happens."
        else
            warn "The router refused. Forward the ports by hand (below)."
        fi
    fi
    if [[ $FORWARDED -eq 0 ]]; then
        echo
        echo "  In your router's settings (often \"Port forwarding\" or \"Virtual server\"),"
        echo "  forward these to ${BOLD}${LAN_IP:-this machine}${RESET}:"
        for p in $PORTS_TCP; do echo "      TCP $p"; done
        for p in $PORTS_UDP; do echo "      UDP $p"; done
        echo "  Tip: also give this machine a fixed (\"reserved\") address in the router's DHCP settings."
        [[ -n "$TTY" && $ASSUME_YES -eq 0 ]] && ask "Press Enter once that's done (or to do it later)." "" >/dev/null
    fi
fi

# ── 10. Start ───────────────────────────────────────────────────────────────
if [[ $START -eq 0 ]]; then
    step "Configuration written — not starting (--no-start)"
    info "Start it with: $COMPOSE up -d --build"
    # An existing install may still have root-owned uploads, which the api's
    # first boot hands to its own user before it starts (see below).
    [[ $EXISTING -eq 1 ]] && info "If that stops with \"container zekktris-api is unhealthy\", the api is still handing its uploads folder over (once): wait until $COMPOSE ps shows it healthy, then run $COMPOSE up -d again (docs/SELF-HOSTING.md §9)."
    [[ -n "$ADMIN_EMAIL" ]] && info "Then create the admin: $COMPOSE exec -w /app/apps/api api node --import tsx/esm scripts/create-admin.ts --email $ADMIN_EMAIL$([[ $EXISTING -eq 0 ]] && echo ' --create-only')"
    exit 0
fi

# The api first, the rest once it is healthy: on an existing install whose
# uploads root still owns, the api hands them to its own user before it starts,
# which can outlast the proxy's wait for it (scripts/lib/start-stack.sh).
[[ -r scripts/lib/start-stack.sh ]] || fail "scripts/lib/start-stack.sh is missing — is this the Zekktris folder?"
# shellcheck source=scripts/lib/start-stack.sh
. scripts/lib/start-stack.sh

step "Building and starting Zekktris"
info "The first build takes several minutes."
$COMPOSE build
$COMPOSE up -d api || fail "Couldn't start the server. Fix the problem above, then run ./install.sh again."

step "Waiting for the server to come up"
if ! wait_for_api 180 "The server is handing its uploads folder to its unprivileged user (once) — waiting for that, up to an hour."; then
    warn "The server didn't report healthy within 3 minutes. Its last log lines:"
    $COMPOSE logs --tail=60 api || true
    fail "Fix the problem above, then run ./install.sh again."
fi
$COMPOSE up -d || fail "The server is running, but the rest of Zekktris didn't start. Fix the problem above, then run: $COMPOSE up -d"
ok "Server is running"
# This code now runs healthy, which finishes any update.sh run that stopped
# halfway; left marked, its next run would roll back past it on a failure.
if GITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)"; then rm -f "$GITDIR/zekktris-update-unfinished"; fi
admin_account_create

HTTPS_OK=0
if [[ "$MODE" == "ip" || "$MODE" == "domain" ]]; then
    step "Getting the HTTPS certificate"
    host="${URL#https://}"
    info "Let's Encrypt checks it can reach $host on port 80/443 from the internet…"
    deadline=$(( $(date +%s) + 240 ))
    while [[ $(date +%s) -lt $deadline ]]; do
        # Connect locally but verify the real certificate for the real name —
        # works even on routers that can't loop back to their own public IP.
        if curl -fsS --max-time 8 --connect-to "$host:443:127.0.0.1:443" "https://$host/health" >/dev/null 2>&1; then
            HTTPS_OK=1; break
        fi
        sleep 5
    done
    if [[ $HTTPS_OK -eq 1 ]]; then
        ok "HTTPS is working — Let's Encrypt reached this server from the internet"
    else
        warn "No certificate yet. What Caddy reported:"
        $DOCKER logs zekktris-proxy 2>&1 | grep -iE 'could not get certificate|challenge|obtain|error' | tail -5 | sed 's/^/      /' || true
        warn "Usually this means port 80/443 isn't forwarded to ${LAN_IP:-this machine} yet,"
        warn "or the ISP blocks incoming port 80. Caddy keeps retrying on its own —"
        warn "fix the forwarding and it will pick it up within a few minutes."
    fi
fi

# ── 11. Done ────────────────────────────────────────────────────────────────
echo
echo "${BOLD}${GREEN}Zekktris is running.${RESET}"
echo
echo "  Open:              ${BOLD}${URL}${RESET}"
if [[ $ADMIN_CREATED -eq 1 ]]; then
    echo "  Sign in:           ${BOLD}${ADMIN_EMAIL}${RESET} with the password you chose — it's the admin."
elif [[ $ADMIN_PROMOTED -eq 1 ]]; then
    echo "  Admin:             ${BOLD}${ADMIN_EMAIL}${RESET} (an existing account — sign in with its own password)."
elif [[ $ADMIN_MISSING -eq 1 ]]; then
    echo "  ${YELLOW}No admin account yet.${RESET} Run ./install.sh again in a terminal to create one"
    echo "                     (or set ZEKKTRIS_ADMIN_PASSWORD; see --admin-email)."
fi
echo "  In the apps:       on the sign-in screen tap ${BOLD}Server · Change${RESET} and enter ${BOLD}${URL#https://}${RESET}"
case "$MODE" in
    ip)
        echo
        echo "  ${YELLOW}Your address is your public IP.${RESET} If your internet provider changes it,"
        echo "  run ./install.sh --reconfigure --ip to move to the new one (people then"
        echo "  re-enter the address). A free dynamic-DNS name (e.g. duckdns.org) avoids that." ;;
    lan)
        echo
        echo "  ${YELLOW}Home network only.${RESET} Phones and the desktop app work; voice/video in a"
        echo "  web browser needs HTTPS, so use the apps for calls (or move to --ip/--domain)." ;;
esac
echo
echo "  Voice & video need UDP 7882 and TCP 7881 reachable as well as the web ports."
echo "  Update later:      ./scripts/update.sh"
echo "  Check health:      ./scripts/doctor.sh"
echo "  Logs:              $COMPOSE logs -f"
echo "  Your data:         $DATA_DIR  (back up its db and uploads folders)"
echo
echo "${DIM}Phone notifications: Zekktris's official iOS/Android apps receive push"
echo "notifications only from servers that hold the app's push keys. Everything"
echo "else works on your server; browsers get notifications through web push.${RESET}"
