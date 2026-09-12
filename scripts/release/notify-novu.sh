#!/usr/bin/env bash

set -euo pipefail

readonly DEFAULT_NOVU_API_URL="https://api.novu.co"
readonly DEFAULT_NOVU_TOPIC_KEY="spectrum-updates"
readonly DEFAULT_NOVU_WORKFLOW_ID="breaking-change-email"
readonly GITHUB_API_VERSION="2026-03-10"
readonly GITHUB_MARKDOWN_API_URL="https://api.github.com/markdown"
readonly RELEASE_TIME_ZONE="America/Los_Angeles"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "::error::required command not found: $1" >&2
    exit 1
  fi
}

require_environment_variable() {
  local variable_name="$1"

  if [[ -z "${!variable_name:-}" ]]; then
    echo "::error::required environment variable is empty: ${variable_name}" >&2
    exit 1
  fi
}

is_true() {
  case "$1" in
    1 | true | TRUE | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

for command_name in curl jq; do
  require_command "$command_name"
done

for variable_name in REPO VERSION RELEASE_NOTES RELEASE_TYPE SERVICE_NAME; do
  require_environment_variable "$variable_name"
done

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::REPO must use the owner/repository format" >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  echo "::error::VERSION must be a valid semantic version without a leading v" >&2
  exit 1
fi

if [[ "$RELEASE_TYPE" != "major" ]]; then
  echo "::error::RELEASE_TYPE must be major; minor and patch releases do not send breaking-change notifications" >&2
  exit 1
fi

readonly NOVU_API_URL="${NOVU_API_URL:-$DEFAULT_NOVU_API_URL}"
readonly NOVU_DRY_RUN="${NOVU_DRY_RUN:-true}"
readonly NOVU_TOPIC_KEY="${NOVU_TOPIC_KEY:-$DEFAULT_NOVU_TOPIC_KEY}"
readonly NOVU_WORKFLOW_ID="${NOVU_WORKFLOW_ID:-$DEFAULT_NOVU_WORKFLOW_ID}"
readonly RELEASE_DATE="${RELEASE_DATE:-$(TZ="$RELEASE_TIME_ZONE" date '+%B %d, %Y' | sed 's/ 0/ /')}"
readonly RELEASE_TAG="${RELEASE_TAG:-v${VERSION}}"
readonly RELEASE_URL="${RELEASE_URL:-https://github.com/${REPO}/releases/tag/${RELEASE_TAG}}"
readonly RELEASE_YEAR="${RELEASE_YEAR:-$(TZ="$RELEASE_TIME_ZONE" date '+%Y')}"
readonly NOVU_TRANSACTION_ID="${NOVU_TRANSACTION_ID:-${NOVU_WORKFLOW_ID}:${REPO}:${RELEASE_TAG}}"

if ! is_true "$NOVU_DRY_RUN"; then
  require_environment_variable NOVU_SECRET_KEY
fi

markdown_request="$(jq -nc \
  --arg context "$REPO" \
  --arg text "$RELEASE_NOTES" \
  '{context:$context, mode:"gfm", text:$text}')"

markdown_headers=(
  --header "Accept: text/html"
  --header "Content-Type: application/json"
  --header "X-GitHub-Api-Version: ${GITHUB_API_VERSION}"
)

if [[ -n "${GH_TOKEN:-}" ]]; then
  markdown_headers+=(--header "Authorization: Bearer ${GH_TOKEN}")
fi

release_notes_html="$(curl \
  --fail-with-body \
  --silent \
  --show-error \
  --location \
  --connect-timeout 10 \
  --max-time 60 \
  --retry 2 \
  --retry-all-errors \
  --retry-delay 2 \
  --request POST \
  "$GITHUB_MARKDOWN_API_URL" \
  "${markdown_headers[@]}" \
  --data "$markdown_request")"

novu_request="$(jq -nc \
  --arg releaseDate "$RELEASE_DATE" \
  --arg releaseNotesHtml "$release_notes_html" \
  --arg releaseTag "$RELEASE_TAG" \
  --arg releaseType "$RELEASE_TYPE" \
  --arg releaseUrl "$RELEASE_URL" \
  --arg releaseYear "$RELEASE_YEAR" \
  --arg repo "$REPO" \
  --arg serviceName "$SERVICE_NAME" \
  --arg topicKey "$NOVU_TOPIC_KEY" \
  --arg transactionId "$NOVU_TRANSACTION_ID" \
  --arg version "$VERSION" \
  --arg workflowId "$NOVU_WORKFLOW_ID" \
  '{
    name: $workflowId,
    to: {type: "Topic", topicKey: $topicKey},
    transactionId: $transactionId,
    payload: {
      repo: $repo,
      version: $version,
      releaseTag: $releaseTag,
      releaseType: $releaseType,
      serviceName: $serviceName,
      releaseDate: $releaseDate,
      releaseYear: $releaseYear,
      releaseNotesHtml: $releaseNotesHtml,
      releaseUrl: $releaseUrl
    }
  }')"

if is_true "$NOVU_DRY_RUN"; then
  echo "Novu dry run; no notification was sent. Request body:"
  jq . <<<"$novu_request"
  exit 0
fi

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

http_code="$(curl \
  --silent \
  --show-error \
  --connect-timeout 10 \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --max-time 60 \
  --retry 2 \
  --retry-all-errors \
  --retry-delay 2 \
  --request POST \
  "${NOVU_API_URL%/}/v1/events/trigger" \
  --header "Authorization: ApiKey ${NOVU_SECRET_KEY}" \
  --header "Content-Type: application/json" \
  --header "Idempotency-Key: ${NOVU_TRANSACTION_ID}" \
  --data "$novu_request")"

echo "Novu response (HTTP ${http_code}):"
if ! jq . "$response_file"; then
  cat "$response_file"
  echo
fi

if [[ ! "$http_code" =~ ^[0-9]{3}$ ]] || ((10#$http_code >= 400)); then
  echo "::error::Novu returned HTTP ${http_code}" >&2
  exit 1
fi

if ! jq -e '(.data // .) | .acknowledged == true and .status == "processed"' "$response_file" >/dev/null; then
  echo "::error::Novu did not acknowledge the workflow as processed" >&2
  exit 1
fi

returned_transaction_id="$(jq -r '(.data // .).transactionId // empty' "$response_file")"
echo "Novu accepted ${NOVU_WORKFLOW_ID} for topic ${NOVU_TOPIC_KEY}."
echo "Transaction ID: ${returned_transaction_id:-$NOVU_TRANSACTION_ID}"
