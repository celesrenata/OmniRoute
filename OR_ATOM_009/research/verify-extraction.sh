#!/bin/sh
# Verify OR_ATOM_009/research/skills/** is byte-identical to the skills-import corpus.
cd "OR_ATOM_009" || exit 1
STAGE=/tmp/or-atom-009-extract
same=0
differ=0
total=0
for f in $(find research/skills -type f); do
  rel=${f#research/skills/}
  name=${rel%%/*}
  rest=${rel#*/}
  case "$name" in
    webgpu-threejs-tsl) src="$STAGE/wgpu/webgpu-threejs-tsl/$rest" ;;
    performance|core-web-vitals|accessibility|web-quality-audit) src="$STAGE/web/web-quality/$name/$rest" ;;
    accessibility-compliance|visual-design-foundations|interaction-design) src="$STAGE/eng/engineering/$name/$rest" ;;
    game-developer) src="$STAGE/fd/fullstack-development/game-developer/$rest" ;;
  esac
  total=$((total+1))
  if [ -f "$src" ] && cmp -s "$src" "$f"; then
    same=$((same+1))
  else
    differ=$((differ+1))
    echo "MISMATCH: $f  (src=$src)"
  fi
done
echo "verified=$same/$total  mismatches=$differ"
