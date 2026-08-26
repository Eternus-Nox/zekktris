package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.SessionInfo
import com.zekktris.data.model.TwoFactorSecret
import com.zekktris.data.model.TwoFactorStatus
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.ui.platform.LocalContext
import com.zekktris.data.model.PasskeyInfo
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.QrCode
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.components.dayLabel
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkMono
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.launch

/** Filled input with password masking (iOS-style bg3 rounded field). */
@Composable
private fun SecureField(value: String, onChange: (String) -> Unit, placeholder: String, masked: Boolean = true) {
    val p = ZkTheme.palette
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(p.bg3)
            .padding(horizontal = 12.dp, vertical = 12.dp),
    ) {
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            visualTransformation = if (masked) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            textStyle = TextStyle(color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp),
            cursorBrush = SolidColor(p.accent),
            modifier = Modifier.fillMaxWidth(),
            decorationBox = { inner ->
                if (value.isEmpty()) Text(placeholder, color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 15.sp)
                inner()
            },
        )
    }
}

@Composable
private fun StatusText(msg: String?, isError: Boolean) {
    msg?.let {
        Text(it, color = if (isError) ZkStatus.dangerSoft else ZkStatus.success, fontFamily = ZkSans, fontSize = 13.sp)
    }
}

// ── Change password ──────────────────────────────────────────────────────────

@Composable
fun ChangePasswordScreen(store: AppStore, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf("") }
    var new by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }

    ScreenScaffold("Change Password", onBack = onBack) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            SectionLabel("CURRENT PASSWORD")
            SecureField(current, { current = it }, "Current password")
            SectionLabel("NEW PASSWORD")
            SecureField(new, { new = it }, "At least 8 characters")
            SectionLabel("CONFIRM NEW PASSWORD")
            SecureField(confirm, { confirm = it }, "Repeat new password")
            StatusText(msg, isError)
            PrimaryButton(
                if (busy) "Updating…" else "Update password",
                enabled = !busy && current.isNotEmpty() && new.length >= 8 && new == confirm,
            ) {
                busy = true; msg = null
                scope.launch {
                    val err = store.changePassword(current, new)
                    busy = false
                    if (err == null) {
                        msg = "Password updated."; isError = false
                        current = ""; new = ""; confirm = ""
                    } else {
                        msg = err; isError = true
                    }
                }
            }
            if (new.isNotEmpty() && confirm.isNotEmpty() && new != confirm) {
                Text("Passwords don't match.", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp)
            }
        }
    }
}

// ── Change username ──────────────────────────────────────────────────────────

@Composable
fun ChangeUsernameScreen(store: AppStore, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }

    ScreenScaffold("Change Username", onBack = onBack) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            SectionLabel("NEW USERNAME")
            SecureField(username, { username = it.lowercase().trim() }, "username", masked = false)
            SectionLabel("CURRENT PASSWORD")
            SecureField(password, { password = it }, "Password")
            Text("Usernames can be changed once every 90 days.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
            StatusText(msg, isError)
            PrimaryButton(
                if (busy) "Saving…" else "Save",
                enabled = !busy && username.isNotBlank() && password.isNotEmpty(),
            ) {
                busy = true; msg = null
                scope.launch {
                    val err = store.changeUsername(username, password)
                    busy = false
                    if (err == null) {
                        msg = "Username updated."; isError = false; password = ""
                    } else {
                        msg = err; isError = true
                    }
                }
            }
        }
    }
}

// ── Change email ─────────────────────────────────────────────────────────────

@Composable
fun ChangeEmailScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }

    ScreenScaffold("Change Email", onBack = onBack) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            state.me?.email?.let {
                Text("Current: $it", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp)
            }
            SectionLabel("NEW EMAIL")
            SecureField(email, { email = it.trim() }, "you@example.com", masked = false)
            SectionLabel("CURRENT PASSWORD")
            SecureField(password, { password = it }, "Password")
            StatusText(msg, isError)
            PrimaryButton(
                if (busy) "Sending…" else "Send verification email",
                enabled = !busy && email.contains("@") && password.isNotEmpty(),
            ) {
                busy = true; msg = null
                scope.launch {
                    val err = store.requestEmailChange(email, password)
                    busy = false
                    if (err == null) {
                        msg = "Check your inbox — we sent a verification link to the new address. Your email changes only after you confirm it."
                        isError = false; password = ""
                    } else {
                        msg = err; isError = true
                    }
                }
            }
        }
    }
}

// ── Two-factor authentication ────────────────────────────────────────────────

