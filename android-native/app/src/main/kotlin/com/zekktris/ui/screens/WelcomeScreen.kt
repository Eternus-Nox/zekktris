package com.zekktris.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.ui.components.AbyssBackground
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkTheme

/** Entry screen: the abyss visual language + the two auth entry points. */
@Composable
fun WelcomeScreen(
    onLogIn: () -> Unit = {},
    onCreateAccount: () -> Unit = {},
) {
    val p = ZkTheme.palette
    AbyssBackground(contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier
                .safeDrawingPadding()
                .fillMaxWidth()
                .padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = "Zekktris",
                color = ZkInk.ink1,
                fontWeight = FontWeight.Bold,
                fontSize = 44.sp,
                textAlign = TextAlign.Center,
            )
            Text(
                text = "Talk. Call. Belong.",
                color = ZkInk.ink3,
                fontSize = 15.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp),
            )

            Column(
                modifier = Modifier
                    .padding(top = 48.dp)
                    .width(280.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    onClick = onLogIn,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = p.accent,
                        contentColor = p.bg0,
                    ),
                ) { Text("Log In", fontWeight = FontWeight.SemiBold) }

                OutlinedButton(
                    onClick = onCreateAccount,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.dp, SolidColor(p.line)),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = ZkInk.ink1),
                ) { Text("Create Account", fontWeight = FontWeight.Medium) }
            }

            ServerRow(Modifier.padding(top = 20.dp))
        }
    }
}

@Preview
@Composable
private fun WelcomeScreenPreview() {
    ZkTheme { WelcomeScreen() }
}
