package com.zekktris.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.LocalFireDepartment
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.ui.theme.ZkFx
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkMono
import kotlin.math.min

/**
 * Messaging-streak pill — a flame + day count, matching iOS's StreakChip
 * (plasma-amber, 16%-fill rounded rect with a 40%-amber border, mono digits).
 */
@Composable
fun StreakPill(days: Int) {
    Row(
        Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(ZkFx.plasmaAmber.copy(alpha = 0.16f))
            .border(1.dp, ZkFx.plasmaAmber.copy(alpha = 0.4f), RoundedCornerShape(6.dp))
            // iOS StreakChip: 6/2.5 padding, 9pt flame (MainView.swift:9825-9833).
            .padding(horizontal = 6.dp, vertical = 2.5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Icon(Icons.Filled.LocalFireDepartment, null, tint = ZkFx.plasmaAmber, modifier = Modifier.size(9.dp))
        Text("${min(days, 10_000)}", color = ZkInk.ink1, fontFamily = ZkMono, fontWeight = FontWeight.SemiBold, fontSize = 10.sp)
    }
}
