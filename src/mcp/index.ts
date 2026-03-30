export type { Provider, SetupProvider } from "./providers";
export {
  allProviders,
  allSetupProviders,
  detectInstalledProviders,
  getProvider,
} from "./providers";

export {
  mcpURL,
  mcpHeaders,
  stripJSONComments,
  loadJSONConfig,
  saveJSONConfig,
  isJSONKeyConfigured,
  installJSONServer,
  removeJSONServer,
} from "./config-helpers";

export { isInstalled, expandHome, appSupportDir } from "./detect";
