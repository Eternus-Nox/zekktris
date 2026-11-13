package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.ZekkPet
import com.zekktris.data.ZekkPetArt
import com.zekktris.data.model.Channel
import com.zekktris.data.model.PetDTO
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.ZekkPetArt
import com.zekktris.ui.components.rememberPetTapState
import com.zekktris.ui.theme.LocalThemeController
import com.zekktris.ui.theme.ZkFx
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkMono
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme
import com.zekktris.util.ProfanityFilter

/**
 * Zekk Pet — the pet two people raise in a 1:1 DM by keeping their streak
 * going. What ChatScreen mounts for it (the header pet is
 * [com.zekktris.ui.components.DmPetButton]):
 *
 *   - [PetAdoptBanner]: the slim bar under the header — Adopt when the DM
 *     may adopt, Cancel on our open invite, Accept / Not now on theirs.
 *     Dismissible for the session, per DM and per kind of bar. Where pets
 *     have colours, Adopt opens the egg picker ([PetEggPickerDialog]) first:
 *     the inviter picks the pet's colour, the same for both people.
 *   - [PetSheet]: the pet card, a bottom sheet —
 *       ZEKK PET
 *       (the big animated pet — tap it for a heart)
 *       Zekk ✎
 *       Level 3 · Baby
 *       [Happy — Fed for today. Keep chatting to earn more points.]
 *       ▓▓▓▓░░ 20/35 to level 4
 *       TODAY'S CARE  ✓ Both say hi +10 · ○ 10 messages each 4/10 · 7/10 +10 …
 *       Egg › Baby › Kid › Teen › Adult › Legendary
 *     While the invite is open it shows the egg and the bar's actions
 *     instead. Closes by itself when the pet goes away (declined, cancelled,
 *     ran away).
 *   - the rename dialog, validated like the server ([ZekkPet.normalizeName]).
 *
 * Everything shown comes from the server ([AppState.dmPets], live through
 * DM_PET_UPDATE); the words come from [ZekkPet], so it reads like web and iOS.
 * The pet is drawn in its own colour ([ZekkPet.artColor]); the chrome around
 * it (buttons, level bar, checks) stays in the viewer's theme. Changes go
 * through [AppStore.changeDmPet]; a refusal toasts the server's reason, as
 * the Disappearing Messages screen does (the egg picker shows it inside).
 */

/** The other person in a 1:1 DM as the pet's words name them: their DM
 *  nickname when set, else their name. */
fun petPeerNameFor(store: AppStore, state: AppState, channel: Channel?): String {
    val peer = channel?.recipients?.let { r -> r.firstOrNull { it.id != state.me?.id } ?: r.firstOrNull() }
    return store.dmNickname(peer?.id) ?: peer?.bestName ?: "them"
}

/** Whether this viewer's pet names are masked: a supervised child whose
 *  guardian turned on "Blur swear words" ([petDisplayName]). */
fun petNamesMasked(state: AppState): Boolean = state.family?.restrictions?.filterProfanity == true

/** The pet's name as this viewer sees it. Either person in the DM can rename
 *  it, so with [masked] ([petNamesMasked]) swear words are masked here, the
 *  same as in message bodies: wherever the name shows (the header pet, the
 *  card, the notices). Only the rename dialog keeps the real name, since it
 *  edits it. */
fun petDisplayName(name: String, masked: Boolean): String = if (masked) ProfanityFilter.mask(name) else name

/** Runs one change at a time; [busy] is the one in flight. A refusal toasts
 *  the server's reason, unless the caller shows it itself ([run]'s
 *  onError: the egg picker shows it inside, as on web and iOS). */
private class PetActions(private val store: AppStore, private val channelId: String, private val ctx: android.content.Context) {
    var busy by mutableStateOf<ZekkPet.Change?>(null)
        private set

    fun run(change: ZekkPet.Change, onError: ((String) -> Unit)? = null, onSuccess: () -> Unit = {}) {
        if (busy != null) return
        busy = change
        store.changeDmPet(channelId, change) { err ->
            busy = null
            when {
                err == null -> onSuccess()
                onError != null -> onError(err)
                else -> toast(err)
            }
        }
    }

    /** A refusal's reason as a toast: what [run] shows without onError, and
     *  where the egg picker sends one it can no longer show itself. */
    fun toast(message: String) {
        android.widget.Toast.makeText(ctx, message, android.widget.Toast.LENGTH_LONG).show()
    }
}

