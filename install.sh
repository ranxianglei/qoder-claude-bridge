#!/bin/bash
#
# Qoder-Claude-Bridge Installer
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/ranxianglei/qoder-claude-bridge/master/install.sh | bash
#
# Or with options (must download first):
#   curl -fsSL https://raw.githubusercontent.com/ranxianglei/qoder-claude-bridge/master/install.sh -o install.sh
#   chmod +x install.sh
#   ./install.sh --restore
#
# Local usage (if you cloned the repo):
#   ./install.sh [--force] [--status] [--restore] [--uninstall]
#

set -e

# =============================================================================
# Configuration
# =============================================================================

REPO="ranxianglei/qoder-claude-bridge"
BRANCH="master"
REPO_URL="https://github.com/${REPO}.git"

# Supported Claude Code versions
SUPPORTED_VERSIONS=("2.1.89")

FORCE_MODE=false
BACKUP_DIR="$HOME/.qoder-bridge-backups"
INSTALL_DIR="$HOME/.qoder-claude-bridge"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# =============================================================================
# Helper Functions
# =============================================================================

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

get_claude_path() {
    local claude_bin
    claude_bin=$(which claude 2>/dev/null || true)
    [ -z "$claude_bin" ] && return 1

    local real_path
    real_path=$(readlink -f "$claude_bin" 2>/dev/null || echo "$claude_bin")

    if [[ "$real_path" == *"cli.js"* ]]; then
        echo "$real_path"
    else
        local dir
        dir=$(dirname "$real_path")
        if [ -f "$dir/../cli.js" ]; then
            echo "$(cd "$dir/.." && pwd)/cli.js"
        elif [ -f "$dir/cli.js" ]; then
            echo "$dir/cli.js"
        else
            return 1
        fi
    fi
}

