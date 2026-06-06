//
//  ZekktrisCalls.swift
//  Zekktris — custom Capacitor plugin for CallKit + voIP.
//
//  WHERE THIS GOES:
//    After running `npx cap add ios` (which creates apps/web/ios/),
//    copy this file and ZekktrisCalls.m into:
//      apps/web/ios/App/App/
//    then run `cd apps/web/ios/App && pod install`.
//
//  WHAT IT DOES:
//    Bridges the JS calls in apps/web/src/lib/native.ts
//    (presentIncomingCall / endCall / reportOutgoingCall) to the
//    iOS system call UI, and exposes presentIncomingCallFromPush(...)
//    for the voIP-push path in AppDelegate. This is what lets the mic
//    stay open on a locked screen — something a PWA cannot do.
//

import Foundation
import Capacitor
import CallKit
import AVFoundation
import UIKit

@objc(ZekktrisCallsPlugin)
public class ZekktrisCallsPlugin: CAPPlugin {
    /// Set in `load()` so the AppDelegate's PushKit callbacks can reach
    /// the live plugin instance to report incoming calls.
    public static weak var shared: ZekktrisCallsPlugin?

    private let provider: CXProvider
    private let callController = CXCallController()

    public override init() {
        let config = CXProviderConfiguration(localizedName: "Zekktris")
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        if let iconImage = UIImage(named: "AppIcon") {
            config.iconTemplateImageData = iconImage.pngData()
        }
        self.provider = CXProvider(configuration: config)
        super.init()
        self.provider.setDelegate(self, queue: nil)
    }

    /// Capacitor calls `load()` once the plugin is attached to the
    /// bridge. Record the singleton here.
    public override func load() {
        ZekktrisCallsPlugin.shared = self
    }

    // MARK: - JS-facing methods

    @objc func presentIncomingCall(_ call: CAPPluginCall) {
        guard let callIdString = call.getString("callId"),
              let callId = UUID(uuidString: pad(callIdString)),
              let callerName = call.getString("callerName") else {
            call.reject("Missing callId or callerName")
            return
        }
        let hasVideo = call.getBool("hasVideo") ?? false
        reportIncoming(callId: callId, callerName: callerName, hasVideo: hasVideo) { error in
            if let error = error {
                call.reject("CallKit failed: \(error.localizedDescription)")
            } else {
                call.resolve()
            }
        }
    }

    @objc func endCall(_ call: CAPPluginCall) {
        guard let callIdString = call.getString("callId"),
              let callId = UUID(uuidString: pad(callIdString)) else {
            call.reject("Missing callId")
            return
        }
        let endAction = CXEndCallAction(call: callId)
        callController.request(CXTransaction(action: endAction)) { error in
            if let error = error {
                call.reject("End call failed: \(error.localizedDescription)")
            } else {
                call.resolve()
            }
        }
    }

    @objc func reportOutgoingCall(_ call: CAPPluginCall) {
        guard let callIdString = call.getString("callId"),
              let callId = UUID(uuidString: pad(callIdString)),
              let calleeName = call.getString("calleeName") else {
            call.reject("Missing callId or calleeName")
            return
        }
        let handle = CXHandle(type: .generic, value: calleeName)
        let startAction = CXStartCallAction(call: callId, handle: handle)
        startAction.contactIdentifier = calleeName
        callController.request(CXTransaction(action: startAction)) { error in
            if let error = error {
                call.reject("Start call failed: \(error.localizedDescription)")
            } else {
                call.resolve()
            }
        }
    }

    // MARK: - Push-facing entry point

    /// Entry point for voIP pushes (see AppDelegate). There is no
    /// CAPPluginCall here — the push arrives natively — so this builds
    /// the UUID itself and reports straight to CallKit. MUST run
    /// synchronously inside the PushKit callback (Apple kills the app
    /// otherwise).
    public func presentIncomingCallFromPush(callId callIdString: String, callerName: String, hasVideo: Bool) {
        guard let callId = UUID(uuidString: pad(callIdString)) else { return }
        reportIncoming(callId: callId, callerName: callerName, hasVideo: hasVideo, completion: nil)
    }

    // MARK: - Shared helpers

    /// Shared CallKit "new incoming call" reporting used by both the
    /// JS-driven path and the voIP-push path.
    private func reportIncoming(callId: UUID, callerName: String, hasVideo: Bool, completion: ((Error?) -> Void)?) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = hasVideo
        update.supportsDTMF = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        provider.reportNewIncomingCall(with: callId, update: update) { error in
            completion?(error)
        }
    }

    /// Snowflake IDs are 18-19 digit strings; UUIDs are 36 chars in
    /// 8-4-4-4-12 format. Pad the snowflake into a deterministic UUID
    /// shape so CallKit can use it as a unique identifier.
    private func pad(_ id: String) -> String {
        let padded = String(repeating: "0", count: max(0, 32 - id.count)) + id
        let chars = Array(padded.prefix(32))
        return "\(String(chars[0..<8]))-\(String(chars[8..<12]))-\(String(chars[12..<16]))-\(String(chars[16..<20]))-\(String(chars[20..<32]))"
    }
}

extension ZekktrisCallsPlugin: CXProviderDelegate {
    public func providerDidReset(_ provider: CXProvider) {
        // CallKit reset (system rebooted, user toggled airplane mode,
        // etc). Notify JS to clean up via the existing voice
        // disconnect path.
        self.notifyListeners("callReset", data: [:])
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        // User tapped Answer on the locked-screen UI. Notify JS to join
        // the LiveKit room.
        self.notifyListeners("callAnswered", data: ["callId": action.callUUID.uuidString])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        // User tapped End. JS will run disconnectVoice via the listener,
        // which itself eventually calls back into endCall — that's fine,
        // the second call resolves with no-op.
        self.notifyListeners("callEnded", data: ["callId": action.callUUID.uuidString])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit has activated the audio session. Configure for VoIP
        // playback + record.
        try? audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
        try? audioSession.setActive(true)
    }
}
