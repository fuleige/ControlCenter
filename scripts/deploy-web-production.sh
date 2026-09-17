#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Production Web deployment must run as root so it can update Nginx and /var/www." >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
production_root="${CONTROLLER_CENTER_WEB_ROOT:-/var/www/controller-center-web}"
nginx_config_target="${CONTROLLER_CENTER_NGINX_CONFIG:-/etc/nginx/conf.d/controller-center-web.conf}"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
release_directory="$production_root/releases/$release_id"
next_link="$production_root/.current-$release_id"

cd "$repository_root"
npm run build -w @controller-center/web

install -d -m 0755 "$release_directory"
cp -a apps/web/dist/. "$release_directory/"
install -D -m 0644 deploy/nginx/controller-center-web.conf "$nginx_config_target"
nginx -t

ln -s "$release_directory" "$next_link"
mv -Tf "$next_link" "$production_root/current"
nginx -s reload

echo "Controller Center production Web deployed to $release_directory"
echo "Production URL: http://127.0.0.1:5173"
