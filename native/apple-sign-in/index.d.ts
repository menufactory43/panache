export interface AppleSignInResult {
  /** The JWT Apple signed: the relay checks it and reads the player's stable id (`sub`) from it. */
  identityToken: string;
  /** The player's id for this team (the token's `sub`). */
  user: string;
  authorizationCode: string | null;
}

export interface AppleSignInPlugin {
  /** Apple's sheet; rejects when the player cancels. `nonce` goes into the token as is. */
  authorize(options?: { nonce?: string }): Promise<AppleSignInResult>;
}

export declare const AppleSignIn: AppleSignInPlugin;
