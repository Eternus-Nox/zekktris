package com.zekktris.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.data.Config
import com.zekktris.data.model.PeekMessage
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkStatus
import com.zekktris.ui.theme.ZkTheme

/**
 * Read-only rendering of a slim [PeekMessage] moderation DTO — author avatar,
 * name, time, content, image/file attachments, reactions, and a DELETED label
 * for messages a supervised child removed (which parents still see). Shared by
 * the family child-DM review and the admin ghost-observe views.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun PeekMessageRow(m: PeekMessage) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Avatar(url = m.authorAvatarUrl, name = m.authorName, size = 34.dp)
        Column(Modifier.padding(start = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(m.authorName, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.Medium, fontSize = 14.sp)
                Text(shortTime(m.createdAt), color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(start = 6.dp))
                if (m.deleted == true) {
                    Text(
                        "DELETED", color = ZkStatus.dangerSoft, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 9.sp,
                        modifier = Modifier.padding(start = 6.dp).clip(RoundedCornerShape(4.dp)).background(ZkStatus.danger.copy(alpha = 0.15f)).padding(horizontal = 5.dp, vertical = 1.dp),
                    )
                }
            }
            val content = m.content
            if (!content.isNullOrEmpty()) {
                Text(
                    content,
                    color = if (m.deleted == true) ZkInk.ink3 else ZkInk.ink1,
                    fontFamily = ZkSans, fontSize = 14.sp,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
            m.attachments?.forEach { at ->
                if (at.contentType?.startsWith("image/") == true) {
                    // Thumbnail first — it survives attachment retention and is
                    // the right size for this 220dp box anyway. The full-size
                    // original is only used while it still exists: once
                    // blobExpiredAt is set the bytes are gone and `url` still
                    // points at the dead path, so loading it renders a broken
                    // tile in a parent's DM-review list.
                    val previewUrl = Config.absoluteUrl(at.thumbnailUrl)
                        ?: if (at.blobExpiredAt != null) null else Config.absoluteUrl(at.url)
                    previewUrl?.let { url ->
                        AsyncImage(
                            url, at.filename, contentScale = ContentScale.Fit,
                            modifier = Modifier.padding(top = 4.dp).widthIn(max = 220.dp).heightIn(max = 220.dp).clip(RoundedCornerShape(8.dp)),
                        )
                    }
                } else {
                    Text("📎 ${at.filename ?: "attachment"}", color = ZkTheme.palette.accent, fontFamily = ZkSans, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp))
                }
            }
            val reacts = m.reactions
            if (!reacts.isNullOrEmpty()) {
                FlowRow(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    reacts.forEach { r ->
                        Text(
                            "${r.emoji} ${r.count}", color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 11.sp,
                            modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(ZkTheme.palette.bg2).padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                }
            }
        }
    }
}
