#!/bin/bash
# deploy.sh — Deploy open robot_decision naar maaier
#
# STRATEGIE: Vervangt de originele C++ binary door een shell wrapper die
# onze Python versie start. Hierdoor start novabot_launch onze code op
# het juiste moment, met correcte DDS timing (geen kill/restart, geen
# DDS state corruptie).
#
# Usage:
#   ./deploy.sh              Deploy + installeer wrapper + herstart
#   ./deploy.sh --hot        Alleen Python files kopiëren (geen reboot)
#   ./deploy.sh --rollback   Herstel originele C++ binary
#   ./deploy.sh --status     Toon huidige status
#
# Na deploy: maaier moet rebooten zodat novabot_launch de wrapper start.
# Na rollback: maaier moet rebooten.
#
# Rollback op maaier zelf:
#   cp /root/novabot/install/compound_decision/lib/compound_decision/robot_decision.orig \
#      /root/novabot/install/compound_decision/lib/compound_decision/robot_decision && reboot

set -e

MOWER=192.168.0.244
MOWER_USER=root
DEPLOY_DIR=/userdata/open_decision
LOG_FILE=$DEPLOY_DIR/decision.log
BINARY_DIR=/root/novabot/install/compound_decision/lib/compound_decision
BINARY=$BINARY_DIR/robot_decision
BACKUP=$BINARY_DIR/robot_decision.orig
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export SSHPASS=novabot
SSH="sshpass -e ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no $MOWER_USER@$MOWER"
SCP="sshpass -e scp -o ConnectTimeout=10 -o StrictHostKeyChecking=no"

case "${1:-deploy}" in
    --rollback)
        echo ">>> Rollback: herstel originele C++ binary..."
        if $SSH "test -f $BACKUP"; then
            $SSH "cp $BACKUP $BINARY && chmod +x $BINARY"
            # Verwijder oude boot hook uit run_novabot.sh als die er is
            $SSH "sed -i '/# CUSTOM: Open robot_decision/,/^  fi$/d' /root/novabot/scripts/run_novabot.sh 2>/dev/null || true"
            $SSH "sed -i '/pkill.*python3.*robot_decision/d' /root/novabot/scripts/run_novabot.sh 2>/dev/null || true"
            echo ">>> Originele binary hersteld. Reboot de maaier: reboot"
        else
            echo ">>> FOUT: Geen backup gevonden op $BACKUP"
            echo ">>> De originele binary is niet vervangen, of de backup is verwijderd."
            exit 1
        fi
        ;;

    --hot)
        echo ">>> Hot deploy: alleen Python files kopiëren (geen reboot nodig)..."
        $SSH "mkdir -p $DEPLOY_DIR"
        $SCP "$SCRIPT_DIR"/*.py "$MOWER_USER@$MOWER:$DEPLOY_DIR/"
        echo ">>> Python files gekopieerd."
        echo ">>> Herstart: kill Python process of reboot maaier"
        echo "    $SSH 'pkill -f \"python3.*robot_decision\"; sleep 1'"
        echo ">>> daemon_node zal de wrapper opnieuw starten."
        ;;

    --status)
        echo ">>> Status check..."
        echo ""
        echo "Binary:"
        $SSH "file $BINARY 2>/dev/null || echo 'niet gevonden'"
        echo ""
        echo "Backup:"
        $SSH "test -f $BACKUP && echo 'backup aanwezig' || echo 'GEEN backup'"
        echo ""
        echo "Python files:"
        $SSH "ls -la $DEPLOY_DIR/*.py 2>/dev/null | wc -l | xargs -I{} echo '{} python files'"
        echo ""
        echo "Running:"
        $SSH "ps aux | grep robot_decision | grep -v grep || echo 'niet actief'"
        ;;

    deploy|*)
        echo ">>> [1/5] Deploy dir aanmaken..."
        $SSH "mkdir -p $DEPLOY_DIR"

        echo ">>> [2/5] Python files kopiëren..."
        $SCP "$SCRIPT_DIR"/*.py "$MOWER_USER@$MOWER:$DEPLOY_DIR/"

        echo ">>> [3/5] Originele binary backuppen..."
        # Alleen backup als het nog een ELF binary is (niet onze wrapper)
        IS_ELF=$($SSH "file $BINARY 2>/dev/null | grep -c ELF || echo 0")
        if [ "$IS_ELF" -gt 0 ]; then
            $SSH "cp $BINARY $BACKUP"
            echo "    Backup: $BACKUP"
        else
            echo "    Wrapper al geïnstalleerd (binary is script, niet ELF)"
        fi

        echo ">>> [4/5] Binary wrapper installeren..."
        # Maak een shell wrapper die Python start i.p.v. de C++ binary.
        # 'exec' vervangt het shell process door Python — novabot_launch
        # ziet Python als het child process en kan het normaal managen.
        # Alle --ros-args van het launch systeem worden doorgegeven via "$@".
        $SSH "cat > $BINARY << 'WRAPPER'
#!/bin/bash
# Open robot_decision wrapper — vervangt C++ binary
# Origineel: robot_decision.orig
# Rollback: cp robot_decision.orig robot_decision && reboot
export PYTHONPATH=\${PYTHONPATH}:/userdata/open_decision
exec python3 /userdata/open_decision/robot_decision.py "\$@" \\
    > /userdata/open_decision/decision.log 2>&1
WRAPPER
chmod +x $BINARY"

        # Verwijder oude boot hook uit run_novabot.sh (niet meer nodig)
        HOOK_EXISTS=$($SSH "grep -c 'open_decision' /root/novabot/scripts/run_novabot.sh 2>/dev/null || echo 0")
        if [ "$HOOK_EXISTS" -gt 0 ]; then
            echo ">>> Oude boot hook verwijderen (niet meer nodig met wrapper)..."
            $SSH "sed -i '/# CUSTOM: Open robot_decision/,/open_decision.log$/d' /root/novabot/scripts/run_novabot.sh 2>/dev/null || true"
            $SSH "sed -i '/pkill.*python3.*robot_decision/d' /root/novabot/scripts/run_novabot.sh 2>/dev/null || true"
        fi

        echo ">>> [5/5] Klaar!"
        echo ""
        echo "    De wrapper is geïnstalleerd. Na een reboot start novabot_launch"
        echo "    automatisch de Python robot_decision."
        echo ""
        echo "    Reboot nu:    $SSH reboot"
        echo "    Logs:         $SSH tail -f $LOG_FILE"
        echo "    Rollback:     ./deploy.sh --rollback"
        echo ""
        echo "    Voor direct testen (zonder reboot):"
        echo "    $SSH 'killall -9 robot_decision; pkill -9 -f python3.*robot_decision; sleep 2; bash $BINARY --ros-args --params-file /root/novabot/install/compound_decision/share/compound_decision/config/robot_decision.yaml &'"
        ;;
esac
