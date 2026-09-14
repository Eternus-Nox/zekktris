package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Numbers
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.Channel
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme
import kotlin.math.roundToInt

/**
 * Drag-to-reorder the channel tree: channels inside a category, channels
 * BETWEEN categories, and the categories themselves.
 *
 * ONE FLAT LIST, matching iOS's ReorderChannelsView and the web's drag tree.
 * Two rules make the flat list mean the same thing as the tree:
 *   * A channel belongs to the nearest category ABOVE it, or to the top level
 *     when there is none — so dragging it past a heading is what re-parents it.
 *   * A category moves as a BLOCK, carrying its channels, and swaps with a
 *     whole neighbouring block rather than stepping through its rows. It can
 *     never move above the uncategorized segment, which the sidebar always
 *     renders first.
 *
 * The drag steps one row at a time as the finger passes each row height, so
 * there is no index arithmetic to get wrong and a category block can move by
 * more than one row in a single step without the offset drifting.
 *
 * Positions are written per sibling group (top-level categories, top-level
 * channels, each category's children numbered independently) — the scheme the
 * server stores and the other two clients send.
 */
private val ROW_HEIGHT = 48.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReorderChannelsSheet(
    store: AppStore,
    state: AppState,
    guildId: String,
    onDismiss: () -> Unit,
) {
    val p = ZkTheme.palette
    val source = state.channelsByGuild[guildId] ?: emptyList()
    var rows by remember(guildId) { mutableStateOf(flattenTree(source)) }
    var draggingId by remember(guildId) { mutableStateOf<String?>(null) }
    var dragOffset by remember(guildId) { mutableStateOf(0f) }
    val rowPx = with(LocalDensity.current) { ROW_HEIGHT.toPx() }
    val haptics = LocalHapticFeedback.current

    /** Move the dragged row one slot. Returns false at the ends, which is what
     *  stops the offset from running away past the list. */
    fun step(id: String, down: Boolean): Boolean {
        val list = rows.toMutableList()
        val i = list.indexOfFirst { it.id == id }
        if (i < 0) return false
        val item = list[i]

        if (!item.isCategory) {
            // Stepping past a heading is exactly what moves a channel into, or
            // out of, that category — no special case needed.
            val j = if (down) i + 1 else i - 1
            if (j !in list.indices) return false
            list[i] = list[j]
            list[j] = item
            rows = list
            return true
        }

        // A category takes its channels with it.
        var end = i + 1
        while (end < list.size && !list[end].isCategory) end++
        val block = list.subList(i, end).toList()
        if (down) {
            if (end >= list.size) return false
            var nextEnd = end + 1
            while (nextEnd < list.size && !list[nextEnd].isCategory) nextEnd++
            val nextBlock = list.subList(end, nextEnd).toList()
            val out = list.toMutableList()
            out.subList(i, nextEnd).clear()
            out.addAll(i, nextBlock + block)
            rows = out
        } else {
            if (i == 0) return false
            var prevStart = i - 1
            while (prevStart > 0 && !list[prevStart].isCategory) prevStart--
            // The uncategorized segment has no heading; a category can't go
            // above it, because the sidebar renders those channels first.
            if (!list[prevStart].isCategory) return false
            val prevBlock = list.subList(prevStart, i).toList()
            val out = list.toMutableList()
            out.subList(prevStart, end).clear()
            out.addAll(prevStart, block + prevBlock)
            rows = out
        }
        return true
    }

    fun commit() {
        var categoryIndex = 0
        var topLevelIndex = 0
        var currentCategory: String? = null
        val childIndex = mutableMapOf<String, Int>()
        val entries = mutableListOf<Triple<String, Int, String?>>()
        rows.forEach { ch ->
            if (ch.isCategory) {
                currentCategory = ch.id
                entries += Triple(ch.id, categoryIndex, null)
                categoryIndex += 1
            } else {
                val parent = currentCategory
                if (parent == null) {
                    entries += Triple(ch.id, topLevelIndex, null)
                    topLevelIndex += 1
                } else {
                    val i = childIndex[parent] ?: 0
                    entries += Triple(ch.id, i, parent)
                    childIndex[parent] = i + 1
                }
            }
        }
        store.applyChannelOrder(guildId, entries)
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg2) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text(
                "Reorder Channels",
                color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
            Column(
                Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
            ) {
                rows.forEachIndexed { index, ch ->
                    val isDragging = draggingId == ch.id
                    val underCategory = rows.take(index).any { it.isCategory }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .height(ROW_HEIGHT)
                            .zIndex(if (isDragging) 1f else 0f)
                            .offset { IntOffset(0, if (isDragging) dragOffset.roundToInt() else 0) }
                            .padding(horizontal = 12.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (isDragging) p.bg3 else p.bg2)
                            .padding(horizontal = 8.dp)
                            .pointerInput(ch.id, rows.size) {
                                detectDragGesturesAfterLongPress(
                                    onDragStart = {
                                        draggingId = ch.id
                                        dragOffset = 0f
                                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                    },
                                    onDrag = { change, drag ->
                                        change.consume()
                                        dragOffset += drag.y
                                        // One step per row height crossed; stop
                                        // accumulating at an end so the row
                                        // can't drift off the list.
                                        while (dragOffset >= rowPx) {
                                            if (step(ch.id, down = true)) dragOffset -= rowPx
                                            else { dragOffset = rowPx; break }
                                        }
                                        while (dragOffset <= -rowPx) {
                                            if (step(ch.id, down = false)) dragOffset += rowPx
                                            else { dragOffset = -rowPx; break }
                                        }
                                    },
                                    onDragEnd = {
                                        draggingId = null
                                        dragOffset = 0f
                                        commit()
                                    },
                                    onDragCancel = {
                                        draggingId = null
                                        dragOffset = 0f
                                    },
                                )
                            },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (underCategory && !ch.isCategory) Spacer(Modifier.width(16.dp))
                        Icon(
                            when {
                                ch.isCategory -> Icons.Filled.Folder
                                ch.isVoice -> Icons.Filled.VolumeUp
                                else -> Icons.Filled.Numbers
                            },
                            contentDescription = null,
                            tint = ZkInk.ink3,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            if (ch.isCategory) (ch.name ?: "Category").uppercase() else (ch.name ?: "channel"),
                            color = if (ch.isCategory) ZkInk.ink2 else ZkInk.ink1,
                            fontFamily = ZkSans,
                            fontWeight = if (ch.isCategory) FontWeight.SemiBold else FontWeight.Normal,
                            fontSize = if (ch.isCategory) 12.sp else 15.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Icon(Icons.Filled.DragHandle, contentDescription = null, tint = ZkInk.ink3, modifier = Modifier.size(18.dp))
                    }
                }
            }
            Text(
                "Press and hold a row to drag it. Drop a channel under a heading to move it there, or above every heading to take it out. A category brings its channels with it.",
                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
            )
        }
    }
}

/** Flatten the tree the way the sidebar renders it: top-level channels first,
 *  then each category followed by its own channels. */
private fun flattenTree(channels: List<Channel>): List<Channel> {
    val sorted = channels.sortedWith(compareBy({ it.position ?: 0 }, { it.id }))
    val out = mutableListOf<Channel>()
    out += sorted.filter { !it.isCategory && !it.isThread && it.parentId == null }
    sorted.filter { it.isCategory }.forEach { cat ->
        out += cat
        out += sorted.filter { !it.isCategory && !it.isThread && it.parentId == cat.id }
    }
    return out
}
