package com.zekktris.ui.screens

import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Memory
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material.icons.filled.PrivacyTip
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material.icons.filled.CheckCircle
import com.zekktris.ui.components.ScreenScaffold
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.Config
import com.zekktris.data.model.PublicUser
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.EmojiPickerSheet
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.components.ShimmerName
import com.zekktris.ui.theme.LocalThemeController
import com.zekktris.ui.theme.ZK_THEMES
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkMono
import com.zekktris.ui.theme.ZkPalette
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// Four tabs, matching iOS SettingsView: Notifications + Privacy fold into
// Profile; themes, frames, tags and the perk-tier list live under Appearance.
private enum class SettingsTab(val label: String) {
    Profile("Profile"), Security("Security"), VoiceVideo("Voice & Video"), Membership("Appearance")
}

/** Full-screen security sub-pages (all in-app; no web hand-off). */
private enum class SecurityPage { Password, Username, Email, TwoFactor, Sessions, Passkeys, DeviceLogin, DateOfBirth }

/** Web Settings on the signed-in server (WebRow's target). */
private val webSettingsUrl get() = com.zekktris.data.Config.CDN_BASE_URL + "/settings"

@Composable
fun SettingsScreen(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    var tab by remember { mutableStateOf(SettingsTab.Profile) }
    var securityPage by remember { mutableStateOf<SecurityPage?>(null) }
    var showBots by remember { mutableStateOf(false) }
    var showAchievements by remember { mutableStateOf(false) }
    securityPage?.let { page ->
        BackHandler { securityPage = null }
        when (page) {
            SecurityPage.Password -> ChangePasswordScreen(store) { securityPage = null }
            SecurityPage.Username -> ChangeUsernameScreen(store) { securityPage = null }
            SecurityPage.Email -> ChangeEmailScreen(store, state) { securityPage = null }
            SecurityPage.TwoFactor -> TwoFactorScreen(store) { securityPage = null }
            SecurityPage.Sessions -> SessionsScreen(store) { securityPage = null }
            SecurityPage.Passkeys -> PasskeysScreen(store) { securityPage = null }
            SecurityPage.DeviceLogin -> ApproveDeviceLoginScreen(store) { securityPage = null }
            SecurityPage.DateOfBirth -> DateOfBirthScreen(store, state) { securityPage = null }
        }
        return
    }
    if (showBots) {
        BackHandler { showBots = false }
        BotsScreen(store, state) { showBots = false }
        return
    }
    if (showAchievements) {
        BackHandler { showAchievements = false }
        AchievementsGalleryScreen(store) { showAchievements = false }
        return
    }
    BackHandler { store.closeSettings() }

    Column(Modifier.fillMaxSize().background(p.bg0)) {
        // Header: rounded ink2 back chevron chip + centered title (iOS style).
        Box(Modifier.fillMaxWidth().statusBarsPadding().height(56.dp)) {
            Box(
                Modifier
                    .align(Alignment.CenterStart)
                    .padding(start = 12.dp)
                    .size(width = 52.dp, height = 40.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(p.bg2)
                    .clickable { store.closeSettings() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.ChevronLeft, "Back", tint = ZkInk.ink2, modifier = Modifier.size(24.dp))
            }
            Text(
                "Settings",
                color = ZkInk.ink1,
                fontWeight = FontWeight.Bold,
                fontSize = 20.sp,
                modifier = Modifier.align(Alignment.Center),
            )
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
                    color = if (selected) Color.White else ZkInk.ink2,
                    fontSize = 13.sp,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
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
            // Each tab renders its OWN content only — nothing lives below the
            // switch, so no section repeats across tabs (fixes the duplicates).
            when (tab) {
                SettingsTab.Profile -> {
                    ProfileSection(store, state)
                    NotificationsSection(store, state)
                    PrivacySection(store, state)
                    FeaturesSection()
                    // Trailing ACHIEVEMENTS section: gallery row directly above
                    // the notifications toggle (iOS MainView.swift:2385-2427).
                    Spacer(Modifier.height(10.dp))
                    SectionLabel("ACHIEVEMENTS", Modifier.padding(start = 16.dp, bottom = 2.dp))
                    NavRow("View Achievements", "See what you've collected and what's left to earn.") { showAchievements = true }
                    SwitchRow(
                        "Achievement notifications",
                        "Get notified when you unlock a new achievement.",
                        state.me?.notifyAchievements != false,
                    ) { store.setNotifyAchievements(it) }
                    Spacer(Modifier.height(24.dp).navigationBarsPadding())
                }
                SettingsTab.Security -> {
                    SecuritySection(state) { securityPage = it }
                    // Bots close out the ACCOUNT section that SecuritySection opens.
                    NavRow("Bots", "Create bot accounts and API tokens", leading = Icons.Filled.Memory) { showBots = true }
                    Spacer(Modifier.height(16.dp))
                    SectionLabel("LEGAL", Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                    LinkRow("Terms of Service", com.zekktris.data.Config.CDN_BASE_URL + "/terms", leading = Icons.Filled.Description)
                    LinkRow("Privacy Policy", com.zekktris.data.Config.CDN_BASE_URL + "/privacy", leading = Icons.Filled.PrivacyTip)
                    Spacer(Modifier.height(16.dp))
                    LogoutRow(store)
                    Text(
                        "Zekktris 5.0",
                        color = ZkInk.ink4,
                        fontSize = 12.sp,
                        modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(vertical = 16.dp),
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                }
                SettingsTab.VoiceVideo -> {
                    VoiceVideoSection(store, state)
                    Spacer(Modifier.height(24.dp).navigationBarsPadding())
                }
                SettingsTab.Membership -> {
                    // iOS order: shimmer (staff) → Appearance editors (free for
                    // everyone) → PERK TIERS → old-subscription link (only for
                    // someone still paying) → DISPLAY (hide-clan-tags) LAST.
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                        if (state.me?.subscriptionTitled == true) {
                            state.me.subscriptionTier?.let { TierPill(it); Spacer(Modifier.height(16.dp)) }
                        }
                        StaffShimmerBlock(store, state)
                        ThemeBlock()
                        AvatarDecorationBlock(store, state)
                        NameTagBlock(store, state)
                    }
                    Spacer(Modifier.height(16.dp))
                    PerkTiersSection(store, state)
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) { DisplayBlock() }
                    Spacer(Modifier.height(24.dp).navigationBarsPadding())
                }
            }
        }
    }
}

@Composable
private fun ProfileSection(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val me = state.me ?: return
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    // Read the picked image off-main, then upload as avatar or banner.
    fun pickAndUpload(uri: Uri?, banner: Boolean) {
        uri ?: return
        scope.launch {
            val loaded = withContext(Dispatchers.IO) { readImageForUpload(ctx, uri) } ?: return@launch
            val (bytes, mime, name) = loaded
            if (banner) store.uploadBanner(name, mime, bytes) else store.uploadAvatar(name, mime, bytes)
        }
    }
    val avatarPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { pickAndUpload(it, false) }
    val bannerPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { pickAndUpload(it, true) }
    var displayName by remember { mutableStateOf(me.displayName ?: "") }
    var bio by remember { mutableStateOf(me.bio ?: "") }
    val status = me.status ?: "online"
    var customStatus by remember { mutableStateOf(me.customStatus ?: "") }
    var customStatusEmoji by remember { mutableStateOf(me.customStatusEmoji ?: "") }
    // keep = leave the current auto-clear timer alone; off = never clear.
    var statusExpiry by remember { mutableStateOf(if (me.customStatusExpiresAt != null) "keep" else "off") }
    var statusMenu by remember { mutableStateOf(false) }
    var statusBusy by remember { mutableStateOf(false) }
    var showStatusEmoji by remember { mutableStateOf(false) }
    // Your own name shimmers back at you here exactly as others see it: staff
    // only, and only while a shimmer color is set (clearing it in Membership is
    // the opt-out). Non-entitled / opted-out falls through to plain ink1 — same
    // gate StaffName applies everywhere else, same ShimmerName renderer.
    val myShimmerHex = if (me.isAdmin == true || me.isModerator == true) {
        me.staffColor?.takeIf { it.isNotBlank() }
    } else {
        null
    }

    Column(Modifier.fillMaxWidth()) {
        // ── Full-bleed profile hero (iOS parity): edge-to-edge banner, avatar
        //    overhanging its bottom edge, and name/@handle/Upload pill to the
        //    RIGHT of the avatar, with a legibility scrim fading into the page.
        val banner = Config.absoluteUrl(me.bannerUrl)
        Box(Modifier.fillMaxWidth().height(282.dp)) {
            Box(
                Modifier.fillMaxWidth().height(238.dp).align(Alignment.TopStart)
                    .background(Brush.horizontalGradient(listOf(p.accent2, p.accent))),
            ) {
                if (banner != null) {
                    AsyncImage(model = banner, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
                // Bottom fade scrim.
                Box(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(96.dp)
                        .background(Brush.verticalGradient(listOf(Color.Transparent, p.bg0))),
                )
                Icon(
                    Icons.Filled.PhotoCamera, "Change banner", tint = Color.White,
                    modifier = Modifier.align(Alignment.TopEnd).padding(10.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.3f))
                        .clickable { bannerPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
                        .padding(6.dp).size(18.dp),
                )
            }
            Row(
                Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(horizontal = 16.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                Box {
                    Box(Modifier.clip(CircleShape).background(p.bg0).padding(3.dp)) {
                        Avatar(url = me.avatarUrl, name = me.bestName, size = 76.dp, decoration = me.avatarDecoration)
                    }
                    Box(
                        Modifier.align(Alignment.BottomEnd).offset(x = (-4).dp, y = (-4).dp).size(20.dp).clip(CircleShape).background(p.bg0),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.size(14.dp).clip(CircleShape).background(statusColor(status)))
                    }
                }
                Column(Modifier.padding(start = 12.dp, bottom = 4.dp).weight(1f)) {
                    ShimmerName(
                        text = me.bestName,
                        colorHex = myShimmerHex,
                        glow = me.staffGlow == true,
                        baseColor = ZkInk.ink1,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                    )
                    Text("@${me.username ?: ""}", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                    Row(
                        Modifier.padding(top = 6.dp).clip(RoundedCornerShape(10.dp)).background(p.accent.copy(alpha = 0.12f))
                            .clickable { avatarPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.AddPhotoAlternate, null, tint = p.accent, modifier = Modifier.size(15.dp))
                        Spacer(Modifier.size(6.dp))
                        Text("Upload Picture", color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    }
                }
            }
        }

        // ── Rest of the profile editor (padded). iOS order:
        //    STATUS → DISPLAY NAME → ABOUT ME → CUSTOM STATUS. ──
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
            Spacer(Modifier.height(4.dp))
            SectionLabel("STATUS")
            Spacer(Modifier.height(8.dp))
            StatusRow("Online", "online", status) { store.updateProfile(status = "online") }
            // Label only — the wire/DB value stays "idle" (renaming it would
            // break every already-shipped client against the live server).
            StatusRow("Away", "idle", status) { store.updateProfile(status = "idle") }
            StatusRow("Do Not Disturb", "dnd", status) { store.updateProfile(status = "dnd") }
            StatusRow("Invisible", "invisible", status) { store.updateProfile(status = "invisible") }

            Spacer(Modifier.height(20.dp))
            SectionLabel("DISPLAY NAME")
            Spacer(Modifier.height(6.dp))
            FilledTextField(displayName, { displayName = it }, "Display name", Modifier.fillMaxWidth())

            Spacer(Modifier.height(20.dp))
            SectionLabel("ABOUT ME")
            Spacer(Modifier.height(6.dp))
            FilledTextField(bio, { bio = it.take(200) }, "Tell people about yourself", Modifier.fillMaxWidth().height(90.dp), singleLine = false, minLines = 3)
            Text("${bio.length}/200", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.align(Alignment.End).padding(top = 4.dp))

            Spacer(Modifier.height(20.dp))
            SectionLabel("CUSTOM STATUS")
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(52.dp).clip(RoundedCornerShape(10.dp)).background(p.bg2).clickable { showStatusEmoji = true },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        customStatusEmoji.ifBlank { "🙂" }, fontSize = 24.sp,
                        modifier = if (customStatusEmoji.isBlank()) Modifier.alpha(0.45f) else Modifier,
                    )
                }
                FilledTextField(customStatus, { customStatus = it.take(128) }, "What's happening?", Modifier.weight(1f))
            }
            if (showStatusEmoji) {
                EmojiPickerSheet(
                    onDismiss = { showStatusEmoji = false },
                    onPick = { customStatusEmoji = it; showStatusEmoji = false },
                )
            }
            Spacer(Modifier.height(8.dp))
            Box {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).clickable { statusMenu = true }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Clear after: ${expiryLabel(statusExpiry)}", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.weight(1f))
                    Icon(Icons.Filled.KeyboardArrowDown, null, tint = ZkInk.ink3, modifier = Modifier.size(18.dp))
                }
                DropdownMenu(expanded = statusMenu, onDismissRequest = { statusMenu = false }) {
                    val opts = buildList {
                        if (me.customStatusExpiresAt != null) add("keep" to "Keep current")
                        add("off" to "Don't clear"); add("30m" to "30 minutes"); add("1h" to "1 hour")
                        add("4h" to "4 hours"); add("today" to "Today"); add("week" to "This week")
                    }
                    opts.forEach { (v, label) ->
                        DropdownMenuItem(text = { Text(label, fontFamily = ZkSans) }, onClick = { statusExpiry = v; statusMenu = false })
                    }
                }
            }
            if (customStatus.isNotBlank() || customStatusEmoji.isNotBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(
                    "Clear status",
                    // iOS renders this as a quiet ink3 affordance, not a
                    // destructive red one (MainView.swift:2554).
                    color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                    modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable {
                        customStatus = ""; customStatusEmoji = ""; statusExpiry = "off"
                        store.setCustomStatus("", "", null)
                    }.padding(horizontal = 8.dp, vertical = 6.dp),
                )
            }

            // ── Single dirty-tracked "Save changes" bar for every editable
            //    profile field (iOS MainView.swift:2064-2102 — the per-field
            //    Save buttons were deliberately removed, task #117). ──
            var saveState by remember { mutableStateOf("idle") } // idle | saving | saved
            val nameDirty = displayName.trim() != (me.displayName ?: "") && displayName.isNotBlank()
            val bioDirty = bio.trim() != (me.bio ?: "")
            val statusDirty = customStatus.trim() != (me.customStatus ?: "") ||
                customStatusEmoji != (me.customStatusEmoji ?: "") ||
                statusExpiry != (if (me.customStatusExpiresAt != null) "keep" else "off")
            val dirty = nameDirty || bioDirty || statusDirty
            LaunchedEffect(saveState) {
                if (saveState == "saved") { kotlinx.coroutines.delay(1500); saveState = "idle" }
            }
            if (dirty || saveState != "idle") {
                Spacer(Modifier.height(16.dp))
                PrimaryButton(
                    when (saveState) { "saving" -> "Saving…"; "saved" -> "Saved."; else -> "Save changes" },
                    enabled = dirty && saveState != "saving",
                ) {
                    saveState = "saving"
                    if (nameDirty || bioDirty) store.updateProfile(displayName = displayName.trim(), bio = bio.trim())
                    if (statusDirty) {
                        statusBusy = true
                        store.setCustomStatus(customStatus, customStatusEmoji, computeExpiresAt(statusExpiry, me.customStatusExpiresAt)) {
                            statusBusy = false
                            saveState = "saved"
                        }
                    } else {
                        saveState = "saved"
                    }
                }
            }

            // Cosmetic perks (name tag, avatar frame, staff shimmer) live in the
            // Membership tab. Email is edited in Security.
        }
    }
}