@Composable
fun TwoFactorScreen(store: AppStore, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    var status by remember { mutableStateOf<TwoFactorStatus?>(null) }
    var setup by remember { mutableStateOf<TwoFactorSecret?>(null) }
    var code by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var recovery by remember { mutableStateOf<List<String>?>(null) }
    var disabling by remember { mutableStateOf(false) }
    var disableCode by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun refresh() { status = store.totpStatus() }
    LaunchedEffect(Unit) { refresh() }

    ScreenScaffold("Two-Factor Auth", onBack = onBack) {
        val st = status
        if (st == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) }
            return@ScreenScaffold
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // Status card
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(14.dp)) {
                Text(
                    if (st.enabled) "Enabled" else "Not enabled",
                    color = if (st.enabled) ZkStatus.success else ZkInk.ink1,
                    fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                )
                Text(
                    if (st.enabled) "Account protected by an authenticator app. ${st.recoveryRemaining} recovery ${if (st.recoveryRemaining == 1) "code" else "codes"} remaining."
                    else "Add a second factor using an authenticator app like 1Password, Authy, or Google Authenticator.",
                    color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }

            if (!st.enabled && setup == null) {
                PrimaryButton("Set up") {
                    scope.launch { setup = store.totpBegin(); code = ""; password = ""; error = null }
                }
            }

            // Enroll card
            setup?.let { s ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    SectionLabel("SCAN WITH YOUR AUTHENTICATOR APP")
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        Box(Modifier.clip(RoundedCornerShape(10.dp)).background(Color.White).padding(10.dp)) {
                            QrCode(s.otpauthUri, size = 200.dp)
                        }
                    }
                    SectionLabel("OR ADD THIS SECRET MANUALLY")
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(p.bg0).padding(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(s.secret, color = ZkInk.ink1, fontFamily = ZkMono, fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Icon(
                            Icons.Filled.ContentCopy, "Copy secret", tint = p.accent,
                            modifier = Modifier.clip(CircleShape).clickable { clipboard.setText(AnnotatedString(s.secret)) }.padding(4.dp).size(16.dp),
                        )
                    }
                    SectionLabel("ENTER THE 6-DIGIT CODE FROM YOUR APP")
                    SecureField(code, { code = it.filter(Char::isDigit).take(6) }, "123456", masked = false)
                    SectionLabel("CONFIRM YOUR ACCOUNT PASSWORD")
                    SecureField(password, { password = it }, "Account password")
                    PrimaryButton(
                        if (busy) "Verifying…" else "Verify & Enable",
                        enabled = !busy && code.length == 6 && password.isNotEmpty(),
                    ) {
                        busy = true; error = null
                        scope.launch {
                            val r = store.totpConfirm(code, password)
                            busy = false
                            if (r != null) {
                                recovery = r.recoveryCodes
                                setup = null; code = ""; password = ""
                                refresh()
                            } else {
                                error = "Invalid code or password."
                            }
                        }
                    }
                }
            }

            // Recovery codes (shown ONCE)
            recovery?.let { codes ->
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    SectionLabel("RECOVERY CODES — SAVE THESE NOW")
                    Text(
                        "Each works once if you lose your authenticator. They will not be shown again.",
                        color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                    )
                    codes.forEach { c ->
                        Text(c, color = ZkInk.ink1, fontFamily = ZkMono, fontSize = 14.sp)
                    }
                    PrimaryButton("Copy all") {
                        clipboard.setText(AnnotatedString(codes.joinToString("\n")))
                    }
                }
            }

            // Disable flow
            if (st.enabled) {
                if (!disabling) {
                    Text(
                        "Disable two-factor…",
                        color = ZkStatus.danger, fontFamily = ZkSans, fontSize = 14.sp,
                        modifier = Modifier.clickable { disabling = true },
                    )
                } else {
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            "Enter a current 6-digit code or one of your recovery codes to disable two-factor authentication.",
                            color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 12.sp,
                        )
                        SecureField(disableCode, { disableCode = it }, "123456 or recovery code", masked = false)
                        PrimaryButton(
                            if (busy) "Disabling…" else "Disable 2FA",
                            enabled = !busy && disableCode.isNotBlank(),
                        ) {
                            busy = true; error = null
                            scope.launch {
                                val ok = store.totpDisable(disableCode.trim())
                                busy = false
                                if (ok) {
                                    disabling = false; disableCode = ""; recovery = null
                                    refresh()
                                } else {
                                    error = "Invalid code."
                                }
                            }
                        }
                    }
                }
            }

            error?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 13.sp) }
        }
    }
}

// ── Active sessions ──────────────────────────────────────────────────────────

