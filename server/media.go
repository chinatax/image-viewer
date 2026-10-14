package main

import (
	"path/filepath"
	"strings"
)

var imageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true,
	".webp": true, ".bmp": true, ".svg": true, ".avif": true,
	".ico": true, ".tif": true, ".tiff": true, ".heic": true, ".heif": true,
}

var videoExts = map[string]bool{
	".mp4": true, ".webm": true, ".mkv": true, ".mov": true,
	".avi": true, ".m4v": true, ".mpg": true, ".mpeg": true,
	".wmv": true, ".flv": true, ".ts": true, ".m2ts": true,
	".3gp": true, ".ogv": true,
}

func isImage(name string) bool {
	return imageExts[strings.ToLower(filepath.Ext(name))]
}

func isVideo(name string) bool {
	return videoExts[strings.ToLower(filepath.Ext(name))]
}
