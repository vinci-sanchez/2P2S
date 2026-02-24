const config = {
  appName: "2P2S(tauri)",
  signaling: {
    secure: true,
    defaultHost: "www-www.u2934071.nyat.app",
    defaultPort: 34157,
  },
  user: {
    defaultNetwork: "",
    defaultRole: "share",
  },
  media: {
    video: {
      frameRate: 15,
      width: { max: 1920 },
      height: { max: 1080 },
    },
    audio: false,
  },
  rtc: {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  },
};

export default config;
