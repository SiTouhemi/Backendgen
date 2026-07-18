# Design-partner program

BackendGen 0.2 is an alpha. Before removing that label, at least three design
partners must complete a real generation trial (see
[exit criteria](#exit-criteria) and the
[launch plan](LAUNCH_PLAN.md)). This document is the complete kit for running
those trials. It makes no production-readiness or token-savings claims;
paired-run token evidence is a separate project described in
[benchmark/README.md](../benchmark/README.md).

## Ideal partner profile

Recruit people who match all three:

1. **AI coding users.** They build with Lovable, v0, Codex, Claude (Code or
   desktop), or Cursor, and are comfortable running a local CLI or MCP server.
2. **They need a NestJS/Prisma/PostgreSQL backend.** BackendGen has exactly one
   target; a partner who needs FastAPI, MySQL, or serverless-only hosting is a
   bad fit today.
3. **They have a real project.** A frontend or product that exists and needs a
   backend — not a toy demonstration invented for the trial. Real requirements
   surface real defects.

Good signals: an existing Lovable/v0 frontend waiting on an API; a founder or
freelancer rebuilding a hand-rolled Express backend; an agency doing repeated
client CRUD/auth backends.

## Recruitment material

Both versions offer the same deal: a free guided alpha generation session in
exchange for structured feedback. Do not promise production readiness, token
savings, or any benchmark numbers.

### Short direct-message version

> I'm building BackendGen, an open-source compiler that turns a small YAML spec
> into a complete tested NestJS + Prisma + PostgreSQL backend — built for
> people using AI tools like Lovable/v0/Cursor for the frontend. It's in alpha
> and I'm looking for a few design partners with a real project that needs a
> backend. The deal: I personally walk you through generating yours, free, and
> you give me structured feedback on what worked and what didn't. Interested?

### Longer email / community-post version

> **Looking for design partners: generate your real backend from a spec (alpha)**
>
> I'm the author of BackendGen, an Apache-2.0 backend compiler for AI coding
> users. You describe your backend in a compact `backend.yaml` — entities,
> auth, organizations, reservations, webhooks, jobs, uploads — and it
> deterministically generates a NestJS 11 + Prisma 6 + PostgreSQL repository
> with tests, migrations, a typed client, and a `frontend-contract.json` your
> AI frontend tool can read instead of scanning backend source. It runs
> locally, needs no account, and also works as an MCP server inside Claude
> Code, Codex, or Cursor.
>
> It's an alpha, and I want it battle-tested on real projects before calling it
> anything else. I'm offering a small number of **free guided alpha
> generations**: we take your real backend requirements, generate the backend
> together, verify the build and tests, and wire it to your frontend using the
> generated contract and client.
>
> In exchange, I ask for a structured debrief: what was confusing, what broke,
> what you'd pay for. Your code stays yours; the generated repository has no
> BackendGen runtime dependency and I keep no copy of your project.
>
> Good fit: you use Lovable, v0, Codex, Claude, or Cursor; you need a
> NestJS/Prisma/PostgreSQL backend; and you have a real project rather than a
> demo. If that's you, reply or open a "Design-partner interest" issue on the
> repository.

## Trial procedure

One trial has seven stages. Nothing is skipped, and no stage's result is
adjusted to make the trial look better.

1. **Intake and suitability check.** Confirm the profile above: real project,
   AI tool in use, NestJS/Prisma/PostgreSQL acceptable, Node.js 22 available.
   Capture project type, entity count estimate, and required features. If a
   required feature does not exist in 0.2, record it and stop — that is useful
   data, not a trial.
2. **Baseline evidence.** Before generating, record how the partner would
   otherwise build this backend: an actual prior attempt (repository, prompts,
   time spent) or, failing that, their own written estimate labeled as an
   estimate. Never convert this into token numbers.
3. **BackendGen generation.** The partner (guided, but hands on their keyboard)
   writes the specification and generates with the CLI or their MCP client.
   Record the specification size, generation duration, generated file count
   from `.backendgen/manifest.json`, and generated line count using a recorded
   local measurement command. The manifest does not contain line counts. Also
   record every point where guidance was required.
4. **Verification.** Run the generated project's build and tests against
   PostgreSQL. Record pass/fail exactly as observed, and any manual fixes
   needed, however small.
5. **Frontend integration.** The partner points their AI frontend tool at
   `frontend-contract.json` and the generated typed client, sets
   `CORS_ORIGINS`, and connects at least one real screen. Record elapsed time
   and friction.
6. **Structured debrief.** Fill in the scorecard below together. Ask the
   willingness-to-pay and pricing questions last, after the experience is
   fresh but complete.
7. **Write-up.** Store the scorecard and your notes. Ask explicitly whether
   the partner permits anonymous public use, named public use, or private use
   only, and record the answer.

### Data and secrets rules

- Never ask for, accept, or store partner secrets, `.env` files, credentials,
  or production data. Specifications declare secret *names* only.
- Private partner code stays on the partner's machine. Do not retain a copy of
  their repository, specification, or generated project unless they grant it
  in writing on the scorecard; default is retain nothing but the scorecard.
- Vulnerability reports discovered during a trial follow [SECURITY.md](../SECURITY.md),
  not a public issue.
- Debrief quotes are publishable only with the permission recorded on the
  scorecard.

## Design-partner scorecard

Copy this block into one file per trial (keep it out of the repository if the
partner requires privacy).

```markdown
# Design-partner scorecard — <partner id> — <date>

## Project
- Project type and one-line description:
- Complexity (entities / relations / features used):
- AI tool and model used (exact versions):

## Baseline
- Prior attempt exists (yes/no) and form (repo / prompts / estimate):
- Baseline prompts or attempts count:
- Baseline elapsed time:
- Baseline token counts (only if provider-reported; otherwise "unavailable"):

## Generation
- Specification size (lines / bytes):
- Generated files (from `.backendgen/manifest.json`):
- Generated lines (measurement command + result):
- Generation duration:
- Build result (exact command + pass/fail):
- Test result (exact command + pass/fail, counts):
- Manual fixes required (list every one):

## Experience
- Defects found (list, with severity):
- Confusing behavior or documentation (list):
- Frontend integration time and friction:

## Commercial
- Willingness to pay (what, for what capability):
- Reaction to $39 Indie / $129 Team payments pack / $79 guided setup
  (each: would buy / maybe / no, and why):

## Consent
- Case-study permission: none / anonymous / named (partner initials + date):
- Artifact retention granted: none / scorecard only / spec / generated repo:
```

## Exit criteria

**One completed design-partner generation** means all of the following, for a
real project:

- the partner's own specification compiled and generated;
- the generated project's build and tests passed on PostgreSQL, with every
  manual fix recorded;
- the partner regenerated at least once after a specification change without
  losing custom code;
- at least one real frontend screen talks to the generated API through the
  contract/client;
- the scorecard is complete, including consent.

A trial that fails any stage is recorded as a failed or partial trial with its
actual results — never reclassified, retried-until-green without recording the
failures, or quietly replaced with an easier project.

The alpha label is not reconsidered until **three completed trials** exist.
Three completed trials do not by themselves make it stable: the remaining
human gates in [LAUNCH_PLAN.md](LAUNCH_PLAN.md) (independent security review,
paired benchmark evidence, MCP connection without maintainer help) still apply.
