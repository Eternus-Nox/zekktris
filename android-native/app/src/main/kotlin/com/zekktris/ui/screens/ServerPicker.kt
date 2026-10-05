package com.zekktris.ui.screens

import androidx.compose.foundation.border
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
import androidx.compose.ui.draw.clip
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
 * "Server: zekktris.com · Change" — a bordered chip near the top of the
 * welcome, sign-in and sign-up screens. Zekktris runs on zekktris.com, and
 * anyone can host their own server; this is where someone points the app at
 * one (a web address or just an IP). Only reachable while signed out, because
 * a session belongs to the server that issued it. Mirrors iOS ServerRow.
 * [onChanged] fires after a switch so the screen can re-read the server's
 * sign-up rules.
 */
@Composable
fun ServerRow(modifier: Modifier = Modifier, onChanged: () -> Unit = {}) {
    val p = ZkTheme.palette
    var showPicker by remember { mutableStateOf(false) }
    // Bumped on change so the label re-reads Config.
    var revision by remember { mutableStateOf(0) }
    Row(
        modifier = modifier
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(50))
            .border(1.dp, p.line, androidx.compose.foundation.shape.RoundedCornerShape(50))
            .clickable { showPicker = true }
            .padding(horizontal = 14.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Server: ", color = ZkInk.ink3, fontSize = 13.sp)
        Text(if (revision >= 0) Config.serverDisplayName else "", color = ZkInk.ink1, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        Text("  ·  Change", color = p.accent, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
    if (showPicker) {
        ServerPickerDialog(
            onDismiss = { showPicker = false },
            onChanged = { revision++; showPicker = false; onChanged() },
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
            val (found, failure) = findServer(address, origin)
            checking = false
            if (found != null) {
                Config.setServerOrigin(found)
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

/** What a server tells the sign-in screens about itself (GET /instance/info). */
data class ServerInfo(
    /** "open" | "invite-only" | "closed" */
    val registration: String,
    /** False when the server is reached by a bare IP (WebAuthn needs a domain). */
    val passkeys: Boolean,
)

/**
 * The current server's [ServerInfo], re-fetched whenever [key] changes (pass a
 * counter that bumps on a server switch). Null while loading or when the
 * server can't be reached — callers then show everything, as before.
 */
@Composable
fun rememberServerInfo(key: Any? = null): ServerInfo? {
    var info by remember(key) { mutableStateOf<ServerInfo?>(null) }
    androidx.compose.runtime.LaunchedEffect(key) {
        info = probe(Config.serverOrigin).first
    }
    return info
}

/**
 * Someone typing "192.168.1.20" or "203.0.113.5" shouldn't need to know the
 * scheme or port. When they typed neither, try HTTPS first, then — for a
 * home-network address only — plain http on 80 and on 5550 (the installer's
 * --lan port). An explicit scheme or port is used as typed. Returns the
 * first origin that answers as a Zekktris server, or a message.
 */
private suspend fun findServer(typed: String, origin: String): Pair<String?, String?> {
    val uri = runCatching { java.net.URI(origin) }.getOrNull()
        ?: return null to "That doesn't look like a server address."
    val host = uri.host ?: return null to "That doesn't look like a server address."
    val explicit = typed.contains("://") || uri.port != -1
    val local = Config.isLocalHost(host)
    val candidates = buildList {
        add(origin)
        if (!explicit && local) {
            val h = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            add("http://$h")
            add("http://$h:5550")
        }
    }
    var firstError: String? = null
    for (candidate in candidates) {
        val (info, err) = probe(candidate)
        if (info != null) return candidate to null
        if (firstError == null) firstError = err
    }
    return null to (firstError ?: "Couldn't reach that server.")
}

/** One GET to {origin}/api/v1/instance/info → (info, null) for a Zekktris
 *  server, otherwise (null, a message to show). */
private suspend fun probe(origin: String): Pair<ServerInfo?, String?> = withContext(Dispatchers.IO) {
    val conn = runCatching { URL("$origin/api/v1/instance/info").openConnection() as HttpURLConnection }
        .getOrElse { return@withContext null to "That doesn't look like a server address." }
    try {
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        conn.setRequestProperty("Accept", "application/json")
        val code = conn.responseCode
        val body = if (code == 200) conn.inputStream.bufferedReader().use { it.readText() } else ""
        val json = runCatching { JSONObject(body) }.getOrNull()
        if (code == 200 && json?.optString("software") == "zekktris") {
            ServerInfo(
                registration = json.optString("registration", "open"),
                passkeys = json.optBoolean("passkeys", true),
            ) to null
        } else {
            null to "Something answered at that address, but it isn't a Zekktris server (or it's too old — its owner should update it)."
        }
    } catch (_: SSLException) {
        null to "That server's HTTPS certificate isn't valid. Its owner needs to finish setting up HTTPS."
    } catch (_: Exception) {
        null to "Couldn't reach that server. Check the address, and that the server is running."
    } finally {
        conn.disconnect()
    }
}
