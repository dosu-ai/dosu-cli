import type { Config } from "../config/config";
import { getSupabaseAnonKey, getSupabaseURL } from "../config/constants";

export async function listSpaceDataSourceIds(config: Config, spaceId: string): Promise<string[]> {
  const accessToken = config.active_account?.session.access_token;
  if (!accessToken) throw new Error("Not logged in. Run 'dosu login' first.");

  const endpoint = new URL("/rest/v1/space_data_source", getSupabaseURL());
  endpoint.searchParams.set("select", "data_source_id");
  endpoint.searchParams.set("space_id", `eq.${spaceId}`);

  const response = await fetch(endpoint, {
    headers: {
      apikey: getSupabaseAnonKey(),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to list this deployment's data sources (status ${response.status}).`);
  }

  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || rows.some((row) => !isDataSourceLink(row))) {
    throw new Error("Supabase returned an invalid space_data_source response.");
  }
  return rows.map((row) => row.data_source_id);
}

function isDataSourceLink(value: unknown): value is { data_source_id: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "data_source_id" in value &&
    typeof value.data_source_id === "string"
  );
}
