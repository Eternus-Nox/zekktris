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
fun RegisterScreen(store: AppStore, state: AppState, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var email by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var dob by remember { mutableStateOf("") }

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
            Text("Create your account", color = ZkInk.ink1, fontWeight = FontWeight.Bold, fontSize = 26.sp)
            Text(
                "You must be at least 13 years old.",
                color = ZkInk.ink3,
                fontSize = 14.sp,
                modifier = Modifier.padding(top = 6.dp, bottom = 20.dp),
            )

            val fieldMod = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp)

            OutlinedTextField(
                value = email, onValueChange = { email = it; store.clearAuthError() },
                label = { Text("Email") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                colors = zkFieldColors(), modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = username, onValueChange = { username = it; store.clearAuthError() },
                label = { Text("Username") }, singleLine = true,
                colors = zkFieldColors(), modifier = fieldMod,
            )
            OutlinedTextField(
                value = displayName, onValueChange = { displayName = it; store.clearAuthError() },
                label = { Text("Display name") }, singleLine = true,
                colors = zkFieldColors(), modifier = fieldMod,
            )
            OutlinedTextField(
                value = password, onValueChange = { password = it; store.clearAuthError() },
                label = { Text("Password") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                colors = zkFieldColors(), modifier = fieldMod,
            )
            OutlinedTextField(
                value = dob, onValueChange = { dob = it; store.clearAuthError() },
                label = { Text("Date of birth") },
                placeholder = { Text("YYYY-MM-DD") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                colors = zkFieldColors(), modifier = fieldMod,
            )

            state.authError?.let {
                Text(
                    text = it, color = ZkStatus.dangerSoft, fontSize = 13.sp,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
            }

            Button(
                onClick = { store.register(email, username, displayName, password, dob.trim()) },
                enabled = !state.authBusy,
                modifier = Modifier.fillMaxWidth().padding(top = 20.dp).height(50.dp),
                colors = ButtonDefaults.buttonColors(containerColor = p.accent, contentColor = p.bg0),
            ) {
                if (state.authBusy) CircularProgressIndicator(color = p.bg0, modifier = Modifier.height(20.dp))
                else Text("Create Account", fontWeight = FontWeight.SemiBold)
            }

            TextButton(onClick = onBack, modifier = Modifier.padding(top = 8.dp)) {
                Text("Cancel", color = ZkInk.ink3)
            }
        }
    }
}
