//
//  AppDelegate+VoIP.reference.swift
//  REFERENCE ONLY — do not copy this file in wholesale.
//
//  Capacitor generates apps/web/ios/App/App/AppDelegate.swift with its
//  own application(_:didFinishLaunchingWithOptions:) and APNs callbacks.
//  ADD the pieces below into that existing class — keep every line
//  Capacitor put there (it wires up the web view and returns true).
//
//  This file won't compile on its own; it documents the deltas only.
//

/*

import PushKit
import CallKit

// 1. Conform the existing AppDelegate to PKPushRegistryDelegate:
//
//    class AppDelegate: UIResponder, UIApplicationDelegate, PKPushRegistryDelegate {

    // 2. Add a stored property:
    var voipRegistry: PKPushRegistry?

    // 3. Inside the EXISTING didFinishLaunchingWithOptions, before
    //    `return true`, add:
    func setUpVoIP() {
        voipRegistry = PKPushRegistry(queue: DispatchQueue.main)
        voipRegistry?.delegate = self
        voipRegistry?.desiredPushTypes = [.voIP]
    }

    // 4. Add the two PushKit delegate methods:

    func pushRegistry(_ registry: PKPushRegistry,
                      didUpdate credentials: PKPushCredentials,
                      for type: PKPushType) {
        let token = credentials.token.map { String(format: "%02x", $0) }.joined()
        // Forward to the server via the existing notification-subscription
        // endpoint — add a "voipToken" field next to the regular APNs token.
        NotificationCenter.default.post(name: .voipTokenUpdated, object: token)
    }

    func pushRegistry(_ registry: PKPushRegistry,
                      didReceiveIncomingPushWith payload: PKPushPayload,
                      for type: PKPushType,
                      completion: @escaping () -> Void) {
        // Server sends { callId, callerName, hasVideo } in the payload.
        let dict = payload.dictionaryPayload
        let callId = dict["callId"] as? String ?? UUID().uuidString
        let callerName = dict["callerName"] as? String ?? "Incoming call"
        let hasVideo = (dict["hasVideo"] as? Bool) ?? false

        // CRITICAL: must report the incoming call to CallKit WITHIN this
        // callback. If iOS receives a voIP push and the app does not
        // report a call within ~5s, Apple permanently disables voIP push
        // for the app.
        ZekktrisCallsPlugin.shared?.presentIncomingCallFromPush(
            callId: callId,
            callerName: callerName,
            hasVideo: hasVideo
        )
        completion()
    }

// 5. Declare the notification name once (file scope, outside the class):
extension Notification.Name {
    static let voipTokenUpdated = Notification.Name("voipTokenUpdated")
}

*/
