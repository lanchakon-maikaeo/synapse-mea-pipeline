package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const maxRequestBytes int64 = 1 << 20
const maxResponseBytes int64 = 32 << 20

func requiredEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" || strings.ContainsAny(value, "\r\n") {
		return "", errors.New(name + " is missing or invalid")
	}
	return value, nil
}

func authorized(request *http.Request, expected string) bool {
	const prefix = "Bearer "
	supplied := request.Header.Get("Authorization")
	if !strings.HasPrefix(supplied, prefix) {
		return false
	}
	actual := supplied[len(prefix):]
	if len(actual) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}

func jsonResponse(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}

func main() {
	token, err := requiredEnv("ROUTING_PROXY_AUTH_TOKEN")
	if err != nil {
		log.Fatal(err)
	}
	rawUpstream, err := requiredEnv("UPSTREAM_URL")
	if err != nil {
		log.Fatal(err)
	}
	upstream, err := url.Parse(rawUpstream)
	if err != nil || upstream.Scheme != "http" ||
		(upstream.Hostname() != "127.0.0.1" && upstream.Hostname() != "localhost") {
		log.Fatal("UPSTREAM_URL must be a loopback HTTP URL")
	}
	healthPath, err := requiredEnv("ENGINE_HEALTH_PATH")
	if err != nil || !strings.HasPrefix(healthPath, "/") {
		log.Fatal("ENGINE_HEALTH_PATH is invalid")
	}

	proxy := httputil.NewSingleHostReverseProxy(upstream)
	originalDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		originalDirector(request)
		request.Host = upstream.Host
		request.Header.Del("Authorization")
		request.Header.Del("Cookie")
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, _ error) {
		jsonResponse(writer, http.StatusServiceUnavailable, map[string]any{
			"error": map[string]string{"code": "routing_engine_unavailable"},
		})
	}
	if rawChangeset := strings.TrimSpace(os.Getenv("INJECT_OSM_CHANGESET")); rawChangeset != "" {
		changeset, parseErr := strconv.ParseInt(rawChangeset, 10, 64)
		if parseErr != nil || changeset < 0 {
			log.Fatal("INJECT_OSM_CHANGESET is invalid")
		}
		proxy.ModifyResponse = func(response *http.Response) error {
			path := response.Request.URL.Path
			if path != "/status" && path != "/route" {
				return nil
			}
			body, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
			_ = response.Body.Close()
			if readErr != nil || int64(len(body)) > maxResponseBytes {
				return errors.New("routing response is too large")
			}
			var payload map[string]any
			if unmarshalErr := json.Unmarshal(body, &payload); unmarshalErr != nil {
				return errors.New("routing response is not JSON")
			}
			payload["osm_changeset"] = changeset
			body, marshalErr := json.Marshal(payload)
			if marshalErr != nil {
				return errors.New("routing response could not be normalized")
			}
			response.Body = io.NopCloser(bytes.NewReader(body))
			response.ContentLength = int64(len(body))
			response.Header.Set("Content-Length", strconv.Itoa(len(body)))
			return nil
		}
	}

	client := &http.Client{Timeout: 5 * time.Second}
	handler := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/health" {
			check, checkErr := http.NewRequestWithContext(
				request.Context(), http.MethodGet, upstream.ResolveReference(&url.URL{Path: healthPath}).String(), nil,
			)
			if checkErr != nil {
				jsonResponse(writer, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
				return
			}
			response, checkErr := client.Do(check)
			if checkErr != nil {
				jsonResponse(writer, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
				return
			}
			_ = response.Body.Close()
			if response.StatusCode < 200 || response.StatusCode >= 300 {
				jsonResponse(writer, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
				return
			}
			jsonResponse(writer, http.StatusOK, map[string]string{"status": "ok"})
			return
		}
		if !authorized(request, token) {
			jsonResponse(writer, http.StatusUnauthorized, map[string]any{
				"error": map[string]string{"code": "unauthorized"},
			})
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodPost {
			writer.Header().Set("Allow", "GET, POST")
			jsonResponse(writer, http.StatusMethodNotAllowed, map[string]any{
				"error": map[string]string{"code": "method_not_allowed"},
			})
			return
		}
		request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
		proxy.ServeHTTP(writer, request)
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
	log.Printf("authenticated routing proxy listening on port %d", port)
	log.Fatal(server.ListenAndServe())
}
