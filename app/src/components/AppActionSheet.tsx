import React from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStyles, useTheme, type Colors } from '../theme';

export type AppActionSheetItem = {
  label: string;
  subtitle?: string;
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  destructive?: boolean;
  disabled?: boolean;
  onPress?: () => void;
};

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  actions: AppActionSheetItem[];
  cancelLabel?: string;
  onClose: () => void;
};

export function AppActionSheet({
  visible,
  title,
  message,
  actions,
  cancelLabel = 'Cancel',
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  const handleAction = (action: AppActionSheetItem) => {
    if (action.disabled) return;
    onClose();
    if (action.onPress) {
      setTimeout(() => action.onPress?.(), 120);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 14) + 8 }]}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}

          {actions.map((action, index) => (
            <TouchableOpacity
              key={`${action.label}-${index}`}
              style={[styles.item, action.disabled && styles.itemDisabled]}
              onPress={() => handleAction(action)}
              activeOpacity={0.82}
              disabled={action.disabled}
            >
              <View style={[styles.iconWrap, action.disabled && styles.iconWrapDisabled]}>
                <Ionicons
                  name={action.icon ?? 'chevron-forward-outline'}
                  size={18}
                  color={
                    action.disabled
                      ? colors.textMuted
                      : action.destructive
                        ? colors.red
                        : colors.text
                  }
                />
              </View>
              <View style={styles.textWrap}>
                <Text style={[styles.itemTitle, action.destructive && styles.itemTitleDestructive, action.disabled && styles.itemTitleDisabled]}>
                  {action.label}
                </Text>
                {action.subtitle ? <Text style={styles.itemSub}>{action.subtitle}</Text> : null}
              </View>
            </TouchableOpacity>
          ))}

          <TouchableOpacity style={styles.cancel} onPress={onClose} activeOpacity={0.82}>
            <Text style={styles.cancelText}>{cancelLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    backgroundColor: c.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 18,
    paddingTop: 12,
    borderTopWidth: 1,
    borderColor: c.cardBorder,
  },
  handle: {
    width: 52,
    height: 5,
    borderRadius: 999,
    alignSelf: 'center',
    backgroundColor: c.cardBorder,
    marginBottom: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
    color: c.text,
    marginBottom: 6,
  },
  message: {
    fontSize: 13,
    lineHeight: 18,
    color: c.textDim,
    marginBottom: 14,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
    marginBottom: 10,
  },
  itemDisabled: {
    opacity: 0.45,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  iconWrapDisabled: {
    backgroundColor: c.inputBg,
    opacity: 0.6,
  },
  textWrap: {
    flex: 1,
  },
  itemTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
  },
  itemTitleDestructive: {
    color: c.red,
  },
  itemTitleDisabled: {
    color: c.textMuted,
  },
  itemSub: {
    marginTop: 2,
    fontSize: 12,
    color: c.textDim,
  },
  cancel: {
    marginTop: 6,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.inputBg,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '700',
    color: c.text,
  },
});
