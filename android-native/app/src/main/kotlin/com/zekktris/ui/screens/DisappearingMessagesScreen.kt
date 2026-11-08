package com.zekktris.ui.screens

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.zekktris.AppState
import com.zekktris.AppStore
import com.zekktris.data.Disappearing
import com.zekktris.ui.components.AbyssBackground
import com.zekktris.ui.components.PrimaryButton
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.launch

/**
 * The Disappearing Messages screen (Signal's): ✕ cancels, ✓ saves (only once
 * the choice differs from the DM's current timer), the description, the
 * radio list Off / 4 weeks … 30 seconds, and Custom Time, which opens a
 * number + unit picker. Full screen in its own dialog window so it draws over
 * the DM settings sheet it's opened from (the MediaGalleryDialog pattern); the
 * header's timer pill opens it too.
 *
 * Saving goes through [AppStore.setDisappearingTimer]: the header follows at
 * once and rolls back if the server refuses; on a refusal the screen stays
 * open with the choice, and a toast says why. An older server (GET settings
 * without `maxTtlSeconds`) takes only 10 s .. 1 day, so only those values are
 * offered there.
 */
@Composable
fun DisappearingMessagesDialog(store: AppStore, state: AppState, channelId: String, onDismiss: () -> Unit) {
    // The Custom Time page lives inside this dialog. Back (the system gesture
    // reaches a dialog as a dismiss request) leaves it before the dialog.
    var customOpen by remember(channelId) { mutableStateOf(false) }
    Dialog(
        onDismissRequest = { if (customOpen) customOpen = false else onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        DisappearingMessagesScreen(
            store, state, channelId,
            customOpen = customOpen,
            setCustomOpen = { customOpen = it },
            onClose = onDismiss,
        )
    }
}

@Composable
private fun DisappearingMessagesScreen(
    store: AppStore,
    state: AppState,
    channelId: String,
    customOpen: Boolean,
    setCustomOpen: (Boolean) -> Unit,
    onClose: () -> Unit,
) {
    val p = ZkTheme.palette
    val ctx = LocalContext.current.applicationContext
    val current = state.dmTimerByChannel[channelId]
    // Refresh the value and learn what this server accepts. Until the first
    // answer a spinner stands in for the list (an older server offers fewer
    // rows); a failed fetch falls back to the range every server takes.
    var loaded by remember(channelId) { mutableStateOf(state.dmTimerBounds != null) }
    LaunchedEffect(channelId) {
        store.getDmSettings(channelId)
        loaded = true
    }
    val bounds = state.dmTimerBounds ?: Disappearing.LEGACY_BOUNDS

    // The pending choice: follows the live value (the other person may change
    // it meanwhile) until the user picks something.
    var touched by remember(channelId) { mutableStateOf(false) }
    var picked by remember(channelId) { mutableStateOf<Int?>(null) }
    val selection = if (touched) picked else current
    var saving by remember(channelId) { mutableStateOf(false) }
    val changed = selection != current
    // The Custom Time page's working value, set when the page opens.
    var draft by remember(channelId) { mutableStateOf(Disappearing.customInitial(current, bounds)) }

    fun choose(seconds: Int?) {
        if (saving) return // the save in flight is the choice
        picked = seconds
        touched = true
    }

    fun save() {
        if (!changed || saving) return
        saving = true
        store.setDisappearingTimer(channelId, selection) { err ->
            saving = false
            if (err == null) onClose()
            else android.widget.Toast.makeText(ctx, err, android.widget.Toast.LENGTH_LONG).show()
        }
    }

    AbyssBackground {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            if (customOpen) {
                DisappearingHeader(
                    title = "Custom Time",
                    leading = Icons.Filled.ChevronLeft, leadingLabel = "Back",
                    onLeading = { setCustomOpen(false) },
                )
                CustomTimePage(
                    draft = draft,
                    bounds = bounds,
                    onChange = { draft = it },
                    onSet = {
                        choose(draft.seconds)
                        setCustomOpen(false)
                    },
                )
            } else {
                DisappearingHeader(
                    title = "Disappearing Messages",
                    leading = Icons.Filled.Close, leadingLabel = "Cancel",
                    onLeading = onClose,
                    trailingEnabled = changed && !saving,
                    onTrailing = ::save,
                ) {
                    if (saving) {
                        CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    } else {
                        Icon(
                            Icons.Filled.Check, "Save",
                            tint = if (changed) p.accent else ZkInk.ink4,
                            modifier = Modifier.size(22.dp),
                        )
                    }
                }
                Column(
                    Modifier
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 28.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Text(Disappearing.DESCRIPTION, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp)
                    if (!loaded) {
                        Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = p.accent, strokeWidth = 2.dp, modifier = Modifier.size(22.dp))
                        }
                    } else {
                        // Presets the server takes, plus the current value when
                        // it's a preset outside them (a fetch that failed), so
                        // the selected row is never missing.
                        val presets = Disappearing.presetsWithin(bounds).let { list ->
                            if (current != null && Disappearing.isPreset(current) && current !in list) {
                                (list + current).sortedDescending()
                            } else list
                        }
                        val custom = selection != null && !Disappearing.isPreset(selection)
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2)) {
                            OptionRow("Off", selected = selection == null) { choose(null) }
                            presets.forEach { secs ->
                                RowDivider()
                                OptionRow(Disappearing.formatLong(secs), selected = selection == secs) { choose(secs) }
                            }
                            RowDivider()
                            OptionRow(
                                "Custom Time",
                                selected = custom,
                                detail = if (custom) Disappearing.formatLong(selection) else null,
                                chevron = true,
                            ) {
                                draft = Disappearing.customInitial(selection, bounds)
                                setCustomOpen(true)
                            }
                        }
                        if (bounds.max < Disappearing.MAX_SECONDS) {
                            Text(
                                "This server accepts timers from ${Disappearing.formatLong(bounds.min)} to ${Disappearing.formatLong(bounds.max)}.",
                                color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The 56dp header: leading button (✕ or back), centred title, and an
 *  optional trailing slot (the ✓). Same geometry as ScreenScaffold. */
@Composable
private fun DisappearingHeader(
    title: String,
    leading: ImageVector,
    leadingLabel: String,
    onLeading: () -> Unit,
    trailingEnabled: Boolean = false,
    onTrailing: () -> Unit = {},
    trailing: (@Composable () -> Unit)? = null,
) {
    val p = ZkTheme.palette
    Box(Modifier.fillMaxWidth().height(56.dp)) {
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .padding(start = 12.dp)
                .size(width = 52.dp, height = 40.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(p.bg2)
                .clickable(onClick = onLeading),
            contentAlignment = Alignment.Center,
        ) {
            Icon(leading, contentDescription = leadingLabel, tint = ZkInk.ink2, modifier = Modifier.size(22.dp))
        }
        Text(
            title,
            color = ZkInk.ink1,
            fontFamily = ZkSans,
            fontWeight = FontWeight.Bold,
            fontSize = 20.sp,
            textAlign = TextAlign.Center,
            maxLines = 1,
            modifier = Modifier.fillMaxWidth().align(Alignment.Center).padding(horizontal = 72.dp),
        )
        if (trailing != null) {
            Box(
                Modifier
                    .align(Alignment.CenterEnd)
                    .padding(end = 12.dp)
                    .size(width = 52.dp, height = 40.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(p.bg2)
                    .clickable(enabled = trailingEnabled, onClick = onTrailing),
                contentAlignment = Alignment.Center,
            ) { trailing() }
        }
    }
}

@Composable
private fun OptionRow(
    label: String,
    selected: Boolean,
    detail: String? = null,
    chevron: Boolean = false,
    onClick: () -> Unit,
) {
    val p = ZkTheme.palette
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp)
            if (detail != null) {
                Text(detail, color = ZkInk.ink3, fontFamily = ZkSans, fontSize = 12.sp, modifier = Modifier.padding(top = 1.dp))
            }
        }
        if (selected) Icon(Icons.Filled.Check, "Selected", tint = p.accent, modifier = Modifier.size(18.dp))
        if (chevron) {
            Icon(Icons.Filled.ChevronRight, null, tint = ZkInk.ink3, modifier = Modifier.padding(start = 6.dp).size(18.dp))
        }
    }
}

@Composable
private fun RowDivider() {
    val p = ZkTheme.palette
    Box(Modifier.fillMaxWidth().height(1.dp).background(p.line))
}

/** Custom Time: a number wheel and a unit wheel (seconds 1–59, minutes 1–59,
 *  hours 1–23, days 1–6, weeks 1–4, narrowed to what the server accepts), and
 *  Set, which makes it the choice and goes back to the list. Changing the
 *  unit clamps the number to the new unit's range. */
@Composable
private fun CustomTimePage(
    draft: Disappearing.Custom,
    bounds: Disappearing.Bounds,
    onChange: (Disappearing.Custom) -> Unit,
    onSet: () -> Unit,
) {
    val p = ZkTheme.palette
    val range = Disappearing.unitRange(draft.unit, bounds) ?: (1..1)
    val numbers = range.toList()
    val units = Disappearing.availableUnits(bounds)
    Column(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Text(
            Disappearing.formatLong(draft.seconds),
            color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 14.sp,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
        )
        Box(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(p.bg2).padding(vertical = 8.dp),
            contentAlignment = Alignment.Center,
        ) {
            // The selection band behind the centred row of both wheels.
            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp)
                    .height(WHEEL_ROW)
                    .clip(RoundedCornerShape(10.dp))
                    .background(p.bg3),
            )
            Row(Modifier.fillMaxWidth()) {
                WheelColumn(
                    items = numbers.map { it.toString() },
                    selectedIndex = (draft.n - range.first).coerceIn(0, numbers.size - 1),
                    onSelect = { i -> onChange(draft.copy(n = numbers[i])) },
                    modifier = Modifier.weight(1f),
                )
                WheelColumn(
                    items = units.map { if (draft.n == 1) it.singular else it.plural },
                    selectedIndex = units.indexOf(draft.unit).coerceAtLeast(0),
                    onSelect = { i -> onChange(Disappearing.changeUnit(draft, units[i], bounds)) },
                    modifier = Modifier.weight(1f),
                )
            }
        }
        Spacer(Modifier.height(4.dp))
        PrimaryButton("Set", onClick = onSet)
    }
}