/** Small ink3 caption used above the cosmetic editors' Label/Color/Preview
 *  fields (mirrors iOS nameTagEditor / staffShimmerEditor sub-labels). */
@Composable
private fun FieldCaption(text: String) {
    Text(text, color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.4.sp)
}

/**
 * Staff + cosmetic editors — grouped under the Appearance tab, free for
 * everyone. Split into ordered blocks so the tab can lay them out to match iOS: STAFF NAME SHIMMER → APPEARANCE (themes) →
 * AVATAR DECORATION → NAME TAG → DISPLAY. NOTE: Android uses a fixed 7-swatch
 * preset palette instead of iOS's free color wheel — an intentional platform
 * simplification.
 */
@Composable
private fun StaffShimmerBlock(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val me = state.me ?: return
    if (me.isAdmin != true && me.isModerator != true) return
    Column(Modifier.fillMaxWidth()) {
        SectionLabel("STAFF NAME SHIMMER")
        Spacer(Modifier.height(6.dp))
        Text(
            "Give your display name an animated shimmer in a color you pick — it overrides your server role colors wherever your name appears. Staff only; turn it off any time.",
            color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp,
        )
        Spacer(Modifier.height(8.dp))
        val shimmerOn = !me.staffColor.isNullOrBlank()
        var shimmerColor by remember(me.staffColor) { mutableStateOf(me.staffColor?.ifBlank { null } ?: "#F4C95B") }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Shimmer my name", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.weight(1f))
            Switch(
                checked = shimmerOn,
                onCheckedChange = { want -> store.setStaffShimmer(if (want) shimmerColor else null) },
                colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = p.accent),
            )
        }
        if (shimmerOn) {
            Spacer(Modifier.height(10.dp))
            FieldCaption("PREVIEW")
            Spacer(Modifier.height(6.dp))
            Box(Modifier.clip(RoundedCornerShape(8.dp)).background(p.bg1).padding(horizontal = 10.dp, vertical = 6.dp)) {
                ShimmerName(
                    text = me.displayName ?: me.username ?: "You",
                    colorHex = shimmerColor, glow = me.staffGlow == true,
                    fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                )
            }
            Spacer(Modifier.height(10.dp))
            FieldCaption("COLOR")
            Spacer(Modifier.height(6.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TAG_COLORS.forEach { hex ->
                    val c = parseHex(hex) ?: p.accent
                    Box(
                        Modifier.size(28.dp).clip(CircleShape).background(c)
                            .then(if (hex.equals(shimmerColor, ignoreCase = true)) Modifier.border(2.dp, Color.White, CircleShape) else Modifier)
                            .clickable { shimmerColor = hex; store.setStaffShimmer(hex) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Add a slight glow", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.weight(1f))
                Switch(
                    checked = me.staffGlow == true,
                    onCheckedChange = { store.setStaffGlow(it) },
                    colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = p.accent),
                )
            }
        }
    }
}

@Composable
private fun AvatarDecorationBlock(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val me = state.me ?: return
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(20.dp))
        SectionLabel("AVATAR DECORATION")
        Spacer(Modifier.height(6.dp))
        run {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                val current = me.avatarDecoration.takeIf { !it.isNullOrEmpty() } ?: "none"
                DECORATIONS.forEach { id ->
                    Box(
                        Modifier.clip(RoundedCornerShape(10.dp))
                            .then(if (id == current) Modifier.background(p.accent.copy(alpha = 0.18f)) else Modifier)
                            .clickable { store.setAvatarDecoration(id) }.padding(4.dp),
                    ) {
                        Avatar(url = me.avatarUrl, name = me.bestName, size = 46.dp, decoration = if (id == "none") null else id)
                    }
                }
            }
        }
    }
}

