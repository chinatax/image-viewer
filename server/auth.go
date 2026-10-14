package main

import (
	"net/http"
	"strings"
)

// authMiddleware guards every route with the configured token. The token may be
// supplied either as an "Authorization: Bearer <token>" header or as a
// "?token=<token>" query parameter (the latter is convenient for <img>/<video>
// src attributes and direct navigation).
func (c *Config) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c.Token == "" {
			next.ServeHTTP(w, r)
			return
		}

		token := ""
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			token = strings.TrimPrefix(h, "Bearer ")
		} else {
			token = r.URL.Query().Get("token")
		}

		if token != c.Token {
			w.Header().Set("WWW-Authenticate", `Bearer realm="imageviewer"`)
			writeErr(w, http.StatusUnauthorized, "invalid or missing token")
			return
		}
		next.ServeHTTP(w, r)
	})
}
