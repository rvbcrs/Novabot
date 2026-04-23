import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useI18n } from '../i18n';

type Props = {
  visible: boolean;
  /** Titel boven het modal, bv. "Edge mowing" of "Spot mow". */
  title: string;
  /** Body tekst die de actie toelicht. */
  message?: string;
  /** Initiële hoogte in cm (2-9). Default 5. */
  initialHeightCm?: number;
  /** Knop-tekst voor bevestigen. Default "Start". */
  confirmLabel?: string;
  onConfirm: (heightCm: number) => void;
  onCancel: () => void;
};

/**
 * Lichtgewicht modal dat de maaier-hoogte laat kiezen voor acties die vroeger
 * direct startten zonder bevestiging (edge/spot mow). User-spec 2026-04-21:
 * ELKE maai-actie moet om de maaihoogte vragen voordat de command naar de
 * maaier gaat. Hergebruikt de stepper-UI van StartMowSheet zodat de look&feel
 * consistent is.
 *
 * De hoogte is in DISPLAY cm (2-9). De callee converteert naar wire format
 * (cm - 2) waar nodig — zie cutting-height-mapping.md.
 */
export default function CuttingHeightPickerModal({
  visible,
  title,
  message,
  initialHeightCm = 5,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const [height, setHeight] = useState(initialHeightCm);

  useEffect(() => {
    if (visible) setHeight(initialHeightCm);
  }, [visible, initialHeightCm]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Ionicons name="cut-outline" size={20} color={colors.emerald} />
            <Text style={styles.title}>{title}</Text>
          </View>
          {message ? <Text style={styles.message}>{message}</Text> : null}

          <View style={styles.section}>
            <View style={styles.labelRow}>
              <Text style={styles.label}>{t('cuttingHeight')}</Text>
              <Text style={styles.labelValue}>{height} cm</Text>
            </View>
            <View style={styles.stepperRow}>
              <TouchableOpacity
                style={styles.stepperBtn}
                onPress={() => setHeight(h => Math.max(2, h - 1))}
                activeOpacity={0.7}
              >
                <Ionicons name="remove" size={20} color={colors.white} />
              </TouchableOpacity>
              <View style={styles.stepperValue}>
                <Text style={styles.stepperText}>{height} cm</Text>
              </View>
              <TouchableOpacity
                style={styles.stepperBtn}
                onPress={() => setHeight(h => Math.min(9, h + 1))}
                activeOpacity={0.7}
              >
                <Ionicons name="add" size={20} color={colors.white} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={onCancel}
              activeOpacity={0.7}
            >
              <Text style={styles.cancelText}>{t('cancel') || 'Cancel'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.confirmButton]}
              onPress={() => onConfirm(height)}
              activeOpacity={0.7}
            >
              <Ionicons name="play" size={16} color={colors.white} />
              <Text style={styles.confirmText}>{confirmLabel ?? 'Start'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    padding: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.white,
  },
  message: {
    fontSize: 14,
    color: colors.textDim,
    lineHeight: 19,
    marginBottom: 12,
  },
  section: {
    marginTop: 4,
    marginBottom: 16,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  labelValue: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.emerald,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepperBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValue: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.white,
    fontVariant: ['tabular-nums'],
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  cancelButton: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  confirmButton: {
    backgroundColor: colors.emerald,
  },
  confirmText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.white,
  },
});
