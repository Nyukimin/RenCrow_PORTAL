package portal

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// PORTAL のアクセスログ。
//
// docs/10_ログ仕様.md（RenCrow_CORE の現行正本）に従う。
//
// PORTAL が自身で拒否したリクエスト（mode不許可、endpoint非許可、
// cross-origin拒否）と CORE へ到達できなかったリクエストは CORE のログに
// 現れない。PORTAL が唯一の証拠元であるため、成功・失敗を問わず記録する。
//
// 出力は JSON 1行で stdout へ書き、収集はプラットフォーム側に委ねる。

const accessLogSchemaVersion = 1

type accessLogger struct {
	mu  sync.Mutex
	out io.Writer
	now func() time.Time
}

func newAccessLogger(out io.Writer) *accessLogger {
	if out == nil {
		out = os.Stdout
	}
	return &accessLogger{out: out, now: func() time.Time { return time.Now().UTC() }}
}

// withAccessLog はリクエストの結果を記録する middleware を返す
func withAccessLog(logger *accessLogger, next http.Handler) http.Handler {
	if next == nil {
		return http.NotFoundHandler()
	}
	if logger == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if skipAccessLog(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		started := logger.now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		logger.write(r, recorder.status, logger.now().Sub(started))
	})
}

// skipAccessLog は監視用 probe を記録対象から外す
//
// 30秒ごとの liveness probe を記録すると、調査に必要な行が埋もれる。
func skipAccessLog(path string) bool {
	return path == "/health/live" || path == "/health/ready"
}

func (l *accessLogger) write(r *http.Request, status int, elapsed time.Duration) {
	entry := map[string]any{
		"schema_version": accessLogSchemaVersion,
		"ts":             l.now().Format("2006-01-02T15:04:05.000Z07:00"),
		"level":          accessLogLevel(status),
		"event":          accessLogEvent(status),
		"module":         "RenCrow_PORTAL",
		"method":         r.Method,
		"path":           r.URL.Path,
		"status":         status,
		"duration_ms":    elapsed.Milliseconds(),
	}
	if v := viewerClientIDFromRequest(r); v != "" {
		entry["viewer_client_id"] = v
	}
	if v := strings.TrimSpace(r.Header.Get(interactionProfileHeader)); v != "" {
		entry["interaction_profile"] = v
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	encoder := json.NewEncoder(l.out)
	_ = encoder.Encode(entry)
}

func accessLogLevel(status int) string {
	switch {
	case status >= 500:
		return "error"
	case status >= 400:
		return "warn"
	default:
		return "info"
	}
}

func accessLogEvent(status int) string {
	if status >= 400 {
		return "proxy.request.denied"
	}
	return "proxy.request.completed"
}

// viewerClientIDFromRequest は相関IDを取り出す
//
// CORE のログと突き合わせる唯一の手がかりになる。POST body は読むと
// proxy へ渡す本文を壊すため、クエリとヘッダだけを見る。
func viewerClientIDFromRequest(r *http.Request) string {
	if v := strings.TrimSpace(r.URL.Query().Get("viewer_client_id")); v != "" {
		return v
	}
	return strings.TrimSpace(r.Header.Get("X-RenCrow-Viewer-Client-Id"))
}

// statusRecorder は書き込まれたステータスコードを記録する
type statusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *statusRecorder) WriteHeader(status int) {
	if s.wroteHeader {
		return
	}
	s.status = status
	s.wroteHeader = true
	s.ResponseWriter.WriteHeader(status)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}

// Flush は SSE 中継のために ResponseWriter の Flush を委譲する
func (s *statusRecorder) Flush() {
	if flusher, ok := s.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
