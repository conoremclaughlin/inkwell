import { useEffect, useState } from 'react';
import { Pressable } from 'react-native';
import { DarkTheme, NavigationContainer, useNavigation } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { AuthStackParamList, RootStackParamList, TabParamList } from './src/navigation';
import { ThreadsScreen } from './src/screens/ThreadsScreen';
import { ThreadScreen } from './src/screens/ThreadScreen';
import { FleetScreen } from './src/screens/FleetScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { NewThreadScreen } from './src/screens/NewThreadScreen';
import { SessionScreen } from './src/screens/SessionScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { SignUpScreen } from './src/screens/SignUpScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import {
  ChatIcon,
  FleetIcon,
  PlusIcon,
  SettingsIcon,
  ThreadsIcon,
} from './src/components/TabIcons';
import { getAuthState, loadAuth, subscribeAuth, type AuthState } from './src/lib/auth';
import { loadPreferences } from './src/lib/storage';
import { colors } from './src/ui/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // Phones drop off networks constantly; coming back should refetch.
      refetchOnReconnect: true,
      // Wired to AppState below — foregrounding the app refetches everything.
      refetchOnWindowFocus: true,
    },
  },
});

// react-query's focus tracking is browser-shaped; on native, "focus" is the
// app returning to the foreground.
function useAppStateFocus() {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    });
    return () => sub.remove();
  }, []);
}

const Stack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tab = createBottomTabNavigator<TabParamList>();

const stackHeaderOptions = {
  headerStyle: { backgroundColor: colors.ink },
  headerShadowVisible: false,
  headerTintColor: colors.textPrimary,
  headerTitleStyle: { fontSize: 16 },
  contentStyle: { backgroundColor: colors.ink },
} as const;

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.ink,
    card: colors.well,
    text: colors.textPrimary,
    border: colors.borderSubtle,
    primary: colors.accent,
  },
};

function Tabs() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <Tab.Navigator
      screenOptions={{
        headerRight: () => (
          <Pressable
            onPress={() => navigation.navigate('Settings')}
            hitSlop={12}
            style={{ paddingHorizontal: 4 }}
            accessibilityLabel="Settings"
            accessibilityRole="button"
          >
            <SettingsIcon color={colors.textSecondary} />
          </Pressable>
        ),
        headerStyle: { backgroundColor: colors.ink },
        headerShadowVisible: false,
        headerTintColor: colors.textPrimary,
        headerTitleStyle: { fontSize: 17, fontWeight: '600' },
        tabBarStyle: { backgroundColor: colors.well, borderTopColor: colors.borderSubtle },
        tabBarActiveTintColor: colors.accentBright,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tab.Screen
        name="Threads"
        component={ThreadsScreen}
        options={{
          tabBarIcon: ({ color, size }) => <ThreadsIcon color={color} size={size} />,
          headerRight: () => (
            <>
              <Pressable
                onPress={() => navigation.navigate('NewThread')}
                hitSlop={12}
                style={{ paddingHorizontal: 8 }}
                accessibilityLabel="New thread"
                accessibilityRole="button"
              >
                <PlusIcon color={colors.textSecondary} />
              </Pressable>
              <Pressable
                onPress={() => navigation.navigate('Settings')}
                hitSlop={12}
                style={{ paddingHorizontal: 4 }}
                accessibilityLabel="Settings"
                accessibilityRole="button"
              >
                <SettingsIcon color={colors.textSecondary} />
              </Pressable>
            </>
          ),
        }}
      />
      <Tab.Screen
        name="Chat"
        component={ChatScreen}
        options={{ tabBarIcon: ({ color, size }) => <ChatIcon color={color} size={size} /> }}
      />
      <Tab.Screen
        name="Fleet"
        component={FleetScreen}
        options={{ tabBarIcon: ({ color, size }) => <FleetIcon color={color} size={size} /> }}
      />
    </Tab.Navigator>
  );
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>(getAuthState());
  const [booted, setBooted] = useState(false);
  useAppStateFocus();

  useEffect(() => {
    const unsubscribe = subscribeAuth(setAuth);
    void Promise.all([loadAuth(), loadPreferences()]).then(() => setBooted(true));
    return unsubscribe;
  }, []);

  // Signing out (or a dead refresh token) must not leave another account's
  // threads in cache.
  useEffect(() => {
    if (booted && !auth.refreshToken) queryClient.clear();
  }, [booted, auth.refreshToken]);

  if (!booted) return null; // Keychain read is fast; a splash frame, not a screen.

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" />
        <NavigationContainer theme={navTheme}>
          {auth.refreshToken ? (
            <Stack.Navigator screenOptions={stackHeaderOptions}>
              <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
              <Stack.Screen
                name="Thread"
                component={ThreadScreen}
                options={({ route }) => ({ title: route.params.title ?? route.params.threadKey })}
              />
              <Stack.Screen
                name="NewThread"
                component={NewThreadScreen}
                options={{ title: 'New thread' }}
              />
              <Stack.Screen
                name="Session"
                component={SessionScreen}
                options={({ route }) => ({ title: route.params.title ?? 'Session' })}
              />
              <Stack.Screen name="Settings" component={SettingsScreen} />
            </Stack.Navigator>
          ) : (
            <AuthStack.Navigator screenOptions={stackHeaderOptions}>
              <AuthStack.Screen
                name="Login"
                component={LoginScreen}
                options={{ headerShown: false }}
              />
              <AuthStack.Screen
                name="SignUp"
                component={SignUpScreen}
                options={{ title: 'Create account' }}
              />
              <AuthStack.Screen
                name="Connect"
                component={ConnectScreen}
                options={{ title: 'Pair with dashboard' }}
              />
            </AuthStack.Navigator>
          )}
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
