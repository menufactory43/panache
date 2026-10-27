export interface GameCenterPlugin {
  /** Signs the player in (Apple's sheet the first time, a "Welcome back" banner after). `signedIn` false: declined or unavailable. */
  authenticate(): Promise<{ signedIn: boolean }>;
  /** Reports achievement progress (0–100); what Game Center already holds at that level or higher is skipped. */
  reportAchievements(options: { achievements: { id: string; percent: number }[] }): Promise<void>;
  /** Submits a score to one leaderboard (Game Center keeps the best). */
  submitScore(options: { leaderboard: string; score: number }): Promise<void>;
  /** Game Center's own screen: the dashboard, or one leaderboard. */
  show(options?: { leaderboard?: string; achievements?: boolean }): Promise<void>;
}

export declare const GameCenter: GameCenterPlugin;
