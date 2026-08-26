package com.zekktris.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FileUpload
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A picked (not yet uploaded) server image: the content Uri for the local
 *  preview + the loaded bytes/mime/filename for the post-create upload.
 *  Plain class (not data) — ByteArray equality is meaningless here. */
private class PickedServerImage(
    val uri: Uri,
    val bytes: ByteArray,
    val mime: String,
    val filename: String,
)

@Composable
fun CreateServerScreen(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Optional server picture + banner, uploaded to the new guild after create
    // (mirrors iOS CreateServerSheet — the server has no icon/banner field on
    // POST /guilds beyond a pre-existing cdn path, so create-then-upload).
    var iconImg by remember { mutableStateOf<PickedServerImage?>(null) }
    var bannerImg by remember { mutableStateOf<PickedServerImage?>(null) }

    fun onPicked(uri: Uri?, isBanner: Boolean) {
        uri ?: return
        scope.launch {
            val loaded = withContext(Dispatchers.IO) { readGuildImage(ctx, uri) }
            if (loaded == null) { error = "Couldn't read that image."; return@launch }
            val (bytes, mime, fn) = loaded
            val img = PickedServerImage(uri, bytes, mime, fn)
            if (isBanner) bannerImg = img else iconImg = img
        }
    }
    val iconPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { onPicked(it, false) }
    val bannerPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { onPicked(it, true) }

    ScreenScaffold("Create a Server", onBack = { store.closeRailPage() }) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Give your server a name. You can change it later.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 15.sp)

            // Optional banner + server picture — tap either to pick an image;
            // both upload to the new guild right after create (mirrors iOS).
            Box(Modifier.fillMaxWidth().height(150.dp)) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(130.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Brush.linearGradient(listOf(p.accent.copy(alpha = 0.35f), p.accent2.copy(alpha = 0.25f))))
                        .clickable(enabled = !busy) { bannerPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    contentAlignment = Alignment.Center,
                ) {
                    val bUri = bannerImg?.uri
                    if (bUri != null) {
                        AsyncImage(model = bUri, contentDescription = "Server banner", modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    } else {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Filled.Image, null, tint = ZkInk.ink2, modifier = Modifier.size(20.dp))
                            Text("Add banner", color = ZkInk.ink2, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                }
                Box(
                    Modifier
                        .align(Alignment.BottomStart)
                        .offset(x = 16.dp)
                        .size(64.dp)
                        .clip(CircleShape)
                        .background(p.bg3)
                        .border(4.dp, p.bg1, CircleShape)
                        .clickable(enabled = !busy) { iconPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    contentAlignment = Alignment.Center,
                ) {
                    val iUri = iconImg?.uri
                    if (iUri != null) {
                        AsyncImage(model = iUri, contentDescription = "Server picture", modifier = Modifier.fillMaxSize().clip(CircleShape), contentScale = ContentScale.Crop)
                    } else {
                        Icon(Icons.Filled.PhotoCamera, null, tint = ZkInk.ink2, modifier = Modifier.size(16.dp))
                    }
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionLabel("SERVER NAME")
                FilledTextField(name, { name = it }, "My cool server", Modifier.fillMaxWidth())
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionLabel("DESCRIPTION (OPTIONAL)")
                FilledTextField(description, { description = it }, "What's it about?", Modifier.fillMaxWidth().height(90.dp), singleLine = false, minLines = 3)
            }

            PrimaryButton(if (busy) "Creating…" else "Create Server", enabled = name.isNotBlank() && !busy) {
                busy = true; error = null
                store.createGuild(
                    name.trim(),
                    description.trim(),
                    icon = iconImg?.let { Triple(it.bytes, it.mime, it.filename) },
                    banner = bannerImg?.let { Triple(it.bytes, it.mime, it.filename) },
                ) { ok -> busy = false; if (!ok) error = "Couldn't create the server." }
            }

            // OR divider
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 2.dp)) {
                Box(Modifier.weight(1f).height(1.dp).background(p.line))
                Text("OR", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 12.dp))
                Box(Modifier.weight(1f).height(1.dp).background(p.line))
            }
            Text("Import a template or backup file (.json). Uses the file's name unless you typed one above.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(p.bg2)
                    .border(1.dp, p.bg3, RoundedCornerShape(12.dp))
                    .clickable { /* file import — coming soon */ }
                    .padding(vertical = 14.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.FileUpload, null, tint = ZkInk.ink2, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Import from a file", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            }

            error?.let { Text(it, color = ZkStatus.danger, fontFamily = ZkSans, fontSize = 13.sp) }
        }
    }
}