get_claude_version() {
    local claude_bin
    claude_bin=$(which claude 2>/dev/null || true)
    [ -z "$claude_bin" ] && return 1

    local version
    version=$("$claude_bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    [ -z "$version" ] && return 1
    echo "$version"
}

is_version_supported() {
    local version="$1"
    for v in "${SUPPORTED_VERSIONS[@]}"; do
        [ "$version" == "$v" ] && return 0
    done
    return 1
}

check_patterns() {
    local cli_js="$1"
    local content
    content=$(cat "$cli_js" 2>/dev/null)

    local found=0 total=5

    echo "Checking patch patterns..."

    grep -q 'async function erY(){try{let q=m7()' <<< "$content" \
        && { echo "  ✓ erY connectivity check"; ((found++)); } \
        || echo "  ✗ erY connectivity check (NOT FOUND)"

    grep -q 'function PJ(){if(D9())return!1' <<< "$content" \
        && { echo "  ✓ PJ function"; ((found++)); } \
        || echo "  ✗ PJ function (NOT FOUND)"

    grep -q '3rd-party platform' <<< "$content" \
        && { echo "  ✓ login options"; ((found++)); } \
        || echo "  ✗ login options (NOT FOUND)"

    grep -q 'onChange:(y)=>{if(y==="platform")' <<< "$content" \
        && { echo "  ✓ login onChange"; ((found++)); } \
        || echo "  ✗ login onChange (NOT FOUND)"

    grep -q 'function MDK(){return{callModel:' <<< "$content" \
        && { echo "  ✓ productionDeps"; ((found++)); } \
        || echo "  ✗ productionDeps (NOT FOUND)"

    echo ""
    echo "Patterns matched: $found/$total"
    [ "$found" -ge "$total" ]
}

is_patched() {
    local cli_js="$1"
    [ -f "$cli_js" ] && grep -q "QODER-CLAUDE-BRIDGE PATCH END" "$cli_js" 2>/dev/null
}

get_backup_path() {
    echo "$BACKUP_DIR/claude-code-${1}-cli.js.backup"
}

# =============================================================================
# Setup: clone & build bridge if needed
# =============================================================================

setup_bridge() {
    # If running from inside the repo (local dev), use current dir
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

    if [ -n "$script_dir" ] && [ -f "$script_dir/package.json" ] && [ -f "$script_dir/src/patch/apply.ts" ]; then
        BRIDGE_DIR="$script_dir"
        log_info "Using local repo: $BRIDGE_DIR"
    else
        # Running via curl pipe or bridge not built — clone to INSTALL_DIR
        BRIDGE_DIR="$INSTALL_DIR"

        if [ -d "$BRIDGE_DIR/.git" ]; then
            log_info "Updating existing installation at $BRIDGE_DIR ..."
            git -C "$BRIDGE_DIR" pull --ff-only origin "$BRANCH" 2>/dev/null || {
                log_warn "Could not pull latest, using existing version"
            }
        else
            log_info "Cloning qoder-claude-bridge into $BRIDGE_DIR ..."
            git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$BRIDGE_DIR"
        fi
    fi

    # Build if dist/ is missing or stale
    if [ ! -f "$BRIDGE_DIR/dist/patch/apply.js" ]; then
        log_info "Building bridge package..."
        cd "$BRIDGE_DIR"
        npm install --silent
        npm run build --silent
        log_success "Build complete"
    else
        log_info "Bridge already built, skipping build"
    fi
}

# =============================================================================
# Commands
# =============================================================================

cmd_status() {
    echo ""
    echo "========================================"
    echo "  Qoder-Claude-Bridge Status"
    echo "========================================"
    echo ""

    local claude_path
    claude_path=$(get_claude_path) || { log_error "Claude Code is not installed"; exit 1; }

    local version
    version=$(get_claude_version) || version="unknown"

    echo "Claude Code path:    $claude_path"
    echo "Claude Code version: $version"
    echo ""

    if [ "$version" != "unknown" ]; then
        if is_version_supported "$version"; then
            log_success "Version $version is supported"
        else
            log_warn "Version $version is NOT tested/supported"
            echo "  Supported: ${SUPPORTED_VERSIONS[*]}"
        fi
    fi

    if is_patched "$claude_path"; then
        log_success "Bridge patch is INSTALLED"
    else
        log_info "Bridge patch is NOT installed"
    fi

    local backup_path
    backup_path=$(get_backup_path "$version")
    if [ -f "$backup_path" ]; then
        log_success "Backup exists: $backup_path"
    else
        log_info "No backup found for version $version"
    fi

    echo ""
}

cmd_install() {
    echo ""
    echo "========================================"
    echo "  Installing Qoder-Claude-Bridge"
    echo "========================================"

    if [ "$FORCE_MODE" = true ]; then
        echo ""
        echo -e "${RED}  ⚠️  FORCE MODE — all checks bypassed${NC}"
        echo -e "${RED}  Patch may fail or corrupt Claude Code.${NC}"
    fi
    echo ""

    # Check prerequisites
    for cmd in git node npm; do
        if ! command -v "$cmd" &>/dev/null; then
            log_error "Required command not found: $cmd"
            exit 1
        fi
    done

    local claude_path
    claude_path=$(get_claude_path) || {
        log_error "Claude Code is not installed"
        echo "Install it with: npm install -g @anthropic-ai/claude-code@2.1.89"
        exit 1
    }

    local version
    version=$(get_claude_version) || {
        log_error "Could not detect Claude Code version"
        exit 1
    }

    echo "Claude Code version: $version"
    echo "Claude Code path:    $claude_path"
    echo ""

    # Version check
    if ! is_version_supported "$version"; then
        if [ "$FORCE_MODE" = true ]; then
            log_warn "Unsupported version $version — skipped (force mode)"
        else
            log_warn "Version $version is NOT tested/supported!"
            echo "  Supported: ${SUPPORTED_VERSIONS[*]}"
            echo ""
            echo "  Use --force to install anyway (risky)"
            echo ""
            read -r -p "Continue anyway? (y/N) " reply
            [[ "$reply" =~ ^[Yy]$ ]] || { log_info "Cancelled"; exit 0; }
        fi
    fi

    # Pattern check
    echo ""
    if ! check_patterns "$claude_path"; then
        if [ "$FORCE_MODE" = true ]; then
            echo ""
            log_warn "Pattern check FAILED — continuing (force mode)"
            echo -e "${RED}  ⚠️  Patch will likely fail or corrupt the bundle.${NC}"
            echo -e "${RED}  Run ./install.sh --restore to recover.${NC}"
        else
            log_error "Patch patterns don't match this Claude Code version!"
            echo ""
            echo "Options:"
            echo "  1. Wait for a bridge update for version $version"
            echo "  2. Force install: curl ... | bash -s -- --force"
            exit 1
        fi
    else
        log_success "All patch patterns matched"
    fi

    # Already patched?
    if is_patched "$claude_path"; then
        log_warn "Bridge patch is already installed"
        read -r -p "Reinstall? (y/N) " reply
        [[ "$reply" =~ ^[Yy]$ ]] || { log_info "Cancelled"; exit 0; }
    fi

    # Clone/build bridge
    setup_bridge

    # Create backup
    mkdir -p "$BACKUP_DIR"
    local backup_path
    backup_path=$(get_backup_path "$version")
    if [ ! -f "$backup_path" ]; then
        log_info "Creating backup: $backup_path"
        cp "$claude_path" "$backup_path"
    else
        log_info "Backup already exists: $backup_path"
    fi

    local in_place_bak="${claude_path}.qoder-bridge.bak"
    [ -f "$in_place_bak" ] || cp "$claude_path" "$in_place_bak"

    # Apply patch
    log_info "Applying bridge patch..."
    cd "$BRIDGE_DIR"
    node dist/patch/apply.js

    echo ""
    log_success "Installation complete!"
    echo ""
    echo "========================================"
    echo "  Usage"
    echo "========================================"
    echo ""
    echo "Option 1 - Skip login (recommended):"
    echo "  QODER_NO_AUTH=1 claude"
    echo ""
    echo "Option 2 - Add alias to ~/.bashrc or ~/.zshrc:"
    echo "  alias claude='QODER_NO_AUTH=1 claude'"
    echo ""
    echo "Option 3 - Non-interactive mode:"
    echo "  claude -p 'your prompt'"
    echo ""
    echo "To restore original Claude Code:"
    echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh | bash -s -- --restore"
    echo ""
}

cmd_restore() {
    echo ""
    echo "========================================"
    echo "  Restoring Claude Code"
    echo "========================================"
    echo ""

    local claude_path
    claude_path=$(get_claude_path) || { log_error "Claude Code is not installed"; exit 1; }

    local version
    version=$(get_claude_version 2>/dev/null || echo "")

    local backup_path=""
    [ -n "$version" ] && backup_path=$(get_backup_path "$version")

    local in_place_bak="${claude_path}.qoder-bridge.bak"

    if [ -n "$backup_path" ] && [ -f "$backup_path" ]; then
        log_info "Restoring from: $backup_path"
        cp "$backup_path" "$claude_path"
        log_success "Claude Code restored"
    elif [ -f "$in_place_bak" ]; then
        log_info "Restoring from: $in_place_bak"
        cp "$in_place_bak" "$claude_path"
        log_success "Claude Code restored"
    else
        log_error "No backup found"
        echo "Reinstall Claude Code: npm install -g @anthropic-ai/claude-code@$version"
        exit 1
    fi
    echo ""
}

cmd_uninstall() {
    echo ""
    echo "========================================"
    echo "  Uninstalling Qoder-Claude-Bridge"
    echo "========================================"
    echo ""

    local claude_path
    claude_path=$(get_claude_path) || { log_error "Claude Code is not installed"; exit 1; }

    if ! is_patched "$claude_path"; then
        log_info "Bridge patch is not installed"
        exit 0
    fi

    echo "This will restore original Claude Code."
    echo "Backup files in $BACKUP_DIR will be kept."
    echo ""
    read -r -p "Continue? (y/N) " reply
    [[ "$reply" =~ ^[Yy]$ ]] || { log_info "Cancelled"; exit 0; }

    cmd_restore
}

# =============================================================================
# Argument parsing
# =============================================================================

ACTION="install"
for arg in "$@"; do
    case "$arg" in
        --force|-f)   FORCE_MODE=true ;;
        --status|-s)  ACTION="status" ;;
        --restore|-r) ACTION="restore" ;;
        --uninstall|-u) ACTION="uninstall" ;;
        --help|-h)    ACTION="help" ;;
    esac
done

case "$ACTION" in
    install)   cmd_install ;;
    status)    cmd_status ;;
    restore)   cmd_restore ;;
    uninstall) cmd_uninstall ;;
    help)
        echo "Usage: install.sh [OPTIONS]"
        echo ""
        echo "Options:"
        echo "  (none)       Install bridge patch (clone, build, patch)"
        echo "  --force, -f  Bypass version/pattern checks (risky)"
        echo "  --status     Show installation status"
        echo "  --restore    Restore original Claude Code from backup"
        echo "  --uninstall  Restore and clean up"
        echo "  --help       Show this help"
        echo ""
        echo "One-line install:"
        echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh | bash"
        echo ""
        echo "With options (download first):"
        echo "  curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh -o install.sh"
        echo "  chmod +x install.sh && ./install.sh --restore"
        ;;
esac
