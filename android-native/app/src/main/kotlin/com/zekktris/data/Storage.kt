package com.zekktris.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.preferencesDataStore

// Single app-wide DataStore. Backs the persistent cookie jar (so the httpOnly
// refresh cookie survives app restarts) and any small key/value prefs.
val Context.zekDataStore: DataStore<Preferences> by preferencesDataStore(name = "zekktris")
