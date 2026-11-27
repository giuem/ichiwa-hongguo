#!/bin/sh
# check-ref.sh UPSTREAM_DIR checks that tools/vectors/ref is openhongguo, as
# checked out in UPSTREAM_DIR at the tag in UPSTREAM, but for the copyright
# header, the import paths and the export.go files that expose internals to
# the vector generator.
set -eu
up=$1
ref=$(cd "$(dirname "$0")/ref" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
status=0
cd "$ref"
for f in $(find . -name '*.go' | sort); do
  case "$f" in
    */export.go) continue ;;
    ./drm/*) src="$up/internal/drm/${f#./drm/}" ;;
    ./protocol/*) src="$up/internal/protocol/${f#./protocol/}" ;;
    ./sdk/model/*) src="$up/sdk/model/${f#./sdk/model/}" ;;
    *) echo "unexpected file $f"; status=1; continue ;;
  esac
  if [ ! -f "$src" ]; then
    echo "$f is not in openhongguo"
    status=1
    continue
  fi
  head -2 "$f" | grep -q '^// Derived from github.com/beilunyang/openhongguo ' || {
    echo "$f lacks the header"
    status=1
  }
  tail -n +4 "$f" |
    sed -e 's#"vectors/ref/sdk/model"#"github.com/beilunyang/openhongguo/sdk/model"#' \
      -e 's#"vectors/ref/protocol#"github.com/beilunyang/openhongguo/internal/protocol#' \
      -e 's#"vectors/ref/drm"#"github.com/beilunyang/openhongguo/internal/drm"#' >"$tmp/a.go"
  if ! diff -u "$src" "$tmp/a.go"; then
    echo "$f differs from openhongguo"
    status=1
  fi
done
exit $status