@Composable
private fun rememberPetActions(store: AppStore, channelId: String): PetActions {
    val ctx = LocalContext.current.applicationContext
    return remember(store, channelId) { PetActions(store, channelId, ctx) }
}

/** A compact bar / card button: accent-filled for the main action, outlined
 *  for the other; dimmed while a change is in flight. */
@Composable
private fun PetButton(label: String, primary: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    val shape = RoundedCornerShape(8.dp)
    Text(
        label,
        color = if (primary) Color.White else ZkInk.ink2,
        fontFamily = ZkSans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 12.sp,
        maxLines = 1,
        modifier = Modifier
            .alpha(if (enabled) 1f else 0.5f)
            .clip(shape)
            .then(if (primary) Modifier.background(p.accent) else Modifier.border(1.dp, p.line, shape))
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    )
}

/** [Adopt] · [Cancel] · [Accept] [Not now]. "Not now" declines the invite
 *  (no notice for either person); the inviter can invite again later.
 *  Without [canAct] (a block, a mute, supervision, or the other person left)
 *  Adopt and Accept hide: they would only fail. So does Accept on a [locked]
 *  invite (the streak is under the minimum: [ZekkPet.Banner.locked]).
 *  [onAdopt]: what Adopt does instead of inviting straight away (opening the
 *  egg picker); null invites at once, with no colour. */
@Composable
private fun PetInviteActions(
    kind: ZekkPet.BannerKind,
    actions: PetActions,
    canAct: Boolean = true,
    locked: Boolean = false,
    onAdopt: (() -> Unit)? = null,
) {
    val busy = actions.busy
    val idle = busy == null
    when (kind) {
        ZekkPet.BannerKind.Adopt -> if (canAct) {
            // `is`: an invite carries its colour, so no one Invite value
            // stands for every invite in flight.
            PetButton(if (busy is ZekkPet.Change.Invite) "Inviting…" else "Adopt", primary = true, enabled = idle) {
                if (onAdopt != null) onAdopt() else actions.run(ZekkPet.Change.Invite())
            }
        }
        ZekkPet.BannerKind.Waiting ->
            PetButton(if (busy == ZekkPet.Change.Decline) "Cancelling…" else "Cancel", primary = false, enabled = idle) {
                actions.run(ZekkPet.Change.Decline)
            }
        ZekkPet.BannerKind.Invited -> Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (canAct && !locked) {
                PetButton(if (busy == ZekkPet.Change.Accept) "Accepting…" else "Accept", primary = true, enabled = idle) {
                    actions.run(ZekkPet.Change.Accept)
                }
            }
            PetButton("Not now", primary = false, enabled = idle) { actions.run(ZekkPet.Change.Decline) }
        }
    }
}

/** The slim adopt / invite bar under the DM header, with its ✕.
 *  [pickColor]: the server keeps a colour per pet (READY
 *  features.zekk_pet_color), so Adopt opens the egg picker
 *  ([PetEggPickerDialog]) rather than inviting straight away; without it
 *  Adopt invites at once with no colour, as before. */
@Composable
fun PetAdoptBanner(store: AppStore, channelId: String, banner: ZekkPet.Banner, canAct: Boolean = true, pickColor: Boolean = false) {
    val p = ZkTheme.palette
    val actions = rememberPetActions(store, channelId)
    var picking by remember { mutableStateOf(false) }
    // The picker belongs to this bar's Adopt: when the bar turns into
    // something else under it (our invite went through, or theirs arrived
    // first) or Adopt hides (a block), it goes too.
    val canAdopt = banner.kind == ZekkPet.BannerKind.Adopt && canAct
    LaunchedEffect(canAdopt) { if (!canAdopt) picking = false }
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(p.bg2)
                .padding(start = 14.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                banner.text, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp,
                modifier = Modifier.weight(1f).padding(end = 8.dp),
            )
            PetInviteActions(
                banner.kind, actions, canAct, banner.locked,
                onAdopt = if (pickColor) ({ picking = true }) else null,
            )
            Icon(
                Icons.Filled.Close, "Dismiss", tint = ZkInk.ink3,
                modifier = Modifier
                    .padding(start = 2.dp)
                    .clip(CircleShape)
                    .clickable { store.dismissPetBanner(channelId, banner.kind) }
                    .padding(8.dp)
                    .size(14.dp),
            )
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
    }

    if (picking && canAdopt) {
        PetEggPickerDialog(
            actions,
            // Read live: the picker asks as it closes, when this bar may be
            // leaving with it (the streak broke under it).
            adoptOffered = { petAdoptOffered(store.state.value, channelId) },
            onDismiss = { picking = false },
        )
    }
}

