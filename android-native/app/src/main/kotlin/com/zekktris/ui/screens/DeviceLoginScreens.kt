package com.zekktris.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.DevicesOther
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.PhoneIphone
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.QrCode2
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppStore
import com.zekktris.DeviceLoginOutcome
import com.zekktris.data.DeviceLoginCode
import com.zekktris.data.model.DeviceLoginRequestInfo
import com.zekktris.ui.components.AbyssBackground
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.components.QrCode
import com.zekktris.ui.components.QrScan
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.components.parseInstant
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkMono
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/*
 * Device-approval login, both halves.
 *
 *   DeviceLoginScreen        — the LOGGED-OUT device. Shows a QR + short code
 *                              and waits for someone to approve it.
 *   ApproveDeviceLoginScreen — the ALREADY SIGNED-IN phone. Scans or types that
 *                              code, shows what is being asked for, and decides.
 *
 * This replaces the old quick-login direction, where the signed-in phone minted
 * a code that was itself the whole credential. Here the short code is public by
 * construction and useless to anyone who is not already authenticated.
 *
 * The approval screen below is a SECURITY CONTROL, not a formality. The one
 * attack the server cannot stop is an attacker starting a request on their own
 * machine and talking the user into approving it — the server just sees a real
 * session make a real approval. All it can do is hand the approver the facts,
 * and all this screen has to do is not hide them. Read the header of
 * apps/api/src/auth/device-login-store.ts before simplifying anything here.
 */

// ── The logged-out device ───────────────────────────────────────────────────

/**
 * Ask to be signed in from a device the user is already signed in on.
 *
 * Lives in the Auth phase, so it wears the same full-bleed abyss look as the
 * login and welcome screens rather than [ScreenScaffold].
 */
