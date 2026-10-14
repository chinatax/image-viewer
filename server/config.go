package main

import (
	"encoding/json"
	"os"
)

// Config holds the server configuration loaded from a JSON file.
type Config struct {
	// Listen is the HTTP listen address, e.g. ":8080".
	Listen string `json:"listen"`
	// Token is the access token. Empty means no auth required.
	Token string `json:"token"`
	// Root is the top-level directory exposed to clients. "/" means whole disk.
	Root string `json:"root"`
}

func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.Listen == "" {
		cfg.Listen = ":8080"
	}
	if cfg.Root == "" {
		cfg.Root = "/"
	}
	return &cfg, nil
}
