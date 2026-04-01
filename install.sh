#!/bin/bash
#
# Qoder-Claude-Bridge Installer
#
# Usage:
#   ./install.sh              # Install patch
#   ./install.sh --force      # Force install (skip version/pattern checks)
#   ./install.sh --restore    # Restore original Claude Code
#   ./install.sh --status     # Check installation status
#   ./install.sh --uninstall  # Uninstall patch
#

set -e

# =============================================================================
# Configuration
# =============================================================================

# Supported Claude Code versions (add new versions here)
SUPPORTED_VERSIONS=("2.1.89")

# Force mode flag
FORCE_MODE=false

# Backup directory
BACKUP_DIR="$HOME/.qoder-bridge-backups"

# Bridge package location
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

get_claude_path() {
    # Find claude binary
    local claude_bin
    claude_bin=$(which claude 2>/dev/null || true)

    if [ -z "$claude_bin" ]; then
        return 1
    fi

    # Resolve to actual cli.js
    local real_path
    real_path=$(readlink -f "$claude_bin" 2>/dev/null || echo "$claude_bin")

    local cli_js
    if [[ "$real_path" == *"cli.js"* ]]; then
        echo "$real_path"
    else
        # Assume standard npm global install structure
        local dir
        dir=$(dirname "$real_path")
        if [ -f "$dir/../cli.js" ]; then
            echo "$dir/../cli.js"
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

    if [ -z "$claude_bin" ]; then
        return 1
    fi

    # Get version from claude --version
    local version
    version=$("$claude_bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)

    if [ -z "$version" ]; then
        return 1
    fi

    echo "$version"
}

is_version_supported() {
    local version="$1"
    for v in "${SUPPORTED_VERSIONS[@]}"; do
        if [ "$version" == "$v" ]; then
            return 0
        fi
    done
    return 1
}

# Check if patch patterns match the bundle
check_patterns() {
    local cli_js="$1"
    local content
    content=$(cat "$cli_js" 2>/dev/null)

    local patterns_found=0
    local patterns_total=5

    echo "Checking patch patterns..."

    # Pattern 1: erY connectivity check
    if echo "$content" | grep -q 'async function erY(){try{let q=m7()'; then
        echo "  ✓ erY connectivity check pattern"
        ((patterns_found++))
    else
        echo "  ✗ erY connectivity check pattern (NOT FOUND)"
    fi

    # Pattern 2: PJ function
    if echo "$content" | grep -q 'function PJ(){if(D9())return!1'; then
        echo "  ✓ PJ function pattern"
        ((patterns_found++))
    else
        echo "  ✗ PJ function pattern (NOT FOUND)"
    fi

    # Pattern 3: login options
    if echo "$content" | grep -q '3rd-party platform'; then
        echo "  ✓ login options pattern"
        ((patterns_found++))
    else
        echo "  ✗ login options pattern (NOT FOUND)"
    fi

    # Pattern 4: login onChange
    if echo "$content" | grep -q 'onChange:(y)=>{if(y==="platform")'; then
        echo "  ✓ login onChange pattern"
        ((patterns_found++))
    else
        echo "  ✗ login onChange pattern (NOT FOUND)"
    fi

    # Pattern 5: productionDeps
    if echo "$content" | grep -q 'function MDK(){return{callModel:'; then
        echo "  ✓ productionDeps pattern"
        ((patterns_found++))
    else
        echo "  ✗ productionDeps pattern (NOT FOUND)"
    fi

    echo ""
    echo "Patterns matched: $patterns_found/$patterns_total"

    if [ "$patterns_found" -lt "$patterns_total" ]; then
        return 1
    fi
    return 0
}

is_patched() {
    local cli_js="$1"
    if [ -f "$cli_js" ]; then
        grep -q "QODER-CLAUDE-BRIDGE PATCH END" "$cli_js" 2>/dev/null
        return $?
    fi
    return 1
}

get_backup_path() {
    local version="$1"
    echo "$BACKUP_DIR/claude-code-${version}-cli.js.backup"
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

    # Check if claude is installed
    local claude_path
    claude_path=$(get_claude_path)

    if [ -z "$claude_path" ]; then
        log_error "Claude Code is not installed"
        echo ""
        echo "Install Claude Code first:"
        echo "  npm install -g @anthropic-ai/claude-code"
        exit 1
    fi

    # Get version
    local version
    version=$(get_claude_version)

    echo "Claude Code path: $claude_path"
    echo "Claude Code version: ${version:-unknown}"
    echo ""

    # Check version support
    if [ -n "$version" ]; then
        if is_version_supported "$version"; then
            log_success "Version $version is supported"
        else
            log_warn "Version $version is NOT tested/supported"
            echo "  Supported versions: ${SUPPORTED_VERSIONS[*]}"
        fi
    fi

    # Check patch status
    if is_patched "$claude_path"; then
        log_success "Bridge patch is INSTALLED"
    else
        log_info "Bridge patch is NOT installed"
    fi

    # Check backup
    if [ -n "$version" ]; then
        local backup_path
        backup_path=$(get_backup_path "$version")
        if [ -f "$backup_path" ]; then
            log_success "Backup exists: $backup_path"
        else
            log_info "No backup found for version $version"
        fi
    fi

    # Check bridge package
    if [ -d "$BRIDGE_DIR/dist" ]; then
        log_success "Bridge package is built"
    else
        log_warn "Bridge package needs to be built (run: npm run build)"
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
        echo -e "${RED}  Backup will still be created.${NC}"
    fi
    echo ""

    # Check if claude is installed
    local claude_path
    claude_path=$(get_claude_path)

    if [ -z "$claude_path" ]; then
        log_error "Claude Code is not installed"
        echo ""
        echo "Install Claude Code first:"
        echo "  npm install -g @anthropic-ai/claude-code"
        exit 1
    fi

    # Get version
    local version
    version=$(get_claude_version)

    if [ -z "$version" ]; then
        log_error "Could not detect Claude Code version"
        exit 1
    fi

    echo "Claude Code version: $version"
    echo "Installation path: $claude_path"
    echo ""

    # Check version support
    if ! is_version_supported "$version"; then
        if [ "$FORCE_MODE" = true ]; then
            log_warn "Version $version is NOT tested/supported — skipped (force mode)"
        else
            log_warn "Version $version is NOT tested/supported!"
            echo "  Supported versions: ${SUPPORTED_VERSIONS[*]}"
            echo ""
            echo "  Use --force to install anyway (may corrupt Claude Code)"
            echo ""
            read -p "Continue anyway? (y/N) " -n 1 -r
            echo ""
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log_info "Installation cancelled"
                exit 0
            fi
        fi
    fi

    # Check patch patterns
    echo ""
    if ! check_patterns "$claude_path"; then
        if [ "$FORCE_MODE" = true ]; then
            echo ""
            log_warn "Pattern check FAILED — continuing anyway (force mode)"
            echo -e "${RED}  ⚠️  WARNING: Patch will likely fail or corrupt the bundle.${NC}"
            echo -e "${RED}  If Claude Code breaks, run: ./install.sh --restore${NC}"
            echo ""
        else
            log_error "Patch patterns do not match this Claude Code version!"
            echo ""
            echo "This usually means Claude Code was updated and this bridge needs updating."
            echo ""
            echo "Options:"
            echo "  1. Wait for a bridge update supporting version $version"
            echo "  2. Force install (risky): ./install.sh --force"
            echo "     ⚠️  May corrupt Claude Code — backup will be created first"
            exit 1
        fi
    else
        log_success "All patch patterns matched"
    fi

    # Check if already patched
    if is_patched "$claude_path"; then
        log_warn "Bridge patch is already installed"
        read -p "Reinstall? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Installation cancelled"
            exit 0
        fi
    fi

    # Check if bridge is built
    if [ ! -d "$BRIDGE_DIR/dist" ]; then
        log_info "Building bridge package..."
        cd "$BRIDGE_DIR"
        npm run build
        if [ $? -ne 0 ]; then
            log_error "Failed to build bridge package"
            exit 1
        fi
    fi

    # Create backup directory
    mkdir -p "$BACKUP_DIR"

    # Create versioned backup
    local backup_path
    backup_path=$(get_backup_path "$version")

    if [ ! -f "$backup_path" ]; then
        log_info "Creating backup: $backup_path"
        cp "$claude_path" "$backup_path"
    else
        log_info "Backup already exists: $backup_path"
    fi

    # Also create .bak file in place (for apply.js)
    local in_place_backup="${claude_path}.qoder-bridge.bak"
    if [ ! -f "$in_place_backup" ]; then
        cp "$claude_path" "$in_place_backup"
    fi

    # Apply patch
    log_info "Applying bridge patch..."

    cd "$BRIDGE_DIR"
    node dist/patch/apply.js

    if [ $? -ne 0 ]; then
        log_error "Failed to apply patch"
        echo ""
        echo "Restoring from backup..."
        cp "$backup_path" "$claude_path"
        exit 1
    fi

    echo ""
    log_success "Installation complete!"
    echo ""
    echo "========================================"
    echo "  Usage"
    echo "========================================"
    echo ""
    echo "Option 1: Skip login (recommended)"
    echo "  $ QODER_NO_AUTH=1 claude"
    echo ""
    echo "Option 2: Add alias to ~/.bashrc"
    echo "  alias claude='QODER_NO_AUTH=1 claude'"
    echo ""
    echo "Option 3: Use -p mode"
    echo "  $ claude -p 'your prompt'"
    echo ""
    echo "To restore original Claude Code:"
    echo "  $ $0 --restore"
    echo ""
}

cmd_restore() {
    echo ""
    echo "========================================"
    echo "  Restoring Claude Code"
    echo "========================================"
    echo ""

    local claude_path
    claude_path=$(get_claude_path)

    if [ -z "$claude_path" ]; then
        log_error "Claude Code is not installed"
        exit 1
    fi

    local version
    version=$(get_claude_version)

    # Try versioned backup first
    local backup_path
    backup_path=$(get_backup_path "$version" 2>/dev/null || echo "")

    # Fallback to in-place backup
    local in_place_backup="${claude_path}.qoder-bridge.bak"

    if [ -n "$backup_path" ] && [ -f "$backup_path" ]; then
        log_info "Restoring from: $backup_path"
        cp "$backup_path" "$claude_path"
        log_success "Claude Code restored successfully"
    elif [ -f "$in_place_backup" ]; then
        log_info "Restoring from: $in_place_backup"
        cp "$in_place_backup" "$claude_path"
        log_success "Claude Code restored successfully"
    else
        log_error "No backup found to restore"
        echo ""
        echo "You may need to reinstall Claude Code:"
        echo "  npm install -g @anthropic-ai/claude-code"
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
    claude_path=$(get_claude_path)

    if [ -z "$claude_path" ]; then
        log_error "Claude Code is not installed"
        exit 1
    fi

    if ! is_patched "$claude_path"; then
        log_info "Bridge patch is not installed"
        exit 0
    fi

    echo "This will:"
    echo "  1. Restore original Claude Code"
    echo "  2. Keep backup files in $BACKUP_DIR"
    echo ""
    read -p "Continue? (y/N) " -n 1 -r
    echo ""

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Uninstall cancelled"
        exit 0
    fi

    cmd_restore
}

# =============================================================================
# Main
# =============================================================================

case "${1:-}" in
    --status|-s)
        cmd_status
        ;;
    --restore|-r)
        cmd_restore
        ;;
    --uninstall|-u)
        cmd_uninstall
        ;;
    --force|-f)
        FORCE_MODE=true
        cmd_install
        ;;
    --help|-h)
        echo "Usage: $0 [COMMAND]"
        echo ""
        echo "Commands:"
        echo "  (none)      Install bridge patch"
        echo "  --force     Force install, bypass version/pattern checks"
        echo "              ⚠️  Use only if you know what you're doing"
        echo "  --status    Check installation status"
        echo "  --restore   Restore original Claude Code"
        echo "  --uninstall Restore original and remove patch"
        echo "  --help      Show this help"
        ;;
    *)
        cmd_install
        ;;
esac
