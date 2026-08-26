package com.zekktris.ui.components

import android.content.Context

/**
 * Compact unicode emoji catalog + recently-used store, ported byte-for-byte
 * from iOS's EmojiCatalog (Components.swift). Each entry is (glyph, searchable
 * name); categories match the web/iOS picker groupings.
 */
object EmojiCatalog {
    data class Category(val name: String, val emoji: List<Pair<String, String>>)

    val categories: List<Category> = listOf(
        Category("Smileys", listOf(
            "😀" to "grinning", "😃" to "smiley", "😄" to "smile", "😁" to "grin", "😆" to "laughing", "😅" to "sweat smile",
            "😂" to "joy", "🤣" to "rofl", "🙂" to "slight smile", "😉" to "wink", "😊" to "blush", "😇" to "innocent",
            "🥰" to "hearts face", "😍" to "heart eyes", "🤩" to "star struck", "😘" to "kiss", "😋" to "yum", "😜" to "winking tongue",
            "🤪" to "zany", "🤔" to "thinking", "🤨" to "raised eyebrow", "😐" to "neutral", "😏" to "smirk", "🙄" to "eye roll",
            "😬" to "grimace", "😴" to "sleeping", "🤒" to "sick", "🤯" to "mind blown", "😎" to "sunglasses", "🥳" to "party face",
            "😢" to "cry", "😭" to "sob", "😡" to "rage", "🤬" to "cursing", "😱" to "scream", "😳" to "flushed",
            "🥺" to "pleading", "😈" to "smiling imp", "💀" to "skull", "👻" to "ghost", "🤖" to "robot", "💩" to "poop",
        )),
        Category("People", listOf(
            "👍" to "thumbs up", "👎" to "thumbs down", "👌" to "ok hand", "✌️" to "victory", "🤞" to "crossed fingers",
            "🤘" to "rock on", "🤙" to "call me", "👈" to "point left", "👉" to "point right", "👆" to "point up",
            "👇" to "point down", "✋" to "raised hand", "🖐️" to "hand splayed", "👋" to "wave", "🤝" to "handshake",
            "🙏" to "pray thanks", "👏" to "clap", "🙌" to "raised hands", "💪" to "muscle flex", "🫶" to "heart hands",
            "🤷" to "shrug", "🤦" to "facepalm", "🧠" to "brain", "👀" to "eyes", "👑" to "crown", "🫡" to "salute",
        )),
        Category("Nature", listOf(
            "🐶" to "dog", "🐱" to "cat", "🐭" to "mouse", "🐹" to "hamster", "🐰" to "rabbit", "🦊" to "fox",
            "🐻" to "bear", "🐼" to "panda", "🐨" to "koala", "🐯" to "tiger", "🦁" to "lion", "🐸" to "frog",
            "🐵" to "monkey", "🐔" to "chicken", "🐧" to "penguin", "🦄" to "unicorn", "🐝" to "bee", "🦋" to "butterfly",
            "🌵" to "cactus", "🌲" to "evergreen", "🌹" to "rose", "🌻" to "sunflower", "🍀" to "clover luck", "🍄" to "mushroom",
            "🌙" to "moon", "⭐" to "star", "🌈" to "rainbow", "⚡" to "zap lightning", "🔥" to "fire", "❄️" to "snowflake",
            "💧" to "droplet", "🌊" to "wave water",
        )),
        Category("Food", listOf(
            "🍎" to "apple", "🍌" to "banana", "🍉" to "watermelon", "🍇" to "grapes", "🍓" to "strawberry", "🍒" to "cherries",
            "🍑" to "peach", "🥭" to "mango", "🍍" to "pineapple", "🥑" to "avocado", "🍔" to "burger", "🍟" to "fries",
            "🍕" to "pizza", "🌭" to "hotdog", "🌮" to "taco", "🌯" to "burrito", "🍜" to "ramen noodles", "🍣" to "sushi",
            "🍩" to "donut", "🍪" to "cookie", "🎂" to "birthday cake", "🍰" to "cake", "🍫" to "chocolate", "🍿" to "popcorn",
            "☕" to "coffee", "🍺" to "beer", "🍷" to "wine", "🥤" to "cup straw",
        )),
        Category("Travel", listOf(
            "🚗" to "car", "🚕" to "taxi", "🚌" to "bus", "🏎️" to "race car", "🚓" to "police car", "🚑" to "ambulance",
            "🚒" to "fire engine", "🚲" to "bike", "🏍️" to "motorcycle", "✈️" to "airplane", "🚀" to "rocket", "🛸" to "ufo",
            "🚁" to "helicopter", "⛵" to "sailboat", "🚢" to "ship", "🗽" to "statue liberty", "🗼" to "tokyo tower", "🏰" to "castle",
            "🏝️" to "desert island", "⛰️" to "mountain", "🏠" to "house", "🌋" to "volcano",
        )),
        Category("Activity", listOf(
            "⚽" to "soccer", "🏀" to "basketball", "🏈" to "football", "⚾" to "baseball", "🎾" to "tennis", "🏐" to "volleyball",
            "🎱" to "8ball", "🏓" to "ping pong", "🥊" to "boxing", "⛳" to "golf", "🎣" to "fishing", "🎽" to "running",
            "🛹" to "skateboard", "🎿" to "ski", "🏆" to "trophy", "🥇" to "gold medal", "🎯" to "dart target", "🎮" to "video game",
            "🕹️" to "joystick", "🎲" to "dice", "♟️" to "chess", "🎰" to "slot machine", "🎳" to "bowling", "🎤" to "microphone sing",
            "🎧" to "headphones", "🎸" to "guitar", "🎹" to "piano", "🥁" to "drum", "🎨" to "art palette", "🎬" to "clapper movie",
        )),
        Category("Objects", listOf(
            "⌚" to "watch", "📱" to "phone", "💻" to "laptop", "⌨️" to "keyboard", "🖥️" to "desktop", "🖨️" to "printer",
            "📷" to "camera", "🎥" to "movie camera", "🔍" to "magnifier search", "💡" to "bulb idea", "🔦" to "flashlight", "📚" to "books",
            "📝" to "memo note", "✏️" to "pencil", "📌" to "pushpin", "📎" to "paperclip", "🔒" to "lock", "🔑" to "key",
            "🔨" to "hammer", "🛠️" to "tools", "⚙️" to "gear", "🧲" to "magnet", "💣" to "bomb", "🧪" to "test tube",
            "💊" to "pill", "💰" to "money bag", "💎" to "gem diamond", "📦" to "package", "🎁" to "gift", "🎈" to "balloon",
            "🎉" to "party popper tada", "🎊" to "confetti",
        )),
        Category("Symbols", listOf(
            "❤️" to "red heart", "🧡" to "orange heart", "💛" to "yellow heart", "💚" to "green heart", "💙" to "blue heart",
            "💜" to "purple heart", "🖤" to "black heart", "🤍" to "white heart", "💔" to "broken heart", "💕" to "two hearts",
            "💖" to "sparkling heart", "💯" to "hundred", "💢" to "anger", "💥" to "collision boom", "💫" to "dizzy", "💦" to "sweat drops",
            "✨" to "sparkles", "❗" to "exclamation", "❓" to "question", "✅" to "check mark", "❌" to "cross mark", "⚠️" to "warning",
            "🚫" to "prohibited", "♻️" to "recycle", "🔞" to "18 plus", "🆒" to "cool", "🆕" to "new", "🆓" to "free",
        )),
        Category("Flags", listOf(
            "🏁" to "checkered flag", "🚩" to "triangular flag", "🏴‍☠️" to "pirate flag", "🏳️" to "white flag",
            "🏳️‍🌈" to "rainbow flag", "🇺🇸" to "usa", "🇬🇧" to "uk", "🇨🇦" to "canada", "🇦🇺" to "australia", "🇩🇪" to "germany",
            "🇫🇷" to "france", "🇪🇸" to "spain", "🇮🇹" to "italy", "🇯🇵" to "japan", "🇰🇷" to "korea", "🇧🇷" to "brazil",
            "🇲🇽" to "mexico", "🇮🇳" to "india",
        )),
    )

    private const val PREFS = "zk_prefs"
    private const val RECENT_KEY = "zk.recentEmoji"

    // Newline-delimited (an emoji glyph never contains '\n').
    fun recents(ctx: Context): List<String> {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(RECENT_KEY, null)
        return raw?.split('\n')?.filter { it.isNotEmpty() } ?: emptyList()
    }

    fun pushRecent(ctx: Context, emoji: String) {
        val cur = recents(ctx).toMutableList()
        cur.remove(emoji)
        cur.add(0, emoji)
        val trimmed = cur.take(24)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(RECENT_KEY, trimmed.joinToString("\n")).apply()
    }
}
