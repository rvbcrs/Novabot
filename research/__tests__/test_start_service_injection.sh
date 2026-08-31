#!/bin/bash
# Regressietest voor GH #82: build_custom_firmware.sh injecteerde zijn custom
# blokken DUBBEL in start_service.sh, omdat het anker
# "sudo apt install -y dnsmasq" twee keer in dat bestand staat (één keer
# uitgecommentarieerd) en `sed /re/r` na ELKE match invoegt.
#
# Draaien: bash research/__tests__/test_start_service_injection.sh
set -u

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/build_custom_firmware.sh"
fails=0

# 1) Elk injectie-anker in het build-script MOET op kolom 0 verankerd zijn.
loose=$(grep -n "sed -i '' '/sudo apt install -y dnsmasq/r" "$SCRIPT")
if [ -n "$loose" ]; then
    echo "FAIL: ongeankerd sed-adres (mist de ^) — injecteert dubbel:"
    echo "$loose"
    fails=1
else
    echo "ok: alle dnsmasq sed-ankers staan op kolom 0"
fi

# 2) Bewijs het gedrag op een namaak-start_service.sh met het anker twee keer,
#    precies zoals de echte (regel 163 echt, regel 237 in commentaar).
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/start_service.sh" <<'EOF'
sudo apt install -y dnsmasq
echo "iets anders"
#     sudo apt install -y dnsmasq
echo "start service finish"
EOF
echo "# CUSTOM BLOK" > "$tmp/block.sh"

sed -i '' '/^sudo apt install -y dnsmasq/r '"$tmp/block.sh" "$tmp/start_service.sh"
n=$(grep -c "# CUSTOM BLOK" "$tmp/start_service.sh")
if [ "$n" -ne 1 ]; then
    echo "FAIL: blok $n keer ingevoegd, verwacht 1"
    fails=1
else
    echo "ok: verankerde sed voegt het blok precies 1x in"
fi

[ "$fails" -eq 0 ] && echo "PASS" || echo "GEFAALD"
exit "$fails"
