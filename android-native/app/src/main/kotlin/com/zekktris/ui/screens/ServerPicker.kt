package com.zekktris.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.data.Config
import com.zekktris.ui.components.zkFieldColors
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

/**
 * "Server: zekktris.com · Change" — shown on the welcome screen. Zekktris runs
 * on zekktris.com, and anyone can host their own server; this is where someone
 * points the app at one. Only reachable while signed out, because a session
 * belongs to the server that issued it. Mirrors iOS ServerRow.
 */
@Composable
fun ServerRow(modifier: Modifier = Modifier) {
    val p = ZkTheme.palette
    var showPicker by remember { mutableStateOf(false) }
    // Bumped on change so the label re-reads Config.
    var revision by remember { mutableStateOf(0) }
    Row(
        modifier = modifier.clickable { showPicker = true }.padding(8.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Server: ", color = ZkInk.ink3, fontSize = 13.sp)
        Text(if (revision >= 0) Config.serverDisplayName else "", color = ZkInk.ink2, fontSize = 13.sp)
        Text(" · Change", color = p.accent, fontSize = 13.sp)
    }
    if (showPicker) {
        ServerPickerDialog(
            onDismiss = { showPicker = false },
            onChanged = { revision++; showPicker = false },
        )
    }
}

/**
 * Pick the server to sign in to: zekktris.com, or the address of a
 * self-hosted one (a web address or a bare IP). The address is checked
 * against GET /api/v1/instance/info before it's saved, so a typo can't leave
 * the app pointed at nothing.
 */
@Composable
fun ServerPickerDialog(onDismiss: () -> Unit, onChanged: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var address by remember { mutableStateOf("") }
    var checking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun connect() {
        if (checking) return
        error = null
        val origin = Config.normalizeOrigin(address)
        if (origin == null) {
            error = if (address.trim().startsWith("http://", ignoreCase = true)) {
                "Plain http:// only works for a server on your home network. Use https://."
            } else {
                "That doesn't look like a server address."
            }
            return
        }
        checking = true
        scope.launch {
            val failure = probe(origin)
            checking = false
            if (failure == null) {
                Config.setServerOrigin(origin)
                onChanged()
            } else {
                error = failure
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = p.bg2,
        title = { Text("Server", color = ZkInk.ink1, fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "Zekktris runs on zekktris.com, and anyone can run their own server. Enter the address you were given — a web address like chat.example.com, or an IP address.",
                    color = ZkInk.ink2, fontSize = 14.sp,
                )
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it; error = null },
                    singleLine = true,
                    label = { Text("Server address") },
                    colors = zkFieldColors(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                    keyboardActions = androidx.compose.foundation.text.KeyboardActions(onGo = { connect() }),
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = ZkStatus.danger, fontSize = 13.sp) }
                if (!Config.isDefaultServer) {
                    TextButton(onClick = { Config.setServerOrigin(null); onChanged() }) {
                        Text("Go back to zekktris.com", color = p.accent)
                    }
                }
                Text(
                    "Now using ${Config.serverDisplayName}. Notifications only arrive from servers set up for this app; everything else works on any server.",
                    color = ZkInk.ink3, fontSize = 12.sp,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { connect() }, enabled = !checking && address.isNotBlank()) {
                Text(if (checking) "Checking…" else "Connect", color = p.accent, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel", color = ZkInk.ink2) }
        },
    )
}

/** One GET to {origin}/api/v1/instance/info. Null = it's a Zekktris server;
 *  otherwise a message to show. */
private suspend fun probe(origin: String): String? = withContext(Dispatchers.IO) {
    val conn = runCatching { URL("$origin/api/v1/instance/info").openConnection() as HttpURLConnection }
        .getOrElse { return@withContext "That doesn't look like a server address." }
    try {
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        conn.setRequestProperty("Accept", "application/json")
        val code = conn.responseCode
        val body = if (code == 200) conn.inputStream.bufferedReader().use { it.readText() } else ""
        val software = runCatching { JSONObject(body).optString("software") }.getOrNull()
        if (code == 200 && software == "zekktris") null
        else "Something answered at that address, but it isn't a Zekktris server (or it's too old — its owner should update it)."
    } catch (_: SSLException) {
        "That server's HTTPS certificate isn't valid. Its owner needs to finish setting up HTTPS."
    } catch (_: Exception) {
        "Couldn't reach that server. Check the address, and that the server is running."
    } finally {
        conn.disconnect()
    }
}
