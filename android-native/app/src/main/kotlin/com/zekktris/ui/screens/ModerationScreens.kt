package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.AuditEntry
import com.zekktris.data.model.Report
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

/** Human-readable audit action, e.g. "member.kick" → "Member kicked". */
private fun auditActionLabel(action: String): String = when (action) {
    "member.kick" -> "Kicked a member"
    "member.ban" -> "Banned a member"
    "member.unban" -> "Unbanned a member"
    "member.timeout" -> "Timed out a member"
    "member.roles" -> "Changed member roles"
    "role.create" -> "Created a role"
    "role.update" -> "Updated a role"
    "role.delete" -> "Deleted a role"
    "channel.create" -> "Created a channel"
    "channel.update" -> "Updated a channel"
    "channel.delete" -> "Deleted a channel"
    "guild.update" -> "Updated the server"
    "message.delete" -> "Deleted a message"
    "message.purge" -> "Purged messages"
    else -> action.replace('.', ' ').replaceFirstChar { it.uppercase() }
}

/** Guild audit log — the moderation-action trail (VIEW_AUDIT_LOG). */
@Composable
fun AuditLogScreen(store: AppStore, state: AppState, guildId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var entries by remember { mutableStateOf<List<AuditEntry>?>(null) }
    LaunchedEffect(guildId) { entries = store.auditLog(guildId) }

    ScreenScaffold("Audit Log", onBack) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val list = entries
            when {
                list == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                list.isEmpty() -> Text("No moderation actions logged yet.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                else -> list.forEach { e ->
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(p.bg2).padding(horizontal = 14.dp, vertical = 10.dp)) {
                        Text(auditActionLabel(e.action), color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Text("by ${e.actorName}", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                        e.reason?.takeIf { it.isNotBlank() }?.let { Text("“$it”", color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(top = 2.dp)) }
                        Text(e.createdAt.take(19).replace('T', ' '), color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
                    }
                }
            }
        }
    }
}

private val REPORT_STATUSES = listOf("open" to "Open", "resolved" to "Resolved", "dismissed" to "Dismissed")

/** Moderation reports queue — resolve/dismiss, optionally ban or delete in one step. */
@Composable
fun ReportsScreen(store: AppStore, state: AppState, guildId: String, onBack: () -> Unit) {
    val p = ZkTheme.palette
    var status by remember { mutableStateOf("open") }
    var reports by remember { mutableStateOf<List<Report>?>(null) }
    var openCount by remember { mutableStateOf(0) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(guildId, status, reload) {
        val w = store.listReports(guildId, status)
        reports = w.reports; openCount = w.openCount
    }

    ScreenScaffold(if (openCount > 0) "Reports · $openCount" else "Reports", onBack) {
        Column(Modifier.fillMaxSize().padding(16.dp)) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                REPORT_STATUSES.forEach { (value, label) ->
                    val sel = status == value
                    Text(
                        label, color = if (sel) p.bg0 else ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp, fontWeight = if (sel) FontWeight.SemiBold else FontWeight.Normal,
                        modifier = Modifier.clip(RoundedCornerShape(20.dp)).background(if (sel) p.accent else p.bg3).clickable { status = value }.padding(horizontal = 14.dp, vertical = 6.dp),
                    )
                }
            }
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val list = reports
                when {
                    list == null -> Text("Loading…", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                    list.isEmpty() -> Text("No $status reports.", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp)
                    else -> list.forEach { r ->
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(r.reasonLabel.uppercase(), color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(ZkStatus.dangerSoft.copy(alpha = 0.14f)).padding(horizontal = 5.dp, vertical = 1.dp))
                                Text("  ${r.targetName}", color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Text("Reported by ${r.reporterName}", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp)
                            r.details?.takeIf { it.isNotBlank() }?.let { Text(it, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 13.sp) }
                            r.messageContent?.takeIf { it.isNotBlank() }?.let {
                                Text("“$it”", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(p.bg3).padding(8.dp))
                            }
                            if (r.status == "open") {
                                Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    ModActionChip("Resolve", p.accent) { store.handleReport(guildId, r.id, "resolve") { reload++ } }
                                    ModActionChip("Dismiss", ZkInk.ink3) { store.handleReport(guildId, r.id, "dismiss") { reload++ } }
                                    if (r.targetType == "user" && state.canBanMembers(guildId)) {
                                        ModActionChip("Ban", ZkStatus.dangerSoft) { store.handleReport(guildId, r.id, "resolve", "ban") { reload++ } }
                                    }
                                    if (r.targetType == "message") {
                                        ModActionChip("Delete msg", ZkStatus.dangerSoft) { store.handleReport(guildId, r.id, "resolve", "delete_message") { reload++ } }
                                    }
                                }
                            } else {
                                Text(r.status.replaceFirstChar { it.uppercase() }, color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ModActionChip(label: String, tint: androidx.compose.ui.graphics.Color, onClick: () -> Unit) {
    Text(
        label, color = tint, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 12.sp,
        modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(tint.copy(alpha = 0.12f)).clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 6.dp),
    )
}