@Composable
private fun NameTagBlock(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val me = state.me ?: return
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(20.dp))
        SectionLabel("NAME TAG")
        Spacer(Modifier.height(6.dp))
        run {
            var tagLabel by remember(me.tagLabel) { mutableStateOf(me.tagLabel ?: "") }
            var tagColor by remember(me.tagColor) { mutableStateOf(me.tagColor ?: TAG_COLORS.first()) }
            FieldCaption("LABEL")
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTextField(tagLabel, { tagLabel = it.take(4) }, "TAG", Modifier.width(96.dp))
                if (tagLabel.isNotBlank()) {
                    val tc = parseHex(tagColor) ?: p.accent
                    Text(
                        tagLabel.uppercase(), color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp,
                        modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(tc).padding(horizontal = 7.dp, vertical = 3.dp),
                    )
                }
            }
            Spacer(Modifier.height(10.dp))
            FieldCaption("COLOR")
            Spacer(Modifier.height(6.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TAG_COLORS.forEach { hex ->
                    val c = parseHex(hex) ?: p.accent
                    Box(
                        Modifier.size(28.dp).clip(CircleShape).background(c)
                            .then(if (hex == tagColor) Modifier.border(2.dp, Color.White, CircleShape) else Modifier)
                            .clickable { tagColor = hex },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                PrimaryButton("Save tag") { store.setNameTag(tagLabel.trim(), tagColor) }
                if ((me.tagLabel ?: "").isNotBlank()) {
                    Text("Remove", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
                        modifier = Modifier.clickable { tagLabel = ""; store.setNameTag("", null) }.padding(6.dp))
                }
            }
        }
    }
}

