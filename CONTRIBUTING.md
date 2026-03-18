# Contributing to Effy

## Branch Strategy (Git Flow Simplified)

```
main          ← production-ready, tagged releases only
  └─ develop  ← integration branch, CI must pass
       ├─ feature/Effy-123-description  ← new features
       ├─ fix/Effy-456-description      ← bug fixes
       ├─ refactor/description           ← code improvements
       └─ hotfix/critical-issue          ← emergency prod fixes (branch from main)
```

### Branch Naming Convention

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feature/Effy-{ticket}-{short-desc}` | `feature/Effy-42-graph-search` |
| Bug fix | `fix/Effy-{ticket}-{short-desc}` | `fix/Effy-99-null-guard` |
| Refactor | `refactor/{short-desc}` | `refactor/extract-common-mapper` |
| Hotfix | `hotfix/{short-desc}` | `hotfix/circuit-breaker-timeout` |
| Release | `release/v{semver}` | `release/v3.6.0` |

### Rules

- `main` and `develop` are **protected** — no direct pushes
- All changes go through **Pull Requests** with at least 1 review
- Squash merge to `develop`, merge commit to `main` (preserves release history)
- Delete branch after merge

---

## Commit Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `docs` | Documentation only changes |
| `chore` | Build process, CI, tooling |
| `security` | Security-related changes |

### Scopes

`gateway`, `memory`, `agents`, `core`, `db`, `shared`, `config`, `ci`, `docker`

### Examples

```
feat(memory): add graph-based importance scoring
fix(gateway): prevent silent swallow of reply errors
refactor(memory): extract _mapGraphRow common helper
perf(memory): parallelize _summarize and _extractMemories
test(security): add FTS5 injection tests
chore(ci): add GitHub Actions workflow
```

---

## Development Workflow

### 1. Setup

```bash
git clone <repo-url> && cd effy
nvm use                     # reads .nvmrc → Node 20
cp .env.example .env        # fill in secrets
npm install
npm run db:init
```

### 2. Daily Development

```bash
git checkout develop
git pull origin develop
git checkout -b feature/Effy-XX-description

# ... code ...

npm test                    # must pass before push
npm run lint
git add <files>
git commit -m "feat(memory): add graph traversal"
git push -u origin feature/Effy-XX-description
```

### 3. Pull Request

- Title: `feat(memory): add graph traversal` (follows commit convention)
- Description: use PR template (auto-loaded)
- Assign at least 1 reviewer
- CI must pass (lint + test)
- Squash merge to `develop`

### 4. Release

```bash
git checkout develop && git pull
git checkout -b release/v3.6.0
# bump version in package.json
# update CHANGELOG.md
git commit -m "chore: release v3.6.0"
git push -u origin release/v3.6.0
# PR → main, merge commit
# tag: git tag v3.6.0 && git push --tags
# merge main back to develop
```

---

## Code Conventions

### Style

- **Indent**: 2 spaces (enforced by .editorconfig)
- **Semicolons**: yes
- **Quotes**: single quotes for JS, double for JSON
- **Trailing commas**: ES5 style (objects, arrays)
- **Line length**: 120 chars soft limit

### Architecture Rules

- **No circular imports** — use DI (constructor injection or parameter injection)
- **Structured logging** — use `createLogger('component:name')`, never `console.log`
- **Config via `??`** — use nullish coalescing for defaults where `0` or `false` are valid
- **Type enforcement** — validate external input types at module boundaries
- **Common helpers** — extract when pattern appears 3+ times
- **Security first** — parameterized SQL only, FTS5 sanitization, input validation

### File Naming

- `kebab-case.js` for all source files
- `tier{N}-{name}.test.js` for tests (N=1 unit, N=2 integration, N=3 e2e)
- `UPPER_CASE.md` for project docs (README, CONTRIBUTING, CHANGELOG, INSTALL)

---

## Testing

```bash
npm test                    # all tests
npm run test:tier1          # unit + security (no DB)
npm run test:tier2          # integration (may need DB)
npm run test:coverage       # with coverage report
```

### Test Requirements

- Every PR must maintain or improve test coverage
- Security tests (SEC-*) must never be removed
- New modules require at least tier-1 unit tests
- Bug fixes require a regression test

---

## Security Checklist (PR Review)

Before approving any PR, verify:

- [ ] No raw string concatenation in SQL queries
- [ ] FTS5 queries go through `sanitizeFtsQuery()`
- [ ] No `console.log` with secrets/tokens
- [ ] Input validation at module boundaries
- [ ] `??` used instead of `||` for config defaults
- [ ] No new `catch (_) {}` silent swallows
