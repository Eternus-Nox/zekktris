package com.zekktris.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import com.zekktris.AppStore
import com.zekktris.Phase
import com.zekktris.ui.components.LoadingScreen
import com.zekktris.ui.screens.DeviceLoginScreen
import com.zekktris.ui.screens.LoginScreen
import com.zekktris.ui.screens.MainScreen
import com.zekktris.ui.screens.RegisterScreen
import com.zekktris.ui.screens.WelcomeScreen

private enum class AuthScreen { Welcome, Login, Register, DeviceLogin }

/** Top-level router keyed off the store's coarse [Phase]. */
@Composable
fun RootScreen(store: AppStore) {
    val state by store.state.collectAsState()
    when (state.phase) {
        // A cold start whose /auth/refresh is failing TRANSIENTLY stays here
        // (session intact, retrying on a ladder) instead of falling through to
        // Auth — see AppStore.bootstrap. `signInInstead` is the escape hatch.
        Phase.Loading -> LoadingScreen(
            reconnecting = state.reconnecting,
            onSignIn = { store.signInInstead() },
        )
        Phase.Auth -> {
            var screen by remember { mutableStateOf(AuthScreen.Welcome) }
            when (screen) {
                AuthScreen.Welcome -> WelcomeScreen(
                    onLogIn = { store.clearAuthError(); screen = AuthScreen.Login },
                    onCreateAccount = { store.clearAuthError(); screen = AuthScreen.Register },
                )
                AuthScreen.Login -> LoginScreen(
                    store,
                    state,
                    onDeviceLogin = { store.clearAuthError(); screen = AuthScreen.DeviceLogin },
                ) { store.cancel2FA(); screen = AuthScreen.Welcome }
                AuthScreen.Register -> RegisterScreen(store, state) { screen = AuthScreen.Welcome }
                // Cancelling returns to Login, not Welcome: the user came here
                // from there and may still want to type a password.
                AuthScreen.DeviceLogin -> DeviceLoginScreen(store) { screen = AuthScreen.Login }
            }
        }
        Phase.Ready -> MainScreen(store, state)
    }
}
