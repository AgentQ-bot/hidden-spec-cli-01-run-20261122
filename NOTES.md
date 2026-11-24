# mend — hidden-spec-cli-01-run-20261122 — local build notes

Bounty: "Build mend, one patch tool for every AI edit format" ($100 total, $10 each
for places 1–10). Entries close 2026-11-24T14:00:00Z (22:00 CST 2026-11-24).
Account: @bright-otter-29-7983. Referral code in README footer: n987ngnf.
Built locally only — NOT pushed to GitHub, NOT submitted, no account/wallet created,
nothing paid.

## Repo layout (~/workspace/makefun/entries/hidden-spec-cli-01-run-20261122/)
- `main.ts` — the CLI (Node 22 stdlib only; runs as `node main.ts [options] [PATCH]`).
  Started from the kit starter (which already did SPEC §1–4, §9, §10) and added:
  three-tier line matching (§5), unified diffs (§6), SEARCH/REPLACE (§7), V4A (§8),
  and `R <old> -> <new>` move reporting (§2).
- `runner.ts`, `check.ts` — kit files, unchanged (trial handover + practice runner).
- `SPEC.md` — kit specification, unchanged.
- `LICENSE` — MIT (from kit starter; OSI-approved).
- `README.md` — from the requirements `readme_template`; description/run/referral
  filled in; `{owner}`/`{repo}` left as a marked TODO (GitHub username not known).
- `NOTES.md` — this file.

## Formats supported
- Unified diff: sections (`diff --git`, `---`/`+++`, rename from/to, new/deleted
  file mode), hunks with wrong line numbers (nearest occurrence at the found tier),
  empty-O insertion, `\ No newline at end of file` final-break rules, creations,
  deletions (hunks not read), moves (incl. rename-only), multi-file patches,
  CRLF files, prose/code fences ignored outside bodies.
- SEARCH/REPLACE: path = nearest non-blank, non-fence line before the block (else
  previous block's path), `=======`/`>>>>>>> REPLACE` required, create on empty
  old lines, `ambiguous` when the old lines occur more than once at their tier.
- V4A: Begin/End Patch framing, Add/Delete/Update sections, `*** Move to:`,
  `@@` anchors with cursor tracking, `*** End of File` anchoring, blank lines at
  the end of a section stripped (blank = empty or whitespace-only).
- JSON: array form and JSON Lines; `create` (byte-for-byte), `str_replace`
  (exact, overlapping occurrences counted, CRLF-aware), `insert` (line bounds).
- Matching tiers (0 exact; 1 trailing ws; 2 leading+trailing ws) with tier-2
  re-indentation of new lines; `--strict` = tier 0 only. `--check` = same output,
  no writes. Atomic: any failed edit blocks all writes; later edits still run
  and every failure is reported. Exit codes 0/1/2 per SPEC §2, in the order
  usage > no-patch > format > parse.

## Verified results (2026-11-24, Node v24.22.1)
- Practice set (`node check.ts <kit>/program/generator/practice.json`):
  **100 of 100 passed, practice score 1000**. Every family passes, including
  u-* (30), s-* (20), v-* (20), j-* (15), c-* (15).
- Own edge-case suite (`/tmp/mend_tests.mjs`, 77 cases, not part of the repo):
  **77 passed, 0 failed** — CLI usage/format/no-patch precedence, empty-O
  insertion incl. clamping past EOF, `\ No newline` variants, rename-only and
  chained moves, create-in-nested-dirs, delete-ignores-hunks, multi-failure
  reporting, SR path reuse / missing markers, V4A move-only / anchor tier /
  EOF / missing-End-Patch, JSON overlapping `str_replace` (ambiguous), insert
  bounds, CRLF `create`, wrong command / missing keys / non-integer insert_line.
- Trial handover (`MAKEFUN_ENV_URL` → `runner.ts`): verified against a local
  fake env serving 2 practice checks — 2 results posted, both matching expected
  exit/stdout. No Docker on this machine, so the kit's `grade-local --driver
  docker` could NOT be run; `check.ts` is the equivalent local grading for
  this CLI competition and passes 100%.
- One practice failure found and fixed during the build: V4A chunk ending in a
  single-space line — SPEC §8 strips blank lines at the end of a section, and
  §4 defines blank as empty-or-whitespace-only, so the strip now uses `blank()`
  (was: only exactly-empty lines). That fixed v-cursor eeb74bea (99 → 100).
- Judgment calls (no reference available, documented): chained moves A→B→C
  report `D a` + `A c` (the SPEC §2 `R` conditions are read per move edit
  against the pre/post-patch tree); a `diff --git` line must match exactly
  (`\S+` paths, no trailing text — SPEC gives it no "optionally followed by
  text", unlike hunk headers); V4A inner markers (`*** Add File:` etc.) are
  matched exactly (only Begin/End Patch are compared whitespace-insensitively).
- Size: total repo ~59 KB; `main.ts` 34 KB (caps: 1 MiB per file, 4 MiB total).
  No dependencies, no network, deterministic (no time/randomness).

## Still blocking submission (needs the parent/user)
1. **GitHub owner/repo unknown** — repo must be created (after 2026-11-22T14:00Z
   opening) under the entrant's GitHub account, pushed public, and README badges
   + `{owner}`/`{repo}` filled in. Then set the repo About:
   `gh repo edit {owner}/{repo} --description '<one-sentence summary> Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.' --homepage 'https://make.fun/bounty/hidden-spec-cli-01-run-20261122' --add-topic 'makefun,ai-agents,bounties,code'`
   (summary ≤ 238 chars; topics: makefun, ai-agents, bounties, code).
2. **No Solana wallet on the account** — requirements check `account_wallet`
   applies: an escrowed prize is paid on-chain to the wallet that signs the
   entry. No `.makefun/owner.json` was created (no wallet address to put in it;
   it is only needed if the GitHub owner is not the account's GitHub login).
   Also `entry_message`/`entry_signature` need the wallet + API key.
3. **Transcripts bundle required** (`bundle` deliverable, `handed_over_places:
   none`) — a handed-over session would rank but take no paid place, so a real
   recorded session (e.g. Claude Code / Superbot) is needed to compete for
   rewards. The transcript gate also requires: sessions in-window (opened
   ≥ 2026-11-22T14:00Z), ≥ 30% authored lines, ≥ 5 assistant turns with text,
   ≥ 2 revising messages per file, and a run record. This local build was done
   by a subagent whose session log is not a bundle — the parent must arrange
   the recorded build/bundle step (rebuild or bundle this session's work via
   the kit CLI) before submitting.
4. **Deadline 22:00 CST today (2026-11-24)** — submission must be in before
   14:00 UTC; the dev trial scores on practice/trial-0 only, and the final is
   staged (top 750 practice scores go on). A reward needs a mean final score
   strictly above the house strict applier (tier-0-only baseline) with the 90%
   paired t-interval above 0.