private fun expiryLabel(v: String): String = when (v) {
    "keep" -> "Keep current"
    "30m" -> "30 minutes"
    "1h" -> "1 hour"
    "4h" -> "4 hours"
    "today" -> "Today"
    "week" -> "This week"
    else -> "Don't clear"
}

/**
 * Resolve an auto-clear choice to an ISO-8601 instant (or null = never clear).
 * Mirrors web's computeExpiresAt / iOS's CustomStatusExpiryChoice.resolved.
 * "keep" leaves the existing expiry untouched.
 */
private fun computeExpiresAt(choice: String, current: String?): String? {
    val zone = ZoneId.systemDefault()
    return when (choice) {
        "keep" -> current
        "30m" -> Instant.now().plusSeconds(30 * 60).toString()
        "1h" -> Instant.now().plusSeconds(60 * 60).toString()
        "4h" -> Instant.now().plusSeconds(4 * 60 * 60).toString()
        "today" -> LocalDate.now(zone).plusDays(1).atStartOfDay(zone).toInstant().toString()
        "week" -> {
            // Mirror web/iOS: next local midnight + (days until Sunday→Monday
            // midnight), where jsDay is 0=Sun..6=Sat. On Sunday this lands on
            // the Monday-after-next (+8d), not tomorrow.
            val jsDay = LocalDate.now(zone).dayOfWeek.value % 7 // MON(1)..SAT(6)→1..6, SUN(7)→0
            val daysUntilSundayMidnight = if (jsDay == 0) 7 else 7 - jsDay
            LocalDate.now(zone).plusDays(1L + daysUntilSundayMidnight).atStartOfDay(zone).toInstant().toString()
        }
        else -> null // "off"
    }
}

private val DECORATIONS = listOf("none", "ring", "glow", "gold", "rose", "violet", "lime", "aurora", "sunset", "emerald", "crimson", "ocean")
private val TAG_COLORS = listOf("#3D9BFF", "#F4C95B", "#EC5FB5", "#9D7BFF", "#7EE787", "#FF4D4D", "#3DD8C0")

/** Read a picked image URI into (bytes, mime, filename) off the main thread; caps at 25 MB. */
private fun readImageForUpload(ctx: android.content.Context, uri: Uri): Triple<ByteArray, String, String>? = runCatching {
    val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@runCatching null
    if (bytes.size > 25 * 1024 * 1024) return@runCatching null
    val mime = ctx.contentResolver.getType(uri) ?: "image/jpeg"
    var name = "image"
    ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
        val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0 && c.moveToFirst()) name = c.getString(idx) ?: name
    }
    if (!name.contains('.')) name = "$name.jpg"
    Triple(bytes, mime, name)
}.getOrNull()

private fun statusColor(status: String): Color = when (status) {
    "idle" -> ZkStatus.idle
    "dnd" -> ZkStatus.dnd
    "invisible" -> ZkInk.ink3
    else -> ZkStatus.online
}

@Composable
private fun StatusRow(label: String, value: String, current: String, onClick: () -> Unit) {
    val p = ZkTheme.palette
    val selected = current == value
    Row(
        Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(RoundedCornerShape(10.dp)).background(p.bg2).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).clip(CircleShape).background(statusColor(value)))
        Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(start = 10.dp).weight(1f))
        if (selected) Icon(Icons.Filled.Check, "Selected", tint = p.accent, modifier = Modifier.size(20.dp))
    }
}