@Composable
fun DeviceLoginScreen(store: AppStore, onBack: () -> Unit) {
    val p = ZkTheme.palette
    val clipboard = LocalClipboardManager.current

    // Bumping this restarts the whole flow (new code, new poll loop).
    var attempt by remember { mutableStateOf(0) }
    var userCode by remember { mutableStateOf<String?>(null) }
    var expiresAtMs by remember { mutableStateOf(0L) }
    var outcome by remember { mutableStateOf<DeviceLoginOutcome?>(null) }
    var nowMs by remember { mutableStateOf(System.currentTimeMillis()) }
    var copied by remember { mutableStateOf(false) }

    // The whole request lives inside this one call: the SECRET device code is a
    // local inside runDeviceLogin and never reaches this composable, and leaving
    // the screen cancels the effect, which ends the poll loop.
    LaunchedEffect(attempt) {
        userCode = null
        outcome = null
        copied = false
        outcome = store.runDeviceLogin { start ->
            userCode = start.userCode
            expiresAtMs = System.currentTimeMillis() + start.expiresIn * 1000L
            nowMs = System.currentTimeMillis()
        }
    }

    // 1 Hz countdown, only while a live code is on screen.
    LaunchedEffect(userCode, outcome) {
        while (userCode != null && outcome == null) {
            nowMs = System.currentTimeMillis()
            delay(1_000)
        }
    }

    val approved = outcome as? DeviceLoginOutcome.Approved
    // Show the account for a beat, then enter the app. The pause is the point:
    // a guessed code can land this device in SOMEONE ELSE'S account, and the
    // only place that can ever be noticed is right here.
    LaunchedEffect(approved) {
        val a = approved ?: return@LaunchedEffect
        delay(2_200)
        store.completeDeviceLogin(a.user)
    }
    // Swallow the back gesture for those two seconds — we are mid-transition and
    // there is nothing to go back to; the session already exists.
    BackHandler(enabled = approved != null) {}

    AbyssBackground(contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier
                .safeDrawingPadding()
                .verticalScroll(rememberScrollState())
                .fillMaxWidth()
                .padding(horizontal = 28.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = if (approved != null) "You're in" else "Log in from another device",
                color = ZkInk.ink1,
                fontFamily = ZkSans,
                fontWeight = FontWeight.Bold,
                fontSize = 26.sp,
                textAlign = TextAlign.Center,
            )

            when {
                approved != null -> {
                    Spacer(Modifier.height(20.dp))
                    Icon(
                        Icons.Filled.CheckCircle,
                        contentDescription = null,
                        tint = ZkStatus.success,
                        modifier = Modifier.size(56.dp),
                    )
                    Spacer(Modifier.height(16.dp))
                    val name = approved.user.displayName?.takeIf { it.isNotBlank() }
                        ?: approved.user.username?.let { "@$it" }
                        ?: "your account"
                    Text(
                        "Signed in as $name",
                        color = ZkInk.ink1,
                        fontFamily = ZkSans,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 17.sp,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        "Not the account you expected? Sign out from Settings straight away.",
                        color = ZkInk.ink3,
                        fontFamily = ZkSans,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }

                outcome != null -> {
                    val (message, detail) = when (val o = outcome!!) {
                        is DeviceLoginOutcome.Denied ->
                            "Request denied" to "The other device turned this down. If that wasn't you, change your password."
                        is DeviceLoginOutcome.Expired ->
                            "That code expired" to "Codes last about five minutes. Get a fresh one and try again."
                        is DeviceLoginOutcome.Failed -> "Couldn't finish" to o.message
                        is DeviceLoginOutcome.Approved -> "" to ""
                    }
                    Spacer(Modifier.height(20.dp))
                    Text(
                        message,
                        color = ZkStatus.dangerSoft,
                        fontFamily = ZkSans,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 16.sp,
                        textAlign = TextAlign.Center,
                    )
                    Text(
                        detail,
                        color = ZkInk.ink3,
                        fontFamily = ZkSans,
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                    Spacer(Modifier.height(20.dp))
                    Box(Modifier.width(280.dp)) {
                        PrimaryButton("Get a new code") { attempt++ }
                    }
                }

                userCode == null -> {
                    Spacer(Modifier.height(32.dp))
                    CircularProgressIndicator(color = p.accent)
                }

                else -> {
                    val code = userCode!!
                    Text(
                        "On a device you're already signed in on, open Settings → Security → " +
                            "“Log in on another device”, then scan this code or type it in.",
                        color = ZkInk.ink3,
                        fontFamily = ZkSans,
                        fontSize = 13.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 10.dp, bottom = 20.dp),
                    )
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(14.dp))
                            .background(Color.White)
                            .padding(12.dp),
                    ) { QrCode(DeviceLoginCode.qrPayload(code), size = 208.dp) }

                    Spacer(Modifier.height(18.dp))
                    Text(
                        DeviceLoginCode.format(code),
                        color = ZkInk.ink1,
                        fontFamily = ZkMono,
                        fontWeight = FontWeight.Bold,
                        fontSize = 30.sp,
                        modifier = Modifier
                            .clip(RoundedCornerShape(10.dp))
                            .clickable {
                                clipboard.setText(AnnotatedString(DeviceLoginCode.format(code)))
                                copied = true
                            }
                            .padding(horizontal = 14.dp, vertical = 6.dp),
                    )
                    Text(
                        if (copied) "Copied" else "Tap to copy",
                        color = if (copied) ZkStatus.success else ZkInk.ink4,
                        fontFamily = ZkSans,
                        fontSize = 11.sp,
                    )

                    val secondsLeft = ((expiresAtMs - nowMs) / 1000L).coerceAtLeast(0L)
                    Text(
                        "Expires in %d:%02d".format(secondsLeft / 60, secondsLeft % 60),
                        color = ZkInk.ink4,
                        fontFamily = ZkSans,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(top = 12.dp),
                    )

                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(top = 18.dp),
                    ) {
                        CircularProgressIndicator(color = p.accent, modifier = Modifier.size(16.dp))
                        Text(
                            "Waiting for approval…",
                            color = ZkInk.ink2,
                            fontFamily = ZkSans,
                            fontSize = 13.sp,
                            modifier = Modifier.padding(start = 10.dp),
                        )
                    }
                }
            }

            if (approved == null) {
                TextButton(onClick = onBack, modifier = Modifier.padding(top = 18.dp)) {
                    Text("Cancel", color = ZkInk.ink3, fontFamily = ZkSans)
                }
            }
        }
    }
}

