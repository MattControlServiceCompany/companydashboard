#!/bin/bash
# =============================================================================
# setup-hooks.sh — Install git hooks for CompanyHub
# Run this once after cloning the repo: bash setup-hooks.sh
# =============================================================================

HOOK_DIR=".git/hooks"

if [ ! -d "$HOOK_DIR" ]; then
    echo "ERROR: Not in a git repository. Run this from the repo root."
    exit 1
fi

echo "Installing pre-commit hook..."

cat > "$HOOK_DIR/pre-commit" << 'HOOKEOF'
#!/bin/bash
# =============================================================================
# PRE-COMMIT HOOK — PII & Secrets Scanner
# Blocks commits that contain personal data, credentials, or sensitive patterns.
# This is the hard gate — nothing gets through if this fires.
# =============================================================================

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
BOLD='\033[1m'

FOUND=0

# Get list of staged files (only added/modified, not deleted)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)

if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

echo ""
echo -e "${BOLD}Running PII & Secrets scan...${NC}"

# --- CHECK 1: Phone number patterns ---
PHONE_PATTERN='\([0-9]{3}\)\s*[0-9]{3}[-.][0-9]{4}|[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}'

for file in $STAGED_FILES; do
    if [[ "$file" =~ \.(html|js|css|json|md|txt|yaml|yml)$ ]]; then
        MATCHES=$(git diff --cached -- "$file" | grep '^+' | grep -v '^+++' | grep -oP "$PHONE_PATTERN" 2>/dev/null)
        if [ -n "$MATCHES" ]; then
            echo -e "${RED}BLOCKED${NC} Phone number found in ${BOLD}$file${NC}:"
            echo "$MATCHES" | head -5
            FOUND=1
        fi
    fi
done

# --- CHECK 2: Email addresses (excluding safe/generic ones) ---
EMAIL_PATTERN='[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.(com|org|edu|net|gov|io|co)'
SAFE_EMAILS='example\.com|placeholder|noreply@|test@test|demo@|anthropic\.com|github\.com'

for file in $STAGED_FILES; do
    if [[ "$file" =~ \.(html|js|css|json|md|txt|yaml|yml)$ ]]; then
        MATCHES=$(git diff --cached -- "$file" | grep '^+' | grep -v '^+++' | grep -oiP "$EMAIL_PATTERN" | grep -viP "$SAFE_EMAILS" 2>/dev/null)
        if [ -n "$MATCHES" ]; then
            echo -e "${RED}BLOCKED${NC} Email address found in ${BOLD}$file${NC}:"
            echo "$MATCHES" | head -5
            FOUND=1
        fi
    fi
done

# --- CHECK 3: API keys and secrets patterns ---
SECRET_PATTERNS=(
    'sk-[a-zA-Z0-9]{20,}'
    'sk-ant-[a-zA-Z0-9-]{20,}'
    'AKIA[0-9A-Z]{16}'
    'ghp_[a-zA-Z0-9]{36}'
    'gho_[a-zA-Z0-9]{36}'
    'xox[bpas]-[a-zA-Z0-9-]+'
    'api[_-]?key\s*[:=]\s*["\x27][a-zA-Z0-9]'
    'password\s*[:=]\s*["\x27][^\s]'
    'secret\s*[:=]\s*["\x27][a-zA-Z0-9]'
    'token\s*[:=]\s*["\x27][a-zA-Z0-9]'
    'Bearer\s+[a-zA-Z0-9._-]{20,}'
)

for file in $STAGED_FILES; do
    if [[ "$file" =~ \.(html|js|css|json|md|txt|yaml|yml|env)$ ]]; then
        DIFF=$(git diff --cached -- "$file" | grep '^+' | grep -v '^+++')
        for pattern in "${SECRET_PATTERNS[@]}"; do
            MATCHES=$(echo "$DIFF" | grep -oP "$pattern" 2>/dev/null)
            if [ -n "$MATCHES" ]; then
                echo -e "${RED}BLOCKED${NC} Secret/credential pattern found in ${BOLD}$file${NC}:"
                echo "$MATCHES" | head -3
                FOUND=1
            fi
        done
    fi
done

# --- CHECK 4: Known company/client name blocklist ---
BLOCKLIST_NAMES=(
    'controlservice\.com'
    'adventhealth'
    'isdschools'
    'kcpublicschools'
    'pembrokehill'
    'nixaschools'
    'downstreamcasino'
    'copaken-brooks'
    'younglife\.org'
    'evangel\.edu'
    'kindredbio'
    'loewshotels'
    'crawfordcountykansas'
)

