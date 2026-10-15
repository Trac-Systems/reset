#!/bin/sh
# Ubuntu 24.04. Review, then run as root on the intended host; never from the devnet.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run as root.' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo 'Linux only.' >&2; exit 1; }
if ! getent group reset >/dev/null; then groupadd --system reset; fi
if ! getent passwd reset >/dev/null; then
  useradd --system --gid reset --home-dir /srv/reset --no-create-home --shell /usr/sbin/nologin reset
else
  record=$(getent passwd reset)
  [ "$(printf '%s' "$record" | cut -d: -f6)" = /srv/reset ] &&
  [ "$(printf '%s' "$record" | cut -d: -f7)" = /usr/sbin/nologin ] &&
  [ "$(id -gn reset)" = reset ] && [ "$(id -nG reset)" = reset ] || {
    echo 'Existing reset account differs; review it manually.' >&2; exit 1;
  }
fi
install -d -o root -g reset -m 0750 /srv/reset /etc/reset
install -d -o reset -g reset -m 0700 /srv/reset/indexer /srv/reset/gateway /srv/reset/relay
install -d -o reset -g reset -m 0700 /srv/reset/indexer/pear /srv/reset/gateway/pear /srv/reset/relay/pear
install -d -o root -g root -m 0755 /opt/reset /opt/reset/releases
# Do not grant sudo or a login shell. Code/config stay owned by root.