private fun parseHex(hex: String?): Color? {
    if (hex.isNullOrBlank()) return null
    return runCatching { Color(android.graphics.Color.parseColor(if (hex.startsWith("#")) hex else "#$hex")) }.getOrNull()
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
private fun SecuritySection(state: AppState, onOpen: (SecurityPage) -> Unit) {
    val me = state.me
    Column {
        // ── SECURITY: device unlock + second factors (iOS SECURITY group). ──
        SectionLabel("SECURITY", Modifier.padding(start = 16.dp, top = 4.dp, bottom = 2.dp))
        // Biometric app lock — device-local; gated + verified before arming.
        val appLock = com.zekktris.ui.theme.LocalAppLock.current
        SwitchRow(
            "App lock",
            if (appLock.supported) "Require your fingerprint, face, or device PIN to open Zekktris." else "Set up a screen lock or biometrics in system settings first.",
            checked = appLock.enabled,
            enabled = appLock.supported,
        ) { appLock.setEnabled(it) }
        InAppRow("Passkeys", leading = Icons.Filled.Fingerprint) { onOpen(SecurityPage.Passkeys) }
        InAppRow("Two-factor authentication", leading = Icons.Filled.Shield) { onOpen(SecurityPage.TwoFactor) }
        // Directly after 2FA (iOS MainView.swift:3296-3306).
        // Approve a login on a device that ISN'T signed in: this phone scans the
        // code that one displays. The label stays as the user's goal rather than
        // the mechanism — from here they are still "logging in on another device".
        InAppRow("Log in on another device", leading = Icons.Filled.QrCode2) { onOpen(SecurityPage.DeviceLogin) }

        // ── ACCOUNT: identity value rows + change/copy affordances (iOS). ──
        Spacer(Modifier.height(14.dp))
        SectionLabel("ACCOUNT", Modifier.padding(start = 16.dp, top = 4.dp, bottom = 2.dp))
        AccountValueRow("Username", me?.username?.let { "@$it" } ?: "—", leading = Icons.Filled.Person) { onOpen(SecurityPage.Username) }
        AccountValueRow("Email", me?.email ?: "—", leading = Icons.Filled.Email) { onOpen(SecurityPage.Email) }
        // Only for an account that can still change it. The server locks the
        // date the moment it is set, so offering the row to everyone else would
        // be a button whose only outcome is an error.
        if (me?.canChangeDob == true) {
            AccountValueRow(
                "Date of birth", me.dateOfBirth ?: "Not set", leading = Icons.Filled.Person,
            ) { onOpen(SecurityPage.DateOfBirth) }
        }
        UserIdRow(me?.id ?: "—")
        InAppRow("Change password", leading = Icons.Filled.Lock) { onOpen(SecurityPage.Password) }
        InAppRow("Active sessions", leading = Icons.Filled.Devices) { onOpen(SecurityPage.Sessions) }
    }
}

/** ACCOUNT value row: leading icon + label + current value + accent "Change" pill. */
@Composable
private fun AccountValueRow(label: String, value: String, leading: ImageVector, onChange: () -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(leading, null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text(label, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
            Text(value, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.padding(top = 1.dp))
        }
        Text(
            "Change",
            color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
            modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(p.accent.copy(alpha = 0.12f)).clickable(onClick = onChange).padding(horizontal = 12.dp, vertical = 7.dp),
        )
    }
}

/** ACCOUNT User ID row: leading icon + mono value + copy button (iOS parity). */
@Composable
private fun UserIdRow(id: String) {
    val clipboard = LocalClipboardManager.current
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Memory, null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
        Column(Modifier.padding(start = 12.dp).weight(1f)) {
            Text("User ID", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
            Text(id, color = ZkInk.ink1, fontFamily = ZkMono, fontSize = 14.sp, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, modifier = Modifier.padding(top = 1.dp))
        }
        Icon(
            Icons.Filled.ContentCopy, "Copy user ID", tint = ZkTheme.palette.accent,
            modifier = Modifier.clip(CircleShape).clickable { clipboard.setText(AnnotatedString(id)) }.padding(6.dp).size(18.dp),
        )
    }
}

@Composable
private fun InAppRow(label: String, leading: ImageVector? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            Icon(leading, null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
        }
        Text(label, color = ZkInk.ink1, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
    }
}

// ── Notifications / Appearance / Privacy sections (iOS parity) ───────────────

@Composable
private fun zkSwitchColors() = SwitchDefaults.colors(
    checkedThumbColor = Color.White,
    checkedTrackColor = ZkTheme.palette.accent,
    uncheckedThumbColor = ZkInk.ink3,
    uncheckedTrackColor = ZkTheme.palette.bg3,
    uncheckedBorderColor = ZkTheme.palette.line,
)

@Composable
private fun SwitchRow(
    title: String,
    subtitle: String?,
    checked: Boolean,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 12.dp).alpha(if (enabled) 1f else 0.5f)) {
            Text(title, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp)
            if (subtitle != null) {
                Text(subtitle, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
            }
        }
        Switch(checked = checked, enabled = enabled, onCheckedChange = onChange, colors = zkSwitchColors())
    }
}

/**
 * System notification-permission status. On Android 13+ push needs the
 * POST_NOTIFICATIONS runtime grant; if the user denied it at launch this row
 * surfaces the problem and deep-links to the system app-notification settings.
 * Re-checks on ON_RESUME so returning from settings updates it live.
 */
