/**
 * AppAlertModal — drop-in replacement for React Native's `Alert.alert`,
 * styled to match the rest of the app (cf. the rain-warning sheet in
 * StartMowSheet). Rendered once at the top of the tree by AppAlertProvider;
 * call sites use the `appAlert()` helper from `context/AppAlertContext`.
 */
import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, useStyles, type Colors } from '../theme';
import { useI18n } from '../i18n';

export type AppAlertButtonStyle = 'default' | 'cancel' | 'destructive';

export interface AppAlertButton {
  text: string;
  style?: AppAlertButtonStyle;
  onPress?: () => void;
}

export interface AppAlertOptions {
  title: string;
  message?: string;
  buttons?: AppAlertButton[];
  /** Optional Ionicons name to render at the top — defaults based on style. */
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  /** Optional accent color for the icon + accent border. */
  accent?: 'info' | 'warning' | 'destructive' | 'success';
}

interface Props {
  visible: boolean;
  options: AppAlertOptions | null;
  onDismiss: () => void;
}

const ACCENT_COLOR: Record<NonNullable<AppAlertOptions['accent']>, string> = {
  info:        '#60a5fa',
  warning:     '#f59e0b',
  destructive: '#ef4444',
  success:     '#10b981',
};

const DEFAULT_ICON: Record<NonNullable<AppAlertOptions['accent']>, React.ComponentProps<typeof Ionicons>['name']> = {
  info:        'information-circle',
  warning:     'warning',
  destructive: 'alert-circle',
  success:     'checkmark-circle',
};

export function AppAlertModal({ visible, options, onDismiss }: Props) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const { t } = useI18n();
  if (!options) return null;

  const accent = options.accent ?? 'info';
  const accentColor = ACCENT_COLOR[accent];
  const iconName = options.icon ?? DEFAULT_ICON[accent];
  const buttons: AppAlertButton[] = options.buttons && options.buttons.length > 0
    ? options.buttons
    : [{ text: t('ok'), style: 'default' }];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { borderColor: accentColor + '55' }]}>
          <View style={styles.headerRow}>
            <View style={[styles.iconCircle, { backgroundColor: accentColor + '22' }]}>
              <Ionicons name={iconName} size={26} color={accentColor} />
            </View>
            <Text style={styles.title}>{options.title}</Text>
          </View>
          {options.message ? (
            <Text style={styles.body}>{options.message}</Text>
          ) : null}
          {(() => {
            // When the dialog ships 3+ buttons (e.g. Cancel / Discard /
            // Save), put cancel + destructive next to each other on one
            // row and the primary action full-width below it. Standard
            // mobile dialog convention: "exit options" cluster, primary
            // action gets its own emphasis below.
            const secondary: { btn: AppAlertButton; idx: number }[] = [];
            const primary: { btn: AppAlertButton; idx: number }[] = [];
            buttons.forEach((b, idx) => {
              if (b.style === 'destructive' || b.style === 'cancel') secondary.push({ btn: b, idx });
              else primary.push({ btn: b, idx });
            });
            const useGroupedLayout = buttons.length > 2 && secondary.length >= 2 && primary.length >= 1;
            const renderBtn = (btn: AppAlertButton, idx: number) => {
              const isDestructive = btn.style === 'destructive';
              const isCancel = btn.style === 'cancel';
              const isPrimary = !isDestructive && !isCancel;
              // Primary buttons always use the same emerald regardless of
              // the dialog accent — the accent colors only the icon/border
              // so a destructive alert (e.g. unsaved-changes prompt) does
              // NOT also paint the "Save" button red.
              const bg = isDestructive
                ? '#ef4444'
                : isCancel
                  ? 'rgba(255,255,255,0.06)'
                  : '#10b981';
              const fg = isCancel ? colors.text : '#ffffff';
              return (
                <TouchableOpacity
                  key={idx}
                  style={[
                    styles.btn,
                    { backgroundColor: bg },
                    // fullWidth keeps flex:1 so a single button in its
                    // row stretches edge-to-edge.
                  ]}
                  onPress={() => {
                    onDismiss();
                    btn.onPress?.();
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.btnText, { color: fg, fontWeight: isPrimary || isDestructive ? '700' : '600' }]}>
                    {btn.text}
                  </Text>
                </TouchableOpacity>
              );
            };
            if (useGroupedLayout) {
              return (
                <View style={{ gap: 8 }}>
                  <View style={styles.buttonRow}>
                    {secondary.map(({ btn, idx }) => renderBtn(btn, idx))}
                  </View>
                  <View style={styles.buttonRow}>
                    {primary.map(({ btn, idx }) => renderBtn(btn, idx))}
                  </View>
                </View>
              );
            }
            return (
              <View style={[
                styles.buttonRow,
                buttons.length === 1 && { justifyContent: 'flex-end' },
              ]}>
                {buttons.map((btn, idx) => renderBtn(btn, idx))}
              </View>
            );
          })()}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: c.card,
    borderWidth: 1,
    borderRadius: 18,
    padding: 22,
    gap: 14,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: { width: 0, height: 8 } },
      android: { elevation: 12 },
    }),
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: c.text,
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    color: c.textDim,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  btn: {
    flex: 1,
    minWidth: 64,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {
    fontSize: 13,
    textAlign: 'center',
    includeFontPadding: false,
  },
});
