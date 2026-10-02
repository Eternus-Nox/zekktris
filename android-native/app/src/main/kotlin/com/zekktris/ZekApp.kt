package com.zekktris

import android.app.Application
import android.content.ComponentCallbacks2
import android.os.Build
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import com.zekktris.crypto.DecryptedMediaCache
import com.zekktris.data.ApiClient
import com.zekktris.data.Gateway
import com.zekktris.data.PersistentCookieStorage
import com.zekktris.data.zekDataStore
import com.zekktris.push.NotificationHelper
import com.zekktris.push.PushManager
import com.zekktris.voice.VoiceManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Application-scoped owner of the singletons (mirrors how the iOS app keeps one
 * APIClient/Gateway/AppStore for the process lifetime). Network calls suspend
 * onto Ktor's engine dispatcher, so the Main-immediate app scope never blocks
 * the UI while keeping StateFlow emissions on the main thread for Compose.
 */
class ZekApp : Application(), ImageLoaderFactory {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** Coil's global loader — with the animated-image decoder so animated custom
     * emoji / stickers actually move (default only decodes the first frame). */
    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .components {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) add(ImageDecoderDecoder.Factory())
                else add(GifDecoder.Factory())
            }
            .build()

    lateinit var api: ApiClient
        private set
    lateinit var gateway: Gateway
        private set
    lateinit var push: PushManager
        private set
    lateinit var voice: VoiceManager
        private set
    lateinit var store: AppStore
        private set

    override fun onCreate() {
        super.onCreate()
        // Which server to talk to — must be loaded before anything builds a URL.
        com.zekktris.data.Config.init(this)
        val cookies = PersistentCookieStorage(zekDataStore)
        api = ApiClient(cookies)
        gateway = Gateway(api, appScope)
        push = PushManager(this, api, appScope)
        voice = VoiceManager(this, appScope)
        store = AppStore(this, api, gateway, push, voice, com.zekktris.crypto.E2EEKeyStore(this), appScope)
        NotificationHelper.ensureChannel(this)
        store.bootstrap()
        sweepStaleCaptures()
    }

    /**
     * Two directories hold PLAINTEXT media that is meant to be transient:
     *  • <cacheDir>/captures — camera captures, written as JPEGs and deleted
     *    once the send completes.
     *  • <cacheDir>/mediaprep — MediaPrep's video-export scratch (the source
     *    copy Transformer needs a file URI for, plus the 720p output). Deleted
     *    in a `finally` on every path.
     * In an E2EE DM both are plaintext copies of something that is ciphertext
     * everywhere else, so neither may be allowed to linger.
     *
     * A process death mid-send (or a crash, or the user swiping the task away
     * at the camera / mid-export) orphans those files, which no per-send delete
     * can ever cover — so sweep both once at startup, before anything in this
     * process can have written to them. Safe because the app is single-process:
     * nothing else is mid-capture or mid-export here.
     *
     * Best-effort by construction: off the main thread, every failure swallowed.
     * A cache sweep must never be able to take down app startup.
     */
    private fun sweepStaleCaptures() {
        appScope.launch(Dispatchers.IO) {
            for (dir in listOf("captures", "mediaprep")) {
                runCatching {
                    java.io.File(cacheDir, dir)
                        .listFiles()
                        ?.forEach { runCatching { it.delete() } }
                }
            }
        }
    }

    // ---- Memory pressure -------------------------------------------------
    // Application IS a ComponentCallbacks2 (the framework dispatches trim
    // callbacks to it), so overriding here is the registration. The decrypted
    // E2EE media cache is the one large, fully-reconstructible Java-heap
    // allocation we own — everything in it can be re-fetched and re-decrypted,
    // so it is the first thing to hand back rather than letting the process get
    // killed. Coil manages its own bitmap pool's trimming.

    // API 34 deprecated every level constant except UI_HIDDEN, but they are all
    // still delivered on the devices we support (minSdk 26).
    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        when (level) {
            // Mild: still foreground, just getting tight — keep half.
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> DecryptedMediaCache.halveAll()
            // Severe, or we're no longer visible: drop the lot. Dropping it when
            // the UI is hidden also means plaintext isn't sitting in a
            // backgrounded process waiting to be dumped.
            ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL,
            ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN,
            ComponentCallbacks2.TRIM_MEMORY_BACKGROUND,
            ComponentCallbacks2.TRIM_MEMORY_MODERATE,
            ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> DecryptedMediaCache.clearAll()
            else -> Unit
        }
    }

    // Deprecated upstream in API 34 but still dispatched on older devices, and
    // minSdk here is 26 — onTrimMemory covers everything from 34 on.
    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onLowMemory() {
        super.onLowMemory()
        DecryptedMediaCache.clearAll()
    }
}
