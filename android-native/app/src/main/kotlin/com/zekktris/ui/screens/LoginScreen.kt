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
fun LoginScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
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

            TextButton(
                onClick = { if (needs2FA) store.cancel2FA() else onBack() },
                modifier = Modifier.padding(top = 8.dp),
            ) {
                Text(if (needs2FA) "Back" else "Cancel", color = ZkInk.ink3)
            }
        }
    }
}