@Composable
private fun NotificationPermissionRow() {
    val ctx = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var enabled by remember { mutableStateOf(NotificationManagerCompat.from(ctx).areNotificationsEnabled()) }
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) enabled = NotificationManagerCompat.from(ctx).areNotificationsEnabled()
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }
    val open = {
        runCatching {
            ctx.startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName),
            )
        }
        Unit
    }
    if (enabled) {
        Row(
            Modifier.fillMaxWidth().clickable { open() }.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("System notifications", color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp)
                Text("Enabled", color = ZkStatus.online, fontFamily = ZkSans, fontSize = 12.sp)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
        }
    } else {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                .clip(RoundedCornerShape(10.dp)).background(ZkStatus.danger.copy(alpha = 0.12f))
                .clickable { open() }.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Notifications are turned off", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text("You won't get messages or call alerts. Tap to enable.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
            }
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = ZkStatus.dangerSoft, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun NotificationsSection(store: AppStore, state: AppState) {
    val ctx = LocalContext.current
    val prefs = remember { ctx.getSharedPreferences("zk_prefs", android.content.Context.MODE_PRIVATE) }
    var notifyMessages by remember { mutableStateOf(prefs.getBoolean("zk.notifyMessages", true)) }
    var notifyCalls by remember { mutableStateOf(prefs.getBoolean("zk.notifyCalls", true)) }

    Column {
        SectionLabel("NOTIFICATIONS", Modifier.padding(start = 16.dp, top = 4.dp, bottom = 2.dp))
        NotificationPermissionRow()
        SwitchRow("Messages & mentions", "Direct messages and @mentions.", notifyMessages) {
            notifyMessages = it; prefs.edit().putBoolean("zk.notifyMessages", it).apply()
        }
        SwitchRow("Incoming calls", "Ring for 1-on-1 calls.", notifyCalls) {
            notifyCalls = it; prefs.edit().putBoolean("zk.notifyCalls", it).apply()
        }
        // System-settings footnote belongs to NOTIFICATIONS (the achievements
        // rows moved to the Profile tab's trailing ACHIEVEMENTS section).
        Text(
            "Sound, lock-screen style, and badges are controlled in Android Settings → Apps → Zekktris → Notifications.",
            color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
    }
}

/** FEATURES — the Parental-controls opt-in that shows the Family button on the
 *  server rail (iOS MainView.swift:3156-3169, zk.showFamily default OFF). */
@Composable
private fun FeaturesSection() {
    val ctx = LocalContext.current
    val prefs = remember { ctx.getSharedPreferences("zk_prefs", android.content.Context.MODE_PRIVATE) }
    var showFamily by remember { mutableStateOf(prefs.getBoolean("zk.showFamily", false)) }
    Column {
        Spacer(Modifier.height(10.dp))
        SectionLabel("FEATURES", Modifier.padding(start = 16.dp, bottom = 2.dp))
        SwitchRow(
            "Parental controls",
            "Show the Family button on the server rail.",
            checked = showFamily,
        ) { showFamily = it; prefs.edit().putBoolean("zk.showFamily", it).apply() }
    }
}

/** APPEARANCE (themes) block — first cosmetic under Appearance, matching iOS. */
@Composable
private fun ThemeBlock() {
    val controller = LocalThemeController.current
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(20.dp))
        SectionLabel("APPEARANCE")
        Spacer(Modifier.height(8.dp))
        run {
            // Two horizontally-scrolling rows of compact ~84x78 cards
            // (iOS MainView.swift:2639-2646), not a tall vertical grid.
            androidx.compose.foundation.lazy.grid.LazyHorizontalGrid(
                rows = androidx.compose.foundation.lazy.grid.GridCells.Fixed(2),
                modifier = Modifier.fillMaxWidth().height(172.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(ZK_THEMES.size) { i ->
                    val (id, label) = ZK_THEMES[i]
                    ThemeCard(id, label, selected = controller.themeId == id, Modifier.width(84.dp)) { controller.setTheme(id) }
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                "Themes apply on this device.",
                color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 12.sp,
            )
        }
    }
}

/** DISPLAY section — the free, device-local "hide clan tags" declutter toggle. */
@Composable
private fun DisplayBlock() {
    val p = ZkTheme.palette
    Column(Modifier.fillMaxWidth()) {
        Spacer(Modifier.height(20.dp))
        SectionLabel("DISPLAY")
        Spacer(Modifier.height(8.dp))
        val hideTags = com.zekktris.ui.theme.LocalHideTags.current
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Hide clan tags", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text(
                    "Hide everyone's name-tag pills (yours too) on this device. Your tag is still visible to others.",
                    color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                )
            }
            Switch(checked = hideTags.enabled, onCheckedChange = { hideTags.setEnabled(it) }, colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = p.accent))
        }
    }
}

/**
 * Compact theme swatch card (iOS themeCard, MainView.swift:2830-2864): ~84x78,
 * a 30dp base circle with two overlapping 13dp accent dots, 10sp label,
 * selected = bg3 fill + accent(0.5) border + a small check badge on the circle.
 */
