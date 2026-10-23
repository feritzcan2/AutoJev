#!/bin/bash

set -euo pipefail

readonly API_BASE="https://de.sentry.io/api/0"
readonly ORGANIZATION="agentloop-22"
readonly PROJECT="jobloop"
readonly PROJECT_ID="4512290640101456"
readonly KEYCHAIN_SERVICE="ai.termloop.sentry.api"

if ! command -v security >/dev/null 2>&1; then
  echo "macOS Keychain command 'security' is required." >&2
  exit 127
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required." >&2
  exit 127
fi

sentry_api_token="$(security find-generic-password -a "${USER}" -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null)" || {
  echo "Sentry token was not found in Keychain service ${KEYCHAIN_SERVICE}." >&2
  exit 1
}
trap 'unset sentry_api_token' EXIT

pretty_json() {
  node -e 'let value=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => { try { console.log(JSON.stringify(JSON.parse(value), null, 2)); } catch { process.stdout.write(value); } });'
}

api_get() {
  local path="$1"
  shift
  curl --fail --silent --show-error --get \
    --header "Authorization: Bearer ${sentry_api_token}" \
    --header "Accept: application/json" \
    "${API_BASE}${path}" \
    "$@" | pretty_json
}

api_put() {
  local path="$1" body="$2"
  curl --fail --silent --show-error --request PUT \
    --header "Authorization: Bearer ${sentry_api_token}" \
    --header "Content-Type: application/json" \
    --data "${body}" \
    "${API_BASE}${path}" | pretty_json
}

# One line per issue: short id, issue id, events, last seen, title.
issue_lines() {
  node -e 'let v=""; process.stdin.on("data", c => v += c).on("end", () => { for (const i of JSON.parse(v)) console.log([i.shortId, i.id, `${i.count}x`, i.lastSeen, i.title].join("  ")); });'
}

usage() {
  echo "Usage: sentry-scans.sh health | issues [period 24h|14d] [query] | list [period] [query] | latest <issue-id> | events <issue-id> | resolve <issue-id> | ignore <issue-id> | usage [period] | report [period] [active-days] | users [period]" >&2
}

command_name="${1:-}"
case "${command_name}" in
  health)
    api_get "/projects/${ORGANIZATION}/${PROJECT}/"
    ;;
  issues | list)
    period="${2:-14d}"
    query="${3:-is:unresolved}"
    out="$(curl --fail --silent --show-error --get \
      --header "Authorization: Bearer ${sentry_api_token}" \
      "${API_BASE}/organizations/${ORGANIZATION}/issues/" \
      --data-urlencode "project=${PROJECT_ID}" \
      --data-urlencode "statsPeriod=${period}" \
      --data-urlencode "sort=freq" \
      --data-urlencode "query=${query}")"
    if [[ "${command_name}" == list ]]; then printf '%s' "${out}" | issue_lines; else printf '%s' "${out}" | pretty_json; fi
    ;;
  latest)
    issue_id="${2:-}"
    if [[ -z "${issue_id}" ]]; then usage; exit 2; fi
    api_get "/organizations/${ORGANIZATION}/issues/${issue_id}/events/latest/"
    ;;
  events)
    issue_id="${2:-}"
    if [[ -z "${issue_id}" ]]; then usage; exit 2; fi
    api_get "/organizations/${ORGANIZATION}/issues/${issue_id}/events/" --data-urlencode "full=true"
    ;;
  resolve)
    issue_id="${2:-}"
    if [[ -z "${issue_id}" ]]; then usage; exit 2; fi
    api_put "/organizations/${ORGANIZATION}/issues/${issue_id}/" '{"status":"resolved"}'
    ;;
  usage)
    period="${2:-14d}"
    fields=(timestamp install_id environment "tags[sentry.release,string]" "tags[os,string]" "tags[providers,string]"
      "tags[window_hours,number]" "tags[scan_total,number]" "tags[scan_completed,number]"
      "tags[scan_partial,number]" "tags[scan_blocked,number]" "tags[scan_failed,number]"
      "tags[scan_timeout,number]" "tags[scan_interrupted,number]" "tags[trial_total,number]"
      "tags[trial_completed,number]" "tags[execute_completed,number]"
      "tags[execute_total,number]" "tags[execute_blocked,number]" "tags[execute_failed,number]"
      "tags[execute_blocker_needs_answer,number]" "tags[execute_blocker_needs_login,number]"
      "tags[execute_blocker_technical,number]" "tags[execute_blocker_site_problem,number]"
      "tags[execute_blocker_not_eligible,number]" "tags[execute_blocker_verification,number]"
      "tags[records_found,number]" "tags[workspaces,number]" "tags[sources,number]")
    args=()
    for field in "${fields[@]}"; do args+=(--data-urlencode "field=${field}"); done
    api_get "/organizations/${ORGANIZATION}/events/" \
      --data-urlencode "dataset=logs" \
      --data-urlencode "project=${PROJECT_ID}" \
      --data-urlencode "statsPeriod=${period}" \
      --data-urlencode "query=message:usage.daily" \
      --data-urlencode "sort=-timestamp" \
      --data-urlencode "per_page=1000" \
      "${args[@]}"
    ;;
  report)
    "$0" usage "${2:-14d}" | node "$(dirname "$0")/usage-report.mjs" "${3:-2}"
    ;;
  users)
    period="${2:-14d}"
    api_get "/organizations/${ORGANIZATION}/sessions/" \
      --data-urlencode "project=${PROJECT_ID}" \
      --data-urlencode "statsPeriod=${period}" \
      --data-urlencode "interval=1d" \
      --data-urlencode "field=sum(session)" \
      --data-urlencode "field=count_unique(user)" \
      --data-urlencode "groupBy=release"
    ;;
  ignore)
    issue_id="${2:-}"
    if [[ -z "${issue_id}" ]]; then usage; exit 2; fi
    api_put "/organizations/${ORGANIZATION}/issues/${issue_id}/" '{"status":"ignored","substatus":"archived_until_escalating"}'
    ;;
  *)
    usage
    exit 2
    ;;
esac
