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

KNOWN_TESTED_VERSIONS=("2.1.89")

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

is_version_known_tested() {
    local version="$1"
    for v in "${KNOWN_TESTED_VERSIONS[@]}"; do
        [ "$version" == "$v" ] && return 0
    done
    return 1
}

is_patched() {
    local cli_js="$1"
    [ -f "$cli_js" ] && grep -q "QODER-CLAUDE-BRIDGE PATCH END" "$cli_js" 2>/dev/null
}

get_global_node_modules_root() {
    local claude_path="$1"
    local package_root
    package_root=$(cd "$(dirname "$claude_path")" && pwd)
    cd "$package_root/../.." && pwd
}

ensure_bridge_runtime_link() {
    local claude_path="$1"
    local node_modules_root
    node_modules_root=$(get_global_node_modules_root "$claude_path")
    local link_path="$node_modules_root/qoder-claude-bridge"

    mkdir -p "$node_modules_root"

    if [ -L "$link_path" ]; then
        local current_target
        current_target=$(readlink -f "$link_path" 2>/dev/null || true)
        local desired_target
        desired_target=$(readlink -f "$BRIDGE_DIR" 2>/dev/null || printf '%s' "$BRIDGE_DIR")
        if [ "$current_target" = "$desired_target" ]; then
            log_info "Bridge runtime link already exists: $link_path"
            return 0
        fi
        rm "$link_path"
    elif [ -e "$link_path" ]; then
        log_error "Cannot create runtime link: $link_path already exists and is not a symlink"
        return 1
    fi

    ln -s "$BRIDGE_DIR" "$link_path"
    log_info "Created bridge runtime link: $link_path -> $BRIDGE_DIR"
}

verify_bridge_runtime_import() {
    local claude_path="$1"
    local package_root
    package_root=$(cd "$(dirname "$claude_path")" && pwd)
    (
        cd "$package_root"
        node --input-type=module -e "import('qoder-claude-bridge').then((mod) => { if (typeof mod.acpCallModel !== 'function') throw new Error('acpCallModel export missing'); console.log('bridge import ok'); }).catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); })"
    )
}

remove_bridge_runtime_link_if_owned() {
    local claude_path="$1"
    local node_modules_root
    node_modules_root=$(get_global_node_modules_root "$claude_path")
    local link_path="$node_modules_root/qoder-claude-bridge"
    if [ -L "$link_path" ]; then
        local current_target
        current_target=$(readlink -f "$link_path" 2>/dev/null || true)
        local desired_target
        desired_target=$(readlink -f "$BRIDGE_DIR" 2>/dev/null || printf '%s' "$BRIDGE_DIR")
        if [ "$current_target" = "$desired_target" ]; then
            rm "$link_path"
            log_info "Removed bridge runtime link: $link_path"
        fi
    fi
}

get_backup_path() {
    echo "$BACKUP_DIR/claude-code-${1}-cli.js.backup"
}

ensure_cq_alias() {
    local alias_line="alias cq='QODER_NO_AUTH=1 claude'"
    local rc_file

    for rc_file in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [ -f "$rc_file" ] && grep -Fqx "$alias_line" "$rc_file" 2>/dev/null; then
            log_info "cq alias already present in $rc_file"
            continue
        fi

        if [ ! -f "$rc_file" ]; then
            touch "$rc_file"
        fi

        printf "\n%s\n" "$alias_line" >> "$rc_file"
        log_info "Added cq alias to $rc_file"
    done
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

run_probe() {
    local cli_js="$1"
    (
        cd "$BRIDGE_DIR"
        CLAUDE_CODE_BUNDLE="$cli_js" node dist/patch/apply.js --check-only
    )
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

    setup_bridge

    if [ "$version" != "unknown" ]; then
        if is_version_known_tested "$version"; then
            log_success "Version $version is known-tested"
        else
            log_warn "Version $version is not in the known-tested list"
            echo "  Known tested: ${KNOWN_TESTED_VERSIONS[*]}"
        fi
    fi

    echo ""
    echo "Compatibility probe:"
    if probe_output=$(run_probe "$claude_path" 2>&1); then
        echo "$probe_output"
    else
        echo "$probe_output"
        log_error "Bundle is not compatible with the current patcher"
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

    if verify_output=$(verify_bridge_runtime_import "$claude_path" 2>&1); then
        log_success "Runtime import check passed"
        echo "$verify_output"
    else
        log_warn "Runtime import check failed"
        echo "$verify_output"
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
        echo "Install it with: npm install -g @anthropic-ai/claude-code"
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

    if is_version_known_tested "$version"; then
        log_success "Version $version is known-tested"
    else
        log_warn "Version $version is not in the known-tested list"
        echo "  Known tested: ${KNOWN_TESTED_VERSIONS[*]}"
    fi

    setup_bridge

    echo ""
    log_info "Running compatibility probe..."
    if probe_output=$(run_probe "$claude_path" 2>&1); then
        echo "$probe_output"
    else
        echo "$probe_output"
        if [ "$FORCE_MODE" = true ]; then
            echo ""
            log_warn "Compatibility probe FAILED — continuing (force mode)"
            echo -e "${RED}  ⚠️  Patch may still fail. Run ./install.sh --restore to recover.${NC}"
        else
            echo ""
            log_error "Bundle is not compatible with the current patcher"
            echo "Use --force to bypass the compatibility probe (risky)."
            exit 1
        fi
    fi

    # Already patched?
    if is_patched "$claude_path"; then
        log_warn "Bridge patch is already installed"
        read -r -p "Reinstall? (y/N) " reply
        [[ "$reply" =~ ^[Yy]$ ]] || { log_info "Cancelled"; exit 0; }
    fi

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

    log_info "Ensuring bridge runtime package is resolvable..."
    ensure_bridge_runtime_link "$claude_path"

    log_info "Verifying bridge runtime import..."
    verify_bridge_runtime_import "$claude_path"

    log_info "Ensuring cq alias exists in shell startup files..."
    ensure_cq_alias

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
    echo "  alias cq='QODER_NO_AUTH=1 claude'"
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

    setup_bridge

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

    remove_bridge_runtime_link_if_owned "$claude_path"
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
        echo "  --force, -f  Bypass compatibility checks (risky)"
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
