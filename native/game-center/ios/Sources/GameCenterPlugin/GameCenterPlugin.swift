import Capacitor
import GameKit

/// Game Center : la connexion du joueur, les succès, les classements et l'écran de Game Center.
/// Le jeu (src/game/game-center.ts) déduit les succès de la Carrière et les envoie tous à chaque
/// fois : ceux que Game Center a déjà à ce niveau sont écartés ici, pour ne pas rejouer leur bannière.
@objc(GameCenterPlugin)
public class GameCenterPlugin: CAPPlugin, CAPBridgedPlugin, GKGameCenterControllerDelegate {
    public let identifier = "GameCenterPlugin"
    public let jsName = "GameCenter"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportAchievements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "submitScore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise)
    ]
    /// Le pourcentage que Game Center a déjà pour chaque succès (chargé à la connexion).
    private var known: [String: Double] = [:]
    private var waiting: [CAPPluginCall] = []
    private var answered = false

    @objc public func authenticate(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.answered {
                call.resolve(["signedIn": GKLocalPlayer.local.isAuthenticated])
                return
            }
            self.waiting.append(call)
            if self.waiting.count > 1 { return }
            GKLocalPlayer.local.authenticateHandler = { [weak self] controller, _ in
                guard let self = self else { return }
                if let controller = controller {
                    self.bridge?.viewController?.present(controller, animated: true)
                    return
                }
                let finish = {
                    self.answered = true
                    let calls = self.waiting
                    self.waiting = []
                    for c in calls { c.resolve(["signedIn": GKLocalPlayer.local.isAuthenticated]) }
                }
                guard GKLocalPlayer.local.isAuthenticated else { finish(); return }
                GKAchievement.loadAchievements { achievements, _ in
                    DispatchQueue.main.async {
                        for a in achievements ?? [] { self.known[a.identifier] = a.percentComplete }
                        finish()
                    }
                }
            }
        }
    }

    @objc public func reportAchievements(_ call: CAPPluginCall) {
        guard GKLocalPlayer.local.isAuthenticated else { call.resolve(); return }
        let list = call.getArray("achievements", JSObject.self) ?? []
        DispatchQueue.main.async {
            var toSend: [GKAchievement] = []
            for item in list {
                guard let id = item["id"] as? String, let raw = item["percent"] as? Double else { continue }
                let percent = min(100, max(0, raw))
                if percent <= (self.known[id] ?? 0) { continue }
                let a = GKAchievement(identifier: id)
                a.percentComplete = percent
                a.showsCompletionBanner = true
                toSend.append(a)
                self.known[id] = percent
            }
            if toSend.isEmpty { call.resolve(); return }
            GKAchievement.report(toSend) { error in
                if let error = error {
                    for a in toSend { self.known[a.identifier] = nil }
                    call.reject(error.localizedDescription)
                } else {
                    call.resolve()
                }
            }
        }
    }

    @objc public func submitScore(_ call: CAPPluginCall) {
        guard GKLocalPlayer.local.isAuthenticated else { call.resolve(); return }
        guard let board = call.getString("leaderboard"), let score = call.getInt("score") else {
            call.reject("leaderboard et score attendus")
            return
        }
        GKLeaderboard.submitScore(score, context: 0, player: GKLocalPlayer.local, leaderboardIDs: [board]) { error in
            if let error = error { call.reject(error.localizedDescription) } else { call.resolve() }
        }
    }

    @objc public func show(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard GKLocalPlayer.local.isAuthenticated else {
                call.reject("Game Center n'est pas connecté", "SIGNED_OUT")
                return
            }
            let vc: GKGameCenterViewController
            if let board = call.getString("leaderboard") {
                vc = GKGameCenterViewController(leaderboardID: board, playerScope: .global, timeScope: .allTime)
            } else if call.getBool("achievements") ?? false {
                vc = GKGameCenterViewController(state: .achievements)
            } else {
                vc = GKGameCenterViewController(state: .dashboard)
            }
            vc.gameCenterDelegate = self
            self.bridge?.viewController?.present(vc, animated: true)
            call.resolve()
        }
    }

    public func gameCenterViewControllerDidFinish(_ gameCenterViewController: GKGameCenterViewController) {
        gameCenterViewController.dismiss(animated: true)
    }
}
