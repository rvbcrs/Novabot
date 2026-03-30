/**
 * DemoBanner — compact toggle bar at top of screen.
 * Shows current demo activity + cycle button when active.
 */
import React from 'react';
import { View, Text, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useDemo } from '../context/DemoContext';

export function DemoBanner() {
  const { enabled, toggle, activity, cycleActivity } = useDemo();

  return (
    <View style={[styles.container, enabled && styles.containerActive]}>
      <Ionicons
        name={enabled ? 'flask' : 'flask-outline'}
        size={16}
        color={enabled ? '#c084fc' : colors.textMuted}
      />
      <Text style={[styles.label, enabled && styles.labelActive]}>
        {enabled ? `Demo: ${activity}` : 'Demo'}
      </Text>

      {enabled && (
        <TouchableOpacity
          style={styles.cycleButton}
          onPress={cycleActivity}
          activeOpacity={0.7}
        >
          <Text style={styles.cycleText}>Next</Text>
          <Ionicons name="arrow-forward" size={12} color="#c084fc" />
        </TouchableOpacity>
      )}

      <Switch
        value={enabled}
        onValueChange={toggle}
        trackColor={{ false: '#374151', true: 'rgba(192,132,252,0.3)' }}
        thumbColor={enabled ? '#c084fc' : '#6b7280'}
        style={styles.switch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 10,
    marginBottom: 12,
  },
  containerActive: {
    backgroundColor: 'rgba(192,132,252,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(192,132,252,0.2)',
  },
  label: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
  },
  labelActive: {
    color: '#c084fc',
  },
  cycleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(192,132,252,0.15)',
    borderRadius: 6,
  },
  cycleText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#c084fc',
  },
  switch: {
    transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }],
  },
});
