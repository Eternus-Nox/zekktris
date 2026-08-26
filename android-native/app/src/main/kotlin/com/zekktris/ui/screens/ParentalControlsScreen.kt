package com.zekktris.ui.screens

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.FamilyUser
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.FilledTextField
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.components.SectionLabel
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

@Composable
fun ParentalControlsScreen(store: AppStore, state: AppState) {
    var managingChild by remember { mutableStateOf<FamilyUser?>(null) }
    LaunchedEffect(Unit) { store.loadFamily() }

    val child = managingChild
    if (child != null) {
        BackHandler { managingChild = null }
        ChildControlsScreen(store, state, child) { managingChild = null }
        return
    }

    val fam = state.family
    ScreenScaffold("Parental Controls", onBack = { store.closeRailPage() }) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            if (state.loadingFamily && fam == null) {
                Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = ZkTheme.palette.accent)
                }
                return@Column
            }

            if (fam?.restrictedHeavily == true) {
                Banner(
                    "Your account is restricted until a parent or guardian is linked. Enter their email below to ask them to supervise your account.",
                    ZkStatus.danger,
                )
            } else if (fam?.graceActive == true) {
                val days = fam.graceDaysRemaining ?: 0
                Banner(
                    "Link a parent or guardian within $days ${if (days == 1) "day" else "days"} to keep full access.",
                    ZkStatus.warning,
                )
            }

            // Read-only summary of the viewer's own restrictions when they are
            // themselves supervised (iOS restrictionsCard).
            fam?.restrictions?.let { RestrictionsCard(it) }

            // Child invites a guardian. Shown to any minor, or anyone in grace,
            // restricted, already supervised, or with a pending guardian invite.
            val showGuardianInvite = fam != null && (
                fam.isMinor == true ||
                fam.graceActive == true ||
                fam.restrictedHeavily == true ||
                fam.supervisedBy.isNotEmpty() ||
                !fam.outgoingParentRequests.isNullOrEmpty()
            )
            if (showGuardianInvite) {
                LinkField(
                    label = "LINK A GUARDIAN",
                    description = "Enter a parent or guardian's email. If they have an account they'll get a request to approve; otherwise we'll email them an invite to create one.",
                    placeholder = "guardian@email.com",
                    buttonLabel = "Invite",
                    onSubmit = { store.familyRequestParent(it) },
                )
            }
            // Parent supervises a child.
            if (fam?.isMinor != true) {
                LinkField(
                    label = "SUPERVISE A CHILD ACCOUNT",
                    description = null,
                    placeholder = "child's username",
                    buttonLabel = "Request",
                    onSubmit = { store.familyRequestLink(it) },
                )
            }

            fam?.incomingChildRequests?.let {
                FamilySection("ASKING YOU TO SUPERVISE THEM", it, accept = { u -> store.familyAcceptChild(u.id) }, remove = { u -> store.familyRemove(u.id) }, manage = null)
            }
            FamilySection("REQUESTS TO ACCEPT", fam?.incomingRequests.orEmpty(), accept = { u -> store.familyAcceptLink(u.id) }, remove = { u -> store.familyRemove(u.id) }, manage = null)
            fam?.outgoingParentRequests?.let {
                FamilySection("GUARDIAN INVITES SENT", it, accept = null, remove = { u -> store.familyRemove(u.id) }, manage = null)
            }
            FamilySection("SUPERVISED BY", fam?.supervisedBy.orEmpty(), accept = null, remove = { u -> store.familyRemove(u.id) }, manage = null)
            FamilySection("CHILDREN YOU SUPERVISE", fam?.children.orEmpty(), accept = null, remove = { u -> store.familyRemove(u.id) }, manage = { managingChild = it })
            FamilySection("PENDING REQUESTS", fam?.outgoingRequests.orEmpty(), accept = null, remove = { u -> store.familyRemove(u.id) }, manage = null)
        }
    }
}

@Composable
private fun Banner(text: String, color: Color) {
    Text(
        text,
        color = ZkInk.ink1,
        fontFamily = ZkSans,
        fontSize = 13.sp,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(color.copy(alpha = 0.15f))
            .border(1.dp, color.copy(alpha = 0.4f), RoundedCornerShape(12.dp))
            .padding(12.dp),
    )
}

@Composable
private fun RestrictionsCard(r: com.zekktris.data.model.ChildRestrictions) {
    val p = ZkTheme.palette
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("YOUR ACCOUNT IS SUPERVISED", color = p.accent3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 11.sp)
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            RestrictionRow("Add friends", r.canAddFriends)
            RestrictionRow("Remove friends", r.canRemoveFriends)
            RestrictionRow("Voice", r.allowVoice)
            RestrictionRow("Video", r.allowVideo)
            RestrictionRow("Streaming", r.allowStream)
            RestrictionRow("Create servers", r.allowCreateGuild)
        }
    }
}

@Composable
private fun RestrictionRow(label: String, allowed: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(
            if (allowed) Icons.Filled.CheckCircle else Icons.Filled.Cancel,
            contentDescription = null,
            tint = if (allowed) ZkStatus.online else ZkInk.ink4,
            modifier = Modifier.size(15.dp),
        )
        Text(label, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(start = 8.dp))
    }
}

@Composable
private fun LinkField(label: String, description: String?, placeholder: String, buttonLabel: String, onSubmit: (String) -> Unit) {
    val p = ZkTheme.palette
    var value by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel(label)
        if (description != null) {
            Text(description, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            FilledTextField(value, { value = it }, placeholder, Modifier.weight(1f))
            Spacer(Modifier.width(8.dp))
            val enabled = value.isNotBlank()
            Text(
                buttonLabel,
                color = Color.White,
                fontFamily = ZkSans,
                fontWeight = FontWeight.SemiBold,
                fontSize = 13.sp,
                modifier = Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .background(p.accent.copy(alpha = if (enabled) 1f else 0.4f))
                    .then(if (enabled) Modifier.clickable { onSubmit(value.trim()); value = "" } else Modifier)
                    .padding(horizontal = 14.dp, vertical = 11.dp),
            )
        }
    }
}

@Composable
private fun FamilySection(
    title: String,
    users: List<FamilyUser>,
    accept: ((FamilyUser) -> Unit)?,
    remove: (FamilyUser) -> Unit,
    manage: ((FamilyUser) -> Unit)?,
) {
    if (users.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionLabel(title)
        users.forEach { u ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .then(if (manage != null) Modifier.clickable { manage(u) } else Modifier),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(url = u.avatarUrl, name = u.name, size = 36.dp)
                Text(u.name, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp, modifier = Modifier.padding(start = 10.dp).weight(1f))
                if (accept != null) {
                    Text("Accept", color = ZkStatus.online, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.clickable { accept(u) })
                    Spacer(Modifier.width(12.dp))
                    Icon(Icons.Filled.Close, "Decline", tint = ZkInk.ink3, modifier = Modifier.size(18.dp).clickable { remove(u) })
                } else {
                    Text("Remove", color = ZkStatus.danger, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.clickable { remove(u) })
                }
                if (manage != null) {
                    Spacer(Modifier.width(8.dp))
                    Icon(Icons.Filled.ChevronRight, null, tint = ZkInk.ink4, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}