for file in $STAGED_FILES; do
    if [[ "$file" =~ \.(html|js|css|json|md|txt|yaml|yml)$ ]]; then
        # Filter out lines with safe demo/placeholder patterns before checking blocklist
        DIFF=$(git diff --cached -- "$file" | grep '^+' | grep -v '^+++' | grep -viP 'demo@|Demo User|placeholder|example\.com|REDACTED' 2>/dev/null)
        for name in "${BLOCKLIST_NAMES[@]}"; do
            MATCHES=$(echo "$DIFF" | grep -oiP "$name" 2>/dev/null)
            if [ -n "$MATCHES" ]; then
                echo -e "${RED}BLOCKED${NC} Client/company data found in ${BOLD}$file${NC}: $name"
                FOUND=1
            fi
        done
    fi
done

# --- CHECK 5: Files that should never be committed ---
BANNED_FILES='\.env|credentials\.json|\.pem$|\.key$|\.pfx$|id_rsa|id_ed25519|client_secret|service-account|CLAUDE\.md|GEMINI\.md|AGENTS\.md|\.cursorrules'

for file in $STAGED_FILES; do
    if echo "$file" | grep -qiP "$BANNED_FILES"; then
        echo -e "${RED}BLOCKED${NC} Banned file type: ${BOLD}$file${NC}"
        FOUND=1
    fi
done

# --- RESULT ---
if [ $FOUND -ne 0 ]; then
    echo ""
    echo -e "${RED}${BOLD}COMMIT BLOCKED${NC}"
    echo -e "PII, credentials, or sensitive data detected in staged files."
    echo -e "Fix the issues above, then try again."
    echo -e ""
    echo -e "${YELLOW}To bypass in an emergency (NOT recommended):${NC}"
    echo -e "  git commit --no-verify"
    echo ""
    exit 1
fi

# --- (CHECK 6 removed 2026-06-12) Version stamping is now handled by scripts/stamp-version.py ---
# The stamp script runs once per deploy before git staging and updates all ?v= tags atomically.
# Per-commit version bumping is no longer required.

echo -e "PII & Secrets scan: ${BOLD}PASSED${NC}"

# --- CHECK 7: What's New (RELEASE_NOTES) wording gate ---
# RELEASE_NOTES entries force-pop a modal in front of every user on their next
# visit. Only run this when app/site-functions.js is staged AND its diff
# actually touches the RELEASE_NOTES array, so unrelated commits are never
# slowed down or blocked by it. See scripts/check_release_notes.py for the
# full rule set and the documented gateOverride escape hatch.
if echo "$STAGED_FILES" | grep -qx 'app/site-functions.js'; then
    RN_DIFF_TOUCHED=$(git diff --cached -- app/site-functions.js | grep -c 'RELEASE_NOTES')
    if [ "$RN_DIFF_TOUCHED" -gt 0 ]; then
        echo ""
        echo -e "${BOLD}Checking RELEASE_NOTES wording...${NC}"
        if command -v python3 >/dev/null 2>&1; then
            PYBIN=python3
        else
            PYBIN=python
        fi
        "$PYBIN" scripts/check_release_notes.py
        RN_EXIT=$?
        if [ $RN_EXIT -ne 0 ]; then
            echo ""
            echo -e "${RED}${BOLD}COMMIT BLOCKED${NC}"
            echo -e "The newest RELEASE_NOTES entry in app/site-functions.js contains developer"
            echo -e "language (see above). Rewrite it in plain, user-facing terms, delete it if"
            echo -e "it describes a purely internal change, or add gateOverride: true +"
            echo -e "gateOverrideReason: '...' to the entry for the rare legitimate exception."
            echo -e ""
            echo -e "${YELLOW}To bypass in an emergency (NOT recommended):${NC}"
            echo -e "  git commit --no-verify"
            echo ""
            exit 1
        fi
    fi
fi

exit 0
HOOKEOF

chmod +x "$HOOK_DIR/pre-commit"
echo "Pre-commit hook installed successfully."
echo ""
echo "The hook scans every commit for:"
echo "  - Phone numbers"
echo "  - Email addresses (non-placeholder)"
echo "  - API keys, tokens, passwords"
echo "  - Client/company names from blocklist"
echo "  - Banned file types (.env, credentials, CLAUDE.md, etc.)"
echo ""
echo "Commits with PII or secrets will be blocked automatically."