/** Whether [channelId]'s bar offers Adopt in [state], as ChatScreen and
 *  [PetAdoptBanner] decide it: what the egg picker is for. */
private fun petAdoptOffered(state: AppState, channelId: String): Boolean {
    if (!state.zekkPetEnabled) return false
    val petState = state.dmPets[channelId]
    return ZekkPet.banner(petState, state.me?.id, "")?.kind == ZekkPet.BannerKind.Adopt && (petState?.canAct ?: true)
}

/** How long a refusal the egg picker showed can explain Adopt going away
 *  under it (time for the resync after it to land), as on iOS. */
private const val PICKER_ERROR_EXPLAINS_CHANGE_MS = 10_000L

/** What the egg picker's callbacks read live, outside composition: whether
 *  it is still up (an invite's answer can land after it has closed) and
 *  when the refusal it shows arrived ([android.os.SystemClock.elapsedRealtime]). */
private class EggPickerPresence {
    var onScreen = true
    var errorAt = 0L
}

/**
 * The egg picker Adopt opens where pets have colours: the six pet colours
 * as still eggs in the shared order ([ZekkPetArt.PET_COLORS]), each named,
 * starting on the viewer's own theme family ([ZekkPetArt.colorForTheme]).
 * The egg sent is the pet's colour for good, and both people see it
 * whatever theme each uses — only the picker's chrome is the viewer's
 * theme, laid out as on iOS (Cancel and a filled Send invite sharing the
 * width). Send invite runs the invite with it and closes on success; a
 * refusal shows here, as on web and iOS, with the picker still open for
 * another try. Back / outside / Cancel close it, except while sending.
 *
 * The bar closes the picker when Adopt goes away under it — which is what
 * the resync after a refusal does when the other person invited first or
 * the streak broke at midnight UTC. As on iOS, a refusal from just before
 * ([PICKER_ERROR_EXPLAINS_CHANGE_MS]) then moves to a toast rather than
 * vanish with the picker, and an answer that lands once the picker has
 * closed toasts too. [adoptOffered]: whether the bar still offers Adopt,
 * read live.
 */
