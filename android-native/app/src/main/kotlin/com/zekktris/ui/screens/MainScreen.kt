package com.zekktris.ui.screens

import androidx.compose.runtime.Composable
import com.zekktris.AppState
import com.zekktris.AppStore

/** Authenticated root: settings overlay, chat view, or the home shell. */
@Composable
fun MainScreen(store: AppStore, state: AppState) {
    when {
        state.showSettings -> SettingsScreen(store, state)
        state.selectedChannelId != null -> ChatScreen(store, state)
        else -> HomeShell(store, state)
    }
}
