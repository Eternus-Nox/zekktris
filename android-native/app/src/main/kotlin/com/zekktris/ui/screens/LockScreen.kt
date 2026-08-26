package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/**
 * Full-screen opaque lock overlay shown while the app is locked. Auto-triggers
 * the biometric/credential prompt on show (which also runs the fail-open escape
 * hatch), with a manual Unlock button to retry after a cancel. Opaque so the
 * content behind it is hidden.
 */
@Composable
fun LockScreen(onUnlock: () -> Unit) {
    val p = ZkTheme.palette
    // Prompt on show; onUnlock() escapes automatically if biometrics are gone.
    LaunchedEffect(Unit) { onUnlock() }
    Box(
        Modifier.fillMaxSize().background(p.bg0).clickable(enabled = false) {},
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Icon(Icons.Filled.Lock, null, tint = p.accent, modifier = Modifier.size(46.dp))
            Text("Zekktris is locked", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
            Text(
                "Unlock with your fingerprint, face, or device PIN.",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 40.dp),
            )
            Text(
                "Unlock", color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                modifier = Modifier.padding(top = 8.dp).clip(RoundedCornerShape(12.dp)).background(p.accent).clickable(onClick = onUnlock).padding(horizontal = 28.dp, vertical = 12.dp),
            )
        }
    }
}
