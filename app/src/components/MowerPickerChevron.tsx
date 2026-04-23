/**
 * Home-header picker. Shows the active mower's display name plus a status
 * dot and firmware version; when there are two or more bound mowers, a tap
 * opens an inline dropdown with a row per mower. No full-screen modal — the
 * dropdown is absolute-positioned so the Home screen stays in view.
 *
 * N = 0: renders nothing (Home has its own empty state).
 * N = 1: renders the name + dot as static text (no chevron).
 * N >= 2: renders the chevron; tapping toggles the dropdown.
 *
 * The trigger row also hosts an optional pencil icon that opens a rename
 * flow for the CURRENTLY ACTIVE mower (dropdown rows never expose rename —
 * they only switch).
 */
import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useActiveMower } from '../hooks/useActiveMower';
import { mowerDisplayName } from '../utils/mowerDisplay';
import type { DeviceState } from '../types';

interface MowerPickerChevronProps {
  onAddMower?: () => void;
  /** Opens rename flow for the currently active mower. */
  onRename?: () => void;
}

function firmwareVersion(m: DeviceState): string | null {
  return m.sensors?.sw_version || m.sensors?.mower_version || null;
}

export function MowerPickerChevron({ onAddMower, onRename }: MowerPickerChevronProps = {}) {
  const { mowers, activeMower, activeMowerSn, setActiveMowerSn } = useActiveMower();
  const [open, setOpen] = useState(false);

  const count = mowers.length;
  // Dropdown opens when there are multiple mowers OR when we have an "Add mower" action to show.
  const canOpen = count >= 2 || !!onAddMower;

  if (count === 0 || !activeMower) return null;

  const activeVersion = firmwareVersion(activeMower);

  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.trigger}
        onPress={() => canOpen && setOpen((v) => !v)}
        disabled={!canOpen}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={
          canOpen
            ? `Active mower ${mowerDisplayName(activeMower)}. Tap to switch or add.`
            : `Active mower ${mowerDisplayName(activeMower)}.`
        }
      >
        <StatusDot online={activeMower.online} />
        <View style={styles.labelColumn}>
          <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
            {mowerDisplayName(activeMower)}
          </Text>
          {activeVersion && (
            <Text style={styles.subtitle} numberOfLines={1} ellipsizeMode="tail">
              {activeVersion}
            </Text>
          )}
        </View>
        {onRename && (
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              setOpen(false);
              onRename();
            }}
            hitSlop={10}
            style={styles.editBtn}
            accessibilityRole="button"
            accessibilityLabel="Rename active mower"
          >
            <Ionicons name="pencil" size={15} color={colors.textMuted} />
          </Pressable>
        )}
        {canOpen && (
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={colors.text}
            style={styles.chevron}
          />
        )}
      </Pressable>

      {open && (
        <>
          <Pressable
            style={styles.backdrop}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close mower picker"
          />
          <View style={styles.dropdown}>
            {mowers.map((m) => {
              const selected = m.sn === activeMowerSn;
              const version = firmwareVersion(m);
              return (
                <Pressable
                  key={m.sn}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => {
                    setActiveMowerSn(m.sn);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Switch to ${mowerDisplayName(m)}`}
                >
                  <StatusDot online={m.online} />
                  <View style={styles.labelColumn}>
                    <Text style={styles.rowName} numberOfLines={1} ellipsizeMode="tail">
                      {mowerDisplayName(m)}
                    </Text>
                    {version && (
                      <Text style={styles.subtitle} numberOfLines={1} ellipsizeMode="tail">
                        {version}
                      </Text>
                    )}
                  </View>
                  {selected && (
                    <Ionicons
                      name="checkmark"
                      size={18}
                      color={colors.emerald}
                      style={styles.check}
                    />
                  )}
                </Pressable>
              );
            })}
            {onAddMower && (
              <>
                <View style={styles.divider} />
                <Pressable
                  style={({ pressed }) => [
                    styles.addRow,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => {
                    setOpen(false);
                    onAddMower();
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Add a new mower"
                >
                  <Ionicons
                    name="add-circle-outline"
                    size={18}
                    color={colors.emerald}
                    style={styles.addIcon}
                  />
                  <Text style={styles.addLabel} numberOfLines={1} ellipsizeMode="tail">
                    Add mower
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </>
      )}
    </View>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <View
      style={[
        styles.dot,
        { backgroundColor: online ? colors.emerald : '#E5484D' },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    zIndex: 100,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    minHeight: 32,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  labelColumn: {
    flex: 1,
    flexShrink: 1,
    marginRight: 4,
  },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
    marginTop: 1,
  },
  editBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    marginLeft: 4,
  },
  chevron: {
    marginLeft: 6,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: -1000,
    right: -1000,
    bottom: -10000,
    backgroundColor: 'transparent',
  },
  dropdown: {
    position: 'absolute',
    top: 40,
    left: 0,
    backgroundColor: colors.bg,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 4,
    minWidth: 240,
    zIndex: 101,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  rowPressed: {
    backgroundColor: colors.cardBorder,
  },
  rowName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  check: {
    marginLeft: 8,
  },
  divider: {
    height: 1,
    backgroundColor: colors.cardBorder,
    marginVertical: 4,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  addIcon: {
    marginRight: 8,
  },
  addLabel: {
    flex: 1,
    color: colors.emerald,
    fontSize: 15,
    fontWeight: '600',
  },
});
