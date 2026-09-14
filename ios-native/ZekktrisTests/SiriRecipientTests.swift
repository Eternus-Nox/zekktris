import XCTest
@testable import Zekktris

/// Who Siri sends to when you don't say the whole username.
///
/// The risk this guards is a message going to the WRONG PERSON: matching is
/// deliberately loose so "Alex" finds "alexjmorgan94", and the price of loose
/// matching is that a near-miss must still ask rather than guess.
final class SiriRecipientTests: XCTestCase {

    private func dm(_ id: String, _ name: String, username: String? = nil) -> WidgetDM {
        WidgetDM(id: id, name: name, streak: 0, avatarURL: nil,
                 isE2EE: false, peerUserId: "u-\(id)", peerUsername: username)
    }

    private lazy var people: [WidgetDM] = [
        dm("1", "Alex Morgan", username: "alexjmorgan94"),
        dm("2", "Priya", username: "priya_k"),
        dm("3", "Tom Nook", username: "tomnook"),
    ]

    func testFirstNameAloneFindsTheFullUsername() {
        let hit = SiriDirectory.rank(heard: "Alex", in: people)
        XCTAssertEqual(hit.map(\.id), ["1"])
    }

    func testSpokenNameWithSpacesMatchesARunTogetherUsername() {
        // Siri writes what it hears as words; the username has no space, and an
        // extra initial in the middle. Edit distance is what carries this one.
        let hit = SiriDirectory.rank(heard: "alex morgan", in: [people[0], people[1]])
        XCTAssertEqual(hit.map(\.id), ["1"])
    }

    func testUsernameSpokenDirectly() {
        XCTAssertEqual(SiriDirectory.rank(heard: "tomnook", in: people).map(\.id), ["3"])
    }

    func testAccentsAndCaseAreIgnored() {
        let jose = dm("4", "José", username: "jose")
        XCTAssertEqual(SiriDirectory.rank(heard: "JOSE", in: [jose]).map(\.id), ["4"])
    }

    func testAStrangerMatchesNobody() {
        XCTAssertTrue(SiriDirectory.rank(heard: "Wilhelmina", in: people).isEmpty)
    }

    func testTwoEquallyGoodMatchesAskRatherThanGuess() {
        let sams = [dm("a", "Sam Carter"), dm("b", "Sam Rivera")]
        let hits = SiriDirectory.rank(heard: "Sam", in: sams)
        XCTAssertEqual(hits.count, 2, "a tie must be handed back for disambiguation")
    }

    func testAClearLeaderIsPickedOverAWeakerNeighbour() {
        // "Priya" is exact; "Pria" is only close. The exact match should win
        // outright rather than producing a "which one?" prompt.
        let candidates = [people[1], dm("9", "Pria")]
        XCTAssertEqual(SiriDirectory.rank(heard: "Priya", in: candidates).map(\.id), ["2"])
    }

    func testExactBeatsPrefixBeatsSimilar() {
        XCTAssertEqual(SiriDirectory.score(spoken: "alex", candidate: "alex"), 1.0)
        XCTAssertGreaterThan(
            SiriDirectory.score(spoken: "alex", candidate: "alexjmorgan94"),
            SiriDirectory.score(spoken: "alex", candidate: "alix"),
        )
    }

    /// A contact card's "Zekktris" instant-message entry: iOS passes the
    /// USERNAME as the handle and the card's real name as the display name.
    func testAContactCardHandleFindsTheAccount() {
        XCTAssertEqual(SiriDirectory.rank(heard: "alexjmorgan94", in: people).map(\.id), ["1"])
    }

    /// …and the real name on its own must not match somebody else. "Mom" is one
    /// edit from "Tom", which is how a message goes to the wrong person.
    func testAShortRealNameDoesNotFuzzyMatchAStranger() {
        XCTAssertTrue(SiriDirectory.rank(heard: "Mom", in: people).isEmpty)
    }

    func testTheUsernameIsMatchedEvenWhenTheDisplayNameIsNothingLike() {
        let alias = dm("7", "🌙 moonlight", username: "danielle")
        XCTAssertEqual(SiriDirectory.rank(heard: "Danielle", in: [alias]).map(\.id), ["7"])
    }
}
