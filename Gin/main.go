package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	"github.com/redis/go-redis/v9"
)

type Config struct {
	Port            string
	RedisURL        string
	MemberTTL       time.Duration
	PingInterval    time.Duration
	ReadTimeout     time.Duration
	WriteTimeout    time.Duration
	MaxMessageBytes int64
	LogFile         string
}

type SignalMessage struct {
	Type      string          `json:"type"`
	ClientID  string          `json:"client_id,omitempty"`
	Role      string          `json:"role,omitempty"`
	Target    string          `json:"target,omitempty"`
	SDP       json.RawMessage `json:"sdp,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
}

type Client struct {
	id   string
	role string
	ip   string
	port string
	conn *websocket.Conn
	send chan []byte
}

type Hub struct {
	mu      sync.RWMutex
	clients map[string]*Client
}

type Server struct {
	cfg Config
	rdb *redis.Client
	hub *Hub
}

func main() {
	cfg := loadConfig()
	rdb := newRedis(cfg.RedisURL)
	hub := &Hub{clients: make(map[string]*Client)}

	server := &Server{cfg: cfg, rdb: rdb, hub: hub}

	fileWriter, closeLog := setupLogging(cfg.LogFile)
	defer closeLog()

	gin.DefaultWriter = os.Stdout
	gin.DefaultErrorWriter = os.Stderr

	router := gin.New()
	router.Use(gin.Logger())
	if fileWriter != nil {
		router.Use(gin.LoggerWithWriter(fileWriter))
	}
	router.Use(gin.Recovery())
	router.GET("/health", server.handleHealth)
	router.GET("/lookup", server.handleLookup)
	router.GET("/members/:id", server.handleMember)
	router.GET("/ws", server.handleWS)

	addr := ":" + cfg.Port
	log.Printf("signaling server listening on %s", addr)
	if err := router.Run(addr); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}

func loadConfig() Config {
	_ = godotenv.Load()

	port := getenv("PORT", "8080")
	redisURL := getenv("REDIS_URL", "")
	if redisURL == "" {
		redisURL = getenv("KV_URL", "")
	}
	if redisURL == "" {
		log.Fatal("REDIS_URL or KV_URL is required")
	}

	ttlSeconds := getenvInt("MEMBER_TTL_SECONDS", 90)

	return Config{
		Port:            port,
		RedisURL:        redisURL,
		MemberTTL:       time.Duration(ttlSeconds) * time.Second,
		PingInterval:    30 * time.Second,
		ReadTimeout:     60 * time.Second,
		WriteTimeout:    10 * time.Second,
		MaxMessageBytes: 64 * 1024,
		LogFile:         getenv("LOG_FILE", "logs/signaling.log"),
	}
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func getenvInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func newRedis(redisURL string) *redis.Client {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		log.Fatalf("invalid redis url: %v", err)
	}
	return redis.NewClient(opt)
}

func setupLogging(path string) (io.Writer, func()) {
	if path == "" {
		log.SetOutput(os.Stdout)
		return nil, func() {}
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Fatalf("failed to create log dir: %v", err)
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		log.Fatalf("failed to open log file: %v", err)
	}

	log.SetOutput(io.MultiWriter(os.Stdout, file))

	return file, func() {
		_ = file.Close()
	}
}

func (s *Server) handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"ok":   true,
		"time": time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleMember(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing id"})
		return
	}
	ctx := c.Request.Context()
	data, err := s.rdb.HGetAll(ctx, memberKey(id)).Result()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(data) == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, data)
}

func (s *Server) handleLookup(c *gin.Context) {
	ip := c.Query("ip")
	if ip == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing ip"})
		return
	}

	ctx := c.Request.Context()
	data, err := s.rdb.HGetAll(ctx, shareIPKey(ip)).Result()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(data) == 0 {
		c.JSON(http.StatusOK, gin.H{"found": false})
		return
	}

	resp := gin.H{
		"found": true,
		"ip":    ip,
	}
	for k, v := range data {
		resp[k] = v
	}
	c.JSON(http.StatusOK, resp)
}

func (s *Server) handleWS(c *gin.Context) {
	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	ip, port := splitHostPort(c.Request.RemoteAddr)
	if clientIP := c.ClientIP(); clientIP != "" {
		ip = clientIP
	}

	client := &Client{
		ip:   ip,
		port: port,
		conn: conn,
		send: make(chan []byte, 64),
	}

	go client.writePump(s.cfg)
	client.readPump(s, c.Request.Context())
}

func (c *Client) readPump(s *Server, ctx context.Context) {
	defer func() {
		s.disconnectClient(ctx, c)
	}()

	c.conn.SetReadLimit(s.cfg.MaxMessageBytes)
	_ = c.conn.SetReadDeadline(time.Now().Add(s.cfg.ReadTimeout))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(s.cfg.ReadTimeout))
		return nil
	})

	for {
		_, payload, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var msg SignalMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			continue
		}
		log.Printf("recv type=%s client_id=%s role=%s target=%s", msg.Type, msg.ClientID, msg.Role, msg.Target)

		if msg.ClientID != "" && c.id == "" {
			c.id = msg.ClientID
		}

		switch msg.Type {
		case "join":
			if msg.ClientID == "" {
				continue
			}
			c.role = msg.Role

			s.hub.add(c)
			s.storeMember(ctx, c)
			s.hub.broadcast(c.id, payload, msg.Target)
		case "leave":
			s.hub.broadcast(c.id, payload, msg.Target)
			return
		case "offer", "answer", "ice", "control", "pli", "ping", "pong":
			s.touchMember(ctx, c)
			s.hub.broadcast(c.id, payload, msg.Target)
		default:
			s.touchMember(ctx, c)
		}
	}
}

func (c *Client) writePump(cfg Config) {
	ticker := time.NewTicker(cfg.PingInterval)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(cfg.WriteTimeout))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(cfg.WriteTimeout))
			if err := c.conn.WriteMessage(websocket.PingMessage, []byte("ping")); err != nil {
				return
			}
		}
	}
}

func (s *Server) disconnectClient(ctx context.Context, c *Client) {
	if c.id != "" {
		s.hub.remove(c)
		s.removeMember(ctx, c)
	}
	if c.send != nil {
		close(c.send)
		c.send = nil
	}
}

func (h *Hub) add(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c.id] = c
}

func (h *Hub) remove(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, c.id)
}

func (h *Hub) broadcast(senderID string, payload []byte, target string) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if target != "" {
		if targetClient, ok := h.clients[target]; ok {
			select {
			case targetClient.send <- payload:
			default:
			}
		}
		return
	}

	for id, client := range h.clients {
		if id == senderID {
			continue
		}
		select {
		case client.send <- payload:
		default:
		}
	}
}

func (s *Server) storeMember(ctx context.Context, c *Client) {
	if c.id == "" {
		return
	}

	fields := map[string]any{
		"client_id": c.id,
		"role":      c.role,
		"ip":        c.ip,
		"port":      c.port,
		"lastSeen":  time.Now().UTC().Format(time.RFC3339),
	}

	_ = s.rdb.HSet(ctx, memberKey(c.id), fields).Err()
	_ = s.rdb.Expire(ctx, memberKey(c.id), s.cfg.MemberTTL).Err()

	if c.role == "share" && c.ip != "" {
		_ = s.rdb.HSet(ctx, shareIPKey(c.ip), fields).Err()
		_ = s.rdb.Expire(ctx, shareIPKey(c.ip), s.cfg.MemberTTL).Err()
	}
}

func (s *Server) touchMember(ctx context.Context, c *Client) {
	if c.id == "" {
		return
	}
	_ = s.rdb.HSet(ctx, memberKey(c.id), "lastSeen", time.Now().UTC().Format(time.RFC3339)).Err()
	_ = s.rdb.Expire(ctx, memberKey(c.id), s.cfg.MemberTTL).Err()
	if c.role == "share" && c.ip != "" {
		_ = s.rdb.HSet(ctx, shareIPKey(c.ip), "lastSeen", time.Now().UTC().Format(time.RFC3339)).Err()
		_ = s.rdb.Expire(ctx, shareIPKey(c.ip), s.cfg.MemberTTL).Err()
	}
}

func (s *Server) removeMember(ctx context.Context, c *Client) {
	if c.id == "" {
		return
	}
	_ = s.rdb.Del(ctx, memberKey(c.id)).Err()
	if c.role == "share" && c.ip != "" {
		_ = s.rdb.Del(ctx, shareIPKey(c.ip)).Err()
	}
}

func memberKey(id string) string {
	return fmt.Sprintf("member:%s", id)
}

func shareIPKey(ip string) string {
	return fmt.Sprintf("share:ip:%s", ip)
}

func splitHostPort(addr string) (string, string) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, ""
	}
	return host, port
}
