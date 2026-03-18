## Summary

<!-- 1-3 bullet points describing what this PR does and why -->

-

## Type

<!-- Check one -->

- [ ] `feat` — New feature
- [ ] `fix` — Bug fix
- [ ] `refactor` — Code improvement (no behavior change)
- [ ] `perf` — Performance improvement
- [ ] `test` — Test addition/update
- [ ] `docs` — Documentation
- [ ] `chore` — Build/CI/tooling
- [ ] `security` — Security fix

## Scope

<!-- Which module(s) are affected? -->

`gateway` / `memory` / `agents` / `core` / `db` / `shared` / `config`

## Changes

<!-- What changed and why? Link to design doc or issue if applicable. -->

## Test Plan

- [ ] Tier-1 tests pass (`npm run test:tier1`)
- [ ] Tier-2 tests pass (`npm run test:tier2`)
- [ ] New/modified code has test coverage
- [ ] Manual verification (describe below)

## Security Checklist

- [ ] No raw SQL string concatenation
- [ ] FTS5 queries use `sanitizeFtsQuery()`
- [ ] No secrets in logs (`console.log`, `log.debug`)
- [ ] Config defaults use `??` (not `||`)
- [ ] No silent catch blocks (`catch (_) {}`)

## Related Issues

<!-- Closes #123, Relates to #456 -->