@Composable
private fun ThemeCard(id: String, label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val pal = ZkPalette.forId(id)
    val darkCircle = if (id.contains("oled", ignoreCase = true)) Color.Black else pal.bg0
    Column(
        modifier
            .height(78.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(if (selected) pal.bg3 else pal.bg1)
            .border(1.dp, if (selected) pal.accent.copy(alpha = 0.5f) else pal.line, RoundedCornerShape(10.dp))
            .clickable(onClick = onClick)
            .padding(6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(38.dp)) {
            // Dark base circle with two overlapping brand dots centered over it.
            Box(Modifier.align(Alignment.Center).size(30.dp).clip(CircleShape).background(darkCircle)) {
                Box(Modifier.align(Alignment.Center).offset(x = (-4).dp).size(13.dp).clip(CircleShape).background(pal.accent))
                Box(Modifier.align(Alignment.Center).offset(x = 4.dp).size(13.dp).clip(CircleShape).background(pal.accent2))
            }
            if (selected) {
                Icon(Icons.Filled.CheckCircle, "Selected", tint = pal.accent, modifier = Modifier.align(Alignment.TopEnd).size(13.dp))
            }
        }
        Text(
            label, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp,
            maxLines = 2, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

@Composable
private fun PrivacySection(store: AppStore, state: AppState) {
    val me = state.me
    LaunchedEffect(Unit) { store.loadRelationships() }
    Column {
        SectionLabel("PRIVACY", Modifier.padding(start = 16.dp, top = 4.dp, bottom = 2.dp))
        SwitchRow(
            "Send read receipts",
            "Let people you DM see Delivered and Read. When off, you won't see receipts on messages sent to you either.",
            me?.dmReadReceiptsEnabled != false,
        ) { store.setDmReadReceipts(it) }
        SwitchRow(
            "Public achievements",
            "Let others see your achievements on your profile. Off keeps them private to you.",
            me?.achievementsPublic != false,
        ) { store.setAchievementsPublic(it) }
        // Only TITLED tiers get the toggle — founder/grandfathered rows have no
        // title to hide (iOS gates on subscriptionTitled).
        if (me?.subscriptionTitled == true) {
            SwitchRow(
                "Show my perk tier",
                "Displays your tier title on your profile. Off hides the title — your perks keep working.",
                me.showSubscriptionTier != false,
            ) { store.setShowSubscriptionTier(it) }
        }

        Spacer(Modifier.height(12.dp))
        SectionLabel("BLOCKED USERS", Modifier.padding(start = 16.dp, bottom = 4.dp))
        val blocked = state.relationships.filter { it.type == "blocked" }
        if (blocked.isEmpty()) {
            Text(
                "You haven't blocked anyone.",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            )
        } else {
            blocked.forEach { r -> BlockedRow(r.user) { store.unblockUser(r.user.id) } }
        }
    }
}

@Composable
private fun BlockedRow(user: PublicUser, onUnblock: () -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(url = user.avatarUrl, name = user.bestName, size = 34.dp)
        Text(user.bestName, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(start = 10.dp).weight(1f))
        Text(
            "Unblock",
            color = p.accent, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(p.accent.copy(alpha = 0.12f))
                .clickable(onClick = onUnblock)
                .padding(horizontal = 12.dp, vertical = 7.dp),
        )
    }
}

@Composable
private fun VoiceVideoSection(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    val prefs = remember { ctx.getSharedPreferences("zk_prefs", android.content.Context.MODE_PRIVATE) }
    var cameraQuality by remember { mutableStateOf(prefs.getString("zk.cameraQuality", "high") ?: "high") }
    var pushToTalk by remember { mutableStateOf(prefs.getBoolean("zk.pushToTalk", false)) }
    fun setQuality(v: String) {
        cameraQuality = v
        prefs.edit().putString("zk.cameraQuality", v).apply()
    }
    // Tier locks come from the ADMIN-CONFIGURED monetization matrix (1080p is
    // gateable too), not hardcoded constants (iOS requiredCameraTier).
    var monetization by remember { mutableStateOf<com.zekktris.data.model.MonetizationConfig?>(null) }
    LaunchedEffect(Unit) { monetization = store.getMonetization() }
    fun matrixTier(v: String?): String? = v?.takeIf { it != "none" }
    // All six iOS options (Models.swift:1424-1449) incl. Auto + Low.
    data class CamQ(val value: String, val label: String, val detail: String, val requiredTier: String?)
    val myRank = tierRank(state.me?.subscriptionTier)
    val cam = monetization?.camera
    val cams = listOf(
        CamQ("auto", "Auto", "Adapts to your connection (≈720p).", null),
        CamQ("low", "Low", "480p · saves bandwidth, good for slow networks.", null),
        CamQ("medium", "720p", "720p · balanced.", null),
        CamQ("high", "1080p", "1080p · sharp, needs a strong uplink.", matrixTier(cam?.p1080)),
        CamQ("k2", "2K", "2560×1440 · sharp, heavy on battery.", matrixTier(cam?.k2 ?: "guardian")),
        CamQ("k4", "4K", "3840×2160 · maximum sharpness — heavy CPU/heat; needs excellent wifi.", matrixTier(cam?.k4 ?: "legend")),
    )
    // A locked persisted pick snaps back to the best free option (iOS snaps a
    // locked selection back).
    LaunchedEffect(monetization, state.me?.subscriptionTier) {
        val current = cams.firstOrNull { it.value == cameraQuality }
        if (current?.requiredTier != null && myRank < tierRank(current.requiredTier)) setQuality("medium")
    }
    Column(Modifier.padding(horizontal = 16.dp)) {
        // ── MICROPHONE renders first, then CAMERA (iOS order). ──
        Text("MICROPHONE", color = ZkInk.ink3, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.5.sp)
        Spacer(Modifier.height(8.dp))
        MicTestRow(state)
        Spacer(Modifier.height(10.dp))
        SwitchRow(
            "Push to talk",
            "Hold the mic button to talk; your mic stays muted otherwise.",
            checked = pushToTalk,
            // Through the store, not straight to prefs: VoiceManager is the single
            // writer of the live PTT state, so a direct pref write only took effect
            // on the NEXT join — flipping this mid-call left the mic gated (or wide
            // open) against what the switch showed.
        ) { pushToTalk = it; store.setPushToTalk(it) }

        Spacer(Modifier.height(20.dp))
        Text("CAMERA", color = ZkInk.ink3, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.5.sp)
        Spacer(Modifier.height(8.dp))
        cams.forEach { q ->
            val locked = q.requiredTier != null && myRank < tierRank(q.requiredTier)
            val selected = cameraQuality == q.value
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(p.bg2)
                    .clickable(enabled = !locked) { setQuality(q.value) }
                    .padding(horizontal = 14.dp, vertical = 12.dp)
                    .alpha(if (locked) 0.55f else 1f),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(if (locked) "${q.label} 🔒" else q.label, color = ZkInk.ink1, fontSize = 15.sp)
                    Text(q.detail, color = ZkInk.ink3, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                }
                if (selected) {
                    Text("✓", color = p.accent, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                }
            }
        }
        Text(
            "Some qualities need a perk tier from this server's admins. 2K and 4K are heavy on battery. Changes apply the next time you turn your camera on.",
            color = ZkInk.ink4,
            fontSize = 12.sp,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

/** A "Test microphone" toggle + a live input-level meter (mirrors iOS
 *  micTestSection). Opens the mic only while active + releases on exit.
 *  While a call is live the test is replaced with an in-use notice so the
 *  meter never contends with the call's mic (iOS MainView.swift:3035-3047). */
@Composable
private fun MicTestRow(state: AppState) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    if (state.activeVoiceChannelId != null) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.MicOff, null, tint = ZkInk.ink3, modifier = Modifier.size(18.dp))
            Text(
                "Your mic is in use by an active call.",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                modifier = Modifier.padding(start = 10.dp),
            )
        }
        return
    }
    val recorder = remember { com.zekktris.voice.VoiceRecorder(ctx) }
    var testing by remember { mutableStateOf(false) }
    var level by remember { mutableStateOf(0f) }
    var permGranted by remember {
        mutableStateOf(androidx.core.content.ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED)
    }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permGranted = granted
        if (granted) testing = recorder.start()
    }
    // Poll the level while testing; stop + release the recorder when not.
    LaunchedEffect(testing) {
        if (testing) {
            while (testing) { level = recorder.currentLevel(); kotlinx.coroutines.delay(50) }
        } else {
            level = 0f
        }
    }
    DisposableEffect(Unit) { onDispose { recorder.cancel() } }  // never leave the mic open

    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(14.dp)) {
        Text(
            if (testing) "Speak — the bar moves with your voice." else "Check your mic is picking you up.",
            color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp,
        )
        // Level meter.
        Spacer(Modifier.height(10.dp))
        Box(Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)).background(p.bg3)) {
            Box(Modifier.fillMaxWidth(level.coerceIn(0f, 1f)).height(8.dp).clip(RoundedCornerShape(4.dp)).background(p.accent))
        }
        // Full-width accent primary button (mic/stop icon), mirroring iOS.
        Spacer(Modifier.height(12.dp))
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                .background(if (testing) ZkStatus.dangerSoft else p.accent)
                .clickable {
                    if (testing) { recorder.cancel(); testing = false }
                    else if (permGranted) testing = recorder.start()
                    else permLauncher.launch(android.Manifest.permission.RECORD_AUDIO)
                }
                .padding(vertical = 11.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (testing) Icons.Filled.Stop else Icons.Filled.Mic, null, tint = Color.White, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(if (testing) "Stop Test" else "Test Microphone", color = Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
        }
    }
}

