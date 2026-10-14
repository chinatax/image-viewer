package main

import (
	"bytes"
	"errors"
	"fmt"
	"hash/fnv"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/gif"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

const thumbCacheMax = 500

type thumbEntry struct {
	modTime time.Time
	size    int64
	data    []byte
}

type thumbCache struct {
	mu sync.Mutex
	m  map[string]thumbEntry
}

var thumbs = &thumbCache{m: make(map[string]thumbEntry)}

// handleThumb serves a downscaled JPEG thumbnail for an image, or (if ffmpeg
// is installed) a frame extracted from a video. When a thumbnail cannot be
// produced — unsupported format, already-small image, or missing ffmpeg — it
// falls back to serving the original file (or 404 for videos).
func (c *Config) handleThumb(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	abs, err := safePath(raw, c.Root)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			writeErr(w, http.StatusNotFound, "not found")
		} else {
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	if info.IsDir() {
		writeErr(w, http.StatusBadRequest, "path is a directory")
		return
	}

	wMax := clampInt(intParam(r, "w", 320), 16, 2048)
	hMax := clampInt(intParam(r, "h", 320), 16, 2048)
	etag := thumbEtag(abs, wMax, hMax, info)

	// Serve from in-memory cache when the underlying file is unchanged.
	thumbs.mu.Lock()
	if e, ok := thumbs.m[etag]; ok && e.modTime.Equal(info.ModTime()) && e.size == info.Size() {
		data := e.data
		thumbs.mu.Unlock()
		serveJPEG(w, r, data, etag)
		return
	}
	thumbs.mu.Unlock()

	if isVideo(filepath.Base(abs)) {
		data, err := videoThumb(abs, wMax, hMax)
		if err != nil {
			writeErr(w, http.StatusNotFound, "no thumbnail available for video")
			return
		}
		storeThumb(etag, info, data)
		serveJPEG(w, r, data, etag)
		return
	}

	data, ok := imageThumb(abs, wMax, hMax)
	if !ok {
		// Unsupported format or already small enough: serve the original.
		c.handleFile(w, r)
		return
	}
	storeThumb(etag, info, data)
	serveJPEG(w, r, data, etag)
}

func storeThumb(etag string, info os.FileInfo, data []byte) {
	thumbs.mu.Lock()
	defer thumbs.mu.Unlock()
	thumbs.m[etag] = thumbEntry{modTime: info.ModTime(), size: info.Size(), data: data}
	if len(thumbs.m) > thumbCacheMax {
		for k := range thumbs.m {
			delete(thumbs.m, k)
			break // evict a single (arbitrary) entry
		}
	}
}

// imageThumb returns a JPEG thumbnail (true) when the image is larger than the
// requested bounds and can be decoded; otherwise it returns (nil, false) to
// signal "serve the original". Supported formats: jpeg, png, gif, webp, bmp,
// tiff. Anything else (svg, avif, heic, ...) falls through to the original.
func imageThumb(path string, wMax, hMax int) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()

	// DecodeConfig only reads the header, so small images are never fully
	// decoded — they are served as-is instead.
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return nil, false // unsupported format (svg, avif, heic, ...)
	}
	if cfg.Width <= wMax && cfg.Height <= hMax {
		return nil, false // already fits, no need to re-encode
	}

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, false
	}
	src, _, err := image.Decode(f)
	if err != nil {
		return nil, false
	}

	thumb := scaleToFit(src, wMax, hMax)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: 80}); err != nil {
		return nil, false
	}
	return buf.Bytes(), true
}

// scaleToFit downscales src into an *image.RGBA no larger than wMax×hMax,
// keeping aspect ratio. Catmull-Rom gives high-quality results; the source is
// composited over a white background so transparent regions become white in
// the JPEG output.
func scaleToFit(src image.Image, wMax, hMax int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= 0 || sh <= 0 {
		return image.NewRGBA(image.Rect(0, 0, 1, 1))
	}
	scale := 1.0
	if sw > wMax {
		scale = float64(wMax) / float64(sw)
	}
	if sh > hMax {
		if s := float64(hMax) / float64(sh); s < scale {
			scale = s
		}
	}
	dw := int(float64(sw)*scale + 0.5)
	dh := int(float64(sh)*scale + 0.5)
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}

	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	return dst
}

// videoThumb extracts a single frame as a JPEG using ffmpeg, if available.
func videoThumb(path string, wMax, hMax int) ([]byte, error) {
	if ffmpegPath == "" {
		return nil, errors.New("ffmpeg not available")
	}
	scale := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease", wMax, hMax)
	for _, ss := range []string{"1", "0"} {
		cmd := exec.Command(ffmpegPath, "-y", "-ss", ss, "-i", path,
			"-frames:v", "1", "-vf", scale, "-f", "mjpeg", "-")
		var out bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = io.Discard
		if err := cmd.Run(); err == nil && out.Len() > 0 {
			return out.Bytes(), nil
		}
	}
	return nil, errors.New("ffmpeg frame extraction failed")
}

var ffmpegPath = func() string {
	p, err := exec.LookPath("ffmpeg")
	if err != nil {
		return ""
	}
	return p
}()

func serveJPEG(w http.ResponseWriter, r *http.Request, data []byte, etag string) {
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func thumbEtag(abs string, wMax, hMax int, info os.FileInfo) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(abs))
	_, _ = fmt.Fprintf(h, "|%d|%d|%d|%d", wMax, hMax, info.ModTime().UnixNano(), info.Size())
	return fmt.Sprintf(`"t-%x"`, h.Sum64())
}

func intParam(r *http.Request, name string, def int) int {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
