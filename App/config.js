const config = {
  appName: "2P2S(tauri)",
  signaling: {
    secure: true,
    defaultHost: "www-www.u2934071.nyat.app",
    defaultPort: 34157,
    network:"83048a06329208f8"
  },
  user: {
    defaultNetwork: "",
    defaultRole: "share",
  },
  media: {
    video: {
      frameRate: 30,
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
    },
    audio: false,
  },
  rtc: {
    iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  },
};

export default config;
