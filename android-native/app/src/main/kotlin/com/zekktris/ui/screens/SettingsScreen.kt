package com.zekktris.ui.screens

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.Config
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

private enum class SettingsTab(val label: String) {
    Profile("Profile"), Security("Security"), VoiceVideo("Voice & Video"), Membership("Membership")
}

private const val WEB_SETTINGS = "https://zekktris.com/settings"

@Composable
fun SettingsScreen(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    var tab by remember { mutableStateOf(SettingsTab.Profile) }
    BackHandler { store.closeSettings() }

    Column(Modifier.fillMaxSize().background(p.bg0)) {
        // header
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 6.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
                tint = ZkInk.ink2,
                modifier = Modifier.clip(CircleShape).clickable { store.closeSettings() }.padding(8.dp).size(20.dp),
            )
            Text("Settings", color = ZkInk.ink1, fontWeight = FontWeight.Bold, fontSize = 20.sp, modifier = Modifier.padding(start = 4.dp))
        }

        // tab chips
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SettingsTab.entries.forEach { t ->
                val selected = t == tab
                Text(
                    text = t.label,
                    color = if (selected) p.bg0 else ZkInk.ink2,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(20.dp))
                        .background(if (selected) p.accent else p.bg2)
                        .clickable { tab = t }
                        .padding(horizontal = 14.dp, vertical = 7.dp),
                )
            }
        }

        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(top = 8.dp),
        ) {
            when (tab) {
                SettingsTab.Profile -> ProfileSection(state)
                SettingsTab.Security -> SecuritySection()
                SettingsTab.VoiceVideo -> VoiceVideoSection()
                SettingsTab.Membership -> MembershipSection(state)
            }

            Spacer(Modifier.height(24.dp))
            LogoutRow(store)
            Text(
                "Zekktris 5.0",
                color = ZkInk.ink4,
                fontSize = 12.sp,
                modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(vertical = 16.dp),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
        }
    }
}

@Composable
private fun ProfileSection(state: AppState) {
    val p = ZkTheme.palette
    val me = state.me ?: return
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        // banner + avatar
        Box(Modifier.fillMaxWidth().height(150.dp)) {
            val banner = Config.absoluteUrl(me.bannerUrl)
            Box(
                Modifier.fillMaxWidth().height(110.dp).clip(RoundedCornerShape(14.dp))
                    .background(Brush.horizontalGradient(listOf(p.accent2, p.accent))),
            ) {
                if (banner != null) {
                    AsyncImage(model = banner, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
            }
            Box(
                Modifier.align(Alignment.BottomStart).offset(x = 14.dp)
                    .clip(CircleShape).background(p.bg0).padding(4.dp),
            ) {
                Avatar(url = me.avatarUrl, name = me.bestName, size = 72.dp)
            }
        }
        Text(me.bestName, color = ZkInk.ink1, fontWeight = FontWeight.Bold, fontSize = 20.sp, modifier = Modifier.padding(top = 6.dp))
        Text("@${me.username ?: ""}", color = ZkInk.ink3, fontSize = 14.sp)
        me.subscriptionTier?.let { TierPill(it) }
        if (!me.bio.isNullOrBlank()) {
            Text(me.bio, color = ZkInk.ink2, fontSize = 14.sp, modifier = Modifier.padding(top = 12.dp))
        }
        me.email?.let {
            Spacer(Modifier.height(16.dp))
            InfoRow("Email", it)
        }
    }
}

@Composable
private fun TierPill(tier: String) {
    val p = ZkTheme.palette
    Text(
        text = tier.replaceFirstChar { it.uppercase() },
        color = p.bg0,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.padding(top = 8.dp).clip(RoundedCornerShape(20.dp)).background(p.accent).padding(horizontal = 12.dp, vertical = 4.dp),
    )
}

@Composable
private fun InfoRow(label: String, value: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, color = ZkInk.ink3, fontSize = 12.sp)
        Text(value, color = ZkInk.ink1, fontSize = 15.sp, modifier = Modifier.padding(top = 2.dp))
    }
}

@Composable
private fun SecuritySection() {
    Column {
        WebRow("Email & password")
        WebRow("Two-factor authentication")
        WebRow("Passkeys")
        WebRow("Active sessions")
        ManagedNote()
    }
}

@Composable
private fun VoiceVideoSection() {
    Column {
        WebRow("Input & output devices")
        WebRow("Noise suppression")
        WebRow("Video quality")
        ManagedNote()
    }
}

@Composable
private fun MembershipSection(state: AppState) {
    val p = ZkTheme.palette
    val tier = state.me?.subscriptionTier
    Column(Modifier.padding(horizontal = 16.dp)) {
        Text(
            text = if (tier != null) "You're a ${tier.replaceFirstChar { it.uppercase() }} member" else "Free plan",
            color = ZkInk.ink1,
            fontWeight = FontWeight.SemiBold,
            fontSize = 16.sp,
        )
        Text(
            "Scout, Guardian, and Legend unlock appearance themes, higher upload caps, and premium streaming quality.",
            color = ZkInk.ink3,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 6.dp),
        )
        Spacer(Modifier.height(12.dp))
        WebRow(if (tier != null) "Manage membership" else "Upgrade")
    }
}

@Composable
private fun WebRow(label: String) {
    val ctx = LocalContext.current
    Row(
        Modifier.fillMaxWidth().clickable {
            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(WEB_SETTINGS))) }
        }.padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, color = ZkInk.ink1, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun ManagedNote() {
    Text(
        "Opens on the web — these settings are managed at zekktris.com.",
        color = ZkInk.ink4,
        fontSize = 12.sp,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun LogoutRow(store: AppStore) {
    Row(
        Modifier.fillMaxWidth().clickable { store.logout() }.padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("Log Out", color = ZkStatus.dangerSoft, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    }
}