// ── The signed-in phone ─────────────────────────────────────────────────────

/**
 * Review and decide a device-login request. Reached from
 * Settings → Security → "Log in on another device".
 *
 * The metadata split rendered below is load-bearing. `ipAddress`,
 * `sameNetwork` and `requestedAt` are observed by the server and a remote
 * attacker cannot forge them; `declaredName`, `platform`, `userAgent` and
 * `locale` are whatever the requesting device said about itself. They are shown
 * under separate headings for exactly that reason — an attacker will call
 * themselves "Pixel 9" and sit in another country.
 */
@Composable
fun ApproveDeviceLoginScreen(store: AppStore, onBack: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    // Naming the account is part of the control: "sign in as @you" is the line
    // that makes a phished approval read wrong.
    val username = store.state.collectAsState().value.me?.username

    var typed by remember { mutableStateOf("") }
    var request by remember { mutableStateOf<DeviceLoginRequestInfo?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var finished by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf(false) }
    // Kept as a String and saved: the Activity can be recreated while the system
    // camera app is in front, and losing this would silently drop the photo.
    var captureUri by rememberSaveable { mutableStateOf<String?>(null) }

    // The system camera writes a full-resolution JPEG into our cache dir. Once
    // it has been decoded (or the capture was cancelled) that file is dead
    // weight, so it goes. NOTE: File(uri.path) is NOT this file — a FileProvider
    // path is "/captures/<name>"; the real file lives under cacheDir.
    fun deleteCapture(uri: android.net.Uri?) {
        val name = uri?.lastPathSegment ?: return
        runCatching { java.io.File(java.io.File(ctx.cacheDir, "captures"), name).delete() }
    }

    fun lookUp(code: String) {
        scope.launch {
            busy = true
            error = null
            val found = store.lookupDeviceLogin(code)
            busy = false
            if (found == null) {
                // Unknown and expired are deliberately the same answer server
                // side, so this message covers both without inventing a
                // distinction the api refuses to make.
                error = "No pending login for that code. It may have expired — get a fresh one on the other device."
            } else {
                request = found
            }
        }
    }

    // One path for both answers, so Deny cannot end up cheaper to wire (and
    // therefore quieter) than Approve.
    fun decide(info: DeviceLoginRequestInfo, approve: Boolean) {
        scope.launch {
            busy = true
            error = null
            val code = DeviceLoginCode.normalize(info.userCode)
            val err = if (approve) store.approveDeviceLogin(code) else store.denyDeviceLogin(code)
            busy = false
            when {
                err != null -> error = err
                approve -> finished = "Approved. That device is signing in now."
                else -> finished = "Denied. That device was not signed in."
            }
        }
    }

    fun consumeImage(uri: android.net.Uri, fromCamera: Boolean) {
        scope.launch {
            busy = true
            error = null
            val decoded = QrScan.decode(ctx, uri)
            if (fromCamera) deleteCapture(uri)
            busy = false
            val code = DeviceLoginCode.parse(decoded)
            when {
                code != null -> { typed = DeviceLoginCode.format(code); lookUp(code) }
                decoded == null -> error = "No QR code found in that picture. Fill the frame with the code, or type it instead."
                // A QR that scanned fine but isn't ours: never follow or fetch
                // whatever it points at, just say so.
                else -> error = "That QR code isn't a Zekktris login code."
            }
        }
    }

    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = captureUri?.let { android.net.Uri.parse(it) }
        captureUri = null
        if (uri != null) {
            if (ok) consumeImage(uri, fromCamera = true) else deleteCapture(uri)
        }
    }

    fun launchCamera() {
        val dir = java.io.File(ctx.cacheDir, "captures").apply { mkdirs() }
        val file = java.io.File(dir, "qr_${System.nanoTime()}.jpg")
        val uri = androidx.core.content.FileProvider.getUriForFile(
            ctx, "${ctx.packageName}.fileprovider", file,
        )
        captureUri = uri.toString()
        cameraLauncher.launch(uri)
    }

    // Asked for HERE, on the tap that needs it — never at launch. The app
    // declares CAMERA in its manifest for voice video, and that declaration
    // makes ACTION_IMAGE_CAPTURE throw SecurityException unless the permission
    // is actually granted, so this is required rather than merely polite.
    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) launchCamera()
        else error = "Camera access is off, so scanning isn't available. Type the code instead."
    }

    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri -> if (uri != null) consumeImage(uri, fromCamera = false) }

    // Deliberately NO onDispose cleanup of a pending capture. A configuration
    // change while the camera app is in front recreates this Activity in the
    // background, and deleting the file there would pull it out from under the
    // camera mid-write. The two explicit deletes above (decoded, or cancelled)
    // cover every path except process death, which leaves one JPEG in a cache
    // dir the OS reclaims — the same trade ChatScreen's capture path makes.

    ScreenScaffold("Log in on another device", onBack = onBack) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val done = finished
            val info = request
            when {
                done != null -> {
                    Spacer(Modifier.height(24.dp))
                    Text(
                        done,
                        color = ZkInk.ink1,
                        fontFamily = ZkSans,
                        fontSize = 15.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(16.dp))
                    PrimaryButton("Done") { onBack() }
                }

                info != null -> DeviceRequestReview(
                    info = info,
                    username = username,
                    busy = busy,
                    error = error,
                    // Extra friction exactly where the risk is: an off-network
                    // request is the shape every remote phish takes, so that
                    // one goes through a destructive confirm. A device on the
                    // same network — the normal case, and the one signal a
                    // remote attacker cannot forge — approves directly, which
                    // is what iOS does.
                    onApprove = { if (info.device.sameNetwork) decide(info, approve = true) else confirming = true },
                    onDeny = { decide(info, approve = false) },
                    onBackToCode = { request = null; error = null },
                )

                else -> {
                    Text(
                        "Signing in somewhere new? Open Zekktris there, choose “Log in from another device”, " +
                            "then scan the code it shows you.",
                        color = ZkInk.ink3,
                        fontFamily = ZkSans,
                        fontSize = 13.sp,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        ScanChoice(
                            label = "Scan QR",
                            icon = Icons.Filled.QrCode2,
                            modifier = Modifier.weight(1f),
                        ) {
                            error = null
                            val granted = androidx.core.content.ContextCompat.checkSelfPermission(
                                ctx, Manifest.permission.CAMERA,
                            ) == PackageManager.PERMISSION_GRANTED
                            if (granted) launchCamera() else cameraPermission.launch(Manifest.permission.CAMERA)
                        }
                        ScanChoice(
                            label = "From photos",
                            icon = Icons.Filled.PhotoLibrary,
                            modifier = Modifier.weight(1f),
                        ) {
                            error = null
                            photoPicker.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                            )
                        }
                    }

                    Spacer(Modifier.height(4.dp))
                    SectionLabel("OR ENTER THE CODE")
                    FilledTextField(
                        value = typed,
                        onValueChange = { typed = it; error = null },
                        placeholder = "ABCD-EFGH",
                        modifier = Modifier.fillMaxWidth(),
                    )
                    PrimaryButton("Continue", enabled = !busy && DeviceLoginCode.isComplete(typed)) {
                        lookUp(DeviceLoginCode.normalize(typed))
                    }
                    if (busy) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                            CircularProgressIndicator(color = ZkTheme.palette.accent, modifier = Modifier.size(20.dp))
                        }
                    }
                    error?.let {
                        Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 13.sp)
                    }
                }
            }
        }
    }

    // The off-network destructive confirm, mirroring iOS's .alert. It is only
    // raised for a request the server did NOT see on this network — the shape
    // every remote phish takes — so the friction lands where the risk is
    // instead of being spent on the ordinary same-network case.
    if (confirming && request != null) {
        val info = request!!
        AlertDialog(
            onDismissRequest = { confirming = false },
            containerColor = ZkTheme.palette.bg2,
            title = { Text("This device isn't on your network", color = ZkInk.ink1, fontFamily = ZkSans) },
            text = {
                Text(
                    "It's asking for full access to your account from somewhere else. Only approve it " +
                        "if you started this sign-in yourself.",
                    color = ZkInk.ink2,
                    fontFamily = ZkSans,
                    fontSize = 13.sp,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    decide(info, approve = true)
                    // Destructive colour, not accent: this is the button that
                    // hands an off-network stranger the account.
                }) { Text("Approve anyway", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold) }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) {
                    Text("Cancel", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold)
                }
            },
        )
    }
}

