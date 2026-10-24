import type { CapacitorConfig } from "@capacitor/cli";

/**
 * L'app iPhone de Panache (Capacitor) : le même jeu que la page publiée, embarqué hors ligne dans l'app
 * (dist/, construit par `npm run build`). `npm run ios` construit, copie dans ios/ et ouvre Xcode.
 */
const config: CapacitorConfig = {
  appId: "io.github.menufactory43.panache",
  appName: "Panache",
  webDir: "dist",
  backgroundColor: "#070a10",
  ios: {
    // le jeu dessine lui-même sous l'encoche (viewport-fit=cover, env(safe-area-inset-*))
    contentInset: "never",
    scrollEnabled: false,
    allowsLinkPreview: false
  },
  plugins: {
    SplashScreen: { launchShowDuration: 0, backgroundColor: "#070a10" }
  }
};

export default config;
