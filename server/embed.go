package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"html"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
)

//go:embed dist
var webDist embed.FS

// 英文站（--en）的公开地址与元信息。
//
// 为什么放在服务端而不是前端：爬虫第一波读到的是**不执行 JS 的原始 HTML**，
// 标题/描述/canonical 这些必须在那时就正确，交给 React 运行时已经晚了。
// 而前端产物是所有站点共用的一份，所以只能由服务端按语言改写。
const (
	siteURL    = "https://pic.to3ks.com"
	siteTitle  = "Local Photo & Video Viewer — No Upload, No Install"
	siteDesc   = "Browse photos and videos from any folder on your computer, right in Chrome. Nothing is uploaded — and MKV, AVI and TS files play too. No install, no account."
	altSiteURL = "https://pic.3ks2u.com" // 同一应用的中文站，用于 hreflang 互指
	appName    = "Image Viewer"

	// Google Search Console 的 HTML 标记验证。用它而不是验证文件：标记就在首页
	// 的 head 里，不用额外托管一个文件，也不会因为路径拼错而 404。
	// 注意：资源（属性）地址必须是 https://pic.to3ks.com/，不能带上 /sitemap.xml。
	gscToken = "0VlsVKQNYV4hI3FnB7z68OnCaKcMB6PMXf2Md0I35Lc"
)

var (
	reTitle = regexp.MustCompile(`(?is)<title>.*?</title>`)
	reLang  = regexp.MustCompile(`(?i)<html[^>]*\blang="[^"]*"`)
)

// 结构化数据（schema.org WebApplication）。只写真实能力，不吹。
var webAppLD = map[string]any{
	"@context":             "https://schema.org",
	"@type":                "WebApplication",
	"name":                 appName,
	"url":                  siteURL + "/",
	"applicationCategory":  "MultimediaApplication",
	"operatingSystem":      "Chrome, Edge (desktop)",
	"browserRequirements":  "A Chromium-based browser with the File System Access API, served over https or localhost.",
	"description":          siteDesc,
	"inLanguage":           "en",
	"isAccessibleForFree":  true,
	"offers":               map[string]any{"@type": "Offer", "price": "0", "priceCurrency": "USD"},
	"featureList": []string{
		"Browse images and videos in any folder on your own computer",
		"Nothing is uploaded: reading and decoding happen inside the browser",
		"Plays MKV, AVI, WMV and MPEG-TS/M2TS files that Chrome cannot open by itself",
		"Thumbnails, folder navigation, slideshow and full-screen viewing",
		"No installation, no account, no ads",
	},
}

// 只在 --en 下注入到 </head> 之前。json.Marshal 会把 < > & 转成 \uXXXX，
// 所以塞进 <script> 里是安全的。
var enHead = func() string {
	ld, err := json.Marshal(webAppLD)
	if err != nil {
		ld = []byte(`{}`)
	}
	titleJS, _ := json.Marshal(siteTitle)
	esc := html.EscapeString
	lines := []string{
		`<meta name="google-site-verification" content="` + gscToken + `">`,
		`<meta name="description" content="` + esc(siteDesc) + `">`,
		`<meta name="robots" content="index,follow,max-image-preview:large">`,
		`<link rel="canonical" href="` + siteURL + `/">`,
		`<link rel="alternate" hreflang="en" href="` + siteURL + `/">`,
		`<link rel="alternate" hreflang="zh-CN" href="` + altSiteURL + `/">`,
		`<link rel="alternate" hreflang="x-default" href="` + siteURL + `/">`,
		`<meta property="og:type" content="website">`,
		`<meta property="og:site_name" content="` + esc(appName) + `">`,
		`<meta property="og:title" content="` + esc(siteTitle) + `">`,
		`<meta property="og:description" content="` + esc(siteDesc) + `">`,
		`<meta property="og:url" content="` + siteURL + `/">`,
		`<meta property="og:locale" content="en">`,
		`<meta property="og:locale:alternate" content="zh_CN">`,
		`<meta name="twitter:card" content="summary">`,
		`<meta name="twitter:title" content="` + esc(siteTitle) + `">`,
		`<meta name="twitter:description" content="` + esc(siteDesc) + `">`,
		`<script type="application/ld+json">` + string(ld) + `</script>`,
		// 前端启动时读这两个值（见 web/src/i18n.ts）：语言 + SEO 标题。
		`<script>window.__KANTU_LANG__="en";window.__KANTU_TITLE__=` + string(titleJS) + `;</script>`,
	}
	return strings.Join(lines, "\n") + "\n"
}()

// 把通用的 index.html 改写成英文站的版本。
func enPage(index []byte) []byte {
	page := reLang.ReplaceAll(index, []byte(`<html lang="en"`))
	page = reTitle.ReplaceAll(page, []byte("<title>"+html.EscapeString(siteTitle)+"</title>"))
	return bytes.Replace(page, []byte("</head>"), []byte(enHead+"</head>"), 1)
}

// robots.txt 与 sitemap.xml 里的地址是站点专属的，所以也只由英文站提供。
// 不加 lastmod：embed 里的文件没有修改时间，写个假的不如不写。
func robotsTxt() []byte {
	return []byte("User-agent: *\nAllow: /\n\nSitemap: " + siteURL + "/sitemap.xml\n")
}

func sitemapXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>` + siteURL + `/</loc>
    <xhtml:link rel="alternate" hreflang="en" href="` + siteURL + `/"/>
    <xhtml:link rel="alternate" hreflang="zh-CN" href="` + altSiteURL + `/"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="` + siteURL + `/"/>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`)
}

// staticHandler serves the embedded frontend build. http.FileServerFS serves
// index.html for "/" automatically, so no extra SPA fallback is needed since
// the app does not use client-side routing.
//
// en 为真时（启动参数 --en）额外做两件事：返回改写过的 index.html（英文标题、
// 描述、canonical、结构化数据，并在前端注入语言标记），以及站点专属的
// robots.txt / sitemap.xml。不加 --en 时完全是文件服务，一个字节都不改。
func staticHandler(en bool) http.Handler {
	sub, err := fs.Sub(webDist, "dist")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			_, _ = w.Write([]byte("前端未构建：请先构建 web/ 并将产物复制到 server/dist/。\n"))
		})
	}
	files := http.FileServerFS(sub)
	if !en {
		return files
	}

	index, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		return files // 读不到就照常托管，前端拿不到标记会退回中文
	}
	page := enPage(index)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/", "/index.html":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			// 页面内容随启动参数而定，浏览器无从用 ETag/Last-Modified 分辨，
			// 所以不缓存：带不带 --en 重启都能立刻看到对应语言。
			w.Header().Set("Cache-Control", "no-cache")
			_, _ = w.Write(page)
		case "/robots.txt":
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			_, _ = w.Write(robotsTxt())
		case "/sitemap.xml":
			w.Header().Set("Content-Type", "application/xml; charset=utf-8")
			w.Header().Set("Cache-Control", "no-cache")
			_, _ = w.Write(sitemapXML())
		default:
			files.ServeHTTP(w, r)
		}
	})
}
