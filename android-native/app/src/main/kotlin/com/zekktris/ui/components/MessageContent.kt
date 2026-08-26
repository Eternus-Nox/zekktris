package com.zekktris.ui.components

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.AppState
import com.zekktris.data.Config
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/**
 * Renders a message body with Discord-style markdown + mentions, matching the
 * iOS renderer. Previously the raw content string was shown verbatim, so
 * **bold**, `code`, <@123>, <#456>, links, etc. all leaked their syntax.
 *
 * Handles: fenced ``` code blocks (monospace, horizontal-scroll), inline
 * `code`, **bold**, *italic* / _italic_, __underline__, ~~strike~~, ||spoiler||,
 * > quote lines, user/role/channel mentions + @everyone/@here (accent), and
 * bare http(s) links (accent). Emoji-only messages render jumbo.
 */
@Composable
fun MessageContent(text: String, state: AppState, modifier: Modifier = Modifier) {
    val p = ZkTheme.palette
    val resolve = rememberMentionResolver(state)
    val emojiUrl = rememberEmojiResolver(state)
    // Parsing is pure but was re-running for every visible row on every
    // recomposition — i.e. on every unrelated AppState emit (a peer typing, a
    // read ack, a presence change) — on the main thread. Memoize it; the
    // resolvers are themselves remembered on the state slices they read, so
    // they're stable keys.
    val blocks = remember(text) { splitBlocks(text) }
    val jumbo = blocks.size == 1 && blocks[0] is Block.Plain && isEmojiOnly((blocks[0] as Block.Plain).text)

    Column(modifier) {
        blocks.forEach { b ->
            when (b) {
                is Block.Code -> CodeBlock(b.text)
                is Block.Plain -> {
                    val rendered = remember(b, p.accent, resolve, emojiUrl) {
                        val quoted = b.text.lineSequence().all { it.isBlank() || it.startsWith("> ") || it == ">" }
                            && b.text.lineSequence().any { it.startsWith(">") }
                        val body = if (quoted) b.text.lineSequence().joinToString("\n") { it.removePrefix("> ").removePrefix(">") } else b.text
                        // `used` is filled by buildInline as it walks the text (side-effect,
                        // read after) with the custom :emoji: it emitted inline placeholders for.
                        val used = LinkedHashMap<String, String>()
                        RenderedText(buildInline(body, p.accent, resolve, emojiUrl, used), used, quoted)
                    }
                    val inline = emojiInlineContent(rendered.emoji)
                    if (rendered.quoted) {
                        Row(Modifier.padding(vertical = 1.dp).height(IntrinsicSize.Min)) {
                            Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(p.line))
                            Text(rendered.annotated, color = ZkInk.ink2, fontFamily = ZkSans, fontSize = 15.sp, inlineContent = inline, modifier = Modifier.padding(start = 8.dp))
                        }
                    } else {
                        Text(
                            rendered.annotated,
                            color = ZkInk.ink1,
                            fontFamily = if (jumbo) FontFamily.Default else ZkSans,
                            fontSize = if (jumbo) 34.sp else 15.sp,
                            inlineContent = inline,
                        )
                    }
                }
            }
        }
    }
}

/** One plain block's parse result, computed once and held across recompositions. */
private class RenderedText(
    val annotated: AnnotatedString,
    val emoji: Map<String, String>,
    val quoted: Boolean,
)

/**
 * One [InlineTextContent] per used custom emoji, sized ~1.3em square and
 * vertically centered so it sits inline with text. Coil loads the image.
 */
