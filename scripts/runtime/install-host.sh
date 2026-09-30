#!/usr/bin/env bash
# Install only MDC's reviewed host files. Run with sudo after preparing the build.
set -euo pipefail

if [[ ${EUID} -ne 0 || $# -ne 1 ]]; then
  echo 'Usage: sudo bash scripts/runtime/install-host.sh PRIVATE_RENDERED_DIRECTORY' >&2
  exit 2
fi
source_dir=$(realpath -- "$1")
unit_source="$source_dir/multi-device-context.service"
caddy_source="$source_dir/multi-device-context.caddy"
unit_target=/etc/systemd/system/multi-device-context.service
caddy_target=/etc/caddy/Caddyfile.d/multi-device-context.caddy
if [[ -L "$unit_target" || -L "$caddy_target" ]]; then
  echo 'Refusing to replace a symlink at an app host-file destination' >&2
  exit 2
fi
for file in "$unit_source" "$caddy_source"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo 'Missing reviewed host file' >&2; exit 2; }
done

systemd-analyze verify "$unit_source"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
port=$(sed -nE 's/^  reverse_proxy 127\.0\.0\.1:([0-9]+)$/\1/p' "$caddy_source")
hostname=$(sed -nE 's@^http://([a-z0-9.-]+) \{@\1@p' "$caddy_source")
[[ "$port" =~ ^[1-9][0-9]{0,4}$ && "$hostname" =~ ^[a-z0-9.-]+$ ]] || { echo 'Invalid generated Caddy site' >&2; exit 2; }
(( port <= 65535 )) || exit 2

umask 077
backup_dir=$(mktemp -d /var/tmp/mdc-host-install.XXXXXXXX)
had_unit=false; had_caddy=false; was_active=false; was_enabled=false
if [[ -f "$unit_target" ]]; then cp -p -- "$unit_target" "$backup_dir/unit"; had_unit=true; fi
if [[ -f "$caddy_target" ]]; then cp -p -- "$caddy_target" "$backup_dir/caddy"; had_caddy=true; fi
if systemctl is-active --quiet multi-device-context.service; then was_active=true; fi
if systemctl is-enabled --quiet multi-device-context.service 2>/dev/null; then was_enabled=true; fi
success=false
restore() {
  status=$?
  if [[ "$success" != true ]]; then
    set +e
    recovery_failures=()
    if [[ "$was_enabled" != true ]]; then
      systemctl disable multi-device-context.service >/dev/null 2>&1 || recovery_failures+=('disable new service')
    fi
    if [[ "$had_unit" == true ]]; then
      cp -p -- "$backup_dir/unit" "$unit_target" || recovery_failures+=('restore service file')
    else
      rm -f -- "$unit_target" || recovery_failures+=('remove new service file')
    fi
    if [[ "$had_caddy" == true ]]; then
      cp -p -- "$backup_dir/caddy" "$caddy_target" || recovery_failures+=('restore Caddy fragment')
    else
      rm -f -- "$caddy_target" || recovery_failures+=('remove new Caddy fragment')
    fi
    systemctl daemon-reload || recovery_failures+=('reload systemd')
    if [[ "$was_active" == true ]]; then
      systemctl restart multi-device-context.service || recovery_failures+=('restart previous service')
    else
      systemctl stop multi-device-context.service || recovery_failures+=('stop new service')
    fi
    if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
      systemctl reload caddy || recovery_failures+=('reload previous Caddy configuration')
    else
      recovery_failures+=('validate previous Caddy configuration')
    fi
    if (( ${#recovery_failures[@]} > 0 )); then
      echo 'Host installation failed; recovery incomplete. Failed steps:' >&2
      printf '  - %s\n' "${recovery_failures[@]}" >&2
    else
      echo 'Host installation failed; previous host files and service state restored.' >&2
    fi
    echo 'Restore the previous application revision separately if this was an update.' >&2
    (( status != 0 )) || status=1
  fi
  echo "Host file backup: $backup_dir"
  exit "$status"
}
trap restore EXIT

install -m 0644 -- "$caddy_source" "$caddy_target"
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
install -m 0644 -- "$unit_source" "$unit_target"
systemctl daemon-reload
systemctl enable multi-device-context.service
systemctl restart multi-device-context.service
ready=false
for ((attempt=0; attempt<30; attempt++)); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/health/ready" >/dev/null; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'MDC did not become ready' >&2; exit 1; }
systemctl reload caddy
curl --fail --silent --max-time 5 -H "Host: $hostname" http://127.0.0.1/health/ready >/dev/null
systemctl is-enabled --quiet multi-device-context.service
systemctl is-active --quiet multi-device-context.service
success=true
echo 'MDC service enabled and healthy through Caddy; unrelated service files were not changed.'
