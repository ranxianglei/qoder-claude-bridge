# Work Log

## 2026-04-01: Installation Script and Documentation

### Added
- `install.sh` - Complete installation script with:
  - Version detection and support check
  - Automatic backup (versioned backups in `~/.qoder-bridge-backups/`)
  - Patch installation
  - Restore functionality
  - Status command
  - Uninstall command
- `README.md` - User documentation with:
  - Quick start guide
  - Installation instructions
  - Usage methods
  - Troubleshooting section
  - Development guide

### Script Commands
```bash
./install.sh           # Install patch
./install.sh --status  # Check status
./install.sh --restore # Restore original
./install.sh --uninstall # Uninstall
```

### Supported Versions
- 2.1.89 ✅

## 2026-04-01: Interactive TUI Login Skip Issue

### Problem
When running `claude` interactively without `QODER_NO_AUTH` env var, the login screen
is not displayed even with a fresh config (no `~/.claude.json`). The TUI goes directly
to theme selection instead of showing the 5 login options (including Qoder options).

### What Works
- `QODER_NO_AUTH=1 claude` correctly skips login and goes directly to theme selection
- `-p` mode works correctly, routing AI calls to Qoder

### Investigation Findings

1. **PJ() Function**: Returns `true` (needs oauth) in simulated tests, but TUI still
   skips login. The function logic appears correct:
   - `QODER_NO_AUTH` check is first: `if(process.env.QODER_NO_AUTH)return!1`
   - Other checks (D9, ANTHROPIC_UNIX_SOCKET, etc.) follow

2. **_oY Component**: Uses `useState(()=>PJ())` to capture `PJ()` result at mount time.
   The result `$` controls whether `preflight` and `oauth` steps are added.

3. **l65 SkippableStep**: Has `skip` prop that can hide children. The `skip` state `z`
   is initialized to `false` and set to `true` via `onSkip` callback.

4. **Pj6 Component**: Has a `useEffect` that triggers OAuth flow when state is
   `"ready_to_start"`. The `onChange` handler sets this state when selecting
   login options.

### Root Cause (Hypothesis)
The issue may be related to:
- React state initialization timing in the minified bundle
- Some caching mechanism in Claude Code that we haven't identified
- Bundle corruption during patching (fixed by using `escapeReplacement()` for `$` chars)

### Temporary Workaround
Use `QODER_NO_AUTH=1 claude` to skip login entirely.

### Next Steps
1. Add runtime debug output to PJ() function (must escape `\n` properly)
2. Check if there's a cached state affecting onboarding
3. Investigate if the backup/restore mechanism is interfering

### Code Changes Made
- Fixed `$` replacement bug in patching (use `$$` to escape `$` in `replace()`)
- Applied all patches correctly with `escapeReplacement()` helper
- Verified bundle integrity with `node --check`

### Patch Status
- erY() connectivity check: Patched ✓
- PJ() QODER_NO_AUTH check: Patched ✓
- Login options (qoder_auth, qoder_noauth): Patched ✓
- Login onChange handler (execFileSync re-exec): Patched ✓
- productionDeps callModel wrapper: Patched ✓
