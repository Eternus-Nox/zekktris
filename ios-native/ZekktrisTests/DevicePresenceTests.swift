import XCTest
import Foundation

// Host-less logic test: `Zekktris/DevicePresence.swift` is compiled into this
// bundle directly (project.yml › targets › ZekktrisTests).

/// Multi-device presence on the phone: what this device reports, what it
/// sends to the gateway, and what the user's own dot and status picker show.
///
/// The owner's rule: the status follows the device actually being used. The
/// phone in use reads Online even while the idle Mac would say Away; once the
/// phone goes to the background the user reads Away (Zekktris is still open
/// on the Mac, nobody is using it).
final class DevicePresenceTests: XCTestCase {

    // MARK: Device activity

    func testForegroundWithRecentTouchIsActive() {
        XCTAssertTrue(DevicePresence.isActive(foreground: true, secondsSinceInteraction: 10, talking: false))
    }

    func testFiveMinutesWithoutInputIsIdle() {
        XCTAssertTrue(DevicePresence.isActive(foreground: true, secondsSinceInteraction: 299, talking: false))
        XCTAssertFalse(DevicePresence.isActive(foreground: true, secondsSinceInteraction: 300, talking: false))
    }

    func testTalkingInVoiceKeepsTheDeviceActive() {
        XCTAssertTrue(DevicePresence.isActive(foreground: true, secondsSinceInteraction: 3_600, talking: true))
    }

    /// Background → idle at once, even mid-call or a second after a touch.
    func testBackgroundIsIdleAtOnce() {
        XCTAssertFalse(DevicePresence.isActive(foreground: false, secondsSinceInteraction: 1, talking: false))
        XCTAssertFalse(DevicePresence.isActive(foreground: false, secondsSinceInteraction: 1, talking: true))
    }

    // MARK: Gateway reporting

    func testNothingReportedOmitsPresenceFromTheHandshake() {
        var r = PresenceReport()
        XCTAssertNil(r.handshakeValue())
        XCTAssertNil(r.takeUpdate(live: true, supported: true))
    }

    func testHandshakeCarriesTheReportedActivityAndNoUpdateFollows() {
        var r = PresenceReport()
        r.report(false)
        XCTAssertEqual(r.handshakeValue(), false)
        // The server already holds it: READY must not repeat it as op 3.
        XCTAssertNil(r.takeUpdate(live: true, supported: true))
    }

    func testAChangeIsSentOnceAndNeverRepeated() {
        var r = PresenceReport()
        r.report(true)
        _ = r.handshakeValue()
        r.report(false)
        XCTAssertEqual(r.takeUpdate(live: true, supported: true), false)
        r.report(false)
        XCTAssertNil(r.takeUpdate(live: true, supported: true))
        r.report(true)
        XCTAssertEqual(r.takeUpdate(live: true, supported: true), true)
    }

    /// An older server gets no op 3 at all (its READY had no flag).
    func testNoUpdateToAServerWithoutTheFeature() {
        var r = PresenceReport()
        r.report(true)
        _ = r.handshakeValue()
        r.report(false)
        XCTAssertNil(r.takeUpdate(live: true, supported: false))
    }

    /// Backgrounded while reconnecting: the change waits for READY/RESUMED
    /// (or rides in the handshake) instead of going into a dead socket.
    func testAChangeWhileNotLiveIsSentOnceLive() {
        var r = PresenceReport()
        r.report(true)
        _ = r.handshakeValue()
        r.report(false)
        XCTAssertNil(r.takeUpdate(live: false, supported: true))
        XCTAssertEqual(r.takeUpdate(live: true, supported: true), false)
    }

    func testAReconnectHandshakeCarriesTheCurrentValue() {
        var r = PresenceReport()
        r.report(true)
        _ = r.handshakeValue()
        r.report(false)
        XCTAssertEqual(r.takeUpdate(live: true, supported: true), false)
        r.sessionEnded()
        r.report(true)
        XCTAssertEqual(r.handshakeValue(), true)
        XCTAssertNil(r.takeUpdate(live: true, supported: true))
    }

    // MARK: Status picker

    func testPickerShowsTheChosenStatusNotTheEffectiveOne() {
        // Chosen Online, but no device in use → effective idle. Still Online.
        XCTAssertEqual(DevicePresence.pickerStatus(chosen: "online", status: "idle"), "online")
        XCTAssertEqual(DevicePresence.pickerStatus(chosen: "dnd", status: "dnd"), "dnd")
    }

    func testPickerFallsBackToStatusOnAnOlderServer() {
        XCTAssertEqual(DevicePresence.pickerStatus(chosen: nil, status: "idle"), "idle")
        XCTAssertEqual(DevicePresence.pickerStatus(chosen: nil, status: "offline"), "online")
        XCTAssertEqual(DevicePresence.pickerStatus(chosen: nil, status: nil), "online")
    }

    // MARK: Own dot

    /// Phone in use while the Mac sits idle: the server says online.
    func testOwnDotFollowsTheLiveEffectiveStatus() {
        XCTAssertEqual(DevicePresence.selfStatus(chosen: "online", live: "online", serverDerives: true), "online")
        // No device in use anywhere → Away, though the choice is Online.
        XCTAssertEqual(DevicePresence.selfStatus(chosen: "online", live: "idle", serverDerives: true), "idle")
    }

    func testOwnDotShowsInvisibleAlthoughFramesSayOffline() {
        XCTAssertEqual(DevicePresence.selfStatus(chosen: "invisible", live: "offline", serverDerives: true), "invisible")
    }

    func testOwnDotFallsBackToTheChoiceBeforeAnyLiveFrame() {
        XCTAssertEqual(DevicePresence.selfStatus(chosen: "online", live: nil, serverDerives: true), "online")
        XCTAssertEqual(DevicePresence.selfStatus(chosen: "dnd", live: "offline", serverDerives: true), "dnd")
    }

    /// Older server: the chosen status is the presence (legacy auto-away).
    func testOwnDotOnAnOlderServerIsTheChoice() {
        XCTAssertEqual(DevicePresence.selfStatus(chosen: "online", live: "idle", serverDerives: false), "online")
        XCTAssertEqual(DevicePresence.selfStatus(chosen: "idle", live: nil, serverDerives: false), "idle")
    }

    // MARK: Own PRESENCE_UPDATE

    func testOwnFrameCarriesChosenAndUnmaskedEffective() {
        let d: [String: Any] = ["user_id": "1", "status": "offline", "guild_id": NSNull(), "chosen_status": "invisible"]
        let own = DevicePresence.selfFields(fromPresenceUpdate: d, selfId: "1")
        XCTAssertEqual(own?.chosen, "invisible")
        XCTAssertEqual(own?.effective, "invisible")

        let idle: [String: Any] = ["user_id": "1", "status": "idle", "guild_id": NSNull(), "chosen_status": "online"]
        XCTAssertEqual(DevicePresence.selfFields(fromPresenceUpdate: idle, selfId: "1")?.effective, "idle")
    }

    func testOtherFramesCarryNoOwnFields() {
        // Someone else's frame, or our per-guild frame without chosen_status.
        let other: [String: Any] = ["user_id": "2", "status": "online", "guild_id": NSNull(), "chosen_status": "online"]
        XCTAssertNil(DevicePresence.selfFields(fromPresenceUpdate: other, selfId: "1"))
        let guild: [String: Any] = ["user_id": "1", "status": "online", "guild_id": "9"]
        XCTAssertNil(DevicePresence.selfFields(fromPresenceUpdate: guild, selfId: "1"))
    }
}
