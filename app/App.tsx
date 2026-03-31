import React, { useCallback, useEffect, useState, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  NavigationContainer,
  DefaultTheme,
  NavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as SplashScreen from 'expo-splash-screen';
import * as NavigationBar from 'expo-navigation-bar';
import { View, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './src/theme/colors';
import { DemoProvider } from './src/context/DemoContext';
import { DevModeProvider, useDevMode } from './src/context/DevModeContext';
import type {
  AuthStackParams,
  ProvisionStackParams,
  MainTabParams,
  SettingsStackParams,
} from './src/navigation/types';
import { getToken, getServerUrl } from './src/services/auth';
import { initSocket, disconnectSocket } from './src/services/socket';

// Keep splash visible while app loads
SplashScreen.preventAutoHideAsync();

// ── Screens ──────────────────────────────────────────────────────────────────

import LoginScreen from './src/screens/LoginScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import HomeScreen from './src/screens/HomeScreen';
import MapScreen from './src/screens/MapScreen';
import ScheduleScreen from './src/screens/ScheduleScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import MessagesScreen from './src/screens/MessagesScreen';
import AppSettingsScreen from './src/screens/AppSettingsScreen';
import OtaScreen from './src/screens/OtaScreen';
import MowerSettingsScreen from './src/screens/MowerSettingsScreen';

// Existing provisioning screens
import SettingsScreen from './src/screens/SettingsScreen';
import DeviceChoiceScreen from './src/screens/DeviceChoiceScreen';
import WifiScreen from './src/screens/WifiScreen';
import BleScanScreen from './src/screens/BleScanScreen';
import ProvisionScreen from './src/screens/ProvisionScreen';

// ── Navigators ───────────────────────────────────────────────────────────────

const AuthStack = createNativeStackNavigator<AuthStackParams>();
const ProvisionStack = createNativeStackNavigator<ProvisionStackParams>();
const SettingsStack = createNativeStackNavigator<SettingsStackParams>();
const Tab = createBottomTabNavigator<MainTabParams>();

// ── Theme ────────────────────────────────────────────────────────────────────

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

// ── Provision Tab (nested stack) ─────────────────────────────────────────────

function ProvisionTabScreen() {
  return (
    <ProvisionStack.Navigator screenOptions={screenOptions}>
      <ProvisionStack.Screen name="Settings" component={SettingsScreen} />
      <ProvisionStack.Screen name="DeviceChoice" component={DeviceChoiceScreen} />
      <ProvisionStack.Screen name="Wifi" component={WifiScreen} />
      <ProvisionStack.Screen name="BleScan" component={BleScanScreen} />
      <ProvisionStack.Screen name="Provision" component={ProvisionScreen} />
    </ProvisionStack.Navigator>
  );
}

// ── Settings Tab (nested stack for OTA + MowerSettings) ─────────────────────

function SettingsTabScreen({
  onLogout,
  onGoToProvision,
}: {
  onLogout: () => void;
  onGoToProvision: () => void;
}) {
  return (
    <SettingsStack.Navigator screenOptions={screenOptions}>
      <SettingsStack.Screen name="SettingsMain">
        {(props) => (
          <AppSettingsScreen
            onLogout={onLogout}
            onGoToProvision={() => props.navigation.navigate('ProvisionFlow' as never)}
            onGoToOta={() => props.navigation.navigate('OTA')}
            onGoToMowerSettings={() => props.navigation.navigate('MowerSettings')}
          />
        )}
      </SettingsStack.Screen>
      <SettingsStack.Screen name="OTA" component={OtaScreen} />
      <SettingsStack.Screen name="MowerSettings" component={MowerSettingsScreen} />
      <SettingsStack.Screen name="ProvisionFlow" component={ProvisionTabScreen} />
    </SettingsStack.Navigator>
  );
}

// ── Main Tabs (respects dev mode) ────────────────────────────────────────────

function MainTabs({ onLogout, onGoToProvision }: { onLogout: () => void; onGoToProvision: () => void }) {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.cardBorder,
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 88 : 64,
          paddingBottom: Platform.OS === 'ios' ? 28 : 8,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.emerald,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ color, size }) => {
          let iconName: React.ComponentProps<typeof Ionicons>['name'] = 'home';
          if (route.name === 'Home') iconName = 'home';
          else if (route.name === 'Map') iconName = 'map';
          else if (route.name === 'Schedules') iconName = 'calendar';
          else if (route.name === 'AppSettings') iconName = 'settings';
          return <Ionicons name={iconName} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarLabel: 'Home' }} />
      <Tab.Screen name="Map" component={MapScreen} options={{ tabBarLabel: 'Map' }} />
      <Tab.Screen name="Schedules" component={ScheduleScreen} options={{ tabBarLabel: 'Schedule' }} />

      {/* Settings — always last */}
      <Tab.Screen
        name="AppSettings"
        options={{ tabBarLabel: 'Settings' }}
      >
        {() => (
          <SettingsTabScreen
            onLogout={onLogout}
            onGoToProvision={onGoToProvision}
          />
        )}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

