import AuthenticationServices
import Capacitor

/// « Se connecter avec Apple » : la feuille d'Apple, puis le jeton qu'elle signe, que le relais vérifie
/// (relay/src/apple.ts). Rien d'autre n'est demandé : ni nom, ni e-mail.
@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]
    private var pending: CAPPluginCall?

    @objc public func authorize(_ call: CAPPluginCall) {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = []
        if let nonce = call.getString("nonce") { request.nonce = nonce }
        pending = call
        DispatchQueue.main.async {
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.webView?.window ?? ASPresentationAnchor()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = pending else { return }
        pending = nil
        guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = cred.identityToken, let token = String(data: tokenData, encoding: .utf8) else {
            call.reject("Apple n'a pas donné de jeton")
            return
        }
        let code = cred.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
        call.resolve(["identityToken": token, "user": cred.user, "authorizationCode": code as Any])
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = pending else { return }
        pending = nil
        let canceled = (error as? ASAuthorizationError)?.code == .canceled
        call.reject(canceled ? "annulé" : error.localizedDescription, canceled ? "CANCELED" : "FAILED")
    }
}
