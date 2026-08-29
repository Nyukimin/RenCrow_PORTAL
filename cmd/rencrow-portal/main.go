package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Nyukimin/RenCrow_PORTAL/internal/migrationhook"
	"github.com/Nyukimin/RenCrow_PORTAL/internal/portal"
)

var version = "dev"

func main() {
	if handled, code := runMigrationCommand(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); handled {
		os.Exit(code)
	}
	defaultConfig := strings.TrimSpace(os.Getenv("RENCROW_PORTAL_CONFIG"))
	configPath := flag.String("config", defaultConfig, "PORTAL JSON設定ファイル")
	flag.Parse()

	cfg, err := portal.LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("PORTAL設定エラー: %v", err)
	}
	handler, err := portal.NewHandler(cfg)
	if err != nil {
		log.Fatalf("PORTAL初期化エラー: %v", err)
	}

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("PORTAL停止エラー: %v", err)
		}
	}()

	log.Printf("RenCrow_PORTAL %s を http://%s で起動します。CORE=%s", version, cfg.Listen, cfg.CoreURL)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("PORTALサーバーエラー: %v", err)
	}
}

func runMigrationCommand(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) (bool, int) {
	if len(args) == 0 || args[0] != "migration-hook" {
		return false, 0
	}
	if len(args) != 1 {
		fmt.Fprintln(stderr, "[NG] migration-hook does not accept arguments")
		return true, 2
	}
	return true, migrationhook.Execute(stdin, stdout, stderr)
}