private fun emojiInlineContent(used: Map<String, String>): Map<String, InlineTextContent> =
    used.entries.associate { (name, url) ->
        "emoji:$name" to InlineTextContent(
            Placeholder(width = 1.3.em, height = 1.3.em, placeholderVerticalAlign = PlaceholderVerticalAlign.Center),
        ) {
            AsyncImage(model = url, contentDescription = ":$name:", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
        }
    }

@Composable
private fun CodeBlock(code: String) {
    val p = ZkTheme.palette
    Box(
        Modifier
            .padding(top = 3.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(p.bg3)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(code, color = ZkInk.ink1, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
    }
}

// ---- parsing ---------------------------------------------------------------

private sealed interface Block {
    data class Plain(val text: String) : Block
    data class Code(val text: String) : Block
}

private val FENCE = Regex("```[a-zA-Z0-9+#-]*\\n?([\\s\\S]*?)```")

/** Split fenced ``` code blocks out from the surrounding plain text. */
private fun splitBlocks(text: String): List<Block> {
    val out = mutableListOf<Block>()
    var last = 0
    for (m in FENCE.findAll(text)) {
        if (m.range.first > last) {
            val chunk = text.substring(last, m.range.first)
            if (chunk.isNotEmpty()) out += Block.Plain(chunk.trim('\n'))
        }
        out += Block.Code(m.groupValues[1].trimEnd('\n'))
        last = m.range.last + 1
    }
    if (last < text.length) {
        val chunk = text.substring(last)
        if (chunk.isNotBlank()) out += Block.Plain(chunk.trim('\n'))
    }
    if (out.isEmpty()) out += Block.Plain(text)
    return out
}

private val MENTION = Regex("<@!?(\\d+)>|<@&(\\d+)>|<#(\\d+)>|@everyone|@here")
private val URL = Regex("https?://[^\\s<>]+")
private val EMOJI_TOKEN = Regex(":([a-zA-Z0-9_]{2,32}):")

/**
 * A single left-to-right scan producing a styled AnnotatedString.
 * [emojiUrl] maps a custom-emoji `:name:` to its image URL (null if unknown);
 * matched ones are emitted as inline-content placeholders and recorded in
 * [usedEmoji] (name → url) for the caller to build InlineTextContent.
 */
private fun buildInline(
    text: String,
    accent: Color,
    resolve: (Char, String) -> String,
    emojiUrl: (String) -> String?,
    usedEmoji: MutableMap<String, String>,
): AnnotatedString =
    buildAnnotatedString {
        var i = 0
        val n = text.length
        // active inline styles (nesting via a simple stack of markers)
        var bold = false
        var italic = false
        var underline = false
        var strike = false
        var spoiler = false

        fun style() = SpanStyle(
            fontWeight = if (bold) FontWeight.Bold else null,
            fontStyle = if (italic) FontStyle.Italic else null,
            textDecoration = when {
                underline && strike -> TextDecoration.combine(listOf(TextDecoration.Underline, TextDecoration.LineThrough))
                underline -> TextDecoration.Underline
                strike -> TextDecoration.LineThrough
                else -> null
            },
            color = if (spoiler) ZkInk.ink4 else Color.Unspecified,
            background = if (spoiler) ZkInk.ink4.copy(alpha = 0.25f) else Color.Unspecified,
        )
        fun emit(s: String) { pushStyle(style()); append(s); pop() }

        while (i < n) {
            // Every token match is anchored AT the cursor. The old form
            // (`text.substring(i)` then `find` from 0, keeping it only when it
            // landed at offset 0) re-copied and re-scanned the whole remainder
            // once per character, making a long pasted message O(n^2).
            // Mentions + @everyone/@here.
            val mm = MENTION.matchAt(text, i)
            if (mm != null) {
                val token = mm.value
                val label = when {
                    token == "@everyone" -> "@everyone"
                    token == "@here" -> "@here"
                    mm.groupValues[1].isNotEmpty() -> "@" + resolve('@', mm.groupValues[1])
                    mm.groupValues[2].isNotEmpty() -> "@" + resolve('&', mm.groupValues[2])
                    else -> "#" + resolve('#', mm.groupValues[3])
                }
                pushStyle(SpanStyle(color = accent, fontWeight = FontWeight.Medium))
                append(label); pop()
                i += token.length; continue
            }
            // Bare links.
            val um = URL.matchAt(text, i)
            if (um != null) {
                pushStyle(SpanStyle(color = accent)); append(um.value); pop()
                i += um.value.length; continue
            }
            // Inline code — literal, no nested formatting.
            if (text[i] == '`' && text.indexOf('`', i + 1) > i) {
                val end = text.indexOf('`', i + 1)
                pushStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = ZkInk.ink4.copy(alpha = 0.2f)))
                append(text.substring(i + 1, end)); pop()
                i = end + 1; continue
            }
            // Custom :emoji: — render as an inline image when the name is known.
            if (text[i] == ':') {
                val em = EMOJI_TOKEN.matchAt(text, i)
                if (em != null) {
                    val name = em.groupValues[1]
                    val url = emojiUrl(name)
                    if (url != null) {
                        usedEmoji[name] = url
                        appendInlineContent("emoji:$name", ":$name:")
                        i += em.value.length; continue
                    }
                }
            }
            // Delimiters (toggle the matching style if a closer exists later).
            val two = if (i + 1 < n) text.substring(i, i + 2) else ""
            when {
                two == "**" && hasCloser(text, i + 2, "**") -> { bold = !bold; i += 2; continue }
                two == "__" && hasCloser(text, i + 2, "__") -> { underline = !underline; i += 2; continue }
                two == "~~" && hasCloser(text, i + 2, "~~") -> { strike = !strike; i += 2; continue }
                two == "||" && hasCloser(text, i + 2, "||") -> { spoiler = !spoiler; i += 2; continue }
                (text[i] == '*' || text[i] == '_') && hasCloser(text, i + 1, text[i].toString()) -> {
                    italic = !italic; i += 1; continue
                }
            }
            emit(text[i].toString()); i += 1
        }
    }

private fun hasCloser(text: String, from: Int, marker: String): Boolean =
    from <= text.length && text.indexOf(marker, from) >= 0

// ---- mention resolution ----------------------------------------------------

/** Resolver: ('@',id)->userName, ('&',id)->roleName, ('#',id)->channelName.
 *  Remembered on the state slices it reads so the parse it keys can survive
 *  AppState emits that touch nothing a mention resolves against. */
@Composable
private fun rememberMentionResolver(state: AppState): (Char, String) -> String =
    remember(state.me, state.membersByGuild, state.dms, state.channelsByGuild) {
        { kind: Char, id: String ->
            when (kind) {
                '@' -> {
                    val name = if (id == state.me?.id) state.me?.bestName
                    else state.membersByGuild.values.asSequence().flatten().firstOrNull { it.userId == id }?.user?.bestName
                        ?: state.dms.asSequence().mapNotNull { it.recipients }.flatten().firstOrNull { it.id == id }?.bestName
                    name ?: "unknown"
                }
                '#' -> state.channelsByGuild.values.asSequence().flatten().firstOrNull { it.id == id }?.name ?: "channel"
                else -> "role"
            }
        }
    }

/** Resolver: custom-emoji `:name:` → absolute image URL (null if not a known guild emoji). */
@Composable
private fun rememberEmojiResolver(state: AppState): (String) -> String? =
    remember(state.guildEmojis) {
        val byName = state.guildEmojis.associate { it.name to (Config.absoluteUrl(it.url) ?: it.url) }
        // Bound to a typed val first: a block ending in a bare lambda literal parses
        // as a second trailing lambda to remember(), not as the block's value.
        val resolve: (String) -> String? = { name -> byName[name] }
        resolve
    }

// ---- emoji-only detection --------------------------------------------------

/** True when the message is only emoji (+ whitespace) and reasonably short. */
private fun isEmojiOnly(text: String): Boolean {
    val t = text.trim()
    if (t.isEmpty()) return false
    var count = 0
    var i = 0
    while (i < t.length) {
        val cp = t.codePointAt(i)
        val chars = Character.charCount(cp)
        val c = t[i]
        if (c.isWhitespace()) { i += chars; continue }
        if (!isEmojiCodepoint(cp)) return false
        count++
        i += chars
    }
    return count in 1..12
}

private fun isEmojiCodepoint(cp: Int): Boolean =
    (cp in 0x1F000..0x1FAFF) || (cp in 0x2600..0x27BF) || (cp in 0x2190..0x21FF) ||
        (cp in 0x2B00..0x2BFF) || (cp in 0xFE00..0xFE0F) || (cp in 0x1F1E6..0x1F1FF) ||
        cp == 0x200D || (cp in 0x20D0..0x20FF)
