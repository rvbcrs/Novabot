import React, { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Application from 'expo-application';
import { useStyles, useTheme, type Colors } from '../theme';
import { useI18n } from '../i18n';
import {
  downloadApk,
  installApk,
  setSkippedVersion,
  type AppLatest,
} from '../services/appUpdate';

type Props = {
  latest: AppLatest;
  onClose: () => void;
};

export function UpdatePromptModal({ latest, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const styles = useStyles(makeStyles);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const installed = Application.nativeApplicationVersion ?? '?';
  const isIos = Platform.OS === 'ios';

  async function handleUpdate() {
    if (isIos) {
      await Linking.openURL('https://github.com/rvbcrs/Novabot/releases/latest');
      onClose();
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { uri } = await downloadApk(latest.apkUrl, setProgress);
      await installApk(uri);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip() {
    await setSkippedVersion(latest.version);
    onClose();
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{t('update.title')}</Text>
          <Text style={styles.subtitle}>
            {installed} {'→'} {latest.version}
          </Text>

          {latest.releaseNotes ? (
            // Long bullet lists previously pushed the action buttons off
            // the bottom of the screen so the user couldn't dismiss the
            // dialog. Wrap the notes in a bounded ScrollView so the
            // buttons always stay visible regardless of release-note
            // length.
            <ScrollView
              style={styles.releaseNotesScroll}
              contentContainerStyle={styles.releaseNotesContent}
              showsVerticalScrollIndicator
              persistentScrollbar
              nestedScrollEnabled
            >
              <Text style={styles.releaseNotes}>{latest.releaseNotes}</Text>
            </ScrollView>
          ) : null}

          {error ? (
            <Text style={styles.errorText}>
              {t('update.errorPrefix')}: {error}
            </Text>
          ) : null}

          {busy ? (
            <View style={styles.progressRow}>
              <ActivityIndicator size="small" color={colors.emerald} />
              <Text style={styles.progressText}>
                {t('update.downloading')} {Math.round(progress * 100)}%
              </Text>
            </View>
          ) : null}

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.skipButton]}
              onPress={handleSkip}
              disabled={busy}
              activeOpacity={0.7}
            >
              <Text style={[styles.buttonText, busy && styles.disabledText]}>
                {t('update.skip')}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.laterButton]}
              onPress={onClose}
              disabled={busy}
              activeOpacity={0.7}
            >
              <Text style={[styles.buttonText, busy && styles.disabledText]}>
                {t('update.later')}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.updateButton, busy && styles.updateButtonBusy]}
              onPress={handleUpdate}
              disabled={busy}
              activeOpacity={0.7}
            >
              <Text style={styles.updateText}>
                {isIos ? t('update.openReleasePage') : t('update.update')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
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
      maxHeight: '85%',
      backgroundColor: c.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.cardBorder,
      padding: 20,
      gap: 12,
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
      color: c.text,
    },
    subtitle: {
      fontSize: 14,
      fontWeight: '600',
      color: c.emerald,
    },
    releaseNotesScroll: {
      maxHeight: 280,
    },
    releaseNotesContent: {
      paddingRight: 4,
    },
    releaseNotes: {
      fontSize: 13,
      color: c.textDim,
      lineHeight: 19,
    },
    errorText: {
      fontSize: 13,
      color: c.red,
      lineHeight: 18,
    },
    progressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    progressText: {
      fontSize: 13,
      color: c.textDim,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 4,
    },
    button: {
      flex: 1,
      height: 40,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 4,
    },
    skipButton: {
      backgroundColor: c.inputBg,
      borderWidth: 1,
      borderColor: c.cardBorder,
    },
    laterButton: {
      backgroundColor: c.inputBg,
      borderWidth: 1,
      borderColor: c.cardBorder,
    },
    updateButton: {
      backgroundColor: c.emerald,
    },
    updateButtonBusy: {
      opacity: 0.5,
    },
    buttonText: {
      fontSize: 13,
      fontWeight: '600',
      color: c.text,
      textAlign: 'center',
    },
    disabledText: {
      opacity: 0.4,
    },
    updateText: {
      fontSize: 13,
      fontWeight: '700',
      color: c.white,
      textAlign: 'center',
    },
  });
