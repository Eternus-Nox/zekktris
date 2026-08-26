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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.Config
import com.zekktris.data.model.InvitePreview
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.launch

@Composable
fun JoinServerScreen(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val scope = rememberCoroutineScope()
    var code by remember { mutableStateOf("") }
    var preview by remember { mutableStateOf<InvitePreview?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    ScreenScaffold("Join a Server", onBack = { store.closeRailPage() }) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            val pv = preview
            if (pv == null) {
                Text("Enter an invite code or link to see the server before you join.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    SectionLabel("INVITE CODE OR LINK")
                    FilledTextField(code, { code = it }, "abc123", Modifier.fillMaxWidth())
                }
                PrimaryButton(if (busy) "Looking up…" else "Preview Invite", enabled = code.isNotBlank() && !busy) {
                    busy = true; error = null
                    scope.launch {
                        val r = store.previewInvite(code)
                        busy = false
                        if (r != null) preview = r else error = "Couldn't find that invite."
                    }
                }
            } else {
                Config.absoluteUrl(pv.guild.bannerUrl)?.let { url ->
                    AsyncImage(model = url, contentDescription = null, modifier = Modifier.fillMaxWidth().height(140.dp).clip(RoundedCornerShape(12.dp)))
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Avatar(url = pv.guild.iconUrl, name = pv.guild.name, size = 56.dp, shape = RoundedCornerShape(16.dp))
                    Column(Modifier.padding(start = 12.dp)) {
                        Text("YOU'VE BEEN INVITED TO JOIN", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp)
                        Text(pv.guild.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 18.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                    }
                }
                if (!pv.guild.description.isNullOrBlank()) {
                    Text(pv.guild.description!!, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(ZkStatus.online))
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "%,d %s".format(pv.guild.memberCount, if (pv.guild.memberCount == 1) "member" else "members"),
                        color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                    )
                }
                PrimaryButton(if (busy) "Joining…" else "Join ${pv.guild.name}", enabled = !busy) {
                    busy = true; error = null
                    store.joinByInvite(pv.code) { ok -> busy = false; if (!ok) error = "Couldn't join that server." }
                }
                Text(
                    "Use a different code",
                    color = ZkInk.ink3,
                    fontFamily = ZkSans,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().clickable { preview = null; error = null },
                )
            }
            error?.let { Text(it, color = ZkStatus.danger, fontFamily = ZkSans, fontSize = 13.sp) }
        }
    }
}
