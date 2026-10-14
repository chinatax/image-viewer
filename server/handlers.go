package main

import (
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type listResponse struct {
	Path   string   `json:"path"`
	Parent string   `json:"parent"`
	Dirs   []string `json:"dirs"`
	Images []string `json:"images"`
	Videos []string `json:"videos"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// safePath validates and cleans a client-supplied path, ensuring it is absolute
// and confined to the configured root. For a whole-disk root ("/") everything
// absolute is allowed.
func safePath(raw, root string) (string, error) {
	if raw == "" {
		return "", errors.New("path is required")
	}
	p := filepath.Clean(raw)
	if !filepath.IsAbs(p) {
		return "", errors.New("path must be absolute")
	}
	rootClean := filepath.Clean(root)
	if rootClean == string(os.PathSeparator) {
		return p, nil
	}
	if p != rootClean && !strings.HasPrefix(p, rootClean+string(os.PathSeparator)) {
		return "", errors.New("path is outside the allowed root")
	}
	return p, nil
}

func parentOf(p string) string {
	if p == string(os.PathSeparator) {
		return ""
	}
	parent := filepath.Dir(p)
	if parent == p {
		return ""
	}
	return parent
}

// handleDirs returns the browsable roots: the configured root plus real mount
// points (excluding pseudo filesystems).
func (c *Config) handleDirs(w http.ResponseWriter, r *http.Request) {
	roots := []string{c.Root}
	seen := map[string]bool{c.Root: true}
	mps := mountPoints()
	sort.Strings(mps)
	for _, mp := range mps {
		if mp == "" || seen[mp] {
			continue
		}
		seen[mp] = true
		roots = append(roots, mp)
	}
	writeJSON(w, http.StatusOK, map[string]any{"roots": roots})
}

func (c *Config) handleList(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	if raw == "" {
		raw = c.Root
	}
	abs, err := safePath(raw, c.Root)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			writeErr(w, http.StatusNotFound, "path not found")
		} else {
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	if !info.IsDir() {
		writeErr(w, http.StatusBadRequest, "path is not a directory")
		return
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	resp := listResponse{
		Path:   abs,
		Parent: parentOf(abs),
		Dirs:   []string{},
		Images: []string{},
		Videos: []string{},
	}
	for _, e := range entries {
		full := filepath.Join(abs, e.Name())
		if e.IsDir() {
			resp.Dirs = append(resp.Dirs, full)
			continue
		}
		if isImage(e.Name()) {
			resp.Images = append(resp.Images, full)
		} else if isVideo(e.Name()) {
			resp.Videos = append(resp.Videos, full)
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (c *Config) handleFile(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("path")
	abs, err := safePath(raw, c.Root)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			writeErr(w, http.StatusNotFound, "file not found")
		} else {
			writeErr(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	if info.IsDir() {
		writeErr(w, http.StatusBadRequest, "path is a directory")
		return
	}

	f, err := os.Open(abs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer f.Close()

	ct := mime.TypeByExtension(strings.ToLower(filepath.Ext(abs)))
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	// ServeContent handles Range requests, If-Modified-Since and 206 responses,
	// which video seeking depends on.
	http.ServeContent(w, r, filepath.Base(abs), info.ModTime(), f)
}

// mountPoints reads /proc/mounts and returns real mount points, skipping pseudo
// and virtual filesystems that would only clutter the directory list.
func mountPoints() []string {
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return nil
	}
	skip := map[string]bool{
		"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true,
		"tmpfs": true, "cgroup": true, "cgroup2": true, "overlay": true,
		"squashfs": true, "autofs": true, "securityfs": true, "pstore": true,
		"debugfs": true, "tracefs": true, "hugetlbfs": true, "mqueue": true,
		"binfmt_misc": true, "ramfs": true, "nsfs": true, "fusectl": true,
		"configfs": true, "rpc_pipefs": true, "bpf": true, "fuse.gvfsd-fuse": true,
	}
	var out []string
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		if skip[fields[2]] {
			continue
		}
		out = append(out, unescapeMount(fields[1]))
	}
	return out
}

// unescapeMount decodes the octal escapes (\040, \011, \012, \134) that
// /proc/mounts uses for spaces and other special characters in mount points.
func unescapeMount(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
