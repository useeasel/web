#!/usr/bin/env bash
# Assembles the ten-option ownership-section preview from the partials.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../ownership-section-preview-2.html

# look-id|caption-html
LOOKS=(
"d|<strong>Look D — the deed.</strong> A CSS certificate of ownership; a rubber stamp thunks down on scroll."
"e|<strong>Look E — take it anywhere.</strong> Host passport stamps (GitHub Pages, Netlify, Cloudflare, your own server) stamp in one by one."
"f|<strong>Look F — rent or own (drag it).</strong> An interactive before/after slider you drag between rented and owned. Try dragging the handle."
"g|<strong>Look G — the receipt.</strong> Two itemized five-year receipts; line items print in and the totals count up (\$960 vs \$0)."
"h|<strong>Look H — your files, plainly yours.</strong> Your repo shown as a file-tree that expands, with plain-language callouts."
"i|<strong>Look I — pull the plug.</strong> Flip the switch: the competitor 404s while your site stays live. Try the toggle."
"j|<strong>Look J — five years, side by side.</strong> A timeline whose cost rail draws across years one to five."
"k|<strong>Look K — the numbers.</strong> A calm stat quartet (\$0 / 100% / 4+ hosts / 0 code) that counts up on scroll."
"l|<strong>Look L — the handoff.</strong> The quiet, editorial option: keys handed over, three crisp proof points."
"m|<strong>Look M — the checklist.</strong> An ownership checklist that ticks itself off for you and stays blank for them."
)

cat _head.html > "$OUT"
for entry in "${LOOKS[@]}"; do
  id="${entry%%|*}"
  caption="${entry#*|}"
  {
    printf '\n<!-- ===================== LOOK %s ===================== -->\n' "$(echo "$id" | tr '[:lower:]' '[:upper:]')"
    printf '<div class="pv-look" data-look="%s" id="look-%s">\n' "$id" "$id"
    printf '  <p class="pv-caption">%s</p>\n' "$caption"
  } >> "$OUT"
  cat "look-$id.html" >> "$OUT"
  printf '\n</div>\n' >> "$OUT"
done
cat _tail.html >> "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"