/**
 * The review card — the SECURITY CONTROL of this whole flow, and a mirror of
 * DeviceLoginApprovalScreen in ios-native/Zekktris/AuthViews.swift (iOS is the
 * design source of truth here). Four rules, all deliberate:
 *
 *   1. The code is large and monospaced under "MAKE SURE THIS MATCHES".
 *      Comparing it with the other device's screen is the check that catches a
 *      code read out to the user over the phone, so it is never a footnote.
 *   2. DENY COMES FIRST and is at least as heavy as Approve. The cheap,
 *      reversible answer is the one under the thumb; Approve is never the
 *      styled-in "obvious" answer. Do not restore a full-width accent Approve
 *      with a quiet Deny underneath — that is how accounts get taken.
 *   3. Server-observed facts and device-claimed strings live in two separate
 *      boxes whose headings say which is which, and the claimed box carries the
 *      warning colour. Do not merge them into one tidy list.
 *   4. An off-network Approve is routed through a destructive confirm (see the
 *      caller); same-network approves go straight through.
 */
@Composable
private fun DeviceRequestReview(
    info: DeviceLoginRequestInfo,
    username: String?,
    busy: Boolean,
    error: String?,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onBackToCode: () -> Unit,
) {
    val p = ZkTheme.palette
    val d = info.device

    // Live countdown seeded from the server's expiresIn. Once it hits zero the
    // buttons go away: approving an expired request only 404s, and leaving them
    // up invites a puzzled second tap.
    var secondsLeft by remember(info.userCode) { mutableStateOf(info.expiresIn.coerceAtLeast(0)) }
    LaunchedEffect(info.userCode) {
        while (secondsLeft > 0) {
            delay(1_000)
            secondsLeft -= 1
        }
    }
    val expired = secondsLeft <= 0

    // ── Headline: what is being asked, and of WHICH account ─────────────────
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(66.dp).clip(CircleShape).background(p.bg3),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                platformIcon(d.platform),
                contentDescription = null,
                tint = ZkInk.ink1,
                modifier = Modifier.size(28.dp),
            )
        }
        Spacer(Modifier.height(10.dp))
        Text(
            "Approve this sign-in?",
            color = ZkInk.ink1,
            fontFamily = ZkSans,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            if (username.isNullOrEmpty()) {
                "A device wants to sign in to your account, with full access to it."
            } else {
                "A device wants to sign in as @$username — with full access to your account."
            },
            color = ZkInk.ink2,
            fontFamily = ZkSans,
            fontSize = 13.sp,
            textAlign = TextAlign.Center,
        )
    }

    // ── The compare-the-codes check ─────────────────────────────────────────
    // Near the top on purpose: this is the one test that catches a code that
    // was read out to the user rather than shown to them.
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(p.bg2)
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "MAKE SURE THIS MATCHES",
            color = ZkInk.ink3,
            fontFamily = ZkSans,
            fontWeight = FontWeight.Bold,
            fontSize = 11.sp,
        )
        Text(
            DeviceLoginCode.format(info.userCode),
            color = ZkInk.ink1,
            fontFamily = ZkMono,
            fontWeight = FontWeight.SemiBold,
            fontSize = 28.sp,
            letterSpacing = 3.sp,
        )
        Text(
            "Only approve if this is exactly the code on the other device's screen.",
            color = ZkInk.ink2,
            fontFamily = ZkSans,
            fontSize = 12.sp,
            textAlign = TextAlign.Center,
        )
        Text(
            if (expired) "This request has expired" else "Expires in ${countdownLabel(secondsLeft)}",
            color = when {
                expired -> ZkStatus.dangerSoft
                secondsLeft <= 30 -> ZkStatus.warning
                else -> ZkInk.ink3
            },
            fontFamily = ZkMono,
            fontSize = 12.sp,
        )
    }

    // ── The one signal a remote attacker cannot forge, when it's bad news ────
    if (!d.sameNetwork) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(ZkStatus.danger.copy(alpha = 0.12f))
                .border(1.dp, ZkStatus.danger.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
                .padding(12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                Icons.Filled.Warning,
                contentDescription = null,
                tint = ZkStatus.danger,
                modifier = Modifier.size(20.dp),
            )
            Column(Modifier.padding(start = 10.dp)) {
                Text(
                    "This device is not on your network",
                    color = ZkInk.ink1,
                    fontFamily = ZkSans,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 13.sp,
                )
                Text(
                    "If you aren't standing in front of the device showing this code, deny it — " +
                        "someone else is asking to get into your account.",
                    color = ZkInk.ink2,
                    fontFamily = ZkSans,
                    fontSize = 12.sp,
                )
            }
        }
    }

    // ── Box 1: server-observed. Cannot be faked by a remote attacker ────────
    CardHeader(Icons.Filled.Shield, ZkStatus.success, "WHAT ZEKKTRIS CAN SEE")
    InfoCard {
        MetaRow(
            "Network",
            if (d.sameNetwork) "Same network as this phone" else "Not on your network",
            valueColor = if (d.sameNetwork) ZkStatus.success else ZkStatus.dangerSoft,
        )
        MetaRow("IP address", d.ipAddress ?: "Unknown", mono = d.ipAddress != null)
        // approxLocation is always null today: the server does no GeoIP rather
        // than guess, and a blank row would read as "nothing suspicious".
        MetaRow(
            "Location",
            d.approxLocation ?: "Unavailable",
            valueColor = if (d.approxLocation == null) ZkInk.ink3 else ZkInk.ink1,
        )
        MetaRow("Started", agoLabel(d.requestedAt))
        Text(
            "Zekktris observed these itself. Someone in another country can't fake them.",
            color = ZkInk.ink3,
            fontFamily = ZkSans,
            fontSize = 11.sp,
        )
    }

    // ── Box 2: device-claimed. Decoration with a health warning ─────────────
    CardHeader(Icons.AutoMirrored.Filled.HelpOutline, ZkStatus.warning, "WHAT THE DEVICE SAYS IT IS")
    InfoCard {
        MetaRow("Device", d.declaredName ?: "Not given")
        MetaRow("Platform", platformLabel(d.platform))
        MetaRow("Language", d.locale ?: "Unknown")
        d.userAgent?.takeIf { it.isNotEmpty() }?.let { MetaRow("Browser or app", it, mono = true) }
        Text(
            "The device typed these about itself, so they can be faked — an attacker will happily " +
                "call themselves “Your Pixel”.",
            color = ZkStatus.warning,
            fontFamily = ZkSans,
            fontSize = 11.sp,
        )
    }

    Text(
        "Nobody from Zekktris will ever ask you to approve a sign-in or read out a code. If somebody " +
            "asked you to do this, deny it.",
        color = ZkInk.ink2,
        fontFamily = ZkSans,
        fontSize = 12.sp,
    )

    error?.let { Text(it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 13.sp) }

    when {
        busy -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            CircularProgressIndicator(color = p.accent, modifier = Modifier.size(20.dp))
        }

        expired -> {
            Text(
                "This request expired before you answered. Nothing was signed in — start again on the " +
                    "other device.",
                color = ZkInk.ink2,
                fontFamily = ZkSans,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            PrimaryButton("Done") { onBackToCode() }
        }

        // Equal size, equal weight, side by side — Deny first. Approve is not a
        // full-width accent bar, and Deny is not a muted afterthought.
        else -> {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "Deny",
                    color = ZkStatus.dangerSoft,
                    fontFamily = ZkSans,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 16.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(12.dp))
                        .background(p.bg3)
                        .border(1.dp, ZkStatus.danger.copy(alpha = 0.5f), RoundedCornerShape(12.dp))
                        .clickable(onClick = onDeny)
                        .padding(vertical = 15.dp),
                )
                Text(
                    "Approve",
                    color = Color.White,
                    fontFamily = ZkSans,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 16.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(12.dp))
                        .background(p.accent)
                        .clickable(onClick = onApprove)
                        .padding(vertical = 15.dp),
                )
            }
            TextButton(onClick = onBackToCode, modifier = Modifier.fillMaxWidth()) {
                Text("Use a different code", color = ZkInk.ink3, fontFamily = ZkSans)
            }
        }
    }
}

