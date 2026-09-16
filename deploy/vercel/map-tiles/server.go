package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

const productionOrigin = "https://mea-synapse-production.vercel.app"

func jsonResponse(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}

func main() {
	tilePath := strings.TrimSpace(os.Getenv("TILE_PATH"))
	if tilePath == "" {
		log.Fatal("TILE_PATH is required")
	}
	tile, err := os.Open(tilePath)
	if err != nil {
		log.Fatal(err)
	}
	info, err := tile.Stat()
	if err != nil {
		log.Fatal(err)
	}
	hasher := sha256.New()
	if _, err = io.Copy(hasher, tile); err != nil {
		log.Fatal(err)
	}
	tileDigest := fmt.Sprintf("%x", hasher.Sum(nil))
	_ = tile.Close()

	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		if request.URL.Path == "/health" {
			jsonResponse(writer, http.StatusOK, map[string]any{
				"status":  "ok",
				"dataset": "protomaps-bmr-20260915",
				"bytes":   info.Size(),
				"sha256":  tileDigest,
			})
			return
		}
		if request.URL.Path != "/bmr.pmtiles" {
			jsonResponse(writer, http.StatusNotFound, map[string]string{"error": "not_found"})
			return
		}
		origin := request.Header.Get("Origin")
		if origin != "" && origin != productionOrigin {
			jsonResponse(writer, http.StatusForbidden, map[string]string{"error": "origin_not_allowed"})
			return
		}
		if origin != "" {
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			writer.Header().Set("Vary", "Origin")
		}
		writer.Header().Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, ETag")
		writer.Header().Set("Cache-Control", "public, max-age=3600, s-maxage=31536000, immutable")
		writer.Header().Set("Content-Type", "application/vnd.pmtiles")
		writer.Header().Set("ETag", `"sha256-`+tileDigest+`"`)
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			writer.Header().Set("Allow", "GET, HEAD")
			jsonResponse(writer, http.StatusMethodNotAllowed, map[string]string{"error": "method_not_allowed"})
			return
		}
		requestTile, openErr := os.Open(tilePath)
		if openErr != nil {
			jsonResponse(writer, http.StatusServiceUnavailable, map[string]string{"error": "tile_unavailable"})
			return
		}
		defer requestTile.Close()
		http.ServeContent(writer, request, "bmr.pmtiles", time.Unix(1789444800, 0), requestTile)
	})

	rawPort := os.Getenv("PORT")
	if rawPort == "" {
		rawPort = "8080"
	}
	port, err := strconv.Atoi(rawPort)
	if err != nil || port < 1 || port > 65535 {
		log.Fatal("PORT is invalid")
	}
	server := &http.Server{
		Addr:              "0.0.0.0:" + strconv.Itoa(port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	log.Printf("PMTiles server listening on port %d", port)
	log.Fatal(server.ListenAndServe())
}
