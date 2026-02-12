import { handleBatteryStepPacket, handleDcStatePacket } from "./battery";
import { handleVolumePacket } from "./volume";
import { handleLampStatePacket } from "./lamp";
import { handleDeviceInfoPacket } from "./device-info";
import { toHex, logLine } from "../utils/formatter";

export type GaiaPacketEvent = {
  address: string;
  vendor_id: number;
  command_id: number;
  command: number;
  ack: boolean;
  flags: number;
  payload: number[];
  status?: number | null;
};

export function handleGaiaPacket(p: GaiaPacketEvent) {
  const dataPayload = p.ack && p.payload.length > 0 ? p.payload.slice(1) : p.payload;

  if (p.vendor_id === 0x5054 && p.ack) {
    switch (p.command) {
      case 0x0455: handleBatteryStepPacket(p.address, dataPayload); break;
      case 0x0456: handleDcStatePacket(p.address, dataPayload); break;
      case 0x0401: handleVolumePacket(p.address, dataPayload); break;
      case 0x0411: handleLampStatePacket(p.address, dataPayload); break;
      case 0x0451:
      case 0x0452:
      case 0x0453:
      case 0x0454:
      case 0x0457: handleDeviceInfoPacket(p.address, p.command, dataPayload); break;
    }
  }

  const payloadText = p.payload.length
    ? p.payload.map((b: number) => toHex(b, 2)).join(" ")
    : "<empty>";
  const statusText = p.status !== null && p.status !== undefined ? ` status=${p.status}` : "";
  
  logLine(
    `${toHex(p.vendor_id, 4)} ${toHex(p.command_id, 4)}${p.ack ? " ACK" : ""}${statusText} ${payloadText}`,
    "IN"
  );
}
