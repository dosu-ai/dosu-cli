import Bonjour, { type Service } from "bonjour-service";

/* v8 ignore start -- Native mDNS lifecycle is verified by the real macOS Bonjour gate. */

const SERVICE_TYPE = "dosu-drive";

export interface DiscoveredDrive {
  id: string;
  name: string;
  host: string;
  url: string;
}

export interface DriveAdvertisement {
  stop(): Promise<void>;
}

export function advertiseDrive(options: {
  id: string;
  name: string;
  port: number;
}): DriveAdvertisement {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `${options.name} · ${options.id.slice(0, 6)}`,
    type: SERVICE_TYPE,
    protocol: "tcp",
    port: options.port,
    txt: { id: options.id, name: options.name, version: "1" },
    disableIPv6: true,
  });
  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolve) => service.stop(resolve));
      await new Promise<void>((resolve) => bonjour.destroy(resolve));
    },
  };
}

export async function discoverDrives(timeoutMs = 1600): Promise<DiscoveredDrive[]> {
  const bonjour = new Bonjour();
  const found = new Map<string, DiscoveredDrive>();
  const browser = bonjour.find({ type: SERVICE_TYPE, protocol: "tcp" });
  browser.on("up", (service) => {
    const drive = discoveredDrive(service);
    if (drive) found.set(drive.id, drive);
  });
  browser.on("down", (service) => {
    const id = textValue(service.txt?.id);
    if (id) found.delete(id);
  });
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  browser.stop();
  await new Promise<void>((resolve) => bonjour.destroy(resolve));
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function discoveredDrive(service: Service): DiscoveredDrive | undefined {
  const id = textValue(service.txt?.id);
  const name = textValue(service.txt?.name) || service.name;
  const address = preferredAddress(service);
  if (!id || !address || !service.port) return undefined;
  const host = address.includes(":") ? `[${address}]` : address;
  return { id, name, host: service.host, url: `http://${host}:${service.port}` };
}

function preferredAddress(service: Service): string | undefined {
  const addresses = service.addresses ?? [];
  return (
    addresses.find(
      (address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address) && !address.startsWith("127."),
    ) ??
    (service.referer?.family === "IPv4" ? service.referer.address : undefined) ??
    addresses.find((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) ??
    service.host
  );
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "number") return String(value);
  return "";
}
/* v8 ignore stop */
