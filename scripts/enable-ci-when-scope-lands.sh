#!/usr/bin/env bash
# Enables the Windows CI workflow as soon as the gh token has the `workflow` scope,
# then pushes tag v0.1.0 so the release build kicks off. Safe to re-run.
#   SKIP_SCOPE_CHECK=1 bash scripts/enable-ci-when-scope-lands.sh   # test the push path once
set -u
cd /home/ubuntu/scribe || exit 3

scope_present() {
  if [ -n "${SKIP_SCOPE_CHECK:-}" ]; then return 0; fi
  curl -sI -H "Authorization: token $(gh auth token)" https://api.github.com/user \
    | grep -i '^x-oauth-scopes' | grep -q workflow
}

remote_has_workflow() {
  git fetch -q origin main || return 0   # on fetch failure assume present: do nothing rather than double-push
  git cat-file -e origin/main:.github/workflows/windows-build.yml 2>/dev/null
}

# ONESHOT=1: a single check that exits 0 if CI is already enabled remotely, 1 if the scope is still missing.
# Used by the systemd timer, which retries on its own schedule and no-ops after success.
if [ -n "${ONESHOT:-}" ]; then
  if remote_has_workflow; then echo "$(date -Is) CI workflow already on origin/main — nothing to do"; exit 0; fi
  if ! scope_present; then echo "$(date -Is) no workflow scope yet — will retry on the next timer tick"; exit 0; fi
fi

for _ in $(seq 1 180); do
  if scope_present; then
    if remote_has_workflow; then
      echo "WORKFLOW_ALREADY_PRESENT_REMOTELY"
    else
      mkdir -p .github/workflows
      cp ci/windows-build.yml .github/workflows/windows-build.yml
      git add .github/workflows/windows-build.yml
      git commit -q -m "Enable the Windows CI build (gh token now has the workflow scope)" || true
      if git push -q origin main; then
        echo "PUSHED_WORKFLOW"
      else
        echo "PUSH_WORKFLOW_FAILED_STILL_NO_SCOPE"
        git reset -q --hard origin/main
      fi
    fi
    git tag -f -a v0.1.0 -m "Scribe 0.1.0" >/dev/null 2>&1
    if git push -q -f origin v0.1.0; then echo "PUSHED_TAG_V0.1.0"; else echo "PUSH_TAG_FAILED"; fi
    sleep 30
    gh run list --limit 3 --json databaseId,status,event,headBranch \
      -q '.[] | "\(.databaseId)\t\(.status)\t\(.event)\t\(.headBranch)"' 2>/dev/null
    exit 0
  fi
  sleep 20
done
echo "TIMED_OUT_NO_SCOPE"
exit 1
