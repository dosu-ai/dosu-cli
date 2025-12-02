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
func GetWebAppURL() string {
	if os.Getenv("DOSU_ENV") == "production" {
		return ProdWebAppURL
	}
	return DevWebAppURL
}

// GetBackendURL returns the appropriate backend URL based on environment
func GetBackendURL() string {
	if os.Getenv("DOSU_ENV") == "production" {
		return ProdBackendURL
	}
	return DevBackendURL
}