private val TIER_SCOUT = Color(0xFF3D9BFF)
private val TIER_GUARDIAN = Color(0xFF9D7BFF)
private val TIER_LEGEND = Color(0xFFF4C95B)

private fun tierColor(id: String) = when (id) {
    "scout" -> TIER_SCOUT
    "guardian" -> TIER_GUARDIAN
    "legend" -> TIER_LEGEND
    else -> TIER_SCOUT
}

/** Ordinal rank for tier gating (none/null < scout < guardian < legend). */
private fun tierRank(id: String?) = when (id) {
    "scout" -> 1
    "guardian" -> 2
    "legend" -> 3
    else -> 0
}

/** What each perk tier adds — highlights the user's current tier. Lines come
 *  from this server's perk settings (AppStore.perkLines). Mirrors iOS
 *  perkTiersSection. */
@Composable
private fun PerkTiersSection(store: AppStore, state: AppState) {
    val tier = state.me?.subscriptionTier
    // Load the server's perk settings so the lines are this server's.
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { store.getMonetization(); loaded = true }
    Column(Modifier.padding(horizontal = 16.dp)) {
        Text("PERK TIERS", color = ZkInk.ink3, fontWeight = FontWeight.Bold, fontSize = 11.sp)
        Spacer(Modifier.height(6.dp))
        Text(
            "Zekktris is free — nothing is for sale. Perk tiers add streaming quality on top, and this server's admins hand them out. A supervising parent's tier also covers their children.",
            color = ZkInk.ink3, fontSize = 12.sp,
        )
        Spacer(Modifier.height(8.dp))
        key(loaded) {
            EntitlementCard(
                null, "Everyone",
                listOf("Every feature, plus all themes, avatar frames & name tags") + store.perkLines(0),
                current = tier == null,
            )
            listOf("scout" to "Scout", "guardian" to "Guardian", "legend" to "Legend").forEach { (id, name) ->
                EntitlementCard(id, name, store.perkLines(tierRank(id)) + "Tier title on your profile", current = tier == id)
            }
        }
        state.me?.subscriptionExpiresAt?.let {
            Text(
                "Your tier runs until ${it.take(10)}.",
                color = ZkInk.ink3, fontSize = 12.sp,
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

@Composable
private fun EntitlementCard(id: String?, name: String, perks: List<String>, current: Boolean) {
    val p = ZkTheme.palette
    val color = id?.let { tierColor(it) } ?: ZkInk.ink2
    // Current tier gets a tier-tinted fill + tier-colored border, radius 12 (iOS).
    val shape = RoundedCornerShape(if (current) 12.dp else 10.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
            .clip(shape)
            .background(if (current) color.copy(alpha = 0.08f) else p.bg2)
            .then(if (current) Modifier.border(1.dp, color.copy(alpha = 0.5f), shape) else Modifier)
            .padding(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(name, color = color, fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = Modifier.weight(1f))
            if (current) {
                Text(
                    "YOUR TIER",
                    color = color, fontWeight = FontWeight.Bold, fontSize = 9.sp,
                    modifier = Modifier.clip(CircleShape).background(color.copy(alpha = 0.2f)).padding(horizontal = 7.dp, vertical = 2.dp),
                )
            }
        }
        perks.forEach { perk ->
            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.Top) {
                Text("✓", color = color, fontSize = 12.sp)
                Text(perk, color = ZkInk.ink2, fontSize = 13.sp, modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}

/** A tappable row (title + subtitle + chevron) that navigates to a sub-page. */
@Composable
private fun NavRow(title: String, subtitle: String, leading: ImageVector? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            Icon(leading, null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, color = ZkInk.ink1, fontSize = 15.sp)
            Text(subtitle, color = ZkInk.ink4, fontSize = 12.sp, modifier = Modifier.padding(top = 1.dp))
        }
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
    }
}

/** A row that opens an arbitrary external [url] in the browser. */
@Composable
private fun LinkRow(label: String, url: String, leading: ImageVector? = null) {
    val ctx = LocalContext.current
    Row(
        Modifier.fillMaxWidth().clickable {
            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }.padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            Icon(leading, null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
        }
        Text(label, color = ZkInk.ink1, fontSize = 15.sp, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = ZkInk.ink3, modifier = Modifier.size(20.dp))
    }
}

@Composable
private fun WebRow(label: String) {
    val ctx = LocalContext.current
    Row(
        Modifier.fillMaxWidth().clickable {
            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(webSettingsUrl))) }
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

/** Full achievement catalog: earned badges highlighted, locked ones greyed
 *  with a progress bar. Mirrors the iOS AchievementsGallerySheet. */
@Composable
private fun AchievementsGalleryScreen(store: AppStore, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var items by remember { mutableStateOf<List<com.zekktris.data.model.Achievement>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { items = store.fetchMyAchievements(); loaded = true }
    ScreenScaffold("Achievements", onBack = onBack) {
        if (loaded && items.isEmpty()) {
            Text("No achievements yet.", color = ZkInk.ink3, fontSize = 13.sp, modifier = Modifier.padding(16.dp))
            return@ScreenScaffold
        }
        val earnedCount = items.count { it.isEarned }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (items.isNotEmpty()) {
                item { Text("$earnedCount of ${items.size} earned", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(bottom = 4.dp)) }
            }
            items(items, key = { it.id }) { a ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(12.dp).alpha(if (a.isEarned) 1f else 0.55f),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(a.marker, fontSize = 24.sp)
                    Column(Modifier.padding(start = 12.dp).weight(1f)) {
                        Text(a.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                        Text(a.description, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                        // Progress bar for a locked achievement with a goal.
                        val goal = a.goal ?: 0
                        if (!a.isEarned && goal > 0) {
                            LinearProgressIndicator(
                                progress = { (a.value.toFloat() / goal).coerceIn(0f, 1f) },
                                color = p.accent, trackColor = p.bg3,
                                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                            )
                            Text("${a.value} / $goal", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                        }
                    }
                    if (a.isEarned) {
                        Icon(Icons.Filled.CheckCircle, "Earned", tint = ZkStatus.online, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun LogoutRow(store: AppStore) {
    // Full-width danger-tint pill with a leading logout icon (iOS logoutSection).
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(ZkStatus.danger.copy(alpha = 0.1f))
            .clickable { store.logout() }
            .padding(vertical = 13.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Filled.Logout, null, tint = ZkStatus.dangerSoft, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("Log Out", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
    }
}