@Composable
private fun PetEggPickerDialog(actions: PetActions, adoptOffered: () -> Boolean, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val themeId = LocalThemeController.current.themeId
    var chosen by remember { mutableStateOf(ZekkPetArt.colorForTheme(themeId)) }
    var error by remember { mutableStateOf<String?>(null) }
    val presence = remember { EggPickerPresence() }
    val sending = actions.busy is ZekkPet.Change.Invite
    val idle = actions.busy == null
    val currentAdoptOffered by rememberUpdatedState(adoptOffered)
    DisposableEffect(presence) {
        onDispose {
            presence.onScreen = false
            // Closed because Adopt went away just after a refusal: hand the
            // reason to a toast. Closed by hand with Adopt still there (or
            // a pick since cleared it), it was read here.
            val reason = error
            if (reason != null && !currentAdoptOffered() &&
                android.os.SystemClock.elapsedRealtime() - presence.errorAt <= PICKER_ERROR_EXPLAINS_CHANGE_MS
            ) {
                actions.toast(reason)
            }
        }
    }
    AlertDialog(
        onDismissRequest = { if (!sending) onDismiss() },
        title = { Text("Pick an egg", color = ZkInk.ink1, fontFamily = ZkSans) },
        text = {
            Column {
                Text("You'll both see this egg.", color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp)
                // Three across, two down: the phone's narrowest dialog still
                // gives each egg room, and the order reads like the theme
                // grid's. The eggs take what the rest leaves and scroll in
                // it (a phone on its side, a large font): the caption, a
                // refusal and the buttons always keep their room.
                Column(
                    Modifier
                        .weight(1f, fill = false)
                        .padding(top = 12.dp)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .selectableGroup(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    ZekkPetArt.PET_COLORS.chunked(3).forEach { row ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            row.forEach { c ->
                                EggSwatch(c, selected = c.id == chosen, enabled = !sending, modifier = Modifier.weight(1f)) {
                                    chosen = c.id
                                    error = null
                                }
                            }
                        }
                    }
                }
                error?.let {
                    Text(
                        it, color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontSize = 12.sp,
                        // TalkBack reads the refusal as it lands (after
                        // "Sending…"), not only when it's swiped to.
                        modifier = Modifier.padding(top = 10.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    )
                }
            }
        },
        // Both buttons in the one slot, so they share the dialog's width like
        // iOS's pair (the dialog would end-align two text buttons).
        confirmButton = {
            Row(
                Modifier.fillMaxWidth().alpha(if (sending) 0.6f else 1f),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                EggPickerButton("Cancel", primary = false, enabled = !sending, modifier = Modifier.weight(1f), onClick = onDismiss)
                EggPickerButton(if (sending) "Sending…" else "Send invite", primary = true, enabled = idle, modifier = Modifier.weight(1f)) {
                    error = null
                    actions.run(
                        ZekkPet.Change.Invite(chosen),
                        onError = { reason ->
                            if (presence.onScreen) {
                                error = reason
                                presence.errorAt = android.os.SystemClock.elapsedRealtime()
                            } else {
                                // The picker closed while this was out (Adopt
                                // went away under it): only a toast is left.
                                actions.toast(reason)
                            }
                        },
                    ) { onDismiss() }
                }
            }
        },
        containerColor = p.bg2,
    )
}

/** The picker's Cancel / Send invite, as on iOS: 44dp tall, Cancel on bg3
 *  in ink2, Send invite filled with the accent in white. */
@Composable
private fun EggPickerButton(label: String, primary: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val p = ZkTheme.palette
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .heightIn(min = 44.dp)
            .clip(shape)
            .background(if (primary) p.accent else p.bg3)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            color = if (primary) Color.White else ZkInk.ink2,
            fontFamily = ZkSans,
            fontWeight = if (primary) FontWeight.SemiBold else FontWeight.Medium,
            fontSize = 15.sp,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * One egg in the picker, as on iOS: the chosen one on bg3 with an accent
 * edge, a check badge and its label in ink1; the rest on bg1 (a step darker
 * than the dialog, so they don't vanish into it) with no edge, labelled in
 * ink3 — in the VIEWER's theme, around an egg in [egg]'s colour: still,
 * uncracked and happy. Spoken as "<Label> egg", a radio button with its
 * selected state.
 */
@Composable
private fun EggSwatch(egg: ZekkPetArt.PetColor, selected: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val p = ZkTheme.palette
    val shape = RoundedCornerShape(10.dp)
    Column(
        modifier
            .clip(shape)
            .background(if (selected) p.bg3 else p.bg1)
            .border(1.dp, if (selected) p.accent.copy(alpha = 0.5f) else Color.Transparent, shape)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .semantics { contentDescription = "${egg.label} egg" }
            .padding(horizontal = 4.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(Modifier.size(52.dp)) {
            ZekkPetArt(
                stage = ZekkPet.Stage.Egg,
                mood = ZekkPet.Mood.Happy,
                color = egg.id,
                size = 52.dp,
                animated = false,
            )
            if (selected) {
                Icon(Icons.Filled.CheckCircle, null, tint = p.accent, modifier = Modifier.align(Alignment.TopEnd).size(14.dp))
            }
        }
        Text(
            egg.label, color = if (selected) ZkInk.ink1 else ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 11.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            // The card already says "<Label> egg"; this would only repeat it.
            modifier = Modifier.padding(top = 2.dp).clearAndSetSemantics {},
        )
    }
}

/** The section labels, as in the DM settings sheet. */
@Composable
private fun SectionLabel(text: String) {
    Text(
        text, color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp, letterSpacing = 0.6.sp,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** The pet card for [channelId]'s Zekk Pet. [peerName]: the other person. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PetSheet(store: AppStore, state: AppState, channelId: String, peerName: String, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    val petState = state.dmPets[channelId]
    val pet = petState?.pet
    val actions = rememberPetActions(store, channelId)
    var renaming by remember(channelId) { mutableStateOf(false) }
    // Accept and Rename hide while the server says they'd only fail; a block
    // or the other person leaving mid-rename closes the dialog.
    val canAct = petState?.canAct ?: true
    LaunchedEffect(canAct) { if (!canAct) renaming = false }
    val masked = petNamesMasked(state)
    // Fresh numbers whenever the card opens (the mood may have turned).
    LaunchedEffect(channelId) { store.loadDmPet(channelId) }
    // Nothing left to show: the invite was declined / cancelled / expired or
    // the pet ran away (from here or anywhere else).
    val gone = petState != null && pet == null
    LaunchedEffect(gone) { if (gone) onDismiss() }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg1) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            SectionLabel("ZEKK PET")
            when {
                pet == null -> Text(
                    "Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp,
                    modifier = Modifier.padding(vertical = 24.dp),
                )
                pet.status == "invited" -> {
                    PetStage(pet, petDisplayName(pet.name, masked))
                    ZekkPet.banner(petState, state.me?.id, peerName)?.let { banner ->
                        Text(banner.text, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp, textAlign = TextAlign.Center)
                        PetInviteActions(banner.kind, actions, canAct, banner.locked)
                    }
                }
                else -> PetCard(pet, petDisplayName(pet.name, masked), state.me?.id, onRename = if (canAct) ({ renaming = true }) else null)
            }
        }
    }

    if (renaming && canAct && pet != null && pet.status != "invited") {
        // The real name, unmasked: this edits it.
        RenamePetDialog(
            current = pet.name,
            saving = actions.busy is ZekkPet.Change.Rename,
            onSave = { name -> actions.run(ZekkPet.Change.Rename(name)) { renaming = false } },
            onDismiss = { renaming = false },
        )
    }
}

/** The big pet on its stage, a rounded square as on web and iOS, so a
 *  sleeping pet's top Z — up by the stage's corner, and further out as it
 *  breathes — stays on it, clear of the corner's curve. A tap squashes it
 *  and floats a heart up — purely local, nothing is sent. Only the stage
 *  (and its ripple) is clipped: the pet draws over it unclipped. [name]: the
 *  pet's name as the viewer sees it ([petDisplayName]). */
@Composable
private fun PetStage(pet: PetDTO, name: String) {
    val p = ZkTheme.palette
    val tap = rememberPetTapState()
    val shape = RoundedCornerShape(16.dp)
    Box(Modifier.size(176.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .matchParentSize()
                .clip(shape)
                .background(p.bg2)
                .border(1.dp, p.line, shape)
                .clickable { tap.tap() }
                .semantics { contentDescription = "Pet $name" },
        )
        // No pointer input of its own, so a tap on it reaches the stage.
        ZekkPetArt(
            stage = ZekkPet.displayStage(pet),
            mood = ZekkPet.Mood.of(pet.mood),
            color = ZekkPet.artColor(pet),
            size = 140.dp,
            progress = ZekkPet.artProgress(pet),
            tap = tap,
        )
    }
}

/** [name]: the pet's name as the viewer sees it ([petDisplayName]). */
@Composable
private fun PetCard(pet: PetDTO, name: String, selfId: String?, onRename: (() -> Unit)?) {
    val p = ZkTheme.palette
    val mood = ZekkPet.moodView(pet)
    val level = ZekkPet.levelProgress(pet)

    PetStage(pet, name)

    // Name with the rename pencil, and the level line.
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 18.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 240.dp),
            )
            if (onRename != null) {
                Icon(
                    Icons.Filled.Edit, "Rename pet", tint = ZkInk.ink3,
                    modifier = Modifier.padding(start = 2.dp).clip(CircleShape).clickable(onClick = onRename).padding(7.dp).size(15.dp),
                )
            }
        }
        Text(ZekkPet.levelLine(pet), color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp)
    }

    // The mood chip: the adjective and its line (asleep: when to wake it).
    // Asleep and grumpy ask for something, so they wear the streak's amber.
    val warn = mood.mood == ZekkPet.Mood.Asleep || mood.mood == ZekkPet.Mood.Grumpy
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (warn) ZkFx.plasmaAmber.copy(alpha = 0.10f) else p.bg2)
            .border(1.dp, if (warn) ZkFx.plasmaAmber.copy(alpha = 0.3f) else p.line, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(mood.label, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        Text(mood.line, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(top = 2.dp))
    }

    // The level bar.
    Column(Modifier.fillMaxWidth()) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(8.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(p.bg3)
                .semantics { contentDescription = "Level ${pet.level} progress: ${level.label}" },
        ) {
            if (level.fraction > 0f) {
                Box(Modifier.fillMaxWidth(level.fraction).height(8.dp).clip(RoundedCornerShape(4.dp)).background(p.accent))
            }
        }
        Text(level.label, color = ZkInk.ink3, fontFamily = ZkMono, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
    }

    // Today's care.
    SectionLabel("TODAY'S CARE")
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(p.bg2)
            .border(1.dp, p.line, RoundedCornerShape(12.dp)),
    ) {
        ZekkPet.taskRows(pet, selfId).forEachIndexed { i, t ->
            if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .semantics(mergeDescendants = true) {
                        contentDescription = "${t.label}${t.progress?.let { ", $it" } ?: ""}, +${t.points}, ${if (t.done) "done" else "not done yet"}"
                    },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(20.dp)
                        .clip(CircleShape)
                        .background(if (t.done) p.accent.copy(alpha = 0.15f) else Color.Transparent)
                        .border(1.dp, if (t.done) p.accent.copy(alpha = 0.5f) else p.line, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    if (t.done) Icon(Icons.Filled.Check, null, tint = p.accent, modifier = Modifier.size(12.dp))
                }
                // The label is weighted, so it is measured after the progress:
                // "{me}/10 · {them}/10" keeps its full width (at a large font
                // size it would otherwise break at the space and drop the
                // other person's count) and the label wraps into what's left.
                Row(Modifier.weight(1f).padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        t.label, color = if (t.done) ZkInk.ink1 else ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    t.progress?.let {
                        Text(
                            it, color = ZkInk.ink3, fontFamily = ZkMono, fontSize = 12.sp,
                            maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(start = 8.dp),
                        )
                    }
                }
                Text(
                    "+${t.points}", color = if (t.done) p.accent else ZkInk.ink3, fontFamily = ZkMono, fontSize = 12.sp,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
    }

    // The stage path, the current one highlighted. Scrolls sideways rather
    // than wrap on a narrow phone.
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Row(Modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            ZekkPet.stagePath(pet.stage).forEachIndexed { i, s ->
                if (i > 0) Icon(Icons.Filled.ChevronRight, null, tint = ZkInk.ink3, modifier = Modifier.padding(horizontal = 1.dp).size(12.dp))
                Text(
                    s.label,
                    color = when {
                        s.current -> ZkInk.ink1
                        s.reached -> ZkInk.ink2
                        else -> ZkInk.ink3
                    },
                    fontFamily = ZkSans,
                    fontWeight = if (s.current) FontWeight.SemiBold else FontWeight.Normal,
                    fontSize = 12.sp,
                    maxLines = 1,
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .then(
                            if (s.current) {
                                Modifier
                                    .background(p.accent.copy(alpha = 0.15f))
                                    .border(1.dp, p.accent.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                            } else {
                                Modifier
                            },
                        )
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            }
        }
    }
}

/** Rename: the name is normalised like the server does (invisible and bidi
 *  formatting characters dropped, trimmed, spaces collapsed, 1–24
 *  characters, not only ZWNJ / ZWJ, no control characters) before it's
 *  sent; the dialog stays open with the draft on a refusal. */
@Composable
private fun RenamePetDialog(current: String, saving: Boolean, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    val p = ZkTheme.palette
    var draft by remember { mutableStateOf(current) }
    val name = ZekkPet.normalizeName(draft)
    val canSave = name != null && name != current && !saving
    val invalid = draft.isNotBlank() && name == null
    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() },
        title = { Text("Rename pet", color = ZkInk.ink1, fontFamily = ZkSans) },
        text = {
            Column {
                // The server takes at most 200 characters before normalising.
                FilledTextField(draft, { draft = it.take(200) }, "Pet name", Modifier.fillMaxWidth())
                Text(
                    if (invalid) "Names are 1–${ZekkPet.NAME_MAX_LENGTH} characters, with no control characters."
                    else "Up to ${ZekkPet.NAME_MAX_LENGTH} characters. You'll both see the new name.",
                    color = if (invalid) ZkStatus.dangerSoft else ZkInk.ink3,
                    fontFamily = ZkSans, fontSize = 12.sp,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(enabled = canSave, onClick = { name?.let(onSave) }) {
                Text(if (saving) "Saving…" else "Save", color = if (canSave) p.accent else ZkInk.ink4, fontFamily = ZkSans)
            }
        },
        dismissButton = {
            TextButton(enabled = !saving, onClick = onDismiss) { Text("Cancel", color = ZkInk.ink2, fontFamily = ZkSans) }
        },
        containerColor = p.bg2,
    )
}
