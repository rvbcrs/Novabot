#!/usr/bin/env bash
# Build a redacted public version of the Novabot wiki.
#
# Content between <!-- PRIVATE --> and <!-- /PRIVATE --> markers is replaced
# with a notice that the section is only available in the private wiki.
#
# Usage:
#   ./scripts/build-public-wiki.sh          # Build to site-public/
#   ./scripts/build-public-wiki.sh serve    # Build + serve on port 8001

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PUBLIC_DOCS="$PROJECT_ROOT/docs-public"
PUBLIC_SITE="$PROJECT_ROOT/site-public"

NOTICE='!!! lock "Private section"
    This section contains sensitive security details (encryption keys, credentials,
    vulnerability specifics) and is only available in the private wiki.'

echo "==> Cleaning previous public docs..."
rm -rf "$PUBLIC_DOCS"

echo "==> Copying docs/ to docs-public/..."
cp -r "$PROJECT_ROOT/docs" "$PUBLIC_DOCS"

echo "==> Stripping PRIVATE sections..."
STRIPPED=0
while IFS= read -r -d '' file; do
    if grep -q '<!-- PRIVATE -->' "$file"; then
        # Use awk to replace PRIVATE blocks with the notice
        awk -v notice="$NOTICE" '
        /<!-- PRIVATE -->/ {
            printing = 0
            print ""
            print notice
            print ""
            next
        }
        /<!-- \/PRIVATE -->/ {
            printing = 1
            next
        }
        printing != 0 || !(/<!-- PRIVATE -->/) { if (printing != 0) print }
        BEGIN { printing = 1 }
        ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
        STRIPPED=$((STRIPPED + 1))
        echo "    Redacted: $(basename "$file")"
    fi
done < <(find "$PUBLIC_DOCS" -name '*.md' -print0)

echo "==> Stripped $STRIPPED files"

echo "==> Building public site..."
cd "$PROJECT_ROOT"

if [ "${1:-}" = "serve" ]; then
    echo "==> Serving on http://localhost:8001"
    mkdocs serve -f mkdocs-public.yml --dev-addr=0.0.0.0:8001
else
    mkdocs build -f mkdocs-public.yml -d "$PUBLIC_SITE"
    echo "==> Public site built at: $PUBLIC_SITE/"
    echo "==> Files with redacted content: $STRIPPED"
    echo ""
    echo "Verify no secrets remain:"
    echo "  grep -r 'abcdabcd1234' $PUBLIC_SITE/ | wc -l  # Should be 0"
    echo "  grep -r 'li9hep19' $PUBLIC_SITE/ | wc -l      # Should be 0"
    echo "  grep -r '47.253.57.111' $PUBLIC_SITE/ | wc -l  # Should be 0"
fi