/** The heading above one of the two evidence boxes: icon + which half it is. */
@Composable
private fun CardHeader(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    tint: Color,
    title: String,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp))
        SectionLabel(title, modifier = Modifier.padding(start = 6.dp))
    }
}

/** `4:07`. Requests live five minutes, so minutes:seconds is the whole range. */
private fun countdownLabel(seconds: Int): String {
    val s = seconds.coerceAtLeast(0)
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

/** The glyph for what the device SAYS it is — decoration, never evidence. */
private fun platformIcon(platform: String): androidx.compose.ui.graphics.vector.ImageVector =
    when (platform.lowercase()) {
        "ios" -> Icons.Filled.PhoneIphone
        "android" -> Icons.Filled.PhoneAndroid
        "web" -> Icons.Filled.Language
        "desktop" -> Icons.Filled.Computer
        else -> Icons.Filled.DevicesOther
    }

@Composable
private fun InfoCard(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(ZkTheme.palette.bg2)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        content = content,
    )
}

@Composable
private fun MetaRow(
    label: String,
    value: String,
    valueColor: Color = ZkInk.ink1,
    mono: Boolean = false,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Text(
            label,
            color = ZkInk.ink3,
            fontFamily = ZkSans,
            fontSize = 13.sp,
            modifier = Modifier.width(112.dp),
        )
        Text(
            value,
            color = valueColor,
            fontFamily = if (mono) ZkMono else ZkSans,
            fontSize = if (mono) 12.sp else 13.sp,
            modifier = Modifier.weight(1f),
        )
    }
}

@Composable
private fun ScanChoice(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val p = ZkTheme.palette
    Column(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(p.bg2)
            .clickable(onClick = onClick)
            .padding(vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null, tint = p.accent, modifier = Modifier.size(26.dp))
        Text(
            label,
            color = ZkInk.ink1,
            fontFamily = ZkSans,
            fontWeight = FontWeight.SemiBold,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
}

/** Requests live five minutes, so this only ever needs seconds and minutes. */
private fun agoLabel(iso: String?): String {
    val instant = parseInstant(iso) ?: return "Just now"
    val seconds = java.time.Duration.between(instant, java.time.Instant.now()).seconds
    return when {
        // Negative means our clock trails the server's; "just now" is honest.
        seconds < 5 -> "Just now"
        seconds < 60 -> "$seconds seconds ago"
        seconds < 120 -> "1 minute ago"
        else -> "${seconds / 60} minutes ago"
    }
}

private fun platformLabel(platform: String): String = when (platform.lowercase()) {
    "ios" -> "iPhone or iPad"
    "android" -> "Android"
    "web" -> "Web browser"
    "desktop" -> "Desktop app"
    else -> "Unrecognised"
}
