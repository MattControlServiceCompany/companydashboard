#!/usr/bin/env python3
"""
check_release_notes.py — Write-time gate for CompanyHub "What's New" entries.

RELEASE_NOTES entries in app/site-functions.js are hand-typed and FORCE-POP
in front of every user whenever the version changes (see
openReleaseNotesIfNeeded() in app/site-functions.js). There is no generator
and, before this script, no gate on wording. That let internal/dev-only
changes (e.g. "fixed a page that was reading from the wrong data source
after a background storage upgrade") get shipped straight to users.

The standing rule (see docs/dashboardlogic.md, 2026-07-14 entry):
  - An entry describes a FEATURE the user can USE. Skip internal fixes
    entirely.
  - Bug fixes ONLY if the user reported them, in plain language.
  - Never reference file names, function names, line numbers, commit
    hashes, or jargon.
  - A version bump does NOT entitle a deploy to an entry. Most deploys
    should ship with NO entry.

This script checks the NEWEST entry (RELEASE_NOTES[0]) — the one that is
about to force-pop for users on the next deploy — for developer language,
and fails loudly if it finds any. It is deliberately narrow: it does not
re-check older, already-shipped entries, so it won't retroactively block
unrelated commits over historical debt.

Usage:
    python scripts/check_release_notes.py                # check RELEASE_NOTES[0]
    python scripts/check_release_notes.py --all           # check every entry (audit mode, non-blocking)
    python scripts/check_release_notes.py --version vX    # check one specific version's entry
    python scripts/check_release_notes.py --text "..."    # check an arbitrary string (for testing/CI)

Exit codes:
    0 — clean (or all violations were explicitly overridden)
    1 — developer language found and not overridden

Legitimate override (rare):
    Add `gateOverride: true` and `gateOverrideReason: '<why this is fine>'`
    to the entry object in app/site-functions.js. Both fields are ignored
    by the rendering code (buildVersionBlock() only reads v/date/title/items)
    so they are safe to add without changing what users see. The override
    reason is printed by this script so it's visible in code review — it is
    not a silent bypass.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SITE_FUNCTIONS_JS = REPO_ROOT / "app" / "site-functions.js"

# ---------------------------------------------------------------------------
# Jargon rules
# ---------------------------------------------------------------------------

# (label shown in output, regex pattern, case-insensitive)
JARGON_TERMS = [
    ("storage", r"\bstorage\b"),
    ("backend", r"\bback[- ]?end\b"),
    ("IndexedDB", r"\bindexeddb\b"),
    ("localStorage", r"\blocalstorage\b"),
    ("migration", r"\bmigrat\w*\b"),
    ("regex", r"\bregexp?\b"),
    ("SRI", r"\bsri\b"),
    ("encoding", r"\bencod\w*\b"),
    ("cache", r"\bcach\w*\b"),
    ("refactor", r"\brefactor\w*\b"),
    ("hotfix", r"\bhot[- ]?fix\w*\b"),
    ("null", r"\bnull\b"),
    ("undefined", r"\bundefined\b"),
    ("data source", r"\bdata\s+source\b"),
]

FILE_EXTENSION_PATTERN = re.compile(r"\.(js|html)\b", re.IGNORECASE)
FUNCTION_CALL_PATTERN = re.compile(r"\(\)")

COMPILED_JARGON = [(label, re.compile(pattern, re.IGNORECASE)) for label, pattern in JARGON_TERMS]


def check_text(text: str) -> list:
    """Return a list of human-readable findings for one string of entry text."""
    findings = []
    if FILE_EXTENSION_PATTERN.search(text):
        findings.append('file extension (.js/.html)')
    if FUNCTION_CALL_PATTERN.search(text):
        findings.append('function-call syntax "()"')
    for label, pattern in COMPILED_JARGON:
        if pattern.search(text):
            findings.append(f'jargon word "{label}"')
    return findings


# ---------------------------------------------------------------------------
# RELEASE_NOTES extraction (Node is used to evaluate the JS array literal
# faithfully — there is no build/module system in this repo to import it,
# and re-implementing a JS object-literal parser in Python would be its own
# source of bugs).
# ---------------------------------------------------------------------------


def extract_release_notes_source(js_source: str) -> str:
    m = re.search(r"var RELEASE_NOTES = (\[)", js_source)
    if not m:
        raise RuntimeError("Could not find 'var RELEASE_NOTES = [' in " + str(SITE_FUNCTIONS_JS))
    start = m.start(1)
    end = js_source.index("\n];", start)  # position of the newline before the closing "];"
    return js_source[start:end + 2]  # include the newline and the closing "]" bracket


def parse_release_notes() -> list:
    if not SITE_FUNCTIONS_JS.exists():
        raise RuntimeError(f"{SITE_FUNCTIONS_JS} not found")
    js_source = SITE_FUNCTIONS_JS.read_text(encoding="utf-8")
    arr_text = extract_release_notes_source(js_source)
    script = "const RELEASE_NOTES = " + arr_text + ";\nprocess.stdout.write(JSON.stringify(RELEASE_NOTES));"
    with tempfile.NamedTemporaryFile(mode="w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(script)
        tmp_path = f.name
    try:
        result = subprocess.run(
            ["node", tmp_path],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=15,
        )
        if result.returncode != 0:
            raise RuntimeError(f"node failed to parse RELEASE_NOTES: {result.stderr}")
        return json.loads(result.stdout)
    finally:
        os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Entry-level checking
# ---------------------------------------------------------------------------


def check_entry(entry: dict) -> tuple:
    """Returns (problems, overridden).

    problems: list of (item_text, findings) tuples
    overridden: True if entry.gateOverride was set (problems still returned
    for visibility, but the caller should not treat this as a failure)
    """
    problems = []
    for item in entry.get("items", []):
        text = item.get("text", "")
        findings = check_text(text)
        if findings:
            problems.append((text, findings))
    overridden = bool(entry.get("gateOverride"))
    return problems, overridden


def report_entry(entry: dict, problems: list, overridden: bool) -> None:
    v = entry.get("v", "?")
    if overridden:
        reason = entry.get("gateOverrideReason", "(no reason given)")
        print(f"[check_release_notes] {v}: OVERRIDDEN -- {reason}")
        for text, findings in problems:
            print(f"  (would have failed on: {', '.join(findings)})")
            print(f"  text: {text}")
        return
    print(f"REJECTED: RELEASE_NOTES entry {v} contains developer language:", file=sys.stderr)
    for text, findings in problems:
        print(f"  matched: {', '.join(findings)}", file=sys.stderr)
        print(f"  text: {text}", file=sys.stderr)
    print(
        "\nRewrite this entry in plain, user-facing language, or delete it if it "
        "describes a purely internal change. See the standing rule in "
        "docs/dashboardlogic.md and the header comment of this script.\n"
        "Legitimate exception: add gateOverride: true and gateOverrideReason: '...' "
        "to the entry object in app/site-functions.js.",
        file=sys.stderr,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description="CompanyHub RELEASE_NOTES wording gate")
    parser.add_argument("--all", action="store_true", help="Check every entry (audit mode)")
    parser.add_argument("--version", metavar="V", help="Check only the entry matching this version string")
    parser.add_argument("--text", metavar="TEXT", help="Check an arbitrary string directly (no file parsing)")
    args = parser.parse_args()

    if args.text is not None:
        findings = check_text(args.text)
        if findings:
            print(f"REJECTED: {', '.join(findings)}", file=sys.stderr)
            print(f"  text: {args.text}", file=sys.stderr)
            sys.exit(1)
        print("PASS: no developer language found")
        sys.exit(0)

    try:
        entries = parse_release_notes()
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    if not entries:
        print("ERROR: RELEASE_NOTES is empty", file=sys.stderr)
        sys.exit(1)

    if args.version:
        matches = [e for e in entries if e.get("v") == args.version]
        if not matches:
            print(f"ERROR: no RELEASE_NOTES entry found for {args.version}", file=sys.stderr)
            sys.exit(1)
        targets = matches
    elif args.all:
        targets = entries
    else:
        targets = [entries[0]]

    any_blocking_failure = False
    any_problem = False
    for entry in targets:
        problems, overridden = check_entry(entry)
        if not problems:
            continue
        any_problem = True
        report_entry(entry, problems, overridden)
        if not overridden:
            any_blocking_failure = True

    # --all is an audit report over ALL historical entries (most of which predate
    # this gate and were never meant to be re-litigated retroactively). It always
    # prints findings but never fails the process. Only the default (newest entry)
    # and --version modes are the actual write-time blocking gate.
    if args.all:
        if any_problem:
            print(
                f"\n[check_release_notes] AUDIT -- {sum(1 for e in targets if check_entry(e)[0])} "
                f"of {len(targets)} entries contain developer language (informational only, not blocking)."
            )
        else:
            print(f"[check_release_notes] AUDIT -- all {len(targets)} entries clean")
        sys.exit(0)

    if any_blocking_failure:
        sys.exit(1)

    checked = targets[0].get("v", "?") if len(targets) == 1 else f"{len(targets)} entries"
    print(f"[check_release_notes] PASS -- {checked} clean")
    sys.exit(0)


if __name__ == "__main__":
    main()