private val WHEEL_ROW = 44.dp
private const val WHEEL_VISIBLE_ROWS = 5

/**
 * One snapping wheel: a LazyColumn padded by two rows each side so every row
 * can sit in the centre band, with a snap fling. The centred row is the value
 * once a scroll settles (a drag, a fling, or a tap on a row, which scrolls it
 * to the centre); a value changed from outside (the unit clamped the number)
 * scrolls the wheel to it. Pure Compose: android.widget.NumberPicker can't be
 * tinted for the dark theme below API 29, and minSdk is 26.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun WheelColumn(
    items: List<String>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = selectedIndex)
    val fling = rememberSnapFlingBehavior(lazyListState = listState)
    val scope = rememberCoroutineScope()
    val rowPx = with(LocalDensity.current) { WHEEL_ROW.roundToPx() }
    // With the two-row padding, the scroll position IS the centred row:
    // item i at offset 0 sits exactly in the band.
    fun centred(): Int =
        listState.firstVisibleItemIndex + if (listState.firstVisibleItemScrollOffset > rowPx / 2) 1 else 0
    // The row in the band right now, so the highlight follows the finger.
    val live by remember { derivedStateOf { centred() } }
    val latestSelected by rememberUpdatedState(selectedIndex)
    val latestOnSelect by rememberUpdatedState(onSelect)
    val latestCount by rememberUpdatedState(items.size)
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }.collect { moving ->
            if (moving) return@collect
            val c = centred()
            if (c in 0 until latestCount && c != latestSelected) latestOnSelect(c)
        }
    }
    LaunchedEffect(selectedIndex, items.size) {
        if (!listState.isScrollInProgress && selectedIndex in items.indices && centred() != selectedIndex) {
            listState.scrollToItem(selectedIndex)
        }
    }
    LazyColumn(
        state = listState,
        flingBehavior = fling,
        contentPadding = PaddingValues(vertical = WHEEL_ROW * (WHEEL_VISIBLE_ROWS / 2)),
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = modifier.height(WHEEL_ROW * WHEEL_VISIBLE_ROWS),
    ) {
        itemsIndexed(items) { i, label ->
            val isSelected = i == live
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(WHEEL_ROW)
                    .clickable { scope.launch { listState.animateScrollToItem(i) } },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    color = if (isSelected) ZkInk.ink1 else ZkInk.ink3,
                    fontFamily = ZkSans,
                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                    fontSize = if (isSelected) 20.sp else 17.sp,
                    maxLines = 1,
                )
            }
        }
    }
}
