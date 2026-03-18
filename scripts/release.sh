#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Effy — Release Script
# Usage: ./scripts/release.sh <major|minor|patch>
# Example: ./scripts/release.sh patch  → 3.5.4 → 3.5.5
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

BUMP_TYPE="${1:-}"
if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo "Usage: $0 <major|minor|patch>"
  exit 1
fi

# Ensure clean working tree
if [[ -n $(git status --porcelain) ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# Ensure on develop branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "develop" ]]; then
  echo "❌ Must be on 'develop' branch (currently on '$BRANCH')."
  exit 1
fi

# Run tests
echo "🧪 Running tests..."
npm test

# Get current version
CURRENT=$(node -p "require('./package.json').version")
echo "📌 Current version: v$CURRENT"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "🚀 New version: v$NEW_VERSION"

# Create release branch
RELEASE_BRANCH="release/v$NEW_VERSION"
git checkout -b "$RELEASE_BRANCH"

# Bump version in package.json
node -e "
  const pkg = require('./package.json');
  pkg.version = '$NEW_VERSION';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Prompt to update CHANGELOG
echo ""
echo "📝 Please update CHANGELOG.md with the new version section."
echo "   Add a section: ## [$NEW_VERSION] - $(date +%Y-%m-%d)"
echo ""
echo "Press ENTER when CHANGELOG.md is ready..."
read -r

# Commit release
git add package.json CHANGELOG.md
git commit -m "chore: release v$NEW_VERSION"

echo ""
echo "✅ Release branch '$RELEASE_BRANCH' created."
echo ""
echo "Next steps:"
echo "  1. git push -u origin $RELEASE_BRANCH"
echo "  2. Create PR → main"
echo "  3. After merge: git tag v$NEW_VERSION && git push --tags"
echo "  4. Merge main back to develop"
