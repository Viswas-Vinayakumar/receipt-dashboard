import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.rezet.app',
  appName: 'Rezet',
  webDir: 'dist',
  // Allow http:// to LAN backend (your Mac). Without this, Android blocks cleartext traffic.
  android: {
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
    // Tell the WebView our LAN backend is trusted for cleartext
    cleartext: true,
  },
}

export default config
