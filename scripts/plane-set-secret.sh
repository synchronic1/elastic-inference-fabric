#!/usr/bin/env bash
# Store a secret in the Plane instance configuration (encrypted), reading the value from the
# terminal WITHOUT echoing it, so it never lands in shell history, chat, git or a compose file.
#   plane-set-secret.sh TYPESAFE_API_KEY         # prompts for the value
#   plane-set-secret.sh TYPESAFE_API_KEY --check # says whether it is set (never prints it)
#   plane-set-secret.sh TYPESAFE_API_KEY --unset
set -euo pipefail
NAME="${1:-}"; MODE="${2:-set}"
case "$NAME" in
  TYPESAFE_API_KEY) ;;
  *) echo "usage: $0 TYPESAFE_API_KEY [--check|--unset]" >&2; exit 2 ;;
esac
CTR="${PLANE_API_CONTAINER:-plane-app-api-1}"
run() { docker exec -i "$CTR" python3 manage.py shell -c "$1"; }
case "$MODE" in
  --check)
    run "
from plane.license.models import InstanceConfiguration as C
from plane.license.utils.instance_value import get_configuration_value
(v,) = get_configuration_value([{'key': '$NAME', 'default': ''}])
row = C.objects.filter(key='$NAME').first()
print('$NAME:', 'set (%d chars, encrypted=%s)' % (len(v or ''), bool(row and row.is_encrypted)) if v else 'not set')" 2>&1 | grep -v levelname ;;
  --unset)
    run "
from django.db import connection
with connection.cursor() as c:
    c.execute('DELETE FROM instance_configurations WHERE key = %s', ['$NAME'])
    print('removed rows:', c.rowcount)" 2>&1 | grep -v levelname ;;
  set)
    read -r -s -p "Value for $NAME (input hidden): " VAL; echo
    [ -n "$VAL" ] || { echo "empty; nothing stored" >&2; exit 1; }
    printf '%s' "$VAL" | run "
import sys
from plane.license.models import InstanceConfiguration as C
from plane.license.utils.encryption import encrypt_data
v = sys.stdin.read().strip()
obj = C._base_manager.filter(key='$NAME').first()   # includes soft-deleted rows (key is unique)
if obj is None:
    obj = C(key='$NAME', category='AI')
obj.deleted_at = None
obj.value = encrypt_data(v); obj.is_encrypted = True; obj.category = obj.category or 'AI'; obj.save()
print('stored $NAME (%d chars, encrypted)' % len(v))" 2>&1 | grep -v levelname ;;
  *) echo "unknown option $MODE" >&2; exit 2 ;;
esac
