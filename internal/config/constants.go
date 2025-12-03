package config

import "os"

const (
	// DevWebAppURL is the local development frontend URL
	DevWebAppURL = "http://localhost:3001"

	// ProdWebAppURL is the production frontend URL
	ProdWebAppURL = "https://app.dosu.dev"

	// DevBackendURL is the local development backend URL
	DevBackendURL = "http://localhost:7001"

	// ProdBackendURL is the production backend URL
	ProdBackendURL = "https://api.dosu.dev"

	// DevSupabaseURL is the local Supabase URL
	DevSupabaseURL = "http://localhost:54321"

	// ProdSupabaseURL is the production Supabase URL
	// TODO: Update this with the actual production Supabase URL
	ProdSupabaseURL = "https://your-project.supabase.co"
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

// GetSupabaseURL returns the appropriate Supabase URL based on environment
// Defaults to production. Set DOSU_DEV=true for local development.
func GetSupabaseURL() string {
	if url := os.Getenv("SUPABASE_URL"); url != "" {
		return url
	}
	if os.Getenv("DOSU_DEV") == "true" {
		return DevSupabaseURL
	}
	return ProdSupabaseURL
}
