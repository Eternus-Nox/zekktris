package com.zekktris

import android.app.Application
import com.zekktris.data.ApiClient
import com.zekktris.data.Gateway
import com.zekktris.data.PersistentCookieStorage
import com.zekktris.data.zekDataStore
import com.zekktris.push.NotificationHelper
import com.zekktris.push.PushManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Application-scoped owner of the singletons (mirrors how the iOS app keeps one
 * APIClient/Gateway/AppStore for the process lifetime). Network calls suspend
 * onto Ktor's engine dispatcher, so the Main-immediate app scope never blocks
 * the UI while keeping StateFlow emissions on the main thread for Compose.
 */
class ZekApp : Application() {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    lateinit var api: ApiClient
        private set
    lateinit var gateway: Gateway
        private set
    lateinit var push: PushManager
        private set
    lateinit var store: AppStore
        private set

    override fun onCreate() {
        super.onCreate()
        val cookies = PersistentCookieStorage(zekDataStore)
        api = ApiClient(cookies)
        gateway = Gateway(api, appScope)
        push = PushManager(api, appScope)
        store = AppStore(api, gateway, push, appScope)
        NotificationHelper.ensureChannel(this)
        store.bootstrap()
    }
}
