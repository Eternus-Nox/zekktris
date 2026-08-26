package com.zekktris.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/**
 * Unified emoji picker (web/iOS EmojiPickerSheet parity): search across unicode
 * + server emoji, a Recently Used row, unicode category sections, and the
 * guild's custom emoji. [onPick] receives either a literal unicode glyph or a
 * `:name:` shortcode for custom emoji. [serverEmojis] is (name, absoluteImageUrl).
 * The caller decides what to do on pick (insert / react) and when to dismiss.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EmojiPickerSheet(
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
    serverEmojis: List<Pair<String, String>> = emptyList(),
    title: String = "Add reaction",
) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current
    var query by remember { mutableStateOf("") }
    val recents = remember { EmojiCatalog.recents(ctx) }
    val q = query.trim().lowercase()

    fun pickUnicode(glyph: String) {
        EmojiCatalog.pushRecent(ctx, glyph)
        onPick(glyph)
    }

    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = p.bg1) {
        Text(title, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
        FilledTextField(query, { query = it }, "Search emoji", Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp))
        LazyColumn(Modifier.fillMaxWidth().fillMaxHeight(0.72f).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (q.isEmpty()) {
                if (recents.isNotEmpty()) {
                    item { SectionCaps("RECENTLY USED") }
                    item { UnicodeGrid(recents) { pickUnicode(it) } }
                }
                if (serverEmojis.isNotEmpty()) {
                    item { SectionCaps("SERVER") }
                    item { CustomGrid(serverEmojis) { onPick(":$it:") } }
                }
                EmojiCatalog.categories.forEach { cat ->
                    item(key = "cat-${cat.name}") { SectionCaps(cat.name.uppercase()) }
                    item(key = "grid-${cat.name}") { UnicodeGrid(cat.emoji.map { it.first }) { pickUnicode(it) } }
                }
            } else {
                val unicodeHits = EmojiCatalog.categories.flatMap { it.emoji }.filter { it.second.contains(q) }.map { it.first }
                val customHits = serverEmojis.filter { it.first.lowercase().contains(q) }
                if (unicodeHits.isEmpty() && customHits.isEmpty()) {
                    item { Text("No emoji found", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 13.sp, modifier = Modifier.padding(top = 24.dp)) }
                }
                if (customHits.isNotEmpty()) {
                    item { SectionCaps("SERVER") }
                    item { CustomGrid(customHits) { onPick(":$it:") } }
                }
                if (unicodeHits.isNotEmpty()) {
                    item { SectionCaps("EMOJI") }
                    item { UnicodeGrid(unicodeHits) { pickUnicode(it) } }
                }
            }
        }
    }
}

@Composable
private fun SectionCaps(title: String) {
    Text(title, color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 10.sp, modifier = Modifier.padding(top = 8.dp, bottom = 2.dp, start = 2.dp))
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UnicodeGrid(emojis: List<String>, onPick: (String) -> Unit) {
    val p = ZkTheme.palette
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        emojis.forEach { glyph ->
            Box(
                Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).background(p.bg2).clickable { onPick(glyph) },
                contentAlignment = Alignment.Center,
            ) { Text(glyph, fontSize = 26.sp) }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CustomGrid(emojis: List<Pair<String, String>>, onPick: (String) -> Unit) {
    val p = ZkTheme.palette
    FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        emojis.forEach { (name, url) ->
            Box(
                Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).background(p.bg2).clickable { onPick(name) }.padding(7.dp),
                contentAlignment = Alignment.Center,
            ) {
                AsyncImage(url, name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}