// ── Authenticated: dev mode = full app, otherwise provisioning only ──────────

function AuthenticatedApp({ onLogout, onGoToProvision }: { onLogout: () => void; onGoToProvision: () => void }) {
  const { unlocked } = useDevMode();

  if (unlocked) {
    return <MainTabs onLogout={onLogout} onGoToProvision={onGoToProvision} />;
  }

  // Locked mode: Provision + Settings (two tabs)
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopColor: colors.cardBorder,
          borderTopWidth: 1,
          height: Platform.OS === 'ios' ? 88 : 64,
          paddingBottom: Platform.OS === 'ios' ? 28 : 8,
          paddingTop: 8,
        },
        tabBarActiveTintColor: colors.emerald,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ color, size }) => {
          const iconName = route.name === 'ProvisionTab' ? 'bluetooth' : 'settings';
          return <Ionicons name={iconName} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="ProvisionTab" component={ProvisionTabScreen} options={{ tabBarLabel: 'Provision' }} />
      <Tab.Screen name="AppSettings" options={{ tabBarLabel: 'Settings' }}>
        {() => (
          <SettingsTabScreen onLogout={onLogout} onGoToProvision={onGoToProvision} />
        )}
      </Tab.Screen>
    </Tab.Navigator>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [appReady, setAppReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const navigationRef = useRef<NavigationContainerRef<MainTabParams>>(null);

  // Check for existing token on mount
  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const serverUrl = await getServerUrl();
        if (token && serverUrl) {
          setIsAuthenticated(true);
          // Initialize socket connection
          initSocket(serverUrl);
        }
      } catch {
        // No token found, stay on login
      }
      setAuthChecked(true);
    })();
  }, []);

  useEffect(() => {
    // Hide Android navigation bar
    if (Platform.OS === 'android') {
      NavigationBar.setVisibilityAsync('hidden');
      NavigationBar.setBehaviorAsync('overlay-swipe');
      NavigationBar.setBackgroundColorAsync(colors.bg);
    }
    // Wait for auth check, then show app
    const timer = setTimeout(() => setAppReady(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  const onLayoutRootView = useCallback(async () => {
    if (appReady && authChecked) {
      await SplashScreen.hideAsync();
    }
  }, [appReady, authChecked]);

  const handleLoginSuccess = useCallback(
    (_token: string, serverUrl: string) => {
      initSocket(serverUrl);
      setIsAuthenticated(true);
    },
    [],
  );

  const handleLogout = useCallback(() => {
    disconnectSocket();
    setIsAuthenticated(false);
  }, []);

  const handleGoToProvision = useCallback(() => {
    // Navigate to provision tab via the navigation container ref
    navigationRef.current?.navigate('ProvisionTab' as never);
  }, []);

  if (!appReady || !authChecked) return null;

  return (
    <DevModeProvider>
    <DemoProvider>
    <View style={{ flex: 1 }} onLayout={onLayoutRootView}>
      <NavigationContainer theme={DarkTheme} ref={navigationRef}>
        <StatusBar style="light" />
        {isAuthenticated ? (
          <AuthenticatedApp onLogout={handleLogout} onGoToProvision={handleGoToProvision} />
        ) : (
          <AuthStack.Navigator screenOptions={screenOptions}>
            <AuthStack.Screen name="Login">
              {(props) => (
                <LoginScreen {...props} onLoginSuccess={handleLoginSuccess} />
              )}
            </AuthStack.Screen>
            <AuthStack.Screen name="Register">
              {(props) => (
                <RegisterScreen
                  {...props}
                  onLoginSuccess={handleLoginSuccess}
                />
              )}
            </AuthStack.Screen>
          </AuthStack.Navigator>
        )}
      </NavigationContainer>
    </View>
    </DemoProvider>
    </DevModeProvider>
  );
}
