package main

import (
	"flag"
	"log"
	"net/http"
	"time"
)

func main() {
	cfgPath := flag.String("config", "config.json", "path to config file")
	// 界面语言：默认中文，加 --en 出英文。前端本身读不到命令行参数，
	// 所以由这里在返回 index.html 时注入标记（见 embed.go）。
	en := flag.Bool("en", false, "serve the UI in English (default: Chinese)")
	flag.Parse()

	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	api := http.NewServeMux()
	api.HandleFunc("GET /api/dirs", cfg.handleDirs)
	api.HandleFunc("GET /api/list", cfg.handleList)
	api.HandleFunc("GET /api/file", cfg.handleFile)
	api.HandleFunc("GET /api/thumb", cfg.handleThumb)

	root := http.NewServeMux()
	root.Handle("/api/", cfg.authMiddleware(api)) // 旧的服务端 API（方案1纯前端下已不使用，保留无害）
	root.Handle("/", staticHandler(*en))          // 前端静态资源挂在根路径

	log.Printf("imageviewer listening on %s (root=%s)", cfg.Listen, cfg.Root)
	if err := http.ListenAndServe(cfg.Listen, logMiddleware(root)); err != nil {
		log.Fatal(err)
	}
}

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start))
	})
}
