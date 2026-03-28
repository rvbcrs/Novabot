import React, { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as SplashScreen from 'expo-splash-screen';
import { View } from 'react-native';
import { colors } from './src/theme/colors';
import type { RootStackParams } from './src/navigation/types';

// Keep splash visible while app loads
SplashScreen.preventAutoHideAsync();

import SettingsScreen from './src/screens/SettingsScreen';
import DeviceChoiceScreen from './src/screens/DeviceChoiceScreen';
import WifiScreen from './src/screens/WifiScreen';
import BleScanScreen from './src/screens/BleScanScreen';
import ProvisionScreen from './src/screens/ProvisionScreen';

const Stack = createNativeStackNavigator<RootStackParams>();

const DarkTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.emerald,
    background: colors.bg,
    card: colors.bg,
    text: colors.text,
    border: colors.cardBorder,
    notification: colors.emerald,
  },
};

const screenOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: colors.bg },
  animation: 'slide_from_right' as const,
};

export default function App() {
  const [appReady, setAppReady] = useState(false);

  useEffect(() => {
    // Simulate brief loading (fonts, etc.) then hide splash
    const timer = setTimeout(() => setAppReady(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  const onLayoutRootView = useCallback(async () => {
    if (appReady) {
      await SplashScreen.hideAsync();
    }
  }, [appReady]);

  if (!appReady) return null;

  return (
    <View style={{ flex: 1 }} onLayout={onLayoutRootView}>
    <NavigationContainer theme={DarkTheme}>
      <StatusBar style="light" />
      <Stack.Navigator initialRouteName="Settings" screenOptions={screenOptions}>
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="DeviceChoice" component={DeviceChoiceScreen} />
        <Stack.Screen name="Wifi" component={WifiScreen} />
        <Stack.Screen name="BleScan" component={BleScanScreen} />
        <Stack.Screen name="Provision" component={ProvisionScreen} />
      </Stack.Navigator>
    </NavigationContainer>
    </View>
  );
}
