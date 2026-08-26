package com.zekktris.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Public
import androidx.compose.material.icons.filled.Search
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.model.DiscoverableGuild
import com.zekktris.ui.components.Avatar
import com.zekktris.ui.components.ScreenScaffold
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.delay

private val DISCOVERY_CATEGORIES = listOf(
    "Gaming", "Music", "Entertainment", "Education", "Science & Technology",
    "Content Creator", "Anime & Manga", "Movies & TV", "Other",
)

@Composable
fun DiscoverScreen(store: AppStore, state: AppState) {
    val p = ZkTheme.palette
    var query by remember { mutableStateOf("") }
    var category by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(query, category) {
        delay(300)
        store.loadDiscoverable(query.ifBlank { null }, category)
    }

    ScreenScaffold("Discover", onBack = { store.closeRailPage() }) {
        // Search field
        Row(
            Modifier
                .padding(start = 16.dp, end = 16.dp, top = 10.dp)
                .fillMaxWidth()
                .clip(RoundedCornerShape(10.dp))
                .background(p.bg2)
                .padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Search, null, tint = ZkInk.ink3, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            BasicTextField(
                value = query,
                onValueChange = { query = it },
                singleLine = true,
                textStyle = TextStyle(color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp),
                cursorBrush = androidx.compose.ui.graphics.SolidColor(p.accent),
                modifier = Modifier.weight(1f),
                decorationBox = { inner ->
                    if (query.isEmpty()) Text("Search servers", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 15.sp)
                    inner()
                },
            )
        }

        // Category chips
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            CategoryChip("All", selected = category == null) { category = null }
            DISCOVERY_CATEGORIES.forEach { c ->
                CategoryChip(c, selected = category == c) { category = if (category == c) null else c }
            }
        }

        // Content
        when {
            state.loadingDiscoverable && state.discoverable.isEmpty() ->
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = p.accent)
                }
            state.discoverable.isEmpty() ->
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Icon(Icons.Filled.Public, null, tint = ZkInk.ink3, modifier = Modifier.size(30.dp))
                        Text("No public servers found", color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 14.sp, modifier = Modifier.padding(top = 8.dp))
                    }
                }
            else -> LazyColumn(
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.discoverable, key = { it.id }) { g ->
                    DiscoverRow(g, joined = state.guilds.any { it.id == g.id }) { store.joinDiscoverable(g.id) }
                }
            }
        }
    }
}

@Composable
private fun CategoryChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = if (selected) p.bg0 else ZkInk.ink2,
        fontFamily = ZkSans,
        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
        fontSize = 12.sp,
        modifier = Modifier
            .clip(CircleShape)
            .background(if (selected) p.accent else p.bg2)
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp, vertical = 6.dp),
    )
}

@Composable
private fun DiscoverRow(guild: DiscoverableGuild, joined: Boolean, onJoin: () -> Unit) {
    val p = ZkTheme.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(p.bg2)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(url = guild.iconUrl, name = guild.name, size = 44.dp)
        Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
            Text(guild.name, color = ZkInk.ink1, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = guild.discoveryDescription ?: guild.description
            if (!sub.isNullOrBlank()) {
                Text(sub, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
            guild.memberCount?.let {
                Text("$it members", color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 11.sp, modifier = Modifier.padding(top = 2.dp))
            }
        }
        if (joined) {
            Text("Joined", color = ZkInk.ink3, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                modifier = Modifier.clip(CircleShape).background(p.bg3).padding(horizontal = 14.dp, vertical = 7.dp))
        } else {
            Text("Join", color = androidx.compose.ui.graphics.Color.White, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                modifier = Modifier.clip(CircleShape).background(p.accent).clickable(onClick = onJoin).padding(horizontal = 14.dp, vertical = 7.dp))
        }
    }
}
