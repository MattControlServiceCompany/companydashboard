#!/usr/bin/env python3
"""
stamp-version.py — Deploy-time version stamper for CompanyHub.

Fetches the live CH_VERSION from every deployed host, computes the next
integer patch number from the PRODUCTION host's patch, rewrites site-ui.js
CH_VERSION, and rewrites ALL ?v= tags in all four HTML files to the new
integer.

By default this checks BOTH GitHub Pages and Netlify, since both currently
deploy from origin/main and their CH_VERSION values should always match —
a divergence between them is itself a signal that one host's deploy
silently failed or is lagging. Only the PRODUCTION host (see PRODUCTION_HOST
below) is treated as a hard failure if unreachable; a stale/unreachable
non-production host is reported as a warning, not a fatal error.

Usage:
    python scripts/stamp-version.py
    python scripts/stamp-version.py --force-version 524   # offline fallback
    python scripts/stamp-version.py --live-url <url>      # single-host override

Exit 0 on success. Exit 1 with details on any failure.
"""

import argparse
import os
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

# All hosts this script checks by default. Both deploy from origin/main today,
# so their CH_VERSION should always agree; a mismatch is worth surfacing.
HOSTS = {
    "github_pages": "https://MattControlServiceCompany.github.io/companydashboard/site-ui.js",
    "netlify": "https://cscdashboard.netlify.app/site-ui.js",
}

# Which entry in HOSTS is authoritative for computing the next patch number
# and is treated as a hard failure if unreachable. GITHUB PAGES IS PRODUCTION
# for routine `main` deploys (cutover 2026-07-15: Netlify was decoupled from
# `main` — its dashboard Production branch is now `stable`, deployed only
# from `stable`, and it no longer builds on pushes to `main`). GitHub Pages
# is now the iteration/verification host; Netlify remains the STABLE host,
# updated only via the `stable` branch. Netlify stays in HOSTS below so a
# stale/lagging Netlify is still reported as a WARNING, just not fatal.
PRODUCTION_HOST = "github_pages"

SITE_UI_JS = REPO_ROOT / "site-ui.js"
SITE_FUNCTIONS_JS = REPO_ROOT / "app" / "site-functions.js"
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


class LiveFetchError(Exception):
    """Raised when a single host's site-ui.js cannot be fetched or parsed."""


def fetch_live_patch(live_url: str) -> int:
    """Fetch site-ui.js from live_url and return its CH_VERSION patch integer.

    Raises LiveFetchError on any network or parse failure. Callers decide
    whether a given host's failure is fatal (production) or a warning
    (non-production).
    """
    try:
        with urllib.request.urlopen(live_url, timeout=10) as resp:
            content = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:
        raise LiveFetchError(f"fetch failed: {exc}") from exc

    # Parse: var CH_VERSION = 'v2026.06.11.520';
    m = re.search(r"CH_VERSION\s*=\s*['\"]v[\d.]+\.(\d+)['\"]", content)
    if not m:
        raise LiveFetchError(
            f"could not parse CH_VERSION (first 200 chars: {content[:200]!r})"
        )

    return int(m.group(1))


def check_live_hosts(hosts: dict) -> dict:
    """Fetch CH_VERSION patch from each {label: url} host.

    Returns {label: (patch_int_or_None, error_str_or_None)}.
    Never raises — failures are captured per-host so callers can decide
    which ones are fatal.
    """
    results = {}
    for label, url in hosts.items():
        try:
            results[label] = (fetch_live_patch(url), None)
        except LiveFetchError as exc:
            results[label] = (None, str(exc))
    return results


