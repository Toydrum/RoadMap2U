#!/usr/bin/env bash

set -euo pipefail

: "${BUILD_DIR:?BUILD_DIR is required}"
: "${SITE_BUCKET:?SITE_BUCKET is required}"
: "${DISTRIBUTION_ID:?DISTRIBUTION_ID is required}"
: "${RELEASE_SHA:?RELEASE_SHA is required}"

[[ "$RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'RELEASE_SHA must be an exact lowercase 40-character commit SHA.' >&2
  exit 1
}
test -f "$BUILD_DIR/index.html"
test -f "$BUILD_DIR/ngsw.json"
test -f "$BUILD_DIR/sw.js"
test -f "$BUILD_DIR/manifest.webmanifest"

release_prefix="releases/$RELEASE_SHA"
current_prefix='releases/current'
previous_prefix='releases/previous'
seed_previous=false

# Preserve the complete prior mutable release before changing current.
if aws s3api head-object \
  --bucket "$SITE_BUCKET" \
  --key "$current_prefix/index.html" >/dev/null 2>&1; then
  aws s3 sync \
    "s3://$SITE_BUCKET/$current_prefix/" \
    "s3://$SITE_BUCKET/$previous_prefix/" \
    --delete \
    --only-show-errors
else
  seed_previous=true
fi

# Publish cache-busted assets before any mutable entrypoint.
aws s3 sync "$BUILD_DIR" "s3://$SITE_BUCKET" \
  --exclude '*' \
  --include '*.js' \
  --include '*.css' \
  --include 'media/*' \
  --exclude 'sw.js' \
  --exclude 'ngsw-worker.js' \
  --exclude 'safety-worker.js' \
  --exclude 'worker-basic.min.js' \
  --cache-control 'public,max-age=31536000,immutable' \
  --only-show-errors

aws s3 sync "$BUILD_DIR" "s3://$SITE_BUCKET" \
  --exclude '*.js' \
  --exclude '*.css' \
  --exclude 'media/*' \
  --exclude 'index.html' \
  --exclude 'index.csr.html' \
  --exclude 'ngsw.json' \
  --exclude 'manifest.webmanifest' \
  --exclude 'robots.txt' \
  --exclude 'sitemap.xml' \
  --cache-control 'public,max-age=86400' \
  --only-show-errors

mutable_entrypoints=(
  index.csr.html
  ngsw.json
  sw.js
  ngsw-worker.js
  safety-worker.js
  worker-basic.min.js
  manifest.webmanifest
  robots.txt
  sitemap.xml
)

publish_mutable() {
  local entrypoint="$1"
  local destination="$2"
  local content_type
  local target="$entrypoint"
  if [[ -n "$destination" ]]; then
    target="$destination/$entrypoint"
  fi
  case "$entrypoint" in
    index.html | index.csr.html) content_type='text/html; charset=utf-8' ;;
    manifest.webmanifest) content_type='application/manifest+json' ;;
    ngsw.json) content_type='application/json' ;;
    robots.txt) content_type='text/plain; charset=utf-8' ;;
    sitemap.xml) content_type='application/xml; charset=utf-8' ;;
    *.js) content_type='text/javascript; charset=utf-8' ;;
    *)
      echo "No explicit content type configured for $entrypoint." >&2
      return 1
      ;;
  esac
  aws s3 cp "$BUILD_DIR/$entrypoint" "s3://$SITE_BUCKET/$target" \
    --cache-control 'no-cache,max-age=0,must-revalidate' \
    --content-type "$content_type" \
    --only-show-errors
}

for entrypoint in "${mutable_entrypoints[@]}"; do
  if [[ -f "$BUILD_DIR/$entrypoint" ]]; then
    publish_mutable "$entrypoint" "$release_prefix"
    publish_mutable "$entrypoint" "$current_prefix"
    if [[ "$seed_previous" == true ]]; then
      publish_mutable "$entrypoint" "$previous_prefix"
    fi
    publish_mutable "$entrypoint" ''
  fi
done

# Keep index last in each snapshot, and make the live root index the final upload.
publish_mutable index.html "$release_prefix"
publish_mutable index.html "$current_prefix"
if [[ "$seed_previous" == true ]]; then
  publish_mutable index.html "$previous_prefix"
fi
publish_mutable index.html ''

invalidation_id="$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths \
    '/' \
    '/index.html' \
    '/index.csr.html' \
    '/ngsw.json' \
    '/sw.js' \
    '/ngsw-worker.js' \
    '/safety-worker.js' \
    '/worker-basic.min.js' \
    '/manifest.webmanifest' \
    '/robots.txt' \
    '/sitemap.xml' \
  --query 'Invalidation.Id' \
  --output text)"
aws cloudfront wait invalidation-completed \
  --distribution-id "$DISTRIBUTION_ID" \
  --id "$invalidation_id"
