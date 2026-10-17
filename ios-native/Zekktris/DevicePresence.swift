import Foundation

/// Multi-device presence: the user's status follows the device in use.
///
/// A server whose READY carries `features.presence_activity` derives the
/// EFFECTIVE status everyone sees from the status the user picked
/// (`SelfUser.chosenStatus`) and the activity each connected device reports:
/// chosen "online" reads "online" while ANY device is in use and "idle" once
/// none is (Zekktris open somewhere, nobody using it). This device reports its
/// activity in IDENTIFY/RESUME and with PRESENCE_UPDATE (op 3) on each change,
/// and never PATCHes /users/@me {status} on its own. Older servers keep the
/// legacy auto-away PATCHes (AppStore.desiredAutoStatus).
///
/// Pure logic, compiled into the test bundle too (DevicePresenceTests).
enum DevicePresence {
    /// Seconds without input before this device counts as not in use.
    /// Same 5 minutes as the web client and the legacy auto-away.
    static let idleThresholdSeconds: TimeInterval = 300

    /// Whether the person is using this device: the app is in the foreground
    /// AND they touched it within the threshold or are talking in voice. A
    /// backgrounded app is idle at once, even with the socket still up (a
    /// background voice call, or the seconds before iOS suspends it).
    static func isActive(foreground: Bool, secondsSinceInteraction: TimeInterval, talking: Bool) -> Bool {
        foreground && (talking || secondsSinceInteraction < idleThresholdSeconds)
    }

    /// The status the picker shows as selected: what the user CHOSE. An older
    /// server sends no `chosenStatus`, and there `status` is the choice.
    /// "offline" or nothing (a stale pre-connect snapshot, a fresh account) is
    /// never a choice, so Online is selected then.
    static func pickerStatus(chosen: String?, status: String?) -> String {
        let s = chosen ?? status ?? ""
        return (s.isEmpty || s == "offline") ? "online" : s
    }

    /// The user's own avatar dot.
    ///
    /// - `chosen`: what the picker shows (`pickerStatus`).
    /// - `live`: the latest PRESENCE_UPDATE for our own id — the server's
    ///   effective status, masked like everyone else's ("invisible" arrives as
    ///   "offline"). nil before the first one.
    /// - `effective`: the self user's `effectiveStatus ?? status` — the
    ///   effective status from REST/READY (unmasked), shown until the first
    ///   live frame. (`status` is the pick on current servers; it only stands
    ///   in for a server that sends no `effectiveStatus`.)
    /// - `serverDerives`: the server derives presence from device activity.
    ///
    /// Older server: the chosen status IS the presence (auto-away PATCHes it).
    /// New server: chosen Invisible shows Invisible (the frames say offline);
    /// otherwise the live effective status, else the REST one, so a phone in
    /// use shows Online even while the idle Mac would say Away, and the Mac
    /// shows Away once nobody is using any device. "offline" for ourselves is
    /// only ever a stale value while we are connected, so it falls back to the
    /// choice.
    static func selfStatus(chosen: String, live: String?, effective: String?, serverDerives: Bool) -> String {
        guard serverDerives else { return chosen }
        if chosen == "invisible" { return "invisible" }
        for s in [live, effective] {
            if let s, s != "offline", s != "invisible" { return s }
        }
        return chosen
    }

    /// The PATCH /users/@me body that sets the chosen status. `manual`: the
    /// user picked it in the status picker, sent as `statusSource: "manual"`.
    /// Without the marker a server with multi-device presence reads an "idle"
    /// as an older client's AUTOMATIC away — it only marks older apps'
    /// devices as not in use, and goes back to online once the user's last
    /// device disconnects — so a deliberate Away would not stick. The legacy
    /// auto-away push (older servers only) is automatic and
    /// sends no marker. Servers that predate the field drop it.
    static func statusPatch(_ status: String, manual: Bool) -> [String: Any] {
        manual ? ["status": status, "statusSource": "manual"] : ["status": status]
    }

    /// The own-status fields carried by a PRESENCE_UPDATE about ourselves: the
    /// guild_id=null frame to our own connections adds `chosen_status`
    /// (unmasked). nil for any other frame. The effective status (for
    /// SelfUser.effectiveStatus) is unmasked: "offline" there means Invisible.
    static func selfFields(fromPresenceUpdate d: [String: Any], selfId: String) -> (chosen: String, effective: String)? {
        guard d["user_id"] as? String == selfId,
              let chosen = d["chosen_status"] as? String,
              let status = d["status"] as? String
        else { return nil }
        return (chosen, chosen == "invisible" ? "invisible" : status)
    }
}

/// What this device has told the gateway about its activity, so a change is
/// sent once and never repeated. Owned by `Gateway`; mirrors the web client's
/// presenceActive / presenceSent pair (packages/client/src/gateway.ts).
struct PresenceReport: Equatable {
    /// The activity the app last reported. nil until it reports: IDENTIFY
    /// then omits `presence`, which the server reads as active.
    private(set) var reported: Bool?
    /// The value the server's session holds for this connection (sent in
    /// IDENTIFY/RESUME or as op 3). nil = nothing sent on this session.
    private(set) var sent: Bool?

    mutating func report(_ active: Bool) { reported = active }

    /// `presence` for an IDENTIFY/RESUME. Records it as what the server holds.
    mutating func handshakeValue() -> Bool? {
        sent = reported
        return reported
    }

    /// The value to send as PRESENCE_UPDATE (op 3), or nil when nothing is
    /// due: not live yet, an older server, nothing reported, or no change
    /// since the server last heard from us. Records a returned value as sent.
    mutating func takeUpdate(live: Bool, supported: Bool) -> Bool? {
        guard live, supported, let reported, reported != sent else { return nil }
        sent = reported
        return reported
    }

    /// The logical session ended (sign-out / fresh connect): the next
    /// handshake starts over. The reported activity itself is kept.
    mutating func sessionEnded() { sent = nil }
}
