#!/bin/bash
# NOVA daily auto-scan — credentials sourced from protected /opt/nova/.scan_creds (0600)
set -a; . /opt/nova/.scan_creds 2>/dev/null; set +a
B="https://127.0.0.1"
TOKEN=$(curl -sk -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${NOVA_USER}\",\"password\":\"${NOVA_PASS}\"}" | grep -oP '"token":"\K[^"]+')
if [ -z "$TOKEN" ]; then echo "[$(date -Is)] login failed"; exit 1; fi
curl -sk -X POST "$B/api/scan/full-system" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"hostId":"ssh-172.12.26.127","mode":"deep"}' >/dev/null
for i in $(seq 1 60); do
  sleep 3
  R=$(curl -sk "$B/api/scan/latest" -H "Authorization: Bearer $TOKEN")
  SCORE=$(echo "$R" | grep -oP '"overallScore":\K[0-9]+' | head -1)
  HEALTH=$(echo "$R" | grep -oP '"health":"\K[^"]+' | head -1)
  if [ -n "$SCORE" ] && [ $(( $(date +%s) - $(stat -c %Y /opt/nova/backend/reports/latest.json 2>/dev/null || echo 0) )) -lt 120 ]; then
    echo "[$(date -Is)] daily scan complete: ${SCORE}/100 ${HEALTH}"; exit 0
  fi
done
echo "[$(date -Is)] daily scan: timed out waiting for report"; exit 1
