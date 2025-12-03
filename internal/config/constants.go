package config

import "os"

const (
	// DevWebAppURL is the local development frontend URL
	DevWebAppURL = "http://localhost:3001"

	// ProdWebAppURL is the production frontend URL
	ProdWebAppURL = "https://app.dosu.dev"

	// DevBackendURL is the local development backend URL
	DevBackendURL = "http://localhost:8000"

	// ProdBackendURL is the production backend URL
	ProdBackendURL = "https://api.dosu.dev"
)

// GetWebAppURL returns the appropriate web app URL based on environment
// Defaults to production. Set DOSU_DEV=true for local development.
func GetWebAppURL() string {
	if url := os.Getenv("DOSU_WEB_APP_URL"); url != "" {
		return url
	}
	if os.Getenv("DOSU_DEV") == "true" {
		return DevWebAppURL
	}
	return ProdWebAppURL
}

// GetBackendURL returns the appropriate backend URL based on environment
// Defaults to production. Set DOSU_DEV=true for local development.
func GetBackendURL() string {
	if url := os.Getenv("DOSU_BACKEND_URL"); url != "" {
		return url
	}
	if os.Getenv("DOSU_DEV") == "true" {
		return DevBackendURL
	}
	return ProdBackendURL
}
