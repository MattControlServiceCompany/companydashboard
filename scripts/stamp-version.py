#!/usr/bin/env python3
"""
stamp-version.py — Deploy-time version stamper for CompanyHub.

Fetches the live CH_VERSION from GitHub Pages, computes the next
integer patch number, rewrites site-ui.js CH_VERSION, and rewrites
ALL ?v= tags in all four HTML files to the new integer.

Usage:
    python scripts/stamp-version.py
    python scripts/stamp-version.py --force-version 524   # offline fallback

Exit 0 on success. Exit 1 with details on any failure.
"""

import argparse
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
LIVE_SITE_UI_URL = (
    "https://MattControlServiceCompany.github.io/companydashboard/site-ui.js"
)
SITE_UI_JS = REPO_ROOT / "site-ui.js"
HTML_FILES = [
    REPO_ROOT / "energy-department.html",
    REPO_ROOT / "index.html",
    REPO_ROOT / "service-department.html",
    REPO_ROOT / "ems-leads.html",
]

# Matches both ?v=NNN and ?v=YYYY.MM.DD.NNN (the core.js anomaly)
VQ_PATTERN = re.compile(
    r"(\?v=)(?:\d{4}\.\d{2}\.\d{2}\.)?(\d+)"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def fetch_live_patch() -> int:
    """Fetch the live site-ui.js from GitHub Pages and parse CH_VERSION."""
    try:
        with urllib.request.urlopen(LIVE_SITE_UI_URL, timeout=10) as resp:
            content = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:
        print(
            f"ERROR: Could not fetch live site-ui.js from GitHub Pages.\n"
            f"  URL: {LIVE_SITE_UI_URL}\n"
            f"  Reason: {exc}\n"
            f"\n"
            f"If you are offline or GitHub Pages is down, use:\n"
            f"  python scripts/stamp-version.py --force-version <patch_number>\n"
            f"\n"
            f"IMPORTANT: --force-version must be (current live patch) + 1.\n"
            f"Check the live site for the current version before using this flag.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Parse: var CH_VERSION = 'v2026.06.11.520';
    m = re.search(r"CH_VERSION\s*=\s*['\"]v[\d.]+\.(\d+)['\"]", content)
    if not m:
        print(
            f"ERROR: Could not parse CH_VERSION from live site-ui.js.\n"
            f"  Fetched content (first 200 chars): {content[:200]!r}",
            file=sys.stderr,
        )
        sys.exit(1)

    return int(m.group(1))


def build_version_string(patch: int) -> str:
    today = date.today()
    return f"v{today.year}.{today.month:02d}.{today.day:02d}.{patch}"


def rewrite_site_ui(new_version: str) -> None:
    """Rewrite CH_VERSION line in site-ui.js."""
    if not SITE_UI_JS.exists():
        print(f"ERROR: {SITE_UI_JS} not found.", file=sys.stderr)
        sys.exit(1)

    text = SITE_UI_JS.read_text(encoding="utf-8")
    new_text = re.sub(
        r"(var CH_VERSION\s*=\s*['\"])v[\d.]+(['\"])",
        rf"\g<1>{new_version}\g<2>",
        text,
    )
    if new_text == text:
        print(
            f"WARNING: CH_VERSION line in site-ui.js did not change. "
            f"Expected to find pattern: var CH_VERSION = 'v...'",
            file=sys.stderr,
        )
    SITE_UI_JS.write_text(new_text, encoding="utf-8")


def rewrite_html_tags(new_patch: int) -> dict:
    """Rewrite all ?v= tags in all HTML files to new_patch integer.

    Returns a dict of {filename: count_replaced}.
    """
    replacement = rf"\g<1>{new_patch}"
    totals = {}
    for html_file in HTML_FILES:
        if not html_file.exists():
            print(f"WARNING: {html_file} not found — skipping.", file=sys.stderr)
            continue
        text = html_file.read_text(encoding="utf-8")
        new_text, count = VQ_PATTERN.subn(replacement, text)
        html_file.write_text(new_text, encoding="utf-8")
        totals[html_file.name] = count
    return totals


def verify_tags(new_patch: int) -> list:
    """Grep all HTML files for any ?v= tag NOT equal to new_patch.

    Returns a list of (file, line_num, line_content) tuples for failures.
    Raises SystemExit(1) if any mismatches remain.
    """
    failures = []
    for html_file in HTML_FILES:
        if not html_file.exists():
            continue
        for line_num, line in enumerate(
            html_file.read_text(encoding="utf-8").splitlines(), start=1
        ):
            for m in VQ_PATTERN.finditer(line):
                found_patch = int(m.group(2))
                if found_patch != new_patch:
                    failures.append((html_file.name, line_num, line.strip()))
    return failures


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="CompanyHub deploy-time version stamper")
    parser.add_argument(
        "--force-version",
        type=int,
        metavar="PATCH",
        help=(
            "Skip live fetch and use this patch number directly. "
            "For offline use only — must equal (live patch + 1)."
        ),
    )
    args = parser.parse_args()

    # Step 1: Determine new patch number
    if args.force_version is not None:
        new_patch = args.force_version
        print(f"[stamp-version] Using forced patch number: {new_patch}")
    else:
        print(f"[stamp-version] Fetching live CH_VERSION from GitHub Pages...")
        live_patch = fetch_live_patch()
        new_patch = live_patch + 1
        print(f"[stamp-version] Live patch: {live_patch} -> New patch: {new_patch}")

    new_version = build_version_string(new_patch)
    print(f"[stamp-version] New version string: {new_version}")

    # Step 2: Rewrite site-ui.js
    print(f"[stamp-version] Rewriting site-ui.js CH_VERSION...")
    rewrite_site_ui(new_version)

    # Step 3: Rewrite all ?v= tags in HTML files
    print(f"[stamp-version] Rewriting ?v= tags in HTML files...")
    totals = rewrite_html_tags(new_patch)
    total_tags = sum(totals.values())
    for fname, count in totals.items():
        print(f"  {fname}: {count} tags updated")

    # Step 4: Verify — grep for any non-matching tag
    print(f"[stamp-version] Verifying zero stale ?v= tags...")
    failures = verify_tags(new_patch)
    if failures:
        print(
            f"\nERROR: {len(failures)} stale ?v= tag(s) remain after rewrite:",
            file=sys.stderr,
        )
        for fname, line_num, line in failures:
            print(f"  {fname}:{line_num}: {line}", file=sys.stderr)
        print(
            f"\nDo NOT commit. Fix the above tags manually or re-run this script.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(
        f"\n[stamp-version] SUCCESS - Stamped {new_version} "
        f"({total_tags} tags updated across {len(totals)} files)"
    )
    print(f"[stamp-version] Stage these files before committing:")
    print(f"  site-ui.js")
    for html_file in HTML_FILES:
        if html_file.exists():
            print(f"  {html_file.name}")


if __name__ == "__main__":
    main()
