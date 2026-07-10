package com.zekktris.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.zekktris.ZekApp

/**
 * FCM entry point. The system routes here for token rotation and for messages
 * received while the app is in the foreground (backgrounded messages are drawn
 * by the OS directly from the push `notification` block — see the manifest
 * default-channel/icon meta-data).
 */
class ZekMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        (applicationContext as? ZekApp)?.push?.onNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: "Zekktris"
        val body = message.notification?.body ?: message.data["body"].orEmpty()
        NotificationHelper.show(applicationContext, title, body, message.data)
    }
}
