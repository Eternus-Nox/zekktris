package com.zekktris.crypto

import java.lang.ref.WeakReference

/**
 * Session-lifetime, IN-MEMORY-ONLY store for decrypted E2EE attachment bytes
 * (the Android mirror of iOS `AppStore.decryptedMedia` + its LRU queue).
 *
 * Security invariant: decrypted media must NEVER touch disk — no file cache,
 * no temp files, no Coil disk layer. Everything lives in this map and is
 * dropped on E2EE relock/disable and on sign-out, so plaintext can't outlive
 * the key.
 *
 * Eviction: least-recently-used, enforced on every insert. A LinkedHashMap in
 * access order is the LRU queue; after each put the eldest entries are evicted
 * until the cache is back within BOTH budgets (max 128 items / [maxBytes]),
 * never evicting the entry that was just stored. Reads mark the entry
 * most-recently-used.
 *
 * Byte budget is HEAP-RELATIVE, not a fixed number: these are Java-heap
 * ByteArrays and the app does not request largeHeap, so on a mid/low-end
 * device the whole heap can be smaller than a fixed 128 MB budget and the
 * cache alone would OOM the process. See [defaultMaxBytes].
 *
 * On top of budget overflow, the process can also shed this cache under system
 * memory pressure — ZekApp's onTrimMemory/onLowMemory call [trimAll]/[clearAll]
 * (iOS gets the equivalent for free from its URLCache/didReceiveMemoryWarning).
 *
 * Keys are attachment ids; encrypted thumbnails are stored under
 * "<attachmentId>:thumb" so they never collide with the full image.
 */
class DecryptedMediaCache(
    private val maxCount: Int = 128,
    private val maxBytes: Long = defaultMaxBytes(),
) {
    // accessOrder = true → iteration order is LRU→MRU; get() refreshes recency.
    private val map = LinkedHashMap<String, ByteArray>(32, 0.75f, true)
    private var totalBytes = 0L

    init {
        register(this)
    }

    /** Cached plaintext for [id], marked most-recently-used; null on a miss. */
    @Synchronized
    fun get(id: String): ByteArray? = map[id]

    /** Store plaintext, then evict LRU entries until back within the
     *  count/byte budget (never evicting the just-stored one). */
    @Synchronized
    fun put(id: String, data: ByteArray) {
        map.remove(id)?.let { totalBytes -= it.size }
        map[id] = data
        totalBytes += data.size
        evictLru(byteBudget = maxBytes, countBudget = maxCount, keep = id, floorCount = 1)
    }

    /** Shed LRU entries until the cache holds at most [toBytes] (memory
     *  pressure). Unlike [put] this may empty the cache completely. */
    @Synchronized
    fun trim(toBytes: Long) {
        evictLru(byteBudget = toBytes.coerceAtLeast(0L), countBudget = maxCount, keep = null, floorCount = 0)
    }

    /** Halve the live footprint — the gentle response to TRIM_MEMORY_RUNNING_LOW. */
    @Synchronized
    fun halve() = trim(totalBytes / 2)

    /** Drop everything (relock / E2EE disable / sign-out / memory pressure):
     *  plaintext must not outlive the key. */
    @Synchronized
    fun clear() {
        map.clear()
        totalBytes = 0L
    }

    /** Evict least-recently-used entries until BOTH budgets are met. [keep] is
     *  never evicted (the just-stored entry); [floorCount] is the smallest size
     *  the map is allowed to shrink to. Caller holds the instance lock. */
    private fun evictLru(byteBudget: Long, countBudget: Int, keep: String?, floorCount: Int) {
        val it = map.entries.iterator()
        while ((totalBytes > byteBudget || map.size > countBudget) && map.size > floorCount && it.hasNext()) {
            val eldest = it.next()
            if (eldest.key == keep) continue // never evict the just-stored entry
            totalBytes -= eldest.value.size
            it.remove()
        }
    }

    companion object {
        /** Never take more than this, however big the heap is. */
        private const val CEILING_BYTES = 64L * 1024 * 1024
        /** …and never so little that caching stops being worth it. */
        private const val FLOOR_BYTES = 8L * 1024 * 1024

        /**
         * An eighth of the app's Java heap, clamped to [FLOOR_BYTES]…[CEILING_BYTES].
         * `maxMemory()` is the per-app heap cap the framework actually enforces
         * (largeHeap is NOT set), so this scales from a ~96 MB-heap budget phone
         * (12 MB cache) up to a large device (64 MB cache) instead of handing the
         * cache a budget bigger than the heap it lives in.
         */
        fun defaultMaxBytes(): Long =
            (Runtime.getRuntime().maxMemory() / 8).coerceIn(FLOOR_BYTES, CEILING_BYTES)

        // Live instances, weakly held. The cache is owned privately by AppStore,
        // so this registry is how the Application-level memory-pressure callbacks
        // reach it without AppStore having to publish a handle. Weak refs mean a
        // discarded store's cache is still collectable.
        private val live = ArrayList<WeakReference<DecryptedMediaCache>>(2)

        private fun register(cache: DecryptedMediaCache) {
            synchronized(live) { live.add(WeakReference(cache)) }
        }

        /** Snapshot the live caches, dropping refs whose owner has been GC'd. */
        private fun liveCaches(): List<DecryptedMediaCache> = synchronized(live) {
            val alive = ArrayList<DecryptedMediaCache>(live.size)
            val it = live.iterator()
            while (it.hasNext()) {
                val c = it.next().get()
                if (c == null) it.remove() else alive.add(c)
            }
            alive
        }

        /** Shed every live cache down to [toBytes]. */
        fun trimAll(toBytes: Long) = liveCaches().forEach { it.trim(toBytes) }

        /** Halve every live cache (mild pressure). */
        fun halveAll() = liveCaches().forEach { it.halve() }

        /** Empty every live cache (severe pressure / app no longer visible). */
        fun clearAll() = liveCaches().forEach { it.clear() }
    }
}
