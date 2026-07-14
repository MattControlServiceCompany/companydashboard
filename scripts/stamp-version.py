#!/usr/bin/env python3
"""
stamp-version.py — Deploy-time version stamper for CompanyHub.

Fetches the live CH_VERSION from every deployed host, computes the next
integer patch number from the hosts' agreed-upon current patch, rewrites
site-ui.js CH_VERSION, and rewrites ALL ?v= tags in all four HTML files to
the new integer.

This checks BOTH GitHub Pages and Netlify (see HOSTS below). BOTH ARE
PRODUCTION today — there has not been a deliberate cutover to a single
host, both serve real users, and both must agree. Every host in HOSTS is
treated as a hard failure if it is stale (serving a version other than the
one this run just verified/stamped) or unreachable. A host mismatch is not
a warning; it means one host's deploy silently failed, which is the exact
bug class this script exists to catch, so it fails loudly and refuses to
guess a new patch number until a human resolves the disagreement.

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

# All hosts this script checks. Both deploy from origin/main today, both are
# public and serve real users, and BOTH ARE PRODUCTION — GitHub Pages is the
# historical production host (bookmarks and client portal links point here);
# Netlify auto-deploys from main and survived a recent GitHub Pages outage
# (repo private/public flip took GitHub Pages dark on 2026-07-14 while
# Netlify stayed up). No deliberate single-host cutover has happened. Until
# one does, every host below is checked and every host is a hard failure if
# stale or unreachable — there is no "spare" host that only warns.
#
# If a real single-host cutover happens later (i.e. one of these hosts is
# formally retired), that is the point to reintroduce a single authoritative
# host concept here — e.g. remove the retired entry from HOSTS entirely
# rather than re-adding a soft-warn tier for it.
HOSTS = {
    "github_pages": "https://MattControlServiceCompany.github.io/companydashboard/site-ui.js",
    "netlify": "https://cscdashboard.netlify.app/site-ui.js",
}

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
            "Skip the default all-hosts check (see HOSTS) and check ONLY "
            "this single URL. Defaults to the CH_LIVE_SITE_UI_URL env var "
            "if set, else checks every host in HOSTS — all of which are "
            "production and must agree."
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
        else:
            hosts_to_check = HOSTS

        print(
            f"[stamp-version] Checking live CH_VERSION on "
            f"{len(hosts_to_check)} host(s) (all treated as production)..."
        )
        results = check_live_hosts(hosts_to_check)
        for label, url in hosts_to_check.items():
            patch, err = results[label]
            if err:
                print(f"  [{label}] {url}\n      FAIL - ERROR: {err}")
            else:
                print(f"  [{label}] {url}\n      CH_VERSION patch: {patch}")

        # Step 1a: Any unreachable/unparseable host is a hard failure. Every
        # host in HOSTS is production — there is no non-fatal "warn only"
        # tier. See the HOSTS comment above for why.
        errored = [label for label, (patch, err) in results.items() if err]
        if errored:
            print(
                f"\nERROR: {len(errored)} of {len(results)} host(s) could not "
                f"be checked:",
                file=sys.stderr,
            )
            for label in errored:
                _, err = results[label]
                print(f"  [{label}] {hosts_to_check[label]}: {err}", file=sys.stderr)
            print(
                f"\nEvery host in HOSTS is production and must be reachable "
                f"and reporting a valid CH_VERSION before stamping a new "
                f"version.\n"
                f"\n"
                f"To check a single host only, use:\n"
                f"  python scripts/stamp-version.py --live-url <url>\n"
                f"  (or set the CH_LIVE_SITE_UI_URL environment variable)\n"
                f"\n"
                f"If you are offline or all hosts are down, use:\n"
                f"  python scripts/stamp-version.py --force-version <patch_number>\n"
                f"\n"
                f"IMPORTANT: --force-version must be (current live patch) + 1.\n"
                f"Check the live site(s) for the current version before using this flag.",
                file=sys.stderr,
            )
            sys.exit(1)

        # Step 1b: Every host was reachable. If they disagree with each
        # other, that is its own distinct, loud failure — it means one
        # host's deploy silently failed or is lagging behind another. Do
        # NOT silently pick one side; a human must resolve it before a new
        # patch number is computed, or a version could get reused/skipped.
        patches = {label: patch for label, (patch, err) in results.items()}
        distinct_patches = set(patches.values())
        if len(distinct_patches) > 1:
            print(
                f"\nERROR: HOSTS DISAGREE ON THE LIVE VERSION — "
                f"this means one host's deploy silently failed or is "
                f"lagging behind another. Refusing to guess which host is "
                f"correct.",
                file=sys.stderr,
            )
            for label, patch in patches.items():
                print(f"  [{label}] reports patch {patch}", file=sys.stderr)
            print(
                f"\nResolve the disagreement (re-deploy the lagging host, "
                f"or investigate why it's stale) before re-running this "
                f"script. To bypass and check a single host only, use:\n"
                f"  python scripts/stamp-version.py --live-url <url>",
                file=sys.stderr,
            )
            sys.exit(1)

        agreed_patch = distinct_patches.pop()
        new_patch = agreed_patch + 1
        print(
            f"[stamp-version] All {len(hosts_to_check)} host(s) agree on "
            f"patch: {agreed_patch} -> New patch: {new_patch}"
        )

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
