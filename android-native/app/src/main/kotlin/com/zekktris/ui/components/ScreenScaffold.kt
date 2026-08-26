package com.zekktris.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/**
 * Standard full-screen page: the abyss backdrop, an iOS-style header with a
 * gray rounded back chevron (leading) + centered title, then the content.
 * Mirrors the back-button styling shared across the iOS screens.
 */
@Composable
fun ScreenScaffold(
    title: String,
    onBack: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = ZkTheme.palette
    AbyssBackground {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Box(Modifier.fillMaxWidth().height(56.dp)) {
                Box(
                    Modifier
                        .align(Alignment.CenterStart)
                        .padding(start = 12.dp)
                        .size(width = 52.dp, height = 40.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .background(p.bg2)
                        .clickable(onClick = onBack),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Filled.ChevronLeft, contentDescription = "Back", tint = ZkInk.ink2, modifier = Modifier.size(24.dp))
                }
                Text(
                    title,
                    color = ZkInk.ink1,
                    fontFamily = ZkSans,
                    fontWeight = FontWeight.Bold,
                    fontSize = 20.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().align(Alignment.Center).padding(horizontal = 72.dp),
                )
            }
            content()
        }
    }
}

/** Uppercase section label used above form fields (iOS "SUPERVISE A CHILD ACCOUNT" style). */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        color = ZkInk.ink3,
        fontFamily = ZkSans,
        fontWeight = FontWeight.Bold,
        fontSize = 11.sp,
        // iOS sectionTitle tracking = Theme.capTracking(11) = 11 × 0.14
        // (MainView.swift:3408-3412, Theme.swift:298).
        letterSpacing = 1.54.sp,
        modifier = modifier,
    )
}

/** Filled (bg3) rounded input matching the iOS form fields. */
@Composable
fun FilledTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    minLines: Int = 1,
    masked: Boolean = false,
) {
    val p = ZkTheme.palette
    androidx.compose.foundation.layout.Box(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(p.bg3)
            .padding(horizontal = 12.dp, vertical = 12.dp),
    ) {
        androidx.compose.foundation.text.BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = singleLine,
            minLines = minLines,
            // Password fields: dot-mask + a KeyboardType.Password IME so the text
            // isn't shown and doesn't feed the keyboard's learning/autocorrect.
            visualTransformation = if (masked) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
            keyboardOptions = if (masked) androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password, autoCorrect = false) else androidx.compose.foundation.text.KeyboardOptions.Default,
            textStyle = androidx.compose.ui.text.TextStyle(color = ZkInk.ink1, fontFamily = ZkSans, fontSize = 15.sp),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(p.accent),
            modifier = Modifier.fillMaxWidth(),
            decorationBox = { inner ->
                if (value.isEmpty()) {
                    Text(placeholder, color = ZkInk.ink4, fontFamily = ZkSans, fontSize = 15.sp)
                }
                inner()
            },
        )
    }
}

/** Full-width primary action button (accent when enabled). */
@Composable
fun PrimaryButton(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val p = ZkTheme.palette
    Text(
        label,
        color = androidx.compose.ui.graphics.Color.White,
        fontFamily = ZkSans,
        fontWeight = FontWeight.SemiBold,
        fontSize = 15.sp,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(if (enabled) p.accent else p.bg3)
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = 13.dp),
    )
}
