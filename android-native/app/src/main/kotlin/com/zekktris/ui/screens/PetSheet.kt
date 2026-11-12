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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.ZekkPet
import com.zekktris.data.model.Channel
import com.zekktris.data.model.PetDTO
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.ZekkPetArt
import com.zekktris.ui.components.rememberPetTapState
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
 *     Dismissible for the session, per DM and per kind of bar.
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
 * Changes go through [AppStore.changeDmPet]; a refusal toasts the server's
 * reason, as the Disappearing Messages screen does.
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

/** Runs one change at a time; [busy] is the one in flight. */
private class PetActions(private val store: AppStore, private val channelId: String, private val ctx: android.content.Context) {
    var busy by mutableStateOf<ZekkPet.Change?>(null)
        private set

    fun run(change: ZekkPet.Change, onSuccess: () -> Unit = {}) {
        if (busy != null) return
        busy = change
        store.changeDmPet(channelId, change) { err ->
            busy = null
            if (err == null) onSuccess()
            else android.widget.Toast.makeText(ctx, err, android.widget.Toast.LENGTH_LONG).show()
        }
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
 *  invite (the streak is under the minimum: [ZekkPet.Banner.locked]). */
@Composable
private fun PetInviteActions(kind: ZekkPet.BannerKind, actions: PetActions, canAct: Boolean = true, locked: Boolean = false) {
    val busy = actions.busy
    val idle = busy == null
    when (kind) {
        ZekkPet.BannerKind.Adopt -> if (canAct) {
            PetButton(if (busy == ZekkPet.Change.Invite) "Inviting…" else "Adopt", primary = true, enabled = idle) {
                actions.run(ZekkPet.Change.Invite)
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

/** The slim adopt / invite bar under the DM header, with its ✕. */
@Composable
fun PetAdoptBanner(store: AppStore, channelId: String, banner: ZekkPet.Banner, canAct: Boolean = true) {
    val p = ZkTheme.palette
    val actions = rememberPetActions(store, channelId)
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
            PetInviteActions(banner.kind, actions, canAct, banner.locked)
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

/** The big pet on its round stage. A tap squashes it and floats a heart up —
 *  purely local, nothing is sent. Only the stage (and its ripple) is round:
 *  the pet draws over it unclipped, so a sleeping pet's top Z — out by the
 *  stage's edge, and further out as it breathes — isn't cut off. [name]: the
 *  pet's name as the viewer sees it ([petDisplayName]). */
@Composable
private fun PetStage(pet: PetDTO, name: String) {
    val p = ZkTheme.palette
    val tap = rememberPetTapState()
    Box(Modifier.size(176.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .matchParentSize()
                .clip(CircleShape)
                .background(p.bg2)
                .border(1.dp, p.line, CircleShape)
                .clickable { tap.tap() }
                .semantics { contentDescription = "Pet $name" },
        )
        // No pointer input of its own, so a tap on it reaches the stage.
        ZekkPetArt(
            stage = ZekkPet.displayStage(pet),
            mood = ZekkPet.Mood.of(pet.mood),
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
