package com.zekktris.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.ui.components.AbyssBackground
import com.zekktris.ui.components.zkFieldColors
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

@Composable
fun LoginScreen(
    store: AppStore,
    state: AppState,
    onDeviceLogin: () -> Unit = {},
    onBack: () -> Unit,
) {
    val p = ZkTheme.palette
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var showForgot by remember { mutableStateOf(false) }
    val needs2FA = state.pending2FAEmail != null

    AbyssBackground(contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .fillMaxWidth()
                .padding(horizontal = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = if (needs2FA) "Two-factor" else "Welcome back",
                color = ZkInk.ink1,
                fontWeight = FontWeight.Bold,
                fontSize = 26.sp,
            )
            Text(
                text = if (needs2FA) "Enter your authenticator code." else "Log in to your Zekktris account.",
                color = ZkInk.ink3,
                fontSize = 14.sp,
                modifier = Modifier.padding(top = 6.dp, bottom = 24.dp),
            )

            if (!needs2FA) {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it; store.clearAuthError() },
                    label = { Text("Email") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    colors = zkFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it; store.clearAuthError() },
                    label = { Text("Password") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    colors = zkFieldColors(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 12.dp),
                )
            } else {
                OutlinedTextField(
                    value = code,
                    onValueChange = { code = it; store.clearAuthError() },
                    label = { Text("6-digit code") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    colors = zkFieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            state.authError?.let {
                Text(
                    text = it,
                    color = ZkStatus.dangerSoft,
                    fontSize = 13.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 12.dp),
                )
            }

            Button(
                onClick = {
                    if (needs2FA) store.submit2FA(code.trim())
                    else store.login(email, password)
                },
                enabled = !state.authBusy,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 20.dp)
                    .height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = p.accent, contentColor = p.bg0),
            ) {
                if (state.authBusy) CircularProgressIndicator(color = p.bg0, modifier = Modifier.height(20.dp))
                else Text(if (needs2FA) "Verify" else "Log In", fontWeight = FontWeight.SemiBold)
            }

            if (!needs2FA) {
                val ctx = androidx.compose.ui.platform.LocalContext.current
                TextButton(
                    onClick = { store.loginWithPasskey(ctx) },
                    enabled = !state.authBusy,
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                ) {
                    Text("Sign in with a passkey", color = p.accent, fontWeight = FontWeight.SemiBold)
                }
                // Device-approval login: this device shows a code, a phone the
                // user is already signed in on approves it. The way in for
                // someone who can't type their password on this screen at all
                // (a TV, a borrowed laptop, a forgotten password on a phone).
                TextButton(
                    onClick = onDeviceLogin,
                    enabled = !state.authBusy,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Log in from another device", color = p.accent, fontWeight = FontWeight.SemiBold)
                }
                // The plain way back in, which this screen was missing entirely
                // — iOS and web have had it since launch.
                TextButton(
                    onClick = { showForgot = true },
                    enabled = !state.authBusy,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Forgot your password?", color = ZkInk.ink3)
                }
            }

            TextButton(
                onClick = { if (needs2FA) store.cancel2FA() else onBack() },
                modifier = Modifier.padding(top = 8.dp),
            ) {
                Text(if (needs2FA) "Back" else "Cancel", color = ZkInk.ink3)
            }
        }
    }

    if (showForgot) {
        ForgotPasswordDialog(store, initialEmail = email, onDismiss = { showForgot = false })
    }
}

/**
 * Password reset, in the two stages the server's flow actually has: ask for the
 * email, then redeem the code it contains. Mirrors iOS's ForgotPasswordView,
 * including the deliberately uninformative confirmation — the server answers
 * the same way whether or not the address exists, and the UI must not leak what
 * the API is careful not to.
 */
@Composable
private fun ForgotPasswordDialog(store: AppStore, initialEmail: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var stage by remember { mutableStateOf(0) }   // 0 = request, 1 = redeem
    var email by remember { mutableStateOf(initialEmail) }
    var code by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var info by remember { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        containerColor = p.bg2,
        title = { Text("Reset password", color = ZkInk.ink1, fontWeight = FontWeight.SemiBold) },
        text = {
            Column {
                if (stage == 0) {
                    Text(
                        "Enter your account email and we'll send a reset code.",
                        color = ZkInk.ink3, fontSize = 13.sp,
                    )
                    OutlinedTextField(
                        value = email,
                        onValueChange = { email = it; error = null },
                        label = { Text("Email") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                        colors = zkFieldColors(),
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    )
                } else {
                    Text(
                        "Enter the code from your email and choose a new password.",
                        color = ZkInk.ink3, fontSize = 13.sp,
                    )
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it; error = null },
                        label = { Text("Reset code") },
                        singleLine = true,
                        colors = zkFieldColors(),
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                    )
                    OutlinedTextField(
                        value = newPassword,
                        onValueChange = { newPassword = it; error = null },
                        label = { Text("New password") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        colors = zkFieldColors(),
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    )
                }
                error?.let {
                    Text(it, color = ZkStatus.dangerSoft, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp))
                }
                info?.let {
                    Text(it, color = p.accent, fontSize = 13.sp, modifier = Modifier.padding(top = 10.dp))
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && if (stage == 0) email.isNotBlank()
                          else code.isNotBlank() && newPassword.length >= 8,
                onClick = {
                    busy = true; error = null; info = null
                    if (stage == 0) {
                        store.requestPasswordReset(email) { err ->
                            busy = false
                            if (err != null) {
                                error = err
                            } else {
                                info = "If an account exists for that email, a reset code is on its way."
                                stage = 1
                            }
                        }
                    } else {
                        store.resetPassword(code, newPassword) { err ->
                            busy = false
                            if (err != null) error = err else onDismiss()
                        }
                    }
                },
            ) {
                Text(
                    if (busy) "…" else if (stage == 0) "Send code" else "Reset password",
                    color = p.accent, fontWeight = FontWeight.SemiBold,
                )
            }
        },
        dismissButton = {
            TextButton(enabled = !busy, onClick = {
                if (stage == 1) { stage = 0; error = null; info = null } else onDismiss()
            }) {
                Text(if (stage == 1) "Back" else "Cancel", color = ZkInk.ink3)
            }
        },
    )
}