@Composable
fun SessionsScreen(store: AppStore, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var sessions by remember { mutableStateOf<List<SessionInfo>?>(null) }
    suspend fun refresh() { sessions = store.listSessions().sortedByDescending { it.current } }
    LaunchedEffect(Unit) { refresh() }

    ScreenScaffold("Active Sessions", onBack = onBack) {
        val list = sessions
        if (list == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = p.accent) }
            return@ScreenScaffold
        }
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            list.forEach { s ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                sessionLabel(s.userAgent),
                                color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 14.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            if (s.current) {
                                Text(
                                    "THIS DEVICE",
                                    color = p.bg0, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 9.sp,
                                    modifier = Modifier.padding(start = 8.dp).clip(CircleShape).background(p.accent).padding(horizontal = 7.dp, vertical = 2.dp),
                                )
                            }
                        }
                        Text(
                            listOfNotNull(s.ipAddress, s.lastUsedAt?.let { "last used ${dayLabel(it)}" }).joinToString(" · "),
                            color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }
                    if (!s.current) {
                        Icon(
                            Icons.Filled.Delete, "Revoke", tint = ZkStatus.danger,
                            modifier = Modifier
                                .clip(CircleShape)
                                .clickable { scope.launch { store.revokeSession(s.id); refresh() } }
                                .padding(6.dp)
                                .size(18.dp),
                        )
                    }
                }
            }
        }
    }
}

private fun sessionLabel(ua: String?): String = when {
    ua == null -> "Unknown device"
    ua.contains("Zekktris", ignoreCase = true) -> "Zekktris app"
    ua.contains("Android", ignoreCase = true) -> "Android"
    ua.contains("iPhone") || ua.contains("iOS") -> "iPhone"
    ua.contains("Macintosh") -> "Mac"
    ua.contains("Windows") -> "Windows"
    ua.contains("Firefox") -> "Firefox"
    ua.contains("Chrome") -> "Chrome"
    ua.contains("Safari") -> "Safari"
    else -> ua.take(32)
}

/**
 * Manage passkeys: add one (a WebAuthn registration via CredentialManager,
 * password step-up required) or remove one. Mirrors the iOS Settings passkeys
 * section. NOTE: the platform ceremony only succeeds once the server publishes
 * /.well-known/assetlinks.json for this app's package + signing cert.
 */
@Composable
fun PasskeysScreen(store: AppStore, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<PasskeyInfo>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // A pending action awaiting the password step-up (add or delete).
    var pwPrompt by remember { mutableStateOf<((String) -> Unit)?>(null) }
    suspend fun refresh() { list = store.fetchPasskeys() }
    LaunchedEffect(Unit) { refresh() }

    ScreenScaffold("Passkeys", onBack = onBack) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                "Passkeys let you sign in with your fingerprint, face, or screen lock instead of a password.",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
            )
            error?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp) }
            PrimaryButton(if (busy) "Working…" else "Add a passkey", enabled = !busy) {
                error = null
                pwPrompt = { pw ->
                    busy = true; error = null
                    scope.launch {
                        val e = store.addPasskey(ctx, pw)
                        busy = false
                        if (e == null) refresh() else error = e
                    }
                }
            }
            Spacer(Modifier.size(4.dp))
            SectionLabel("YOUR PASSKEYS")
            val pks = list
            when {
                pks == null -> CircularProgressIndicator(color = p.accent, modifier = Modifier.size(24.dp))
                pks.isEmpty() -> Text("No passkeys yet.", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 13.sp)
                else -> pks.forEach { pk ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(pk.deviceName ?: "Passkey", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 14.sp)
                            Text(
                                listOfNotNull(if (pk.backedUp) "Synced" else null, pk.createdAt?.let { "added ${dayLabel(it)}" }).joinToString(" · "),
                                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp),
                            )
                        }
                        Icon(
                            Icons.Filled.Delete, "Remove", tint = ZkStatus.danger,
                            modifier = Modifier.clip(CircleShape).clickable(enabled = !busy) {
                                error = null
                                pwPrompt = { pw ->
                                    busy = true; error = null
                                    scope.launch {
                                        val e = store.removePasskey(pk.id, pw)
                                        busy = false
                                        if (e == null) refresh() else error = e
                                    }
                                }
                            }.padding(6.dp).size(18.dp),
                        )
                    }
                }
            }
        }
    }

    pwPrompt?.let { action ->
        var pw by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { pwPrompt = null },
            containerColor = p.bg2,
            title = { Text("Confirm your password", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = { FilledTextField(pw, { pw = it }, "Current password", Modifier.fillMaxWidth(), masked = true) },
            confirmButton = {
                TextButton(onClick = { val a = action; pwPrompt = null; a(pw) }, enabled = pw.isNotBlank()) {
                    Text("Continue", color = p.accent, fontFamily = ZkSans)
                }
            },
            dismissButton = { TextButton(onClick = { pwPrompt = null }) { Text("Cancel", color = ZkInk.ink3, fontFamily = ZkSans) } },
        )
    }
}

// The old QuickLoginScreen lived here: it minted a short-lived code on THIS
// (signed-in) device that a logged-out device could redeem for a session — a
// shape where the displayed code was the entire credential, so anyone who saw
// it owned the account for the next five minutes. It has been replaced by the
// inverted flow in DeviceLoginScreens.kt, where the logged-out device asks and
// this one approves. The /auth/quick-login/* routes still exist server-side but
// are marked @deprecated; see the delete checklist at
// apps/api/src/routes/auth.ts (search "quick-login").