def get_release_notes_top_version() -> str:
    """Return RELEASE_NOTES[0].v from app/site-functions.js, or None if not found.

    This is the hand-maintained changelog that app/report-engine.js compares
    against the live-fetched CH_VERSION to decide whether to show the
    "update available" banner. If this value falls behind CH_VERSION, the
    banner fires permanently and cannot be cleared client-side (see
    fix/release-notes-version-pairing, 2026-07-28).
    """
    if not SITE_FUNCTIONS_JS.exists():
        return None
    text = SITE_FUNCTIONS_JS.read_text(encoding="utf-8")
    m = re.search(r"var\s+RELEASE_NOTES\s*=\s*\[", text)
    if not m:
        return None
    # First v: '...' occurrence after the RELEASE_NOTES[ opening is entry [0].
    m2 = re.search(r"v:\s*['\"](v[\d.]+)['\"]", text[m.end():])
    if not m2:
        return None
    return m2.group(1)


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
    parser.add_argument(
        "--live-url",
        type=str,
        metavar="URL",
        help=(
            "Skip the default both-hosts check (see HOSTS) and check ONLY "
            "this single URL, treated as production. Defaults to the "
            "CH_LIVE_SITE_UI_URL env var if set, else checks every host in "
            f"HOSTS with {PRODUCTION_HOST!r} as production."
        ),
    )
    args = parser.parse_args()

    # Step 1: Determine new patch number
    if args.force_version is not None:
        new_patch = args.force_version
        print(f"[stamp-version] Using forced patch number: {new_patch}")
    else:
        override_url = args.live_url or os.environ.get("CH_LIVE_SITE_UI_URL")
        if override_url:
            hosts_to_check = {"override": override_url}
            production_label = "override"
        else:
            hosts_to_check = HOSTS
            production_label = PRODUCTION_HOST

        print(
            f"[stamp-version] Checking live CH_VERSION on "
            f"{len(hosts_to_check)} host(s)..."
        )
        results = check_live_hosts(hosts_to_check)
        for label, url in hosts_to_check.items():
            patch, err = results[label]
            marker = " [PRODUCTION]" if label == production_label else ""
            if err:
                print(f"  [{label}{marker}] {url}\n      ERROR: {err}")
            else:
                print(f"  [{label}{marker}] {url}\n      CH_VERSION patch: {patch}")

        prod_patch, prod_err = results[production_label]
        if prod_err:
            print(
                f"\nERROR: Could not fetch live site-ui.js from the PRODUCTION "
                f"host ({production_label}).\n"
                f"  Reason: {prod_err}\n"
                f"\n"
                f"If this host is wrong, override it with:\n"
                f"  python scripts/stamp-version.py --live-url <url>\n"
                f"  (or set the CH_LIVE_SITE_UI_URL environment variable)\n"
                f"\n"
                f"If you are offline or production is down, use:\n"
                f"  python scripts/stamp-version.py --force-version <patch_number>\n"
                f"\n"
                f"IMPORTANT: --force-version must be (current live patch) + 1.\n"
                f"Check the live site for the current version before using this flag.",
                file=sys.stderr,
            )
            sys.exit(1)

        # Non-production hosts are informational only: warn, don't fail.
        for label, (patch, err) in results.items():
            if label == production_label:
                continue
            if err:
                print(
                    f"WARNING: could not check non-production host [{label}]: {err}"
                )
            elif patch != prod_patch:
                print(
                    f"WARNING: non-production host [{label}] reports patch "
                    f"{patch}, but production [{production_label}] reports "
                    f"{prod_patch}. Both hosts deploy from origin/main and "
                    f"should match — this likely means [{label}]'s deploy "
                    f"silently failed or is lagging behind."
                )

        new_patch = prod_patch + 1
        print(
            f"[stamp-version] Production ({production_label}) patch: "
            f"{prod_patch} -> New patch: {new_patch}"
        )

    new_version = build_version_string(new_patch)
    print(f"[stamp-version] New version string: {new_version}")

    # Step 1.5: Gate — RELEASE_NOTES[0].v in app/site-functions.js MUST equal
    # the version being stamped. app/report-engine.js's update-banner check
    # compares RELEASE_NOTES[0].v (loadedVer) against the live-fetched
    # CH_VERSION (fetchedVer). If they are allowed to drift, the "update
    # available" banner fires permanently and cannot be cleared client-side.
    # This happened twice (v711 and v712 shipped with no release-note entry)
    # before this gate was added. Do not weaken this to a warning.
    print(f"[stamp-version] Checking RELEASE_NOTES[0].v in app/site-functions.js...")
    top_note_version = get_release_notes_top_version()
    if top_note_version is None:
        print(
            f"\nERROR: Could not find RELEASE_NOTES[0].v in "
            f"{SITE_FUNCTIONS_JS}.\n"
            f"  Expected to find: var RELEASE_NOTES = [ {{ v: 'v...', ... }}\n"
            f"\n"
            f"ACTION REQUIRED: Add a RELEASE_NOTES entry for {new_version} at "
            f"the TOP of the RELEASE_NOTES array in app/site-functions.js "
            f"(newest first), then re-run this script.",
            file=sys.stderr,
        )
        sys.exit(1)
    if top_note_version != new_version:
        print(
            f"\nERROR: RELEASE_NOTES[0].v ({top_note_version}) does not match "
            f"the version being stamped ({new_version}).\n"
            f"\n"
            f"Every stamped version MUST have a matching RELEASE_NOTES entry. "
            f"Without one, app/report-engine.js's update-check compares the "
            f"stale RELEASE_NOTES[0].v against the new live CH_VERSION, "
            f"decides an update is permanently available, and shows the "
            f"'update available' banner on every page load, tab focus, and "
            f"5-minute interval forever -- with no way to clear it client-side.\n"
            f"\n"
            f"ACTION REQUIRED: Before re-running this script, add a new entry "
            f"to the TOP of the RELEASE_NOTES array in app/site-functions.js "
            f"(~line 1577) with:\n"
            f"    v: '{new_version}',\n"
            f"  describing what changed in this deploy, in plain user-facing "
            f"language, naming the page(s) affected. Then re-run "
            f"scripts/stamp-version.py.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"[stamp-version] OK -- RELEASE_NOTES[0].v matches {new_version}")

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
